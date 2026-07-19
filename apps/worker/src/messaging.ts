import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, type Database } from "@stl/db";
import {
  renderTemplate,
  evaluatePolicy,
  type PolicyContext,
  type Clock,
} from "@stl/core";
import { QUEUE } from "@stl/queue";
import { emitEvent } from "./events.js";
import type { WorkerDeps } from "./deps.js";

/**
 * Shared outbound-message pipeline (plan: architecture §5.3, conversation-engine
 * §3). Every automated send — first-touch, AI reply, and follow-up workflow
 * steps — goes through this one path: render → deterministic policy gate →
 * transactional outbox → relay. This is what makes "the follow-up engine sends"
 * true AND compliant: nothing reaches a lead without clearing the gate.
 *
 * Runs inside the caller's transaction (tx) so the message + outbox intent are
 * atomic with whatever domain change triggered them.
 */
export interface ComposeArgs {
  tx: Database;
  deps: WorkerDeps;
  tenantId: string;
  leadId: string;
  conversationId: string;
  channel: "sms" | "email";
  /** Template key to render, or a literal body when `body` is given. */
  templateKey: string;
  body?: string;
  /** Distinguishes this message for the unique dedupe constraint. */
  dedupeScope: string;
  correlationId: string;
  followUpsSentInWindow?: number;
}

export type ComposeResult =
  | { status: "queued"; messageId: string; outboxId: string }
  | { status: "blocked"; code: string }
  | { status: "duplicate" };

export async function composeAndEnqueue(args: ComposeArgs): Promise<ComposeResult> {
  const { tx, deps, tenantId, leadId, conversationId } = args;

  const [lead] = await tx
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.id, leadId))
    .limit(1);
  if (!lead) throw new Error(`lead ${leadId} not found`);

  // Render the body (from a template unless a literal was supplied).
  let body = args.body ?? "";
  if (!body) {
    const settings = await loadSettings(tx, tenantId, deps.clock);
    const tpl = await loadTemplate(tx, tenantId, args.templateKey, args.channel);
    body = renderTemplate(tpl, {
      firstName: lead.firstName ?? "there",
      agentName: settings.agentName,
      businessName: settings.businessName,
      serviceLabel: (lead.serviceRequested ?? "your project").replace(/_/g, " "),
      city: lead.city ?? "your area",
    }).text;
  }

  // Deterministic policy gate — consent, suppression, quiet hours, caps.
  const settings = await loadSettings(tx, tenantId, deps.clock);
  const consent = await currentConsent(tx, leadId, args.channel);
  const suppressed = await isSuppressed(tx, contactFor(lead, args.channel));
  const ctx: PolicyContext = {
    channel: args.channel,
    consent: { channel: args.channel, status: consent },
    isSuppressed: suppressed,
    quietHours: {
      startHour: settings.quietHoursStart,
      endHour: settings.quietHoursEnd,
      timezone: settings.timezone,
    },
    clock: deps.clock,
    followUpsSentInWindow: args.followUpsSentInWindow ?? 0,
    followUpCap: settings.followUpCap,
    deliveryLockout: false,
    approvedKnowledge: [],
  };
  const verdict = evaluatePolicy(ctx, { action: "send_reply", replyText: body });
  if (!verdict.allowed) {
    await emitEvent(tx, {
      tenantId,
      leadId,
      type: "message.blocked",
      correlationId: args.correlationId,
      payload: { code: verdict.code, templateKey: args.templateKey },
    });
    return { status: "blocked", code: verdict.code };
  }

  // Transactional outbox: unique dedupe key prevents a retried step from
  // sending twice.
  const dedupeKey = `${args.dedupeScope}:${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;
  const [message] = await tx
    .insert(schema.messages)
    .values({
      tenantId,
      conversationId,
      direction: "out",
      channel: args.channel,
      body,
      templateKey: args.templateKey,
      dedupeKey,
      status: "queued",
      policySnapshot: { scheduledFor: verdict.scheduledFor },
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  if (!message) return { status: "duplicate" };

  const [outbox] = await tx
    .insert(schema.outbox)
    .values({
      tenantId,
      aggregateType: "message",
      aggregateId: message.id,
      intentType: `${args.channel}.send`,
      payload: {
        messageId: message.id,
        to: contactFor(lead, args.channel),
        body,
        dedupeKey,
      },
    })
    .returning({ id: schema.outbox.id });

  await emitEvent(tx, {
    tenantId,
    leadId,
    type: "message.requested",
    correlationId: args.correlationId,
    payload: { messageId: message.id, templateKey: args.templateKey },
  });

  await deps.enqueue(QUEUE.messagingOut, `relay:${outbox!.id}`, {
    tenantId,
    outboxId: outbox!.id,
    correlationId: args.correlationId,
  });

  return { status: "queued", messageId: message.id, outboxId: outbox!.id };
}

function contactFor(
  lead: { phoneE164: string | null; emailNormalized: string | null },
  channel: "sms" | "email",
): string | null {
  return channel === "email" ? lead.emailNormalized : lead.phoneE164;
}

async function loadSettings(tx: Database, tenantId: string, _clock: Clock) {
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

async function loadTemplate(
  tx: Database,
  tenantId: string,
  key: string,
  channel: string,
): Promise<string> {
  const [tpl] = await tx
    .select({ body: schema.messageTemplates.body })
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.tenantId, tenantId), eq(schema.messageTemplates.key, key)))
    .limit(1);
  void channel;
  return (
    tpl?.body ??
    "Hi {{firstName}}, this is {{agentName}} from {{businessName}} — just following up. Reply STOP to opt out."
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
    .where(and(eq(schema.consentRecords.leadId, leadId), eq(schema.consentRecords.channel, channel)))
    .orderBy(schema.consentRecords.capturedAt);
  return (rows[rows.length - 1]?.status as "granted" | "revoked" | "unknown") ?? "unknown";
}

async function isSuppressed(tx: Database, contact: string | null): Promise<boolean> {
  if (!contact) return true;
  const rows = await tx
    .select({ id: schema.suppressionEntries.id })
    .from(schema.suppressionEntries)
    .where(eq(schema.suppressionEntries.value, contact))
    .limit(1);
  return rows.length > 0;
}
