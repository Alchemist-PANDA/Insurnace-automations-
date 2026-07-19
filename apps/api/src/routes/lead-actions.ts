import type { FastifyInstance } from "fastify";
import type { Database } from "@stl/db";
import { takeoverLead, resumeLead, retryFailedMessage, acknowledgeLead } from "@stl/worker";
import { requireAuth, requireRole } from "../auth/context.js";

/**
 * Human-in-the-loop lead actions (plan: blueprint §5I, MVP acceptance #8/#9).
 * Authenticated + RBAC-gated: these mutate leads, so they require sales_rep or
 * higher (analysts are read-only). Tenant comes from the session.
 */
export function registerLeadActionRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/leads/:id/takeover", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth || !requireRole(auth, "sales_rep", reply)) return;
    const { id } = req.params as { id: string };
    const res = await takeoverLead(db, { tenantId: auth.tenantId, leadId: id, userId: auth.userId, now: new Date() });
    if (!res.ok) return reply.code(409).send(res);
    return { ok: true };
  });

  app.post("/v1/leads/:id/resume", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth || !requireRole(auth, "sales_rep", reply)) return;
    const { id } = req.params as { id: string };
    const res = await resumeLead(db, { tenantId: auth.tenantId, leadId: id, userId: auth.userId, now: new Date() });
    if (!res.ok) return reply.code(409).send(res);
    return { ok: true };
  });

  app.post("/v1/leads/:id/acknowledge", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth || !requireRole(auth, "sales_rep", reply)) return;
    const { id } = req.params as { id: string };
    await acknowledgeLead(db, auth.tenantId, id, auth.userId, new Date());
    return { ok: true };
  });

  app.post("/v1/messages/:id/retry", async (req, reply) => {
    const auth = await requireAuth(db, req, reply);
    if (!auth || !requireRole(auth, "sales_manager", reply)) return;
    const { id } = req.params as { id: string };
    const res = await retryFailedMessage(db, { tenantId: auth.tenantId, messageId: id });
    if (!res.ok) return reply.code(409).send({ error: "message not in a retryable state" });
    return { ok: true };
  });
}
