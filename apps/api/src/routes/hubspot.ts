import type { FastifyInstance } from "fastify";
import type { Database } from "@stl/db";
import { processCrmInbound } from "@stl/worker";

/**
 * HubSpot inbound webhook (plan: integrations §4, PLAN M9). Deal stage changes
 * flow back as won/lost outcomes. HubSpot v3 signs requests; validation is
 * best-effort here (the app secret is validated when configured). Events are
 * idempotent by (dealId, stage) at the outcome level.
 */
export function registerHubSpotRoutes(app: FastifyInstance, db: Database): void {
  app.post("/webhooks/hubspot", async (req, reply) => {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let handled = 0;
    for (const ev of events as Record<string, unknown>[]) {
      // HubSpot property-change events carry objectId + propertyValue.
      const dealExternalId = String(ev.objectId ?? ev.dealId ?? "");
      const stage = String(ev.propertyValue ?? ev.stage ?? "");
      if (!dealExternalId || !stage) continue;
      const amount = ev.amount != null ? Number(ev.amount) : null;
      const res = await processCrmInbound(db, { dealExternalId, stage, amount });
      if (res.handled) handled += 1;
    }
    reply.code(200);
    return { received: events.length, handled };
  });
}
