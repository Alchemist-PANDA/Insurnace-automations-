import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { FakeSmsChannel } from "@stl/messaging";
import { FakeLlm } from "@stl/llm";
import { FakeCalendar } from "@stl/calendar";
import { FakeCrm } from "@stl/crm";
import { randomUUID } from "node:crypto";
import { makeDeps, type WorkerDeps } from "./deps.js";
import { processWorkflow } from "./processors/workflow.js";
import { takeoverLead, resumeLead, retryFailedMessage } from "./processors/takeover.js";

/**
 * M8 — workflow/follow-up engine + human takeover (plan: blueprint §5I/§5J,
 * MVP acceptance #8, #9). Proves state-triggered sequencing with stop
 * conditions, durable delayed steps, takeover pausing automation, and DLQ retry.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("workflow engine + takeover", () => {
  const tenantId = randomUUID();
  const clockNow = new Date("2026-07-20T15:00:00Z");
  let deps: WorkerDeps;
  const enqueued: { queue: string; jobId: string; data: unknown; opts?: { delay?: number } }[] = [];

  beforeAll(async () => {
    const db = getDb();
    deps = makeDeps({
      db,
      sms: new FakeSmsChannel(),
      llm: new FakeLlm(),
      calendar: new FakeCalendar(),
      crm: new FakeCrm(),
      clock: { now: () => clockNow },
      enqueue: async (queue, jobId, data, opts) => {
        enqueued.push({ queue, jobId, data, opts });
      },
    });
    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId, name: "Summit", slug: `s-${tenantId.slice(0, 8)}` });
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeLead(state: string, phone: string): Promise<string> {
    const db = getDb();
    return withTenant(db, { tenantId }, async (tx) => {
      const [lead] = await tx
        .insert(schema.leads)
        .values({ tenantId, state, firstName: "Sarah", phoneE164: phone })
        .returning({ id: schema.leads.id });
      await tx.insert(schema.conversations).values({ tenantId, leadId: lead!.id, channel: "sms" });
      return lead!.id;
    });
  }

  it("starts a run and schedules the first step (durable delayed job)", async () => {
    enqueued.length = 0;
    const leadId = await makeLead("contacted", "+12145551301");
    const res = await processWorkflow(deps, { tenantId, leadId, trigger: "no_reply", correlationId: "w1" });
    expect(res.status).toBe("started");
    expect(res.runId).toBeTruthy();
    const wfJobs = enqueued.filter((e) => e.queue === "workflow");
    expect(wfJobs).toHaveLength(1);
    expect((wfJobs[0]!.opts?.delay ?? 0)).toBeGreaterThan(0);
  });

  it("executes a step and schedules the next", async () => {
    const leadId = await makeLead("contacted", "+12145551302");
    const start = await processWorkflow(deps, { tenantId, leadId, trigger: "no_reply", correlationId: "w2" });
    const runId = start.runId!;
    const res = await processWorkflow(deps, {
      tenantId,
      leadId,
      trigger: "no_reply",
      runId,
      stepKey: "sms_1",
      correlationId: "w2",
    });
    expect(res.status).toBe("step_executed");

    const db = getDb();
    const steps = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.runId, runId)),
    );
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[0]!.status).toBe("executed");
  });

  it("stops the sequence when the lead books mid-flow (stop condition)", async () => {
    const leadId = await makeLead("contacted", "+12145551303");
    const start = await processWorkflow(deps, { tenantId, leadId, trigger: "no_reply", correlationId: "w3" });
    const runId = start.runId!;
    // Lead books.
    await withTenant(getDb(), { tenantId }, (tx) =>
      tx.update(schema.leads).set({ state: "booked" }).where(eq(schema.leads.id, leadId)),
    );
    const res = await processWorkflow(deps, {
      tenantId,
      leadId,
      trigger: "no_reply",
      runId,
      stepKey: "sms_1",
      correlationId: "w3",
    });
    expect(res.status).toBe("stopped");

    const db = getDb();
    const [run] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)),
    );
    expect(run!.status).toBe("stopped");
    expect(run!.stopReason).toContain("booked");
  });

  it("does not start a duplicate run for the same lead+workflow", async () => {
    const leadId = await makeLead("contacted", "+12145551304");
    const a = await processWorkflow(deps, { tenantId, leadId, trigger: "no_reply", correlationId: "w4" });
    const b = await processWorkflow(deps, { tenantId, leadId, trigger: "no_reply", correlationId: "w4" });
    expect(a.runId).toBe(b.runId);
  });

  it("takeover pauses the AI and stops running workflows (accept #8)", async () => {
    const leadId = await makeLead("qualifying", "+12145551305");
    await processWorkflow(deps, { tenantId, leadId, trigger: "no_reply", correlationId: "w5" });
    const db = getDb();

    const res = await takeoverLead(db, { tenantId, leadId, userId: "rep1", now: clockNow });
    expect(res.ok).toBe(true);

    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("human_owned");
    const [convo] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.leadId, leadId)),
    );
    expect(convo!.aiPaused).toBe(true);
    const runs = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.leadId, leadId)),
    );
    expect(runs.every((r) => r.status !== "running")).toBe(true);
  });

  it("resume restores the pre-takeover state and un-pauses AI", async () => {
    const leadId = await makeLead("qualifying", "+12145551306");
    const db = getDb();
    await takeoverLead(db, { tenantId, leadId, userId: "rep1", now: clockNow });
    const res = await resumeLead(db, { tenantId, leadId, userId: "rep1", now: clockNow });
    expect(res.ok).toBe(true);
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("qualifying");
    const [convo] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.leadId, leadId)),
    );
    expect(convo!.aiPaused).toBe(false);
  });

  it("retries a failed message from the DLQ view (accept #9)", async () => {
    const leadId = await makeLead("contacted", "+12145551307");
    const db = getDb();
    // Create a failed message + failed outbox row.
    const { messageId } = await withTenant(db, { tenantId }, async (tx) => {
      const [convo] = await tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.leadId, leadId))
        .limit(1);
      const [msg] = await tx
        .insert(schema.messages)
        .values({
          tenantId,
          conversationId: convo!.id,
          direction: "out",
          channel: "sms",
          body: "hi",
          status: "failed",
          dedupeKey: `x:${randomUUID()}`,
        })
        .returning({ id: schema.messages.id });
      await tx.insert(schema.outbox).values({
        tenantId,
        aggregateType: "message",
        aggregateId: msg!.id,
        intentType: "sms.send",
        payload: {},
        status: "failed",
      });
      return { messageId: msg!.id };
    });

    const res = await retryFailedMessage(db, { tenantId, messageId });
    expect(res.ok).toBe(true);
    const [msg] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)),
    );
    expect(msg!.status).toBe("queued");
  });
});
