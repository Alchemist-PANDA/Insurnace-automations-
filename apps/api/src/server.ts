import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { getDb } from "@stl/db";
import { createLogger } from "@stl/logger";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerTwilioRoutes } from "./routes/twilio.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerLeadActionRoutes } from "./routes/lead-actions.js";
import { registerHubSpotRoutes } from "./routes/hubspot.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerAuthRoutes } from "./routes/auth.js";

export interface BuildOptions {
  /** Inject a db for tests; defaults to the shared pool. */
  db?: ReturnType<typeof getDb>;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast bridges a pino major-version type gap between our pino and the one
    // Fastify's types are generated against; the runtime shape is compatible.
    loggerInstance: createLogger({ service: "api" }) as unknown as FastifyBaseLogger,
    // Correlation id per request, propagated into jobs (architecture §7).
    genReqId: () => `cid_${crypto.randomUUID()}`,
    trustProxy: true,
  });

  // Capture the raw JSON body so ingest can verify HMAC signatures over exactly
  // the bytes that were signed (architecture §6.1).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const raw = body as string;
        (_req as { rawBody?: string }).rawBody = raw;
        done(null, raw.length ? JSON.parse(raw) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Allow the dashboard origin to call the API with the session cookie.
  await app.register(cors, {
    origin: (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(","),
    credentials: true,
  });

  // Twilio posts application/x-www-form-urlencoded.
  await app.register(formbody);

  // Rate limiting on public endpoints (plan: compliance §3, PLAN M11). Keyed by
  // source key for ingest, else by IP. Generous default; providers/webhooks
  // burst legitimately, so this guards abuse, not normal traffic.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const params = req.params as { sourceId?: string } | undefined;
      return params?.sourceId ?? req.ip;
    },
    allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
  });

  const db = opts.db ?? getDb();

  registerHealthRoutes(app, db);
  registerAuthRoutes(app, db);
  registerIngestRoutes(app, db);
  registerTwilioRoutes(app, db);
  registerLeadRoutes(app, db);
  registerLeadActionRoutes(app, db);
  registerHubSpotRoutes(app, db);
  registerAnalyticsRoutes(app, db);

  return app;
}
