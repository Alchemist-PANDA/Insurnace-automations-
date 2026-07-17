import { getDb, withTenant, closeDb } from "./client.js";
import * as s from "./schema.js";
import { roofingHvacFirstTouchTemplate } from "@stl/core";
import { randomUUID } from "node:crypto";

/**
 * Seed data (plan: data-model §7). Demo tenant "Summit Roofing" with one user
 * per role, a lead source with a known signing secret, settings, and the
 * roofing/HVAC first-touch template. Idempotent-ish: safe to run on a fresh DB.
 */
async function main() {
  const db = getDb();

  const tenantId = randomUUID();
  const secondTenantId = randomUUID();

  // Platform-level insert (no RLS tenant needed for tenants/users tables which
  // are not tenant-scoped) — use a platform-admin context.
  await withTenant(db, { tenantId, platformAdmin: true }, async (tx) => {
    await tx.insert(s.tenants).values([
      { id: tenantId, name: "Summit Roofing", slug: "summit-roofing" },
      { id: secondTenantId, name: "Peak HVAC", slug: "peak-hvac" },
    ]);

    const roles = [
      ["owner@summit.test", "Sam Owner", "tenant_owner"],
      ["manager@summit.test", "Morgan Manager", "sales_manager"],
      ["rep@summit.test", "Riley Rep", "sales_rep"],
      ["analyst@summit.test", "Avery Analyst", "analyst"],
      ["admin@platform.test", "Pat Admin", "platform_admin"],
    ] as const;

    for (const [email, name, role] of roles) {
      const userId = randomUUID();
      await tx.insert(s.users).values({ id: userId, email, name });
      await tx.insert(s.memberships).values({ tenantId, userId, role });
    }

    await tx.insert(s.tenantSettings).values({
      tenantId,
      businessName: "Summit Roofing",
      agentName: "Ava",
    });

    await tx.insert(s.leadSources).values({
      tenantId,
      key: "website-form",
      name: "Website Contact Form",
      signingSecret: "dev-source-secret-summit",
      mapping: {
        name: "full_name",
        email: "email",
        phone: "phone",
        city: "city",
        service: "service",
      },
    });

    await tx.insert(s.messageTemplates).values({
      tenantId,
      key: "first_touch",
      channel: "sms",
      body: roofingHvacFirstTouchTemplate,
    });
  });

  console.log(`Seeded tenant Summit Roofing (${tenantId})`);
  console.log(`Seeded tenant Peak HVAC (${secondTenantId})`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
