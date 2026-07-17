import { eq } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import type { MessagingOutJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent } from "../events.js";

export interface RelayResult {
  status: "sent" | "already_dispatched" | "failed";
  providerSid?: string;
  errorCode?: string;
}

/**
 * Outbox relay (plan: architecture §5.3 transactional outbox). Reads a pending
 * outbox row, sends via the channel adapter, and records the result. Safe under
 * retries: a dispatched row is never sent again, and the channel's dedupeKey is
 * the provider-side backstop.
 */
export async function processMessagingOut(
  deps: WorkerDeps,
  job: MessagingOutJob,
): Promise<RelayResult> {
  const { db, sms } = deps;

  const outboxRow = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.id, job.outboxId))
      .limit(1);
    return row ?? null;
  });

  if (!outboxRow) throw new Error(`outbox ${job.outboxId} not found`);
  if (outboxRow.status === "dispatched") {
    return { status: "already_dispatched" };
  }

  const payload = outboxRow.payload as {
    messageId: string;
    to: string;
    body: string;
    dedupeKey: string;
  };
  const sender = await loadSender(db, job.tenantId);

  // Provider call happens OUTSIDE the transaction (no long-held locks / no
  // network inside a tx). Idempotency comes from dedupeKey + status guard.
  const result = await sms.send({
    tenantSender: { sender },
    to: payload.to,
    body: payload.body,
    dedupeKey: payload.dedupeKey,
    correlationId: job.correlationId,
  });

  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    if (result.ok) {
      await tx
        .update(schema.messages)
        .set({ status: "sent", providerSid: result.providerSid })
        .where(eq(schema.messages.id, payload.messageId));
      await tx
        .update(schema.outbox)
        .set({ status: "dispatched", attempts: outboxRow.attempts + 1 })
        .where(eq(schema.outbox.id, job.outboxId));
      await tx.insert(schema.messageDeliveryEvents).values({
        tenantId: job.tenantId,
        messageId: payload.messageId,
        providerSid: result.providerSid,
        status: "sent",
      });
      await emitMessageEvent(tx, job.tenantId, payload.messageId, "message.sent", job.correlationId);
      return { status: "sent" as const, providerSid: result.providerSid };
    }

    // Failure. Retryable errors bubble up (throw) so BullMQ retries; terminal
    // errors mark the message failed and are visible in the DLQ view.
    if (result.retryable) {
      await tx
        .update(schema.outbox)
        .set({ status: "failed", attempts: outboxRow.attempts + 1 })
        .where(eq(schema.outbox.id, job.outboxId));
      throw new Error(`retryable send failure: ${result.code} ${result.message}`);
    }

    await tx
      .update(schema.messages)
      .set({ status: "failed" })
      .where(eq(schema.messages.id, payload.messageId));
    await tx
      .update(schema.outbox)
      .set({ status: "failed", attempts: outboxRow.attempts + 1 })
      .where(eq(schema.outbox.id, job.outboxId));
    await tx.insert(schema.messageDeliveryEvents).values({
      tenantId: job.tenantId,
      messageId: payload.messageId,
      status: "failed",
      errorCode: result.code,
    });
    await emitMessageEvent(tx, job.tenantId, payload.messageId, "message.failed", job.correlationId);
    return { status: "failed" as const, errorCode: result.code };
  });
}

async function emitMessageEvent(
  tx: Database,
  tenantId: string,
  messageId: string,
  type: string,
  correlationId: string,
) {
  const [msg] = await tx
    .select({ conversationId: schema.messages.conversationId })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  if (!msg) return;
  const [convo] = await tx
    .select({ leadId: schema.conversations.leadId })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, msg.conversationId))
    .limit(1);
  if (!convo) return;
  await emitEvent(tx, { tenantId, leadId: convo.leadId, type, correlationId, payload: { messageId } });
}

async function loadSender(db: Database, tenantId: string): Promise<string> {
  // Slice 1: a single tenant sender. Real per-tenant sender config lands with
  // the integrations screen. Fall back to a dev messaging service sid.
  void db;
  void tenantId;
  return process.env.TWILIO_MESSAGING_SERVICE_SID || "MG_dev_sender";
}
