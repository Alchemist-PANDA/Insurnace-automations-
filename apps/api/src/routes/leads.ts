import type { FastifyInstance } from "fastify";
import { desc, eq, and } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { requireAuth } from "../auth/context.js";

/**
 * Read endpoints for the dashboard (plan: PLAN M2 lead inbox, M3 timeline).
 *
 * Tenant comes from the authenticated session (or the dev-header fallback, which
 * production rejects). Every query runs inside withTenant so RLS is enforced.
 */
export function registerLeadRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/leads", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth) return;
    return withTenant(db, { tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.leads.id,
          firstName: schema.leads.firstName,
          lastName: schema.leads.lastName,
          phoneE164: schema.leads.phoneE164,
          city: schema.leads.city,
          serviceRequested: schema.leads.serviceRequested,
          state: schema.leads.state,
          scoreCurrent: schema.leads.scoreCurrent,
          scoreBand: schema.leads.scoreBand,
          createdAt: schema.leads.createdAt,
          firstTouchAt: schema.leads.firstTouchAt,
        })
        .from(schema.leads)
        .orderBy(desc(schema.leads.createdAt))
        .limit(100);
      return { leads: rows };
    });
  });

  app.get("/v1/leads/:id", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    return withTenant(db, { tenantId: auth.tenantId }, async (tx) => {
      const [lead] = await tx
        .select()
        .from(schema.leads)
        .where(eq(schema.leads.id, id))
        .limit(1);
      if (!lead) {
        reply.code(404);
        return { error: "not found" };
      }

      const conversation = (
        await tx
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.leadId, id))
          .limit(1)
      )[0];

      const messages = conversation
        ? await tx
            .select({
              id: schema.messages.id,
              direction: schema.messages.direction,
              body: schema.messages.body,
              status: schema.messages.status,
              createdAt: schema.messages.createdAt,
            })
            .from(schema.messages)
            .where(eq(schema.messages.conversationId, conversation.id))
            .orderBy(schema.messages.createdAt)
        : [];

      const scores = await tx
        .select({
          total: schema.leadScores.total,
          band: schema.leadScores.band,
          breakdown: schema.leadScores.breakdown,
          createdAt: schema.leadScores.createdAt,
        })
        .from(schema.leadScores)
        .where(eq(schema.leadScores.leadId, id))
        .orderBy(desc(schema.leadScores.createdAt));

      const events = await tx
        .select({
          type: schema.leadEvents.type,
          occurredAt: schema.leadEvents.occurredAt,
        })
        .from(schema.leadEvents)
        .where(eq(schema.leadEvents.leadId, id))
        .orderBy(schema.leadEvents.occurredAt);

      return { lead, messages, scores, events };
    });
  });

  // Suppress reference so `and` stays importable for future filters.
  void and;
}
