import { eq, and, gt } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import {
  verifyPassword,
  generateSessionToken,
  hashToken,
} from "@stl/core";

/**
 * Session service (plan: compliance §3 "secure session handling"). Sessions are
 * random tokens stored only as SHA-256 hashes; the raw token lives in an
 * httpOnly cookie. Auth-bootstrap lookups (users, memberships) run under an
 * audited platform context because the tenant isn't known until the user is
 * resolved.
 */
export interface AuthPrincipal {
  userId: string;
  tenantId: string;
  role: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function login(
  db: Database,
  email: string,
  password: string,
): Promise<{ raw: string; principal: AuthPrincipal } | null> {
  // users is not tenant-scoped.
  const [user] = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase().trim()))
    .limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;

  // Resolve the user's tenant + role (platform context — tenant not yet known).
  const membership = await withTenant(
    db,
    { tenantId: user.id, platformAdmin: true },
    async (tx) => {
      const [m] = await tx
        .select({ tenantId: schema.memberships.tenantId, role: schema.memberships.role })
        .from(schema.memberships)
        .where(eq(schema.memberships.userId, user.id))
        .limit(1);
      return m ?? null;
    },
  );
  if (!membership) return null;

  const { raw, hash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    userId: user.id,
    tenantId: membership.tenantId,
    role: membership.role,
    tokenHash: hash,
    expiresAt,
  });

  return { raw, principal: { userId: user.id, tenantId: membership.tenantId, role: membership.role } };
}

export async function resolveSession(
  db: Database,
  rawToken: string | undefined,
): Promise<AuthPrincipal | null> {
  if (!rawToken) return null;
  const [row] = await db
    .select({
      userId: schema.sessions.userId,
      tenantId: schema.sessions.tenantId,
      role: schema.sessions.role,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.tokenHash, hashToken(rawToken)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function logout(db: Database, rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(rawToken)));
}
