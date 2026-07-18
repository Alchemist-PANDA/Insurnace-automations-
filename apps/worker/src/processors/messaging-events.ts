import { eq, and, desc } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { detectOptOut, assertTransition } from "@stl/core";
import { isStatusNewer } from "@stl/messaging";
import { QUEUE, type MessagingEventJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface InboundResult {
  handled: "opted_out" | "recorded" | "help" | "no_lead";
  leadId?: string;
}

/**
 * Inbound + status processor (plan: architecture §6.3, compliance §1).
 *
 * The deterministic opt-out detector runs BEFORE any AI. On opt-out we revoke
 * consent, suppress the contact, cancel scheduled sends, and move the lead to
 * opted_out — all in one transaction. The conversation/qualification engine
 * (M6) plugs in where we currently just record the inbound message.
 */
export async function processMessagingEvent(
  deps: WorkerDeps,
  job: MessagingEventJob,
): Promise<InboundResult | { handled: "status" }> {
  if (job.kind === "status") {
    await processStatus(deps, job);
    return { handled: "status" };
  }
  return processInbound(deps, job);
}

async function processInbound(
  deps: WorkerDeps,
  job: MessagingEventJob,
): Promise<InboundResult> {
  const { db, clock } = deps;
  const body = String(job.payload.Body ?? "");
  const from = String(job.payload.From ?? "");
  const providerSid = String(job.payload.MessageSid ?? "");

  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.phoneE164, from))
      .orderBy(desc(schema.leads.createdAt))
      .limit(1);
    if (!lead) return { handled: "no_lead" as const };

    const convo = await ensureConversation(tx, job.tenantId, lead.id);

    // Record the inbound message (idempotent on providerSid via dedupeKey).
    await tx
      .insert(schema.messages)
      .values({
        tenantId: job.tenantId,
        conversationId: convo.id,
        direction: "in",
        channel: "sms",
        body,
        providerSid,
        dedupeKey: providerSid ? `in:${providerSid}` : null,
        status: "received",
      })
      .onConflictDoNothing();

    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId: lead.id,
      type: "message.received",
      correlationId: job.correlationId,
    });
    if (!lead.firstReplyAt) {
      await tx
        .update(schema.leads)
        .set({ firstReplyAt: clock.now() })
        .where(eq(schema.leads.id, lead.id));
    }

    // Deterministic opt-out — never delegated to the LLM.
    const optOut = detectOptOut(body);
    if (optOut.isOptOut) {
      await handleOptOut(tx, {
        tenantId: job.tenantId,
        leadId: lead.id,
        phone: from,
        state: lead.state,
        clock,
        correlationId: job.correlationId,
        matchedBy: optOut.matchedBy ?? "keyword",
      });
      return { handled: "opted_out" as const, leadId: lead.id };
    }

    if (optOut.isHelp) {
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: lead.id,
        type: "message.help_requested",
        correlationId: job.correlationId,
      });
      return { handled: "help" as const, leadId: lead.id };
    }

    // Normal reply. Move to engaged, then hand off to the conversation engine
    // for AI qualification (enqueued after the tx commits).
    if (lead.state === "contacted" || lead.state === "new") {
      await safeTransition(tx, lead.id, lead.state, "engaged");
    }
    await deps.enqueue(QUEUE.conversation, `conv:${lead.id}:${providerSid || Date.now()}`, {
      tenantId: job.tenantId,
      leadId: lead.id,
      correlationId: job.correlationId,
    });
    return { handled: "recorded" as const, leadId: lead.id };
  });
}

async function handleOptOut(
  tx: Database,
  args: {
    tenantId: string;
    leadId: string;
    phone: string;
    state: string;
    clock: WorkerDeps["clock"];
    correlationId: string;
    matchedBy: string;
  },
): Promise<void> {
  // 1. Revoke consent (append to ledger).
  await tx.insert(schema.consentRecords).values({
    tenantId: args.tenantId,
    leadId: args.leadId,
    channel: "sms",
    status: "revoked",
    revokedAt: args.clock.now(),
    revocationMethod: args.matchedBy,
  });

  // 2. Suppress the contact (tenant-level).
  await tx
    .insert(schema.suppressionEntries)
    .values({
      tenantId: args.tenantId,
      channel: "sms",
      value: args.phone,
      reason: `opt-out (${args.matchedBy})`,
    })
    .onConflictDoNothing();

  // 3. Cancel all pending scheduled sends for this lead (outbox rows for its
  // messages). This is the "STOP immediately blocks scheduled messages" rule.
  const convo = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.leadId, args.leadId))
    .limit(1);
  if (convo[0]) {
    const pendingMsgs = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, convo[0].id),
          eq(schema.messages.status, "queued"),
        ),
      );
    for (const m of pendingMsgs) {
      await tx
        .update(schema.outbox)
        .set({ status: "failed" }) // voided: never dispatched
        .where(
          and(
            eq(schema.outbox.aggregateId, m.id),
            eq(schema.outbox.status, "pending"),
          ),
        );
      await tx
        .update(schema.messages)
        .set({ status: "failed" })
        .where(eq(schema.messages.id, m.id));
    }
  }

  // 4. Transition to opted_out (terminal for automation).
  await safeTransition(tx, args.leadId, args.state, "opted_out");

  await emitEvent(tx, {
    tenantId: args.tenantId,
    leadId: args.leadId,
    type: "lead.opted_out",
    correlationId: args.correlationId,
    payload: { matchedBy: args.matchedBy },
  });
  await audit(tx, {
    tenantId: args.tenantId,
    actorType: "system",
    action: "lead.opted_out",
    entityType: "lead",
    entityId: args.leadId,
    after: { matchedBy: args.matchedBy },
    correlationId: args.correlationId,
  });
}

async function processStatus(deps: WorkerDeps, job: MessagingEventJob): Promise<void> {
  const { db } = deps;
  const sid = String(job.payload.MessageSid ?? "");
  const status = String(job.payload.MessageStatus ?? "sent");
  const errorCode = job.payload.ErrorCode ? String(job.payload.ErrorCode) : undefined;

  await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [msg] = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.providerSid, sid))
      .limit(1);
    if (!msg) return;

    // Out-of-order guard: never regress a later status with an earlier one.
    if (!isStatusNewer(status as never, msg.status as never)) return;

    await tx
      .update(schema.messages)
      .set({ status })
      .where(eq(schema.messages.id, msg.id));
    await tx.insert(schema.messageDeliveryEvents).values({
      tenantId: job.tenantId,
      messageId: msg.id,
      providerSid: sid,
      status,
      errorCode,
    });
  });
}

async function ensureConversation(tx: Database, tenantId: string, leadId: string) {
  const existing = await tx
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.leadId, leadId))
    .limit(1);
  if (existing[0]) return existing[0];
  const [created] = await tx
    .insert(schema.conversations)
    .values({ tenantId, leadId, channel: "sms" })
    .returning();
  return created!;
}

async function safeTransition(
  tx: Database,
  leadId: string,
  from: string,
  to: string,
): Promise<void> {
  assertTransition(from as never, to as never);
  await tx.update(schema.leads).set({ state: to }).where(eq(schema.leads.id, leadId));
}
