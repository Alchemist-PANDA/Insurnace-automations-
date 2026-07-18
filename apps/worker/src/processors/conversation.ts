import { eq, and, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { withTenant, schema, type Database } from "@stl/db";
import {
  evaluatePolicy,
  nextQuestion,
  isQualificationComplete,
  mergeAnswers,
  detectOptOut,
  assertTransition,
  roofingHvacQualificationSchema,
  type PolicyContext,
  type KnowledgeRef,
} from "@stl/core";
import { parseAgentTurn, type AgentTurn } from "@stl/llm";
import { QUEUE, type ConversationJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface ConversationResult {
  outcome:
    | "replied"
    | "qualified"
    | "handoff"
    | "opted_out"
    | "blocked"
    | "clarify";
  reply?: string;
  blockedCode?: string;
}

/**
 * Conversation orchestrator (plan: conversation-engine §1). Runs on a normal
 * inbound reply. The LLM proposes structured output; the deterministic policy
 * gate disposes. The model never sends, never touches consent, and can only
 * propose allowlisted actions.
 */
export async function processConversation(
  deps: WorkerDeps,
  job: ConversationJob,
): Promise<ConversationResult> {
  const { db, llm, clock } = deps;

  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    if (!lead) throw new Error(`lead ${job.leadId} not found`);

    const convo = await getConversation(tx, job.leadId);
    if (!convo || convo.aiPaused) {
      return { outcome: "handoff" as const };
    }

    // Conversation window (last several messages), oldest first.
    const window = await tx
      .select({
        direction: schema.messages.direction,
        body: schema.messages.body,
      })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, convo.id))
      .orderBy(desc(schema.messages.createdAt))
      .limit(10);
    const ordered = [...window].reverse();
    const lastInbound = [...ordered].reverse().find((m) => m.direction === "in");

    // Approved, in-window knowledge only.
    const knowledge = await loadApprovedKnowledge(tx, job.tenantId, clock.now());

    // Current qualification state.
    const qa = await getQualificationAnswers(tx, job.leadId);
    const answers = (qa?.answers as Record<string, unknown>) ?? {};
    const pending = nextQuestion(roofingHvacQualificationSchema, answers);

    // ── LLM call with structured output; one repair retry, then fallback. ──
    const system = buildSystemPrompt(knowledge, pending?.question ?? null);
    const messages = ordered.map((m) => ({
      role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
      content: m.body,
    }));

    const started = Date.now();
    let turn: AgentTurn | null = null;
    let rawResponse = "";
    for (let attempt = 0; attempt < 2 && !turn; attempt++) {
      const res = await llm.complete({
        system,
        messages,
        maxTokens: 500,
        temperature: 0.3,
      });
      rawResponse = res.raw;
      const parsed = parseAgentTurn(res.raw);
      if (parsed.ok) turn = parsed.turn;
    }
    const latencyMs = Date.now() - started;

    // Fallback when the model won't produce valid structured output.
    if (!turn) {
      await recordInteraction(tx, job, convo.id, system, rawResponse, null, { fallback: true }, latencyMs);
      return sendFallback(tx, deps, job, convo.id, lead.state);
    }

    // ── Deterministic intent handling — never left to the model. ──
    // Opt-out: re-run the deterministic detector on the actual inbound text.
    if (lastInbound && detectOptOut(lastInbound.body).isOptOut) {
      await recordInteraction(tx, job, convo.id, system, rawResponse, turn, { redirected: "opt_out" }, latencyMs);
      return { outcome: "opted_out" as const };
    }
    if (turn.detected_intents.includes("wants_human") || turn.detected_intents.includes("dissatisfied")) {
      await pauseForHuman(tx, deps, job, convo.id, lead.state, turn.internal_summary);
      await recordInteraction(tx, job, convo.id, system, rawResponse, turn, { redirected: "handoff" }, latencyMs);
      return { outcome: "handoff" as const };
    }

    // Merge extracted facts into structured qualification data.
    const mergedAnswers = mergeAnswers(answers, turn.extracted_facts);
    const complete = isQualificationComplete(roofingHvacQualificationSchema, mergedAnswers);
    await upsertQualification(tx, job.tenantId, job.leadId, mergedAnswers, complete);

    // ── Policy gate — the reply cannot ship without passing. ──
    const settings = await loadSettings(tx, job.tenantId);
    const consent = await currentConsent(tx, job.leadId);
    const suppressed = await isSuppressed(tx, lead.phoneE164);
    const policyCtx: PolicyContext = {
      channel: "sms",
      consent: { channel: "sms", status: consent },
      isSuppressed: suppressed,
      quietHours: {
        startHour: settings.quietHoursStart,
        endHour: settings.quietHoursEnd,
        timezone: settings.timezone,
      },
      clock,
      followUpsSentInWindow: 0,
      followUpCap: settings.followUpCap,
      deliveryLockout: false,
      approvedKnowledge: knowledge,
    };
    const verdict = evaluatePolicy(policyCtx, {
      action: "send_reply",
      replyText: turn.proposed_reply,
      knowledgeRefs: turn.knowledge_refs,
    });

    await recordInteraction(tx, job, convo.id, system, rawResponse, turn, verdict, latencyMs);

    if (!verdict.allowed) {
      // A rejected reply (e.g. unverified pricing) falls back to the approved
      // uncertainty response + a rep task — never the model's raw claim.
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        type: "message.blocked",
        correlationId: job.correlationId,
        payload: { code: verdict.code },
      });
      return sendFallback(tx, deps, job, convo.id, lead.state, verdict.code);
    }

    // Ship the approved reply through the outbox.
    await enqueueReply(tx, deps, job, convo.id, lead.phoneE164, turn.proposed_reply, "ai_reply");

    // Advance state: engaged → qualifying, or → qualified when complete.
    if (complete) {
      await transition(tx, job.leadId, lead.state, "qualified");
      await tx
        .update(schema.leads)
        .set({ qualifiedAt: clock.now() })
        .where(eq(schema.leads.id, job.leadId));
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        type: "lead.qualified",
        correlationId: job.correlationId,
        payload: { answers: mergedAnswers },
      });
      await audit(tx, {
        tenantId: job.tenantId,
        actorType: "ai",
        action: "lead.qualified",
        entityType: "lead",
        entityId: job.leadId,
        after: { answers: mergedAnswers },
        correlationId: job.correlationId,
      });
      // Hand off to routing/booking.
      await deps.enqueue(QUEUE.crmSync, `crm:${job.leadId}`, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        correlationId: job.correlationId,
      });
      return { outcome: "qualified" as const, reply: turn.proposed_reply };
    }

    if (lead.state === "engaged") {
      await transition(tx, job.leadId, lead.state, "qualifying");
    }
    return {
      outcome: turn.needs_clarification ? ("clarify" as const) : ("replied" as const),
      reply: turn.proposed_reply,
    };
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(knowledge: KnowledgeRef[], nextQ: string | null): string {
  // Knowledge is passed as approved reference material; lead messages are
  // treated as untrusted data. The real defense is structural (policy gate),
  // but we still instruct the model clearly.
  return [
    "You are a lead-qualification assistant for a home-services company.",
    "Answer ONLY from approved knowledge. If unsure, say a specialist will confirm.",
    "Never invent pricing, discounts, guarantees, or availability.",
    "Respond in JSON matching the AgentTurn schema. Keep replies under 320 characters.",
    nextQ ? `The next question to work toward: ${nextQ}` : "",
    `Approved knowledge entry ids available: ${knowledge.map((k) => k.id).join(", ") || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function getConversation(tx: Database, leadId: string) {
  const [c] = await tx
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.leadId, leadId))
    .limit(1);
  return c ?? null;
}

async function loadApprovedKnowledge(
  tx: Database,
  tenantId: string,
  now: Date,
): Promise<KnowledgeRef[]> {
  const rows = await tx
    .select({
      id: schema.knowledgeEntries.id,
      type: schema.knowledgeEntries.type,
      validFrom: schema.knowledgeEntries.validFrom,
      validUntil: schema.knowledgeEntries.validUntil,
    })
    .from(schema.knowledgeEntries)
    .where(
      and(
        eq(schema.knowledgeEntries.tenantId, tenantId),
        eq(schema.knowledgeEntries.approved, true),
      ),
    );
  // Deterministically exclude expired promotions etc.
  return rows
    .filter((r) => (!r.validFrom || r.validFrom <= now) && (!r.validUntil || r.validUntil >= now))
    .map((r) => ({ id: r.id, type: r.type as KnowledgeRef["type"] }));
}

async function getQualificationAnswers(tx: Database, leadId: string) {
  const [row] = await tx
    .select()
    .from(schema.qualificationAnswers)
    .where(eq(schema.qualificationAnswers.leadId, leadId))
    .limit(1);
  return row ?? null;
}

async function upsertQualification(
  tx: Database,
  tenantId: string,
  leadId: string,
  answers: Record<string, unknown>,
  complete: boolean,
) {
  await tx
    .insert(schema.qualificationAnswers)
    .values({ tenantId, leadId, schemaKey: roofingHvacQualificationSchema.key, answers, complete })
    .onConflictDoUpdate({
      target: schema.qualificationAnswers.leadId,
      set: { answers, complete, updatedAt: new Date() },
    });
}

async function enqueueReply(
  tx: Database,
  deps: WorkerDeps,
  job: ConversationJob,
  conversationId: string,
  to: string | null,
  body: string,
  templateKey: string,
) {
  const dedupeKey = `${templateKey}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const [message] = await tx
    .insert(schema.messages)
    .values({
      tenantId: job.tenantId,
      conversationId,
      direction: "out",
      channel: "sms",
      body,
      templateKey,
      dedupeKey,
      status: "queued",
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  if (!message) return; // duplicate reply suppressed
  const [outbox] = await tx
    .insert(schema.outbox)
    .values({
      tenantId: job.tenantId,
      aggregateType: "message",
      aggregateId: message.id,
      intentType: "sms.send",
      payload: { messageId: message.id, to, body, dedupeKey },
    })
    .returning({ id: schema.outbox.id });
  await deps.enqueue(QUEUE.messagingOut, `relay:${outbox!.id}`, {
    tenantId: job.tenantId,
    outboxId: outbox!.id,
    correlationId: job.correlationId,
  });
}

async function sendFallback(
  tx: Database,
  deps: WorkerDeps,
  job: ConversationJob,
  conversationId: string,
  state: string,
  code?: string,
): Promise<ConversationResult> {
  await enqueueReply(
    tx,
    deps,
    job,
    conversationId,
    null,
    "Thanks! A specialist will confirm that for you and follow up shortly.",
    "uncertainty",
  );
  await audit(tx, {
    tenantId: job.tenantId,
    actorType: "system",
    action: "conversation.fallback",
    entityType: "lead",
    entityId: job.leadId,
    after: { code: code ?? "parse_failure" },
    correlationId: job.correlationId,
  });
  void state;
  return { outcome: "blocked", blockedCode: code ?? "parse_failure" };
}

async function pauseForHuman(
  tx: Database,
  deps: WorkerDeps,
  job: ConversationJob,
  conversationId: string,
  state: string,
  summary: string,
) {
  await tx
    .update(schema.conversations)
    .set({ aiPaused: true })
    .where(eq(schema.conversations.id, conversationId));
  await transition(tx, job.leadId, state, "human_owned");
  await emitEvent(tx, {
    tenantId: job.tenantId,
    leadId: job.leadId,
    type: "human.takeover_started",
    correlationId: job.correlationId,
    payload: { summary, reason: "requested_or_dissatisfied" },
  });
  await audit(tx, {
    tenantId: job.tenantId,
    actorType: "ai",
    action: "human.handoff_suggested",
    entityType: "lead",
    entityId: job.leadId,
    after: { summary },
    correlationId: job.correlationId,
  });
  void deps;
}

async function transition(tx: Database, leadId: string, from: string, to: string) {
  if (from === to) return;
  assertTransition(from as never, to as never);
  await tx.update(schema.leads).set({ state: to }).where(eq(schema.leads.id, leadId));
}

async function recordInteraction(
  tx: Database,
  job: ConversationJob,
  conversationId: string,
  system: string,
  raw: string,
  parsed: AgentTurn | null,
  verdict: unknown,
  latencyMs: number,
) {
  await tx.insert(schema.aiInteractions).values({
    tenantId: job.tenantId,
    leadId: job.leadId,
    conversationId,
    promptHash: createHash("sha256").update(system).digest("hex"),
    rawResponse: raw,
    parsed: parsed as unknown as object,
    gateVerdict: verdict as object,
    latencyMs,
    correlationId: job.correlationId,
  });
}

async function loadSettings(tx: Database, tenantId: string) {
  const [s] = await tx
    .select()
    .from(schema.tenantSettings)
    .where(eq(schema.tenantSettings.tenantId, tenantId))
    .limit(1);
  const [t] = await tx
    .select({ timezone: schema.tenants.timezone })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  return {
    quietHoursStart: s?.quietHoursStart ?? 8,
    quietHoursEnd: s?.quietHoursEnd ?? 21,
    followUpCap: s?.followUpCap ?? 5,
    timezone: t?.timezone ?? "America/Chicago",
  };
}

async function currentConsent(
  tx: Database,
  leadId: string,
): Promise<"granted" | "revoked" | "unknown"> {
  const rows = await tx
    .select({ status: schema.consentRecords.status })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.leadId, leadId),
        eq(schema.consentRecords.channel, "sms"),
      ),
    )
    .orderBy(schema.consentRecords.capturedAt);
  return (rows[rows.length - 1]?.status as "granted" | "revoked" | "unknown") ?? "unknown";
}

async function isSuppressed(tx: Database, phone: string | null): Promise<boolean> {
  if (!phone) return true;
  const rows = await tx
    .select({ id: schema.suppressionEntries.id })
    .from(schema.suppressionEntries)
    .where(eq(schema.suppressionEntries.value, phone))
    .limit(1);
  return rows.length > 0;
}
