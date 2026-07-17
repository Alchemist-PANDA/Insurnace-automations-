import { eq, and } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import {
  renderTemplate,
  evaluatePolicy,
  assertTransition,
  type PolicyContext,
} from "@stl/core";
import type { FirstTouchJob } from "@stl/queue";
import { QUEUE } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface FirstTouchResult {
  status: "sent_queued" | "blocked" | "duplicate";
  reason?: string;
  outboxId?: string;
}

/**
 * First-touch composer (plan: architecture §6.2, blueprint §5C). Renders the
 * personalized opener, runs the deterministic policy gate, and writes the
 * message + outbox intent + state change in ONE transaction. The unique
 * dedupe_key constraint guarantees no duplicate first message under retries.
 */
export async function processFirstTouch(
  deps: WorkerDeps,
  job: FirstTouchJob,
): Promise<FirstTouchResult> {
  const { db, clock } = deps;

  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    if (!lead) throw new Error(`lead ${job.leadId} not found`);

    // Idempotency: if the first-touch message already exists, stop. Scoped to
    // the outbound first_touch specifically — an inbound reply in the same
    // conversation must NOT masquerade as a prior first-touch (which would let
    // an opted-out lead skip the policy gate).
    const convo = await ensureConversation(tx, job.tenantId, job.leadId);
    const existing = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, convo.id),
          eq(schema.messages.dedupeKey, `first_touch:${job.leadId}`),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return { status: "duplicate" as const };
    }

    const settings = await loadSettings(tx, job.tenantId);
    const consent = await currentConsent(tx, job.leadId, "sms");
    const suppressed = await isSuppressed(tx, job.tenantId, lead.phoneE164);

    // Render the opener.
    const template = await loadTemplate(tx, job.tenantId);
    const { text } = renderTemplate(template, {
      firstName: lead.firstName ?? "there",
      agentName: settings.agentName,
      businessName: settings.businessName,
      serviceLabel: serviceLabel(lead.serviceRequested),
      city: lead.city ?? "your area",
    });

    // Deterministic policy gate — nothing reaches a lead without passing.
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
      approvedKnowledge: [],
    };
    const verdict = evaluatePolicy(policyCtx, { action: "send_reply", replyText: text });

    if (!verdict.allowed) {
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        type: "message.blocked",
        correlationId: job.correlationId,
        payload: { code: verdict.code, reason: verdict.reason },
      });
      await audit(tx, {
        tenantId: job.tenantId,
        actorType: "system",
        action: "first_touch.blocked",
        entityType: "lead",
        entityId: job.leadId,
        after: { code: verdict.code },
        correlationId: job.correlationId,
      });
      return { status: "blocked" as const, reason: verdict.code };
    }

    // Transactional outbox: message (queued) + outbox intent + state change,
    // all atomic. dedupe_key makes the message insert the idempotency anchor.
    const dedupeKey = `first_touch:${job.leadId}`;
    const [message] = await tx
      .insert(schema.messages)
      .values({
        tenantId: job.tenantId,
        conversationId: convo.id,
        direction: "out",
        channel: "sms",
        body: text,
        templateKey: "first_touch",
        dedupeKey,
        status: "queued",
        policySnapshot: { scheduledFor: verdict.scheduledFor },
      })
      .returning({ id: schema.messages.id });

    const [outbox] = await tx
      .insert(schema.outbox)
      .values({
        tenantId: job.tenantId,
        aggregateType: "message",
        aggregateId: message!.id,
        intentType: "sms.send",
        payload: { messageId: message!.id, to: lead.phoneE164, body: text, dedupeKey },
      })
      .returning({ id: schema.outbox.id });

    assertTransition(lead.state as never, "contacted");
    await tx
      .update(schema.leads)
      .set({ state: "contacted", firstTouchAt: clock.now(), updatedAt: clock.now() })
      .where(eq(schema.leads.id, job.leadId));

    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId: job.leadId,
      type: "message.requested",
      correlationId: job.correlationId,
      payload: { messageId: message!.id },
    });
    await audit(tx, {
      tenantId: job.tenantId,
      actorType: "system",
      action: "first_touch.queued",
      entityType: "message",
      entityId: message!.id,
      correlationId: job.correlationId,
    });

    // Hand the outbox row to the relay.
    await deps.enqueue(QUEUE.messagingOut, `relay:${outbox!.id}`, {
      tenantId: job.tenantId,
      outboxId: outbox!.id,
      correlationId: job.correlationId,
    });

    return { status: "sent_queued" as const, outboxId: outbox!.id };
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
    businessName: s?.businessName || "our team",
    agentName: s?.agentName || "Ava",
    quietHoursStart: s?.quietHoursStart ?? 8,
    quietHoursEnd: s?.quietHoursEnd ?? 21,
    followUpCap: s?.followUpCap ?? 5,
    timezone: t?.timezone ?? "America/Chicago",
  };
}

async function loadTemplate(tx: Database, tenantId: string): Promise<string> {
  const [tpl] = await tx
    .select({ body: schema.messageTemplates.body })
    .from(schema.messageTemplates)
    .where(eq(schema.messageTemplates.tenantId, tenantId))
    .limit(1);
  return (
    tpl?.body ??
    "Hi {{firstName}}, this is {{agentName}} from {{businessName}}. How can we help?"
  );
}

async function currentConsent(
  tx: Database,
  leadId: string,
  channel: string,
): Promise<"granted" | "revoked" | "unknown"> {
  const rows = await tx
    .select({ status: schema.consentRecords.status })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.leadId, leadId),
        eq(schema.consentRecords.channel, channel),
      ),
    )
    .orderBy(schema.consentRecords.capturedAt);
  const last = rows[rows.length - 1];
  return (last?.status as "granted" | "revoked" | "unknown") ?? "unknown";
}

async function isSuppressed(
  tx: Database,
  tenantId: string,
  phone: string | null,
): Promise<boolean> {
  if (!phone) return true;
  const rows = await tx
    .select({ id: schema.suppressionEntries.id })
    .from(schema.suppressionEntries)
    .where(eq(schema.suppressionEntries.value, phone))
    .limit(1);
  void tenantId;
  return rows.length > 0;
}

function serviceLabel(service: string | null): string {
  if (!service) return "your project";
  return service.replace(/_/g, " ");
}
