import { describe, it, expect } from "vitest";
import { resolveDuplicate, type DedupCandidate } from "./dedup.js";

const candidate = (over: Partial<DedupCandidate>): DedupCandidate => ({
  leadId: "lead_1",
  phoneE164: "+12145550142",
  emailNormalized: "sarah@example.com",
  externalIds: {},
  state: "contacted",
  createdAt: new Date().toISOString(),
  ...over,
});

describe("resolveDuplicate", () => {
  it("creates when nothing matches", () => {
    expect(
      resolveDuplicate(
        { phoneE164: "+15550001111", emailNormalized: null, externalIds: {}, isExistingCustomer: false },
        [],
      ),
    ).toEqual({ action: "create" });
  });

  it("merges into an open lead on phone match", () => {
    const out = resolveDuplicate(
      { phoneE164: "+12145550142", emailNormalized: null, externalIds: {}, isExistingCustomer: false },
      [candidate({})],
    );
    expect(out).toMatchObject({ action: "merge", leadId: "lead_1" });
  });

  it("reopens a closed lead", () => {
    const out = resolveDuplicate(
      { phoneE164: "+12145550142", emailNormalized: null, externalIds: {}, isExistingCustomer: false },
      [candidate({ state: "lost" })],
    );
    expect(out).toMatchObject({ action: "reopen" });
  });

  it("attaches to an existing customer", () => {
    const out = resolveDuplicate(
      { phoneE164: "+12145550142", emailNormalized: null, externalIds: {}, isExistingCustomer: true },
      [candidate({ state: "won" })],
    );
    expect(out).toMatchObject({ action: "attach_to_customer" });
  });

  it("flags when multiple open leads match", () => {
    const out = resolveDuplicate(
      { phoneE164: "+12145550142", emailNormalized: "sarah@example.com", externalIds: {}, isExistingCustomer: false },
      [
        candidate({ leadId: "a", emailNormalized: null }),
        candidate({ leadId: "b", phoneE164: null }),
      ],
    );
    expect(out).toMatchObject({ action: "flag_for_review" });
  });

  it("does not silently reopen an opted-out lead", () => {
    const out = resolveDuplicate(
      { phoneE164: "+12145550142", emailNormalized: null, externalIds: {}, isExistingCustomer: false },
      [candidate({ state: "opted_out" })],
    );
    expect(out).toMatchObject({ action: "flag_for_review" });
  });

  it("matches on external id", () => {
    const out = resolveDuplicate(
      { phoneE164: null, emailNormalized: null, externalIds: { fb_lead_id: "X1" }, isExistingCustomer: false },
      [candidate({ phoneE164: null, emailNormalized: null, externalIds: { fb_lead_id: "X1" } })],
    );
    expect(out).toMatchObject({ action: "merge" });
  });
});
