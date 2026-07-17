import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withTenant, closeDb, type Database } from "./client.js";
import * as s from "./schema.js";
import { randomUUID } from "node:crypto";

/**
 * Tenant-isolation attack suite (plan: data-model §5, testing §2 criterion #12,
 * MVP acceptance #12). Proves the DATABASE stops cross-tenant access even when
 * application code deliberately omits a tenant filter.
 *
 * Requires DATABASE_URL pointing at a migrated database with RLS applied.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let db: Database;
const tenantA = randomUUID();
const tenantB = randomUUID();
let leadA: string;
let leadB: string;

d("row-level security", () => {
  beforeAll(async () => {
    db = getDb();
    // Seed one lead in each tenant using each tenant's own context.
    await withTenant(db, { tenantId: tenantA }, async (tx) => {
      const [row] = await tx
        .insert(s.leads)
        .values({ tenantId: tenantA, phoneE164: "+12145550001", state: "new" })
        .returning({ id: s.leads.id });
      leadA = row!.id;
    });
    await withTenant(db, { tenantId: tenantB }, async (tx) => {
      const [row] = await tx
        .insert(s.leads)
        .values({ tenantId: tenantB, phoneE164: "+12145550002", state: "new" })
        .returning({ id: s.leads.id });
      leadB = row!.id;
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("a tenant sees only its own leads on an unfiltered query", async () => {
    const rows = await withTenant(db, { tenantId: tenantA }, async (tx) => {
      // Deliberately NO tenant filter — RLS must scope it anyway.
      return tx.select({ id: s.leads.id, tenantId: s.leads.tenantId }).from(s.leads);
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
    expect(rows.some((r) => r.id === leadB)).toBe(false);
  });

  it("tenant A cannot read tenant B's lead even by id", async () => {
    const rows = await withTenant(db, { tenantId: tenantA }, async (tx) => {
      return tx.select().from(s.leads).where(eq(s.leads.id, leadB));
    });
    expect(rows).toHaveLength(0);
  });

  it("tenant A cannot update tenant B's lead", async () => {
    const updated = await withTenant(db, { tenantId: tenantA }, async (tx) => {
      return tx
        .update(s.leads)
        .set({ state: "archived" })
        .where(eq(s.leads.id, leadB))
        .returning({ id: s.leads.id });
    });
    expect(updated).toHaveLength(0);
    // Confirm B is untouched from B's own context.
    const [b] = await withTenant(db, { tenantId: tenantB }, async (tx) =>
      tx.select().from(s.leads).where(eq(s.leads.id, leadB)),
    );
    expect(b?.state).toBe("new");
  });

  it("suppression entries are tenant-isolated, but platform (null-tenant) rows are shared", async () => {
    // Tenant A suppresses a number; tenant B must not see it. A platform-level
    // suppression (tenant_id null) is visible to both.
    await withTenant(db, { tenantId: tenantA }, (tx) =>
      tx.insert(s.suppressionEntries).values({
        tenantId: tenantA,
        channel: "sms",
        value: "+15550000001",
        reason: "opt-out",
      }),
    );
    await withTenant(db, { tenantId: tenantB, platformAdmin: true }, (tx) =>
      tx.insert(s.suppressionEntries).values({
        tenantId: null,
        channel: "sms",
        value: "+15550000002",
        reason: "platform block",
      }),
    );

    const bView = await withTenant(db, { tenantId: tenantB }, (tx) =>
      tx.select({ value: s.suppressionEntries.value }).from(s.suppressionEntries),
    );
    const values = bView.map((r) => r.value);
    expect(values).not.toContain("+15550000001"); // tenant A's, hidden
    expect(values).toContain("+15550000002"); // platform-level, shared
  });

  it("a platform-admin context can see across tenants (audited elevation)", async () => {
    const rows = await withTenant(
      db,
      { tenantId: tenantA, platformAdmin: true },
      async (tx) => tx.select({ id: s.leads.id }).from(s.leads),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(leadA);
    expect(ids).toContain(leadB);
  });
});
