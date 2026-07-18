import { eq, and, inArray } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { routeLead, DEFAULT_ESCALATION, type RepCandidate } from "@stl/core";
import { QUEUE, type AssignJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface AssignResult {
  primaryUserId: string | null;
  reason: string;
  escalationScheduled: boolean;
}

/**
 * Assignment processor (plan: blueprint §5G, PLAN M5). Loads candidate reps,
 * runs the pure routing engine, persists the assignment + fallback chain, and —
 * for a Hot lead — kicks off the SLA escalation ladder as durable delayed jobs.
 */
export async function processAssignment(
  deps: WorkerDeps,
  job: AssignJob,
): Promise<AssignResult> {
  const { db, clock } = deps;

  const result = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    if (!lead) throw new Error(`lead ${job.leadId} not found`);

    const candidates = await loadCandidates(tx, job.tenantId, lead.phoneE164, lead.emailNormalized);

    const cursor = await getCursor(tx, job.tenantId);
    const routing = routeLead(
      {
        postalCode: lead.postalCode,
        region: lead.region,
        serviceRequested: lead.serviceRequested,
        band: lead.scoreBand ?? "nurture",
      },
      candidates,
      {
        strategies: ["territory", "specialization", "availability", "workload", "round_robin"],
        roundRobinCursor: cursor,
      },
    );

    // Persist primary + fallback assignments.
    await tx.insert(schema.leadAssignments).values({
      tenantId: job.tenantId,
      leadId: job.leadId,
      userId: routing.primaryUserId,
      role: "primary",
      reason: routing.reason,
    });
    if (routing.fallbackUserIds.length > 0) {
      await tx.insert(schema.leadAssignments).values(
        routing.fallbackUserIds.slice(0, 3).map((userId) => ({
          tenantId: job.tenantId,
          leadId: job.leadId,
          userId,
          role: "fallback",
          reason: routing.reason,
        })),
      );
    }
    await tx
      .update(schema.leads)
      .set({ assignedUserId: routing.primaryUserId, updatedAt: clock.now() })
      .where(eq(schema.leads.id, job.leadId));

    // Advance the round-robin cursor.
    await tx
      .insert(schema.routingState)
      .values({ tenantId: job.tenantId, roundRobinCursor: routing.nextCursor })
      .onConflictDoUpdate({
        target: schema.routingState.tenantId,
        set: { roundRobinCursor: routing.nextCursor, updatedAt: clock.now() },
      });

    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId: job.leadId,
      type: "lead.assigned",
      correlationId: job.correlationId,
      payload: { userId: routing.primaryUserId, reason: routing.reason },
    });
    await audit(tx, {
      tenantId: job.tenantId,
      actorType: "system",
      action: "lead.assigned",
      entityType: "lead",
      entityId: job.leadId,
      after: { userId: routing.primaryUserId, reason: routing.reason },
      correlationId: job.correlationId,
    });

    return { routing, band: lead.scoreBand };
  });

  // Hot leads get the SLA escalation ladder (durable delayed jobs). Each step
  // re-checks acknowledgment and cancels itself if the rep has responded.
  let escalationScheduled = false;
  if (result.band === "hot") {
    for (let i = 1; i < DEFAULT_ESCALATION.length; i++) {
      const step = DEFAULT_ESCALATION[i]!;
      await deps.enqueue(
        QUEUE.escalation,
        `esc:${job.leadId}:${i}`,
        { tenantId: job.tenantId, leadId: job.leadId, stepIndex: i, correlationId: job.correlationId },
        { delay: step.afterSeconds * 1000 },
      );
    }
    escalationScheduled = true;
  }

  return {
    primaryUserId: result.routing.primaryUserId,
    reason: result.routing.reason,
    escalationScheduled,
  };
}

async function loadCandidates(
  tx: Database,
  tenantId: string,
  phone: string | null,
  email: string | null,
): Promise<RepCandidate[]> {
  // Reps = members who can own leads.
  const members = await tx
    .select({ userId: schema.memberships.userId, role: schema.memberships.role })
    .from(schema.memberships)
    .where(eq(schema.memberships.tenantId, tenantId));
  const repIds = members
    .filter((m) => m.role === "sales_rep" || m.role === "sales_manager")
    .map((m) => m.userId);
  if (repIds.length === 0) return [];

  const schedules = await tx
    .select()
    .from(schema.userSchedules)
    .where(and(eq(schema.userSchedules.tenantId, tenantId), inArray(schema.userSchedules.userId, repIds)));
  const territoryRows = await tx
    .select()
    .from(schema.territories)
    .where(and(eq(schema.territories.tenantId, tenantId), inArray(schema.territories.userId, repIds)));

  // Current open-lead workload per rep.
  const openAssignments = await tx
    .select({ userId: schema.leads.assignedUserId })
    .from(schema.leads)
    .where(eq(schema.leads.tenantId, tenantId));
  const workload = new Map<string, number>();
  for (const a of openAssignments) {
    if (a.userId) workload.set(a.userId, (workload.get(a.userId) ?? 0) + 1);
  }

  // Existing-customer ownership detection is refined in a later milestone;
  // the routing engine already honors ownsContact when we can populate it.
  const ownerIds = new Set<string>();
  void phone;
  void email;

  const scheduleByUser = new Map(schedules.map((s) => [s.userId, s]));
  const territoriesByUser = new Map<string, string[]>();
  for (const t of territoryRows) {
    const arr = territoriesByUser.get(t.userId) ?? [];
    arr.push(t.key);
    territoriesByUser.set(t.userId, arr);
  }

  return repIds.map((userId) => {
    const sched = scheduleByUser.get(userId);
    return {
      userId,
      active: true,
      territories: territoriesByUser.get(userId) ?? [],
      specialties: (sched?.specialties as string[]) ?? [],
      available: sched?.available ?? true,
      workload: workload.get(userId) ?? 0,
      workloadCap: sched?.workloadCap ?? 10,
      ownsContact: ownerIds.has(userId),
    };
  });
}

async function getCursor(tx: Database, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ cursor: schema.routingState.roundRobinCursor })
    .from(schema.routingState)
    .where(eq(schema.routingState.tenantId, tenantId))
    .limit(1);
  return row?.cursor ?? 0;
}
