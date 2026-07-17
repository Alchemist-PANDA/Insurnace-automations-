import { schema, type Database } from "@stl/db";

/**
 * Append-only event + audit writers (plan: architecture §5.1, compliance §3).
 * Events feed analytics from immutable timestamps; audit rows record every
 * automated decision. Both are written inside the caller's transaction.
 */

export async function emitEvent(
  tx: Database,
  args: {
    tenantId: string;
    leadId: string;
    type: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
    actor?: string;
  },
): Promise<string> {
  const [row] = await tx
    .insert(schema.leadEvents)
    .values({
      tenantId: args.tenantId,
      leadId: args.leadId,
      type: args.type,
      payload: args.payload ?? {},
      correlationId: args.correlationId,
      actor: args.actor ?? "system",
    })
    .returning({ id: schema.leadEvents.id });
  return row!.id;
}

export async function audit(
  tx: Database,
  args: {
    tenantId: string;
    actorType: "user" | "system" | "ai" | "integration";
    actorId?: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    correlationId?: string;
  },
): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    tenantId: args.tenantId,
    actorType: args.actorType,
    actorId: args.actorId,
    action: args.action,
    entityType: args.entityType,
    entityId: args.entityId,
    before: args.before ?? null,
    after: args.after ?? null,
    correlationId: args.correlationId,
  });
}
