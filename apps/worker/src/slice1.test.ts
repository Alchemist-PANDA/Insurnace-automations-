import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { FakeSmsChannel } from "@stl/messaging";
import { randomUUID, createHash } from "node:crypto";
import { makeDeps, type WorkerDeps } from "./deps.js";
import { processIngest } from "./processors/ingest.js";
import { processFirstTouch } from "./processors/first-touch.js";
import { processMessagingOut } from "./processors/relay.js";
import { processMessagingEvent } from "./processors/messaging-events.js";
import { roofingHvacFirstTouchTemplate } from "@stl/core";

/**
 * Slice 1 end-to-end (plan: PLAN.md Slice 1, testing §3):
 * generic webhook → lead record → scoring → Twilio SMS → inbound reply →
 * conversation timeline. Plus the compliance proofs: idempotency (#1, #3) and
 * STOP suppression (#4). Drives processors in sequence with an in-memory
 * enqueue collector and a FakeSmsChannel, against real Postgres.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

interface Enqueued {
  queue: string;
  jobId: string;
  data: unknown;
}

d("Slice 1: webhook → lead → SMS → reply → timeline", () => {
  const tenantId = randomUUID();
  let sourceId: string;
  const clockNow = new Date("2026-07-17T16:00:00Z"); // 11:00 CDT — inside quiet hours
  const sms = new FakeSmsChannel();
  const enqueued: Enqueued[] = [];
  let deps: WorkerDeps;

  beforeAll(async () => {
    const db = getDb();
    deps = makeDeps({
      db,
      sms,
      clock: { now: () => clockNow },
      enqueue: async (queue, jobId, data) => {
        enqueued.push({ queue, jobId, data });
      },
    });

    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({
        id: tenantId,
        name: "Summit Roofing",
        slug: `summit-${tenantId.slice(0, 8)}`,
      });
      await tx.insert(schema.tenantSettings).values({
        tenantId,
        businessName: "Summit Roofing",
        agentName: "Ava",
      });
      await tx.insert(schema.messageTemplates).values({
        tenantId,
        key: "first_touch",
        body: roofingHvacFirstTouchTemplate,
      });
      const [src] = await tx
        .insert(schema.leadSources)
        .values({
          tenantId,
          key: "web",
          name: "Web Form",
          signingSecret: "s",
          mapping: { name: "full_name", phone: "phone", city: "city", service: "service" },
        })
        .returning({ id: schema.leadSources.id });
      sourceId = src!.id;
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function ingestWebhook(payload: Record<string, unknown>, idem?: string) {
    const db = getDb();
    const idempotencyKey =
      idem ?? createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const rawId = await withTenant(db, { tenantId }, async (tx) => {
      const [raw] = await tx
        .insert(schema.rawWebhooks)
        .values({ tenantId, sourceId, payload })
        .returning({ id: schema.rawWebhooks.id });
      await tx
        .insert(schema.ingestIdempotency)
        .values({ tenantId, sourceId, idempotencyKey })
        .onConflictDoNothing();
      return raw!.id;
    });
    return processIngest(deps, {
      tenantId,
      sourceId,
      rawWebhookId: rawId,
      idempotencyKey,
      correlationId: `cid_${randomUUID()}`,
    });
  }

  it("creates exactly one scored lead and enqueues first-touch (accept #1)", async () => {
    const res = await ingestWebhook({
      full_name: "Sarah Connor",
      phone: "+12145550142",
      city: "Dallas",
      service: "roof_replacement",
      sms_consent: true,
    });

    expect(res.action).toBe("create");
    expect(res.leadId).toBeTruthy();
    expect(res.band).not.toBe("unqualified");
    expect(res.enqueuedFirstTouch).toBe(true);

    const db = getDb();
    const leads = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.phoneE164, "+12145550142")),
    );
    expect(leads).toHaveLength(1);
    expect(leads[0]!.scoreCurrent).toBeGreaterThan(0);
    expect(leads[0]!.scoreBand).toBeTruthy();
  });

  it("does not create a duplicate lead on a repeated submission (accept #1/#3)", async () => {
    await ingestWebhook({
      full_name: "Sarah Connor",
      phone: "+12145550142",
      city: "Dallas",
      service: "roof_replacement",
      sms_consent: true,
    });
    const db = getDb();
    const leads = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.phoneE164, "+12145550142")),
    );
    expect(leads).toHaveLength(1); // merged, not duplicated
  });

  it("sends exactly one personalized first-touch SMS via the outbox (accept #2)", async () => {
    const leadId = await getLeadId("+12145550142");
    const ft = await processFirstTouch(deps, {
      tenantId,
      leadId,
      correlationId: "cid_ft",
    });
    expect(ft.status).toBe("sent_queued");

    // Relay the outbox row.
    const relayJob = enqueued.find((e) => e.queue === "messaging-out");
    expect(relayJob).toBeTruthy();
    const relay = await processMessagingOut(deps, relayJob!.data as never);
    expect(relay.status).toBe("sent");

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.body).toContain("Sarah");
    expect(sms.sent[0]!.body).toContain("Summit Roofing");

    // Lead advanced to contacted; message recorded as sent.
    const db = getDb();
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("contacted");
    expect(lead!.firstTouchAt).toBeTruthy();
  });

  it("does not resend the first-touch when the job is retried (accept #3)", async () => {
    const leadId = await getLeadId("+12145550142");
    const retry = await processFirstTouch(deps, { tenantId, leadId, correlationId: "cid_ft2" });
    expect(retry.status).toBe("duplicate");
    expect(sms.sent).toHaveLength(1); // still one send
  });

  it("records an inbound reply on the conversation timeline (accept #5)", async () => {
    const res = (await processMessagingEvent(deps, {
      tenantId,
      kind: "inbound",
      payload: { From: "+12145550142", Body: "Yes, I have an active leak!", MessageSid: "SM_reply1" },
      correlationId: "cid_in",
    })) as { handled: string; leadId?: string };
    expect(res.handled).toBe("recorded");

    const db = getDb();
    const leadId = await getLeadId("+12145550142");
    const convo = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.leadId, leadId)),
    );
    const msgs = await withTenant(db, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, convo[0]!.id))
        .orderBy(schema.messages.createdAt),
    );
    // outbound first-touch + inbound reply
    expect(msgs.map((m) => m.direction)).toEqual(["out", "in"]);
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("engaged");
    expect(lead!.firstReplyAt).toBeTruthy();
  });

  it("STOP immediately opts out, suppresses, and blocks future sends (accept #4)", async () => {
    // A fresh lead so we can queue a pending message then STOP it.
    await ingestWebhook({
      full_name: "Optout Tester",
      phone: "+12145557777",
      city: "Plano",
      service: "roof_repair",
      sms_consent: true,
    });
    const leadId = await getLeadId("+12145557777");

    const stop = (await processMessagingEvent(deps, {
      tenantId,
      kind: "inbound",
      payload: { From: "+12145557777", Body: "STOP", MessageSid: "SM_stop1" },
      correlationId: "cid_stop",
    })) as { handled: string };
    expect(stop.handled).toBe("opted_out");

    const db = getDb();
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("opted_out");

    // Suppression written.
    const supp = await withTenant(db, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.suppressionEntries)
        .where(eq(schema.suppressionEntries.value, "+12145557777")),
    );
    expect(supp).toHaveLength(1);

    // Consent revoked (latest record).
    const consents = await withTenant(db, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.consentRecords)
        .where(
          and(
            eq(schema.consentRecords.leadId, leadId),
            eq(schema.consentRecords.channel, "sms"),
          ),
        )
        .orderBy(schema.consentRecords.capturedAt),
    );
    expect(consents[consents.length - 1]!.status).toBe("revoked");

    // A first-touch attempt after opt-out is blocked by the policy gate.
    const blocked = await processFirstTouch(deps, {
      tenantId,
      leadId,
      correlationId: "cid_blocked",
    });
    expect(blocked.status).toBe("blocked");
  });

  it("writes an audit entry for every automated action (accept #11)", async () => {
    const db = getDb();
    const audits = await withTenant(db, { tenantId }, (tx) =>
      tx.select({ action: schema.auditLogs.action }).from(schema.auditLogs),
    );
    const actions = new Set(audits.map((a) => a.action));
    expect(actions.has("lead.ingested")).toBe(true);
    expect(actions.has("first_touch.queued")).toBe(true);
    expect(actions.has("lead.opted_out")).toBe(true);
  });

  async function getLeadId(phone: string): Promise<string> {
    const db = getDb();
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select({ id: schema.leads.id }).from(schema.leads).where(eq(schema.leads.phoneE164, phone)),
    );
    return lead!.id;
  }
});
