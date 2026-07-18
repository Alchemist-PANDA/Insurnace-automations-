import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { FakeSmsChannel } from "@stl/messaging";
import { FakeLlm } from "@stl/llm";
import { randomUUID } from "node:crypto";
import { makeDeps, type WorkerDeps } from "./deps.js";
import { processConversation } from "./processors/conversation.js";

/**
 * Conversation engine (plan: conversation-engine.md, MVP acceptance #6,#13,#14).
 * Proves: structured extraction saved, unverified pricing blocked, human
 * handoff pauses AI, malformed output falls back — never the model's raw claim.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("conversation orchestrator", () => {
  const tenantId = randomUUID();
  const clockNow = new Date("2026-07-17T16:00:00Z");
  let sms: FakeSmsChannel;
  let llm: FakeLlm;
  let deps: WorkerDeps;
  const enqueued: { queue: string; data: unknown }[] = [];

  beforeAll(async () => {
    const db = getDb();
    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({
        id: tenantId,
        name: "Summit",
        slug: `s-${tenantId.slice(0, 8)}`,
      });
      await tx.insert(schema.tenantSettings).values({ tenantId, businessName: "Summit", agentName: "Ava" });
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    sms = new FakeSmsChannel();
    llm = new FakeLlm();
    enqueued.length = 0;
    deps = makeDeps({
      db: getDb(),
      sms,
      llm,
      clock: { now: () => clockNow },
      enqueue: async (queue, _jobId, data) => {
        enqueued.push({ queue, data });
      },
    });
  });

  async function seedLead(over: { granted?: boolean } = {}): Promise<string> {
    const db = getDb();
    return withTenant(db, { tenantId }, async (tx) => {
      const [lead] = await tx
        .insert(schema.leads)
        .values({
          tenantId,
          state: "engaged",
          firstName: "Sarah",
          phoneE164: `+1214555${Math.floor(1000 + Math.random() * 8999)}`,
          city: "Dallas",
          serviceRequested: "roof_replacement",
        })
        .returning({ id: schema.leads.id });
      const leadId = lead!.id;
      const [c] = await tx
        .insert(schema.conversations)
        .values({ tenantId, leadId, channel: "sms" })
        .returning({ id: schema.conversations.id });
      // An inbound message so the window has a lead turn.
      await tx.insert(schema.messages).values({
        tenantId,
        conversationId: c!.id,
        direction: "in",
        channel: "sms",
        body: "Yes, storm damage on a single family home in Dallas",
        status: "received",
      });
      await tx.insert(schema.consentRecords).values({
        tenantId,
        leadId,
        channel: "sms",
        status: over.granted === false ? "unknown" : "granted",
      });
      return leadId;
    });
  }

  it("extracts structured qualification facts and saves them (accept #6)", async () => {
    const leadId = await seedLead();
    llm.scriptTurn({
      extracted_facts: {
        service: "roof_replacement",
        urgency: "high",
        property_type: "single_family",
        location_confirmed: true,
      },
      detected_intents: [],
      proposed_reply: "Thanks Sarah — would you like to book a free inspection?",
    });

    const res = await processConversation(deps, { tenantId, leadId, correlationId: "c1" });
    expect(res.outcome).toMatch(/replied|qualified|clarify/);

    const db = getDb();
    const [qa] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.qualificationAnswers).where(eq(schema.qualificationAnswers.leadId, leadId)),
    );
    expect(qa!.answers).toMatchObject({ service: "roof_replacement", urgency: "high" });
    // The reply is written to an outbound message + outbox intent; the relay
    // ships it in a separate step, so a relay job was enqueued here.
    expect(enqueued.some((e) => e.queue === "messaging-out")).toBe(true);
  });

  it("blocks an unverified pricing claim; ships the uncertainty reply instead (accept #14)", async () => {
    const leadId = await seedLead();
    llm.scriptTurn({
      proposed_reply: "A full roof replacement will cost you exactly $9,999.",
      detected_intents: ["question_pricing"],
    });

    const res = await processConversation(deps, { tenantId, leadId, correlationId: "c2" });
    expect(res.outcome).toBe("blocked");
    expect(res.blockedCode).toBe("unverified_claim");

    // The outbound message that got queued is the approved uncertainty text,
    // NOT the model's invented price.
    const db = getDb();
    const msgs = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.tenantId, tenantId)),
    );
    const outbound = msgs.filter((m) => m.direction === "out");
    expect(outbound.some((m) => m.body.includes("$9,999"))).toBe(false);
    expect(outbound.some((m) => m.templateKey === "uncertainty")).toBe(true);
  });

  it("allows a pricing reply backed by approved knowledge", async () => {
    const leadId = await seedLead();
    const db = getDb();
    const kId = await withTenant(db, { tenantId }, async (tx) => {
      const [k] = await tx
        .insert(schema.knowledgeEntries)
        .values({
          tenantId,
          type: "pricing_guidance",
          title: "Roof pricing",
          content: "Replacements typically run $8,000-$15,000.",
          approved: true,
        })
        .returning({ id: schema.knowledgeEntries.id });
      return k!.id;
    });
    llm.scriptTurn({
      proposed_reply: "Roof replacements typically run $8,000-$15,000 depending on scope.",
      detected_intents: ["question_pricing"],
      knowledge_refs: [kId],
    });

    const res = await processConversation(deps, { tenantId, leadId, correlationId: "c3" });
    expect(res.outcome).not.toBe("blocked");
  });

  it("pauses AI and hands off when the lead asks for a human (accept #13 boundary)", async () => {
    const leadId = await seedLead();
    llm.scriptTurn({
      proposed_reply: "Sure, connecting you now.",
      detected_intents: ["wants_human"],
    });
    const res = await processConversation(deps, { tenantId, leadId, correlationId: "c4" });
    expect(res.outcome).toBe("handoff");

    const db = getDb();
    const [c] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.leadId, leadId)),
    );
    expect(c!.aiPaused).toBe(true);
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("human_owned");
  });

  it("falls back safely on malformed model output", async () => {
    const leadId = await seedLead();
    llm.script("this is not json", "still not json"); // both attempts fail
    const res = await processConversation(deps, { tenantId, leadId, correlationId: "c5" });
    expect(res.outcome).toBe("blocked");
    expect(res.blockedCode).toBe("parse_failure");
  });

  it("marks the lead qualified and enqueues CRM sync when the schema completes", async () => {
    const leadId = await seedLead();
    llm.scriptTurn({
      extracted_facts: {
        service: "roof_replacement",
        urgency: "high",
        property_type: "single_family",
        location_confirmed: true,
        appointment_intent: true,
      },
      detected_intents: ["wants_appointment"],
      proposed_reply: "Great — I have a couple of inspection times to offer.",
    });
    const res = await processConversation(deps, { tenantId, leadId, correlationId: "c6" });
    expect(res.outcome).toBe("qualified");

    const db = getDb();
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("qualified");
    expect(lead!.qualifiedAt).toBeTruthy();
    expect(enqueued.some((e) => e.queue === "crm-sync")).toBe(true);
  });

  it("records an ai_interactions row for every model call (audit)", async () => {
    const leadId = await seedLead();
    llm.scriptTurn({ proposed_reply: "Thanks!" });
    await processConversation(deps, { tenantId, leadId, correlationId: "c7" });
    const db = getDb();
    const rows = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.aiInteractions).where(eq(schema.aiInteractions.leadId, leadId)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
