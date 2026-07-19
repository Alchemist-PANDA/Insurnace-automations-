import type { FastifyRequest, FastifyReply } from "fastify";
import { loadEnv, devAuthAllowed } from "@stl/config";
import { roleAtLeast, type Role } from "@stl/core";
import { resolveSession, type AuthPrincipal } from "./service.js";
import type { Database } from "@stl/db";

export const SESSION_COOKIE = "stl_session";

/**
 * Resolve the authenticated principal for a request. Precedence:
 *   1. a valid session cookie (the real, production path)
 *   2. x-tenant-id / x-user-id dev headers — ONLY when devAuthAllowed() is true
 *      (never in production; see @stl/config).
 * Returns null when neither yields a principal → the caller replies 401.
 */
export async function resolveAuth(
  db: Database,
  req: FastifyRequest,
): Promise<AuthPrincipal | null> {
  const raw = parseCookie(req.headers.cookie, SESSION_COOKIE);
  const session = await resolveSession(db, raw);
  if (session) return session;

  if (devAuthAllowed(loadEnv())) {
    const tenantId = one(req.headers["x-tenant-id"]);
    if (tenantId) {
      return {
        tenantId,
        userId: one(req.headers["x-user-id"]) ?? "dev-user",
        role: one(req.headers["x-role"]) ?? "tenant_owner",
      };
    }
  }
  return null;
}

/** Guard: resolve auth or send 401. Returns the principal or null (after reply). */
export async function requireAuth(
  db: Database,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthPrincipal | null> {
  const principal = await resolveAuth(db, req);
  if (!principal) {
    reply.code(401).send({ error: "authentication required" });
    return null;
  }
  return principal;
}

/** RBAC guard: require at least `minimum` role, else 403. */
export function requireRole(
  principal: AuthPrincipal,
  minimum: Role,
  reply: FastifyReply,
): boolean {
  if (!roleAtLeast(principal.role, minimum)) {
    reply.code(403).send({ error: `requires ${minimum} or higher` });
    return false;
  }
  return true;
}

export function sessionCookieHeader(raw: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${raw}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
