import { eq } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { canTransition } from "@stl/core";
import { emitEvent, audit } from "../events.js";

/**
 * CRM inbound (plan: integrations §4, PLAN M9). HubSpot deal stage changes flow
 * back as won/lost outcomes that feed attribution. We resolve the lead via the
 * crm_mappings table (deal external id → lead) under an audited platform lookup,
 * then record the outcome and transition the lead.
 */
export interface CrmDealEvent {
  dealExternalId: string;
  stage: string; // e.g. closedwon | closedlost
  amount?: number | null;
}

const WON_STAGES = new Set(["closedwon", "won"]);
const LOST_STAGES = new Set(["closedlost", "lost"]);

export async function processCrmInbound(
  db: Database,
  event: CrmDealEvent,
): Promise<{ handled: boolean; leadId?: string; outcome?: "won" | "lost" }> {
  const type = WON_STAGES.has(event.stage.toLowerCase())
    ? "won"
    : LOST_STAGES.has(event.stage.toLowerCase())
      ? "lost"
      : null;
  if (!type) return { handled: false };

  // Resolve tenant + lead from the deal mapping (system-level lookup).
  const mapping = await withTenant(
    db,
    { tenantId: event.dealExternalId, platformAdmin: true },
    async (tx) => {
      const [m] = await tx
        .select({ tenantId: schema.crmMappings.tenantId, leadId: schema.crmMappings.leadId })
        .from(schema.crmMappings)
        .where(eq(schema.crmMappings.dealExternalId, event.dealExternalId))
        .limit(1);
      return m ?? null;
    },
  );
  if (!mapping) return { handled: false };

  await withTenant(db, { tenantId: mapping.tenantId }, async (tx) => {
    const [lead] = await tx
      .select({ state: schema.leads.state })
      .from(schema.leads)
      .where(eq(schema.leads.id, mapping.leadId))
      .limit(1);
    if (!lead) return;

    await tx.insert(schema.outcomes).values({
      tenantId: mapping.tenantId,
      leadId: mapping.leadId,
      type,
      amount: event.amount ?? null,
    });

    if (canTransition(lead.state as never, type as never).ok) {
      await tx.update(schema.leads).set({ state: type }).where(eq(schema.leads.id, mapping.leadId));
    }

    await emitEvent(tx, {
      tenantId: mapping.tenantId,
      leadId: mapping.leadId,
      type: type === "won" ? "deal.won" : "deal.lost",
      payload: { amount: event.amount ?? null, dealExternalId: event.dealExternalId },
      actor: "integration",
    });
    await audit(tx, {
      tenantId: mapping.tenantId,
      actorType: "integration",
      action: type === "won" ? "deal.won" : "deal.lost",
      entityType: "lead",
      entityId: mapping.leadId,
      after: { amount: event.amount ?? null },
    });
  });

  return { handled: true, leadId: mapping.leadId, outcome: type };
}
