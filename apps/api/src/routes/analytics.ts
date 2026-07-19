import type { FastifyInstance } from "fastify";
import { eq, and, inArray } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { responseTimeStats, funnelRates, type ResponsePair } from "@stl/core";
import { requireAuth } from "../auth/context.js";

/**
 * Analytics (plan: blueprint §6, PLAN M10). Response-time and funnel metrics are
 * computed from immutable lead_events timestamps — never mutable lead rows — so
 * they stay correct even as a lead's state changes.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/analytics", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth) return;

    return withTenant(db, { tenantId: auth.tenantId }, async (tx) => {
      const events = await tx
        .select({
          leadId: schema.leadEvents.leadId,
          type: schema.leadEvents.type,
          occurredAt: schema.leadEvents.occurredAt,
        })
        .from(schema.leadEvents)
        .where(
          inArray(schema.leadEvents.type, [
            "lead.received",
            "message.sent",
            "message.received",
            "lead.qualified",
            "appointment.booked",
            "deal.won",
          ]),
        );

      // First received + first sent per lead → response pairs.
      const received = new Map<string, number>();
      const firstSent = new Map<string, number>();
      const replied = new Set<string>();
      const qualified = new Set<string>();
      const booked = new Set<string>();
      const won = new Set<string>();
      for (const e of events) {
        const ts = e.occurredAt.getTime();
        switch (e.type) {
          case "lead.received":
            if (!received.has(e.leadId) || ts < received.get(e.leadId)!) received.set(e.leadId, ts);
            break;
          case "message.sent":
            if (!firstSent.has(e.leadId) || ts < firstSent.get(e.leadId)!) firstSent.set(e.leadId, ts);
            break;
          case "message.received":
            replied.add(e.leadId);
            break;
          case "lead.qualified":
            qualified.add(e.leadId);
            break;
          case "appointment.booked":
            booked.add(e.leadId);
            break;
          case "deal.won":
            won.add(e.leadId);
            break;
        }
      }

      const pairs: ResponsePair[] = [...received.entries()].map(([leadId, receivedAt]) => ({
        receivedAt,
        firstSentAt: firstSent.get(leadId) ?? null,
      }));
      const rt = responseTimeStats(pairs);
      const total = received.size;
      const counts = {
        total,
        contacted: firstSent.size,
        replied: replied.size,
        qualified: qualified.size,
        booked: booked.size,
        won: won.size,
      };
      const rates = funnelRates(counts);

      // Attribution: sum of won outcome gross profit.
      const outcomeRows = await tx
        .select({ grossProfit: schema.outcomes.grossProfit, amount: schema.outcomes.amount })
        .from(schema.outcomes)
        .where(eq(schema.outcomes.type, "won"));
      const attributedGrossProfit = outcomeRows.reduce(
        (sum, o) => sum + (o.grossProfit ?? o.amount ?? 0),
        0,
      );

      return {
        responseTime: rt,
        funnel: { counts, rates },
        attribution: { attributedGrossProfit, wonDeals: outcomeRows.length },
      };
    });
  });

  // Integration health + DLQ view (plan: PLAN M9/M10, MVP acceptance #9).
  app.get("/v1/health/integrations", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth) return;
    return withTenant(db, { tenantId: auth.tenantId }, async (tx) => {
      const syncJobs = await tx.select().from(schema.crmSyncJobs);
      const failedMessages = await tx
        .select({ id: schema.messages.id, body: schema.messages.body, createdAt: schema.messages.createdAt })
        .from(schema.messages)
        .where(eq(schema.messages.status, "failed"));
      const stuckOutbox = await tx
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(inArray(schema.outbox.status, ["pending", "failed"]));
      return {
        crm: {
          total: syncJobs.length,
          synced: syncJobs.filter((j) => j.status === "synced").length,
          failed: syncJobs.filter((j) => j.status === "failed").length,
        },
        dlq: {
          failedMessages: failedMessages.length,
          items: failedMessages.slice(0, 50),
          pendingOutbox: stuckOutbox.length,
        },
      };
    });
  });

  void and;
}
