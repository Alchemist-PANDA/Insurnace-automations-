import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * Password + session-token cryptography (plan: compliance §3, security). Pure
 * computation (no DB) so it lives in core and is unit-testable. Passwords use
 * scrypt with a per-password salt; session tokens are random and stored only as
 * a SHA-256 hash so a database leak never yields usable tokens.
 */

const SCRYPT_N = 16384;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N }).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  const derived = scryptSync(password, salt!, KEYLEN, { N: SCRYPT_N }).toString("hex");
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(expected!, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A raw session token (given to the client) and its hash (stored in the DB). */
export function generateSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Roles, most→least privileged, for RBAC comparisons. */
export const ROLES = [
  "platform_admin",
  "tenant_owner",
  "sales_manager",
  "sales_rep",
  "analyst",
] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  platform_admin: 5,
  tenant_owner: 4,
  sales_manager: 3,
  sales_rep: 2,
  analyst: 1,
};

/** True if `role` meets or exceeds `minimum` (analyst is read-only, lowest). */
export function roleAtLeast(role: string, minimum: Role): boolean {
  const r = RANK[role as Role];
  return r !== undefined && r >= RANK[minimum];
}
