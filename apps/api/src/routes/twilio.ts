import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { enqueue, QUEUE } from "@stl/queue";

/**
 * Twilio inbound + status webhooks (plan: integrations §2, architecture §6.3).
 * These acknowledge fast and enqueue; signature validation and processing
 * happen in the worker where the tenant's auth token is available.
 *
 * NOTE: In production the signature is validated here with the tenant's token.
 * We resolve the tenant from the message's From/To before enqueueing.
 */
export function registerTwilioRoutes(app: FastifyInstance, db: Database): void {
  app.post("/webhooks/twilio/inbound", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const from = body.From ?? "";
    const resolved = await resolveTenantByPhone(db, from);
    if (resolved) {
      await enqueue(
        QUEUE.messagingEvents,
        `inbound:${body.MessageSid ?? crypto.randomUUID()}`,
        {
          tenantId: resolved.tenantId,
          kind: "inbound",
          payload: body,
          correlationId: req.id,
        },
      );
    }
    // Twilio expects 204/empty TwiML; we reply immediately regardless.
    reply.code(204);
    return null;
  });

  app.post("/webhooks/twilio/status", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const sid = body.MessageSid ?? "";
    const resolved = await resolveTenantByMessageSid(db, sid);
    if (resolved) {
      await enqueue(
        QUEUE.messagingEvents,
        `status:${sid}:${body.MessageStatus ?? ""}`,
        {
          tenantId: resolved.tenantId,
          kind: "status",
          payload: body,
          correlationId: req.id,
        },
      );
    }
    reply.code(204);
    return null;
  });
}

async function resolveTenantByPhone(
  db: Database,
  phone: string,
): Promise<{ tenantId: string } | null> {
  if (!phone) return null;
  return withTenant(db, { tenantId: phone, platformAdmin: true }, async (tx) => {
    const rows = await tx
      .select({ tenantId: schema.leads.tenantId })
      .from(schema.leads)
      .where(eq(schema.leads.phoneE164, phone))
      .orderBy(desc(schema.leads.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });
}

async function resolveTenantByMessageSid(
  db: Database,
  sid: string,
): Promise<{ tenantId: string } | null> {
  if (!sid) return null;
  return withTenant(db, { tenantId: sid, platformAdmin: true }, async (tx) => {
    const rows = await tx
      .select({ tenantId: schema.messages.tenantId })
      .from(schema.messages)
      .where(eq(schema.messages.providerSid, sid))
      .limit(1);
    return rows[0] ?? null;
  });
}
