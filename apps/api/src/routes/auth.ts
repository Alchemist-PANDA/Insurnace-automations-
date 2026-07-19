import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadEnv } from "@stl/config";
import type { Database } from "@stl/db";
import { login, logout } from "../auth/service.js";
import {
  resolveAuth,
  sessionCookieHeader,
  clearCookieHeader,
  SESSION_COOKIE,
} from "../auth/context.js";

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

/**
 * Authentication routes (plan: compliance §3). Login issues an httpOnly session
 * cookie; the raw token is never stored server-side (only its hash).
 */
export function registerAuthRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/auth/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "email and password required" });

    const result = await login(db, parsed.data.email, parsed.data.password);
    if (!result) return reply.code(401).send({ error: "invalid email or password" });

    const secure = loadEnv().NODE_ENV === "production";
    reply.header("set-cookie", sessionCookieHeader(result.raw, secure));
    return { user: { id: result.principal.userId, tenantId: result.principal.tenantId, role: result.principal.role } };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const raw = parseCookie(req.headers.cookie, SESSION_COOKIE);
    await logout(db, raw);
    reply.header("set-cookie", clearCookieHeader());
    return { ok: true };
  });

  app.get("/v1/auth/me", async (req, reply) => {
    const principal = await resolveAuth(db, req);
    if (!principal) return reply.code(401).send({ error: "not authenticated" });
    return { user: principal };
  });
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
