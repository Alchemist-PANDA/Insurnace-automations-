import { eq, and, inArray } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { assertTransition } from "@stl/core";
import { emitEvent, audit } from "../events.js";

/**
 * Human takeover (plan: blueprint §5I, PLAN M8). One-click takeover pauses the
 * AI, stops running follow-up workflows, and moves the lead to human_owned.
 * Resume re-enables automation. These are called from the API layer.
 */
export async function takeoverLead(
  db: Database,
  args: { tenantId: string; leadId: string; userId: string; now: Date },
): Promise<{ ok: boolean; reason?: string }> {
  return withTenant(db, { tenantId: args.tenantId }, async (tx) => {
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, args.leadId))
      .limit(1);
    if (!lead) return { ok: false, reason: "lead not found" };
    if (lead.state === "opted_out") return { ok: false, reason: "lead opted out" };

    // Pause AI on the conversation.
    await tx
      .update(schema.conversations)
      .set({ aiPaused: true })
      .where(eq(schema.conversations.leadId, args.leadId));

    // Stop any running follow-up workflows.
    await tx
      .update(schema.workflowRuns)
      .set({ status: "stopped", stopReason: "human_takeover", endedAt: args.now })
      .where(
        and(
          eq(schema.workflowRuns.leadId, args.leadId),
          eq(schema.workflowRuns.status, "running"),
        ),
      );

    // Record the previous state so resume can restore it.
    if (lead.state !== "human_owned") {
      assertTransition(lead.state as never, "human_owned");
      await tx
        .update(schema.leads)
        .set({
          state: "human_owned",
          customFields: { ...(lead.customFields as object), preTakeoverState: lead.state },
        })
        .where(eq(schema.leads.id, args.leadId));
    }

    await emitEvent(tx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      type: "human.takeover_started",
      actor: args.userId,
    });
    await audit(tx, {
      tenantId: args.tenantId,
      actorType: "user",
      actorId: args.userId,
      action: "human.takeover",
      entityType: "lead",
      entityId: args.leadId,
      before: { state: lead.state },
      after: { state: "human_owned" },
    });
    return { ok: true };
  });
}

export async function resumeLead(
  db: Database,
  args: { tenantId: string; leadId: string; userId: string; now: Date },
): Promise<{ ok: boolean; reason?: string }> {
  return withTenant(db, { tenantId: args.tenantId }, async (tx) => {
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, args.leadId))
      .limit(1);
    if (!lead) return { ok: false, reason: "lead not found" };
    if (lead.state !== "human_owned") return { ok: false, reason: "lead is not human-owned" };

    const prev =
      (lead.customFields as { preTakeoverState?: string })?.preTakeoverState ?? "engaged";

    await tx
      .update(schema.conversations)
      .set({ aiPaused: false })
      .where(eq(schema.conversations.leadId, args.leadId));
    assertTransition("human_owned" as never, prev as never);
    await tx
      .update(schema.leads)
      .set({ state: prev })
      .where(eq(schema.leads.id, args.leadId));

    await emitEvent(tx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      type: "human.takeover_ended",
      actor: args.userId,
    });
    await audit(tx, {
      tenantId: args.tenantId,
      actorType: "user",
      actorId: args.userId,
      action: "human.resume",
      entityType: "lead",
      entityId: args.leadId,
      after: { state: prev },
    });
    return { ok: true };
  });
}

/** Retry a failed message from the DLQ view (plan: MVP acceptance #9). */
export async function retryFailedMessage(
  db: Database,
  args: { tenantId: string; messageId: string },
): Promise<{ ok: boolean; outboxId?: string }> {
  return withTenant(db, { tenantId: args.tenantId }, async (tx) => {
    const [msg] = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, args.messageId))
      .limit(1);
    if (!msg || msg.status !== "failed") return { ok: false };

    // Re-open the outbox intent for the relay to pick up again.
    const [ob] = await tx
      .update(schema.outbox)
      .set({ status: "pending", nextAttemptAt: new Date() })
      .where(
        and(
          eq(schema.outbox.aggregateId, args.messageId),
          inArray(schema.outbox.status, ["failed"]),
        ),
      )
      .returning({ id: schema.outbox.id });
    await tx
      .update(schema.messages)
      .set({ status: "queued" })
      .where(eq(schema.messages.id, args.messageId));
    await audit(tx, {
      tenantId: args.tenantId,
      actorType: "user",
      action: "message.retried",
      entityType: "message",
      entityId: args.messageId,
    });
    return { ok: true, outboxId: ob?.id };
  });
}
