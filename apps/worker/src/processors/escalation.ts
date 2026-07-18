import { eq, and, isNotNull } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { DEFAULT_ESCALATION } from "@stl/core";
import type { EscalationJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface EscalationResult {
  action: string;
  status: "executed" | "cancelled";
}

/**
 * SLA escalation step (plan: blueprint §5G, PLAN M5). Each delayed step first
 * checks whether the lead has been acknowledged or is no longer waiting; if so
 * it cancels itself. Otherwise it performs its notify/fallback action. A lead
 * is never trapped by one unavailable rep.
 */
export async function processEscalation(
  deps: WorkerDeps,
  job: EscalationJob,
): Promise<EscalationResult> {
  const { db } = deps;
  const step = DEFAULT_ESCALATION[job.stepIndex];
  if (!step) return { action: "none", status: "cancelled" };

  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [lead] = await tx
      .select({ state: schema.leads.state })
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    if (!lead) return { action: step.action, status: "cancelled" as const };

    // Cancel if the lead has moved on (booked/human_owned/opted_out/etc.) or the
    // primary assignment was acknowledged.
    const stillWaiting = ["new", "contacted", "engaged", "qualifying", "qualified"].includes(
      lead.state,
    );
    const acked = await tx
      .select({ id: schema.leadAssignments.id })
      .from(schema.leadAssignments)
      .where(
        and(
          eq(schema.leadAssignments.leadId, job.leadId),
          eq(schema.leadAssignments.role, "primary"),
          isNotNull(schema.leadAssignments.acknowledgedAt),
        ),
      )
      .limit(1);

    if (!stillWaiting || acked.length > 0) {
      return { action: step.action, status: "cancelled" as const };
    }

    // Execute the step: an internal notification / fallback move, recorded as an
    // event + audit entry so the SLA ladder is fully observable.
    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId: job.leadId,
      type: "lead.escalated",
      correlationId: job.correlationId,
      payload: { step: step.action, stepIndex: job.stepIndex },
    });
    await audit(tx, {
      tenantId: job.tenantId,
      actorType: "system",
      action: `escalation.${step.action}`,
      entityType: "lead",
      entityId: job.leadId,
      after: { stepIndex: job.stepIndex },
      correlationId: job.correlationId,
    });

    return { action: step.action, status: "executed" as const };
  });
}

/** Acknowledge a lead (rep responded) — halts the escalation ladder. */
export async function acknowledgeLead(
  db: Database,
  tenantId: string,
  leadId: string,
  userId: string,
  now: Date,
): Promise<void> {
  await withTenant(db, { tenantId }, async (tx) => {
    await tx
      .update(schema.leadAssignments)
      .set({ acknowledgedAt: now })
      .where(
        and(
          eq(schema.leadAssignments.leadId, leadId),
          eq(schema.leadAssignments.role, "primary"),
        ),
      );
    await emitEvent(tx, {
      tenantId,
      leadId,
      type: "lead.acknowledged",
      actor: userId,
    });
  });
}
