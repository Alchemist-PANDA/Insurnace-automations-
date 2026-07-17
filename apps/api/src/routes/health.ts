import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Database } from "@stl/db";

export function registerHealthRoutes(app: FastifyInstance, db: Database): void {
  // Liveness — the process is up.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness — dependencies reachable (architecture §7).
  app.get("/readyz", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ready", db: "ok" };
    } catch (err) {
      reply.code(503);
      return { status: "unready", db: "down", error: (err as Error).message };
    }
  });
}
