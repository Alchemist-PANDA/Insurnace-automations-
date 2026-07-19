import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { FakeSmsChannel } from "@stl/messaging";
import { FakeLlm } from "@stl/llm";
import { FakeCalendar } from "@stl/calendar";
import { FakeCrm } from "@stl/crm";
import { randomUUID } from "node:crypto";
import { makeDeps, type WorkerDeps } from "./deps.js";
import { processAssignment } from "./processors/assignment.js";
import { processEscalation, acknowledgeLead } from "./processors/escalation.js";

/**
 * Assignment + SLA escalation (plan: blueprint §5G, PLAN M5). Proves routing
 * persists an assignment, a hot lead schedules the escalation ladder, and
 * acknowledgment halts it (a lead is never trapped by one unavailable rep).
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("assignment + escalation", () => {
  const tenantId = randomUUID();
  const repA = randomUUID();
  const repB = randomUUID();
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
      for (const [uid, email] of [
        [repA, `a-${repA.slice(0, 8)}@x.com`],
        [repB, `b-${repB.slice(0, 8)}@x.com`],
      ] as const) {
        await tx.insert(schema.users).values({ id: uid, email });
        await tx.insert(schema.memberships).values({ tenantId, userId: uid, role: "sales_rep" });
        await tx.insert(schema.userSchedules).values({ tenantId, userId: uid, available: true, workloadCap: 10 });
      }
      // repA covers the 750 territory.
      await tx.insert(schema.territories).values({ tenantId, userId: repA, key: "750" });
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeLead(band: string, postal: string, phone: string): Promise<string> {
    const db = getDb();
    return withTenant(db, { tenantId }, async (tx) => {
      const [lead] = await tx
        .insert(schema.leads)
        .values({
          tenantId,
          state: "qualified",
          firstName: "Sarah",
          phoneE164: phone,
          postalCode: postal,
          region: "TX",
          serviceRequested: "roof_replacement",
          scoreBand: band,
          scoreCurrent: band === "hot" ? 84 : 60,
        })
        .returning({ id: schema.leads.id });
      return lead!.id;
    });
  }

  it("assigns by territory and persists the assignment", async () => {
    const leadId = await makeLead("qualified", "75001", "+12145551201");
    const res = await processAssignment(deps, { tenantId, leadId, correlationId: "a1" });
    expect(res.primaryUserId).toBe(repA); // territory 750 matches
    expect(res.reason).toContain("territory");

    const db = getDb();
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.assignedUserId).toBe(repA);
    const assignments = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leadAssignments).where(eq(schema.leadAssignments.leadId, leadId)),
    );
    expect(assignments.some((a) => a.role === "primary" && a.userId === repA)).toBe(true);
  });

  it("schedules the SLA escalation ladder for a hot lead (delayed jobs)", async () => {
    enqueued.length = 0;
    const leadId = await makeLead("hot", "75002", "+12145551202");
    const res = await processAssignment(deps, { tenantId, leadId, correlationId: "a2" });
    expect(res.escalationScheduled).toBe(true);
    const escJobs = enqueued.filter((e) => e.queue === "escalation");
    expect(escJobs.length).toBeGreaterThanOrEqual(3);
    // Steps are scheduled with increasing delays.
    expect(escJobs.every((e) => (e.opts?.delay ?? 0) > 0)).toBe(true);
  });

  it("executes an escalation step when the lead is unacknowledged", async () => {
    const leadId = await makeLead("hot", "75003", "+12145551203");
    await processAssignment(deps, { tenantId, leadId, correlationId: "a3" });
    const res = await processEscalation(deps, { tenantId, leadId, stepIndex: 1, correlationId: "e3" });
    expect(res.status).toBe("executed");
  });

  it("cancels escalation once the lead is acknowledged", async () => {
    const leadId = await makeLead("hot", "75004", "+12145551204");
    await processAssignment(deps, { tenantId, leadId, correlationId: "a4" });
    await acknowledgeLead(getDb(), tenantId, leadId, repA, clockNow);
    const res = await processEscalation(deps, { tenantId, leadId, stepIndex: 2, correlationId: "e4" });
    expect(res.status).toBe("cancelled");
  });

  it("cancels escalation once the lead has moved on (e.g. booked)", async () => {
    const leadId = await makeLead("hot", "75005", "+12145551205");
    await processAssignment(deps, { tenantId, leadId, correlationId: "a5" });
    await withTenant(getDb(), { tenantId }, (tx) =>
      tx.update(schema.leads).set({ state: "booked" }).where(eq(schema.leads.id, leadId)),
    );
    const res = await processEscalation(deps, { tenantId, leadId, stepIndex: 3, correlationId: "e5" });
    expect(res.status).toBe("cancelled");
  });
});
