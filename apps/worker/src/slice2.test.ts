import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { FakeSmsChannel } from "@stl/messaging";
import { FakeLlm } from "@stl/llm";
import { FakeCalendar } from "@stl/calendar";
import { FakeCrm } from "@stl/crm";
import { randomUUID } from "node:crypto";
import { makeDeps, type WorkerDeps } from "./deps.js";
import { processBooking } from "./processors/booking.js";
import { processCrmSync } from "./processors/crm-sync.js";

/**
 * Slice 2 end-to-end (plan: PLAN.md Slice 2, testing §2):
 * qualified lead → Google Calendar booking → HubSpot sync, plus the calendar
 * concurrency guard (MVP acceptance #7, #10) and CRM idempotency.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("Slice 2: booking → CRM sync", () => {
  const tenantId = randomUUID();
  const clockNow = new Date("2026-07-20T15:00:00Z");
  let calendarConnectionId: string;
  let crm: FakeCrm;
  let deps: WorkerDeps;
  const enqueued: { queue: string; data: unknown }[] = [];

  beforeAll(async () => {
    const db = getDb();
    crm = new FakeCrm();
    deps = makeDeps({
      db,
      sms: new FakeSmsChannel(),
      llm: new FakeLlm(),
      calendar: new FakeCalendar(),
      crm,
      clock: { now: () => clockNow },
      enqueue: async (queue, _id, data) => {
        enqueued.push({ queue, data });
      },
    });

    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId, name: "Summit", slug: `s-${tenantId.slice(0, 8)}` });
      const [conn] = await tx
        .insert(schema.calendarConnections)
        .values({ tenantId, userId: randomUUID(), calendarId: "primary", accessTokenEnc: "tok" })
        .returning({ id: schema.calendarConnections.id });
      calendarConnectionId = conn!.id;
      await tx
        .insert(schema.crmConnections)
        .values({ tenantId, provider: "hubspot", accessTokenEnc: "tok" });
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeQualifiedLead(phone: string): Promise<string> {
    const db = getDb();
    return withTenant(db, { tenantId }, async (tx) => {
      const [lead] = await tx
        .insert(schema.leads)
        .values({
          tenantId,
          state: "qualified",
          firstName: "Sarah",
          lastName: "Connor",
          emailNormalized: `sarah${phone.slice(-4)}@example.com`,
          phoneE164: phone,
          city: "Dallas",
          serviceRequested: "roof_replacement",
          scoreCurrent: 84,
          scoreBand: "hot",
        })
        .returning({ id: schema.leads.id });
      await tx.insert(schema.qualificationAnswers).values({
        tenantId,
        leadId: lead!.id,
        schemaKey: "roofing-hvac@1",
        answers: { service: "roof_replacement", urgency: "high" },
        complete: true,
      });
      return lead!.id;
    });
  }

  const slot = {
    startsAt: "2026-07-21T15:00:00.000Z",
    endsAt: "2026-07-21T16:00:00.000Z",
  };

  it("books a qualified lead into a real calendar slot (accept #7)", async () => {
    const leadId = await makeQualifiedLead("+12145551001");
    const res = await processBooking(deps, {
      tenantId,
      leadId,
      calendarConnectionId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      correlationId: "b1",
    });
    expect(res.status).toBe("booked");
    expect(res.externalEventId).toBeTruthy();

    const db = getDb();
    const [lead] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)),
    );
    expect(lead!.state).toBe("booked");
    expect(lead!.bookedAt).toBeTruthy();
    // CRM sync was enqueued after booking.
    expect(enqueued.some((e) => e.queue === "crm-sync")).toBe(true);
  });

  it("prevents two leads booking the same slot concurrently (accept #7 race)", async () => {
    const leadA = await makeQualifiedLead("+12145552001");
    const leadB = await makeQualifiedLead("+12145552002");
    const raceSlot = {
      startsAt: "2026-07-22T15:00:00.000Z",
      endsAt: "2026-07-22T16:00:00.000Z",
    };

    // Fire both bookings for the identical slot at once.
    const [ra, rb] = await Promise.all([
      processBooking(deps, { tenantId, leadId: leadA, calendarConnectionId, ...raceSlot, correlationId: "ra" }),
      processBooking(deps, { tenantId, leadId: leadB, calendarConnectionId, ...raceSlot, correlationId: "rb" }),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(["booked", "slot_taken"]); // exactly one wins

    const db = getDb();
    const holds = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.slotHolds).where(eq(schema.slotHolds.startsAt, new Date(raceSlot.startsAt))),
    );
    const confirmed = holds.filter((h) => h.status === "confirmed");
    expect(confirmed).toHaveLength(1); // only one confirmed hold for the slot
  });

  it("syncs the lead to the CRM as contact + deal + note + meeting (accept #10)", async () => {
    const leadId = await makeQualifiedLead("+12145553001");
    // Book so there is a meeting to sync.
    await processBooking(deps, {
      tenantId,
      leadId,
      calendarConnectionId,
      startsAt: "2026-07-23T15:00:00.000Z",
      endsAt: "2026-07-23T16:00:00.000Z",
      correlationId: "b3",
    });

    const res = await processCrmSync(deps, { tenantId, leadId, correlationId: "s3" });
    expect(res.status).toBe("synced");
    expect(res.contactExternalId).toBeTruthy();
    expect(crm.contacts.size).toBeGreaterThan(0);
    expect(crm.deals.size).toBeGreaterThan(0);
    expect(crm.notes.length).toBeGreaterThan(0);
    expect(crm.meetings.length).toBeGreaterThan(0);

    // Mapping persisted for idempotency.
    const db = getDb();
    const [mapping] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.crmMappings).where(eq(schema.crmMappings.leadId, leadId)),
    );
    expect(mapping!.contactExternalId).toBe(res.contactExternalId);
  });

  it("re-syncing does not create a duplicate contact (idempotency)", async () => {
    const leadId = await makeQualifiedLead("+12145554001");
    const first = await processCrmSync(deps, { tenantId, leadId, correlationId: "s4a" });
    const before = crm.contacts.size;
    const second = await processCrmSync(deps, { tenantId, leadId, correlationId: "s4b" });
    expect(second.contactExternalId).toBe(first.contactExternalId);
    expect(crm.contacts.size).toBe(before); // no new contact
  });

  it("retries on a transient CRM failure (throws so BullMQ re-runs)", async () => {
    const leadId = await makeQualifiedLead("+12145555001");
    crm.failFor(1);
    await expect(
      processCrmSync(deps, { tenantId, leadId, correlationId: "s5" }),
    ).rejects.toThrow();
    // The sync job row records the failure for the health screen.
    const db = getDb();
    const [row] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.crmSyncJobs).where(eq(schema.crmSyncJobs.leadId, leadId)),
    );
    expect(row!.status).toBe("failed");
    // A subsequent attempt succeeds.
    const retry = await processCrmSync(deps, { tenantId, leadId, correlationId: "s5b" });
    expect(retry.status).toBe("synced");
  });
});
