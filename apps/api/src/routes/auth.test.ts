import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenant, getDb, closeDb, schema } from "@stl/db";
import { hashPassword } from "@stl/core";
import { resetEnvCache } from "@stl/config";
import { randomUUID } from "node:crypto";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

/**
 * Authentication + RBAC (plan: Tier 1 #1, compliance §3). Proves password login
 * issues a working session, sessions authenticate protected routes, analysts
 * are read-only, and — critically — the dev-header fallback is refused when
 * disabled (the production guard).
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("auth + RBAC", () => {
  let app: FastifyInstance;
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const analystId = randomUUID();
  let leadId: string;

  beforeAll(async () => {
    const db = getDb();
    app = await buildServer({ db });
    await app.ready();
    const pw = hashPassword("demo1234");
    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId, name: "T", slug: `t-${tenantId.slice(0, 8)}` });
      await tx.insert(schema.users).values([
        { id: ownerId, email: `owner-${tenantId.slice(0, 6)}@x.com`, passwordHash: pw },
        { id: analystId, email: `analyst-${tenantId.slice(0, 6)}@x.com`, passwordHash: pw },
      ]);
      await tx.insert(schema.memberships).values([
        { tenantId, userId: ownerId, role: "tenant_owner" },
        { tenantId, userId: analystId, role: "analyst" },
      ]);
      const [lead] = await tx.insert(schema.leads).values({ tenantId, state: "engaged", phoneE164: "+12145559100" }).returning({ id: schema.leads.id });
      await tx.insert(schema.conversations).values({ tenantId, leadId: lead!.id, channel: "sms" });
      leadId = lead!.id;
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    resetEnvCache();
  });

  const ownerEmail = () => `owner-${tenantId.slice(0, 6)}@x.com`;
  const analystEmail = () => `analyst-${tenantId.slice(0, 6)}@x.com`;

  async function loginCookie(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "demo1234" },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"] as string;
    return setCookie.split(";")[0]!; // "stl_session=..."
  }

  it("rejects a wrong password", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: ownerEmail(), password: "nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("logs in and authenticates a protected route with the session cookie", async () => {
    const cookie = await loginCookie(ownerEmail());
    const res = await app.inject({ method: "GET", url: "/v1/leads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().leads.some((l: { id: string }) => l.id === leadId)).toBe(true);
  });

  it("rejects protected routes with no credentials", async () => {
    resetEnvCache();
    process.env.AUTH_ALLOW_DEV_HEADERS = "false"; // simulate the production posture
    resetEnvCache();
    const res = await app.inject({ method: "GET", url: "/v1/leads" });
    expect(res.statusCode).toBe(401);
    // dev header must ALSO be refused when the fallback is disabled
    const res2 = await app.inject({ method: "GET", url: "/v1/leads", headers: { "x-tenant-id": tenantId } });
    expect(res2.statusCode).toBe(401);
    delete process.env.AUTH_ALLOW_DEV_HEADERS;
    resetEnvCache();
  });

  it("enforces RBAC: an analyst cannot take over a lead", async () => {
    const cookie = await loginCookie(analystEmail());
    const res = await app.inject({ method: "POST", url: `/v1/leads/${leadId}/takeover`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("allows a tenant_owner to take over", async () => {
    const cookie = await loginCookie(ownerEmail());
    const res = await app.inject({ method: "POST", url: `/v1/leads/${leadId}/takeover`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("me returns the principal; logout clears the session", async () => {
    const cookie = await loginCookie(ownerEmail());
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    expect(me.json().user.role).toBe("tenant_owner");
    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie } });
    const after = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});
