import type { FastifyInstance } from "fastify";
import type { Database } from "@stl/db";
import { takeoverLead, resumeLead, retryFailedMessage, acknowledgeLead } from "@stl/worker";

/**
 * Human-in-the-loop lead actions (plan: blueprint §5I, MVP acceptance #8/#9).
 * Tenant + acting user come from the `x-tenant-id` / `x-user-id` dev shim until
 * better-auth sessions land in M1; all work runs under withTenant (RLS).
 */
export function registerLeadActionRoutes(app: FastifyInstance, db: Database): void {
  const ctx = (headers: Record<string, string | string[] | undefined>) => {
    const tenantId = one(headers["x-tenant-id"]);
    const userId = one(headers["x-user-id"]) ?? "system";
    return { tenantId, userId };
  };

  app.post("/v1/leads/:id/takeover", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId, userId } = ctx(req.headers);
    if (!tenantId) return reply.code(400).send({ error: "x-tenant-id required" });
    const res = await takeoverLead(db, { tenantId, leadId: id, userId, now: new Date() });
    if (!res.ok) return reply.code(409).send(res);
    return { ok: true };
  });

  app.post("/v1/leads/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId, userId } = ctx(req.headers);
    if (!tenantId) return reply.code(400).send({ error: "x-tenant-id required" });
    const res = await resumeLead(db, { tenantId, leadId: id, userId, now: new Date() });
    if (!res.ok) return reply.code(409).send(res);
    return { ok: true };
  });

  app.post("/v1/leads/:id/acknowledge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId, userId } = ctx(req.headers);
    if (!tenantId) return reply.code(400).send({ error: "x-tenant-id required" });
    await acknowledgeLead(db, tenantId, id, userId, new Date());
    return { ok: true };
  });

  app.post("/v1/messages/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = ctx(req.headers);
    if (!tenantId) return reply.code(400).send({ error: "x-tenant-id required" });
    const res = await retryFailedMessage(db, { tenantId, messageId: id });
    if (!res.ok) return reply.code(409).send({ error: "message not in a retryable state" });
    return { ok: true };
  });
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
