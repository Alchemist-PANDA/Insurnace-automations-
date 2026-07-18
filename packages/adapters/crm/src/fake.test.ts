import { describe, it, expect } from "vitest";
import { FakeCrm } from "./fake.js";

const conn = { accessToken: "t" };

describe("FakeCrm", () => {
  it("upserts a contact by email (idempotent — no duplicate on re-sync)", async () => {
    const crm = new FakeCrm();
    const a = await crm.upsertContact(conn, {
      firstName: "Sarah",
      lastName: "Connor",
      email: "sarah@example.com",
      phone: "+12145550142",
    });
    const b = await crm.upsertContact(conn, {
      externalId: a.externalId,
      firstName: "Sarah",
      lastName: "Connor-Reese",
      email: "sarah@example.com",
      phone: "+12145550142",
    });
    expect(b.externalId).toBe(a.externalId);
    expect(crm.contacts.size).toBe(1);
    expect(crm.contacts.get(a.externalId)?.lastName).toBe("Connor-Reese");
  });

  it("associates a deal with a contact", async () => {
    const crm = new FakeCrm();
    const c = await crm.upsertContact(conn, { firstName: "A", lastName: null, email: "a@x.com", phone: null });
    const d = await crm.upsertDeal(conn, {
      contactExternalId: c.externalId,
      name: "Roof",
      stage: "qualifiedtobuy",
      score: 84,
      band: "hot",
    });
    expect(crm.deals.get(d.externalId)?.contactExternalId).toBe(c.externalId);
  });

  it("records notes and meetings", async () => {
    const crm = new FakeCrm();
    const c = await crm.upsertContact(conn, { firstName: "A", lastName: null, email: "a@x.com", phone: null });
    await crm.addNote(conn, { contactExternalId: c.externalId, body: "hello" });
    await crm.createMeeting(conn, {
      contactExternalId: c.externalId,
      title: "Inspection",
      startsAt: new Date(),
      endsAt: new Date(),
    });
    expect(crm.notes).toHaveLength(1);
    expect(crm.meetings).toHaveLength(1);
  });

  it("simulates a transient failure for the configured number of calls", async () => {
    const crm = new FakeCrm();
    crm.failFor(1);
    await expect(
      crm.upsertContact(conn, { firstName: "A", lastName: null, email: "a@x.com", phone: null }),
    ).rejects.toThrow();
    // Next call succeeds.
    const ok = await crm.upsertContact(conn, { firstName: "A", lastName: null, email: "a@x.com", phone: null });
    expect(ok.externalId).toBeTruthy();
  });
});
