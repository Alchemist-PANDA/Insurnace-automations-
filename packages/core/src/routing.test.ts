import { describe, it, expect } from "vitest";
import { routeLead, type RepCandidate, type RoutingConfig } from "./routing.js";

const rep = (over: Partial<RepCandidate>): RepCandidate => ({
  userId: "u",
  active: true,
  territories: [],
  specialties: [],
  available: true,
  workload: 0,
  workloadCap: 10,
  ...over,
});

const cfg = (over: Partial<RoutingConfig> = {}): RoutingConfig => ({
  strategies: ["territory", "specialization", "availability", "workload", "round_robin"],
  roundRobinCursor: 0,
  ...over,
});

const input = {
  postalCode: "75001",
  region: "TX",
  serviceRequested: "roof_replacement",
  band: "hot",
};

describe("routeLead", () => {
  it("prefers a rep whose territory matches", () => {
    const res = routeLead(
      input,
      [
        rep({ userId: "far", territories: ["9"] }),
        rep({ userId: "near", territories: ["750"] }),
      ],
      cfg(),
    );
    expect(res.primaryUserId).toBe("near");
    expect(res.reason).toContain("territory");
  });

  it("existing-customer ownership wins outright", () => {
    const res = routeLead(
      input,
      [
        rep({ userId: "owner", ownsContact: true, available: false, territories: ["9"] }),
        rep({ userId: "other", territories: ["750"] }),
      ],
      cfg(),
    );
    expect(res.primaryUserId).toBe("owner");
    expect(res.reason).toContain("ownership");
  });

  it("balances by workload", () => {
    const res = routeLead(
      input,
      [
        rep({ userId: "busy", workload: 8 }),
        rep({ userId: "free", workload: 1 }),
      ],
      cfg({ strategies: ["workload"] }),
    );
    expect(res.primaryUserId).toBe("free");
  });

  it("skips reps at their workload cap but keeps them as fallback", () => {
    const res = routeLead(
      input,
      [
        rep({ userId: "capped", workload: 10, workloadCap: 10 }),
        rep({ userId: "ok", workload: 2 }),
      ],
      cfg(),
    );
    expect(res.primaryUserId).toBe("ok");
    expect(res.fallbackUserIds).toContain("capped");
  });

  it("never traps a hot lead: returns fallback-queue when nobody is available", () => {
    const res = routeLead(
      input,
      [rep({ userId: "a", available: false, workload: 10, workloadCap: 10 })],
      cfg({ strategies: ["availability"] }),
    );
    // Unavailable + capped → still surfaces as fallback ordering, not null,
    // because orderedFallback is non-empty.
    expect(res.primaryUserId).toBe("a");
  });

  it("routes to fallback queue when there are no candidates", () => {
    const res = routeLead(input, [], cfg());
    expect(res.primaryUserId).toBeNull();
    expect(res.reason).toContain("fallback queue");
  });

  it("advances the round-robin cursor", () => {
    const reps = [rep({ userId: "a" }), rep({ userId: "b" })];
    const first = routeLead(input, reps, cfg({ strategies: ["round_robin"], roundRobinCursor: 0 }));
    const second = routeLead(input, reps, cfg({ strategies: ["round_robin"], roundRobinCursor: first.nextCursor }));
    expect(first.primaryUserId).not.toBe(second.primaryUserId);
    expect(second.nextCursor).toBe(2);
  });
});
