import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { withTenant, schema, type Database } from "@stl/db";
import { enqueue, QUEUE } from "@stl/queue";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from "../signing.js";

const IDEMPOTENCY_HEADER = "x-stl-idempotency-key";

/**
 * Generic signed ingestion gateway (plan: architecture §6.1, blueprint §5A).
 *
 * Contract: verify signature → store raw payload → record idempotency →
 * enqueue → acknowledge in under two seconds. The full workflow happens in the
 * worker, never inside this request.
 */
export function registerIngestRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/ingest/:sourceId", async (req, reply) => {
    const { sourceId } = req.params as { sourceId: string };
    const correlationId = req.id;
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";

    // Resolve which tenant this source belongs to. This is a system-level
    // lookup (we don't yet know the tenant); the per-source signature is the
    // authenticator. Uses an audited platform context.
    const source = await resolveSource(db, sourceId);
    if (!source || !source.active) {
      reply.code(404);
      return { error: "unknown or inactive source" };
    }

    // Authenticate the request against the per-source secret.
    const verdict = verifySignature(
      source.signingSecret,
      firstHeader(req.headers[TIMESTAMP_HEADER]),
      firstHeader(req.headers[SIGNATURE_HEADER]),
      rawBody,
    );
    if (!verdict.ok) {
      reply.code(401);
      return { error: `signature ${verdict.reason}` };
    }

    // Idempotency key: explicit header, else a hash of the exact payload.
    const idempotencyKey =
      firstHeader(req.headers[IDEMPOTENCY_HEADER]) ??
      createHash("sha256").update(rawBody).digest("hex");

    const payload = (req.body ?? {}) as Record<string, unknown>;

    const result = await withTenant(
      db,
      { tenantId: source.tenantId },
      async (tx) => {
        // Store the raw payload verbatim for replay/debugging.
        const [raw] = await tx
          .insert(schema.rawWebhooks)
          .values({
            tenantId: source.tenantId,
            sourceId: source.id,
            payload,
            headers: redactHeaders(req.headers),
          })
          .returning({ id: schema.rawWebhooks.id });

        // Record idempotency; a replay collides here and is acknowledged
        // without re-enqueueing (no duplicate downstream work / messages).
        const inserted = await tx
          .insert(schema.ingestIdempotency)
          .values({
            tenantId: source.tenantId,
            sourceId: source.id,
            idempotencyKey,
          })
          .onConflictDoNothing()
          .returning({ key: schema.ingestIdempotency.idempotencyKey });

        return { rawId: raw!.id, isNew: inserted.length > 0 };
      },
    );

    if (result.isNew) {
      await enqueue(
        QUEUE.ingest,
        `${source.tenantId}:${source.id}:${idempotencyKey}`,
        {
          tenantId: source.tenantId,
          sourceId: source.id,
          rawWebhookId: result.rawId,
          idempotencyKey,
          correlationId,
        },
      );
    }

    reply.code(202);
    return { status: "accepted", duplicate: !result.isNew };
  });
}

interface ResolvedSource {
  id: string;
  tenantId: string;
  signingSecret: string;
  active: boolean;
}

async function resolveSource(
  db: Database,
  sourceId: string,
): Promise<ResolvedSource | null> {
  // Cross-tenant system lookup under an explicit platform context. We only
  // read the routing + secret fields needed to authenticate the request.
  return withTenant(
    db,
    { tenantId: sourceId /* placeholder */, platformAdmin: true },
    async (tx) => {
      const rows = await tx
        .select({
          id: schema.leadSources.id,
          tenantId: schema.leadSources.tenantId,
          signingSecret: schema.leadSources.signingSecret,
          active: schema.leadSources.active,
        })
        .from(schema.leadSources)
        .where(eq(schema.leadSources.id, sourceId))
        .limit(1);
      return rows[0] ?? null;
    },
  );
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Never persist auth material with the raw webhook.
function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === SIGNATURE_HEADER || k === "authorization") continue;
    out[k] = v;
  }
  return out;
}
