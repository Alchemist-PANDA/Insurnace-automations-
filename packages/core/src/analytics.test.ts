import { describe, it, expect } from "vitest";
import {
  percentile,
  responseTimeStats,
  funnelRates,
  roi,
  incrementalGrossProfit,
} from "./analytics.js";

describe("percentile", () => {
  it("computes median and p90", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBeCloseTo(91, 0);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("responseTimeStats", () => {
  it("computes median, p90, and within-window percentages", () => {
    const base = 1_000_000;
    const stats = responseTimeStats([
      { receivedAt: base, firstSentAt: base + 10_000 }, // 10s
      { receivedAt: base, firstSentAt: base + 25_000 }, // 25s
      { receivedAt: base, firstSentAt: base + 45_000 }, // 45s
      { receivedAt: base, firstSentAt: base + 120_000 }, // 120s
      { receivedAt: base, firstSentAt: null }, // never contacted
    ]);
    expect(stats.count).toBe(5);
    expect(stats.contacted).toBe(4);
    // 10 and 25 are within 30s → 50%
    expect(stats.withinPct.s30).toBe(50);
    // 10,25,45 within 60s → 75%
    expect(stats.withinPct.s60).toBe(75);
    // 10,25,45 within 90s → 75%
    expect(stats.withinPct.s90).toBe(75);
  });

  it("ignores negative deltas and handles empty", () => {
    const empty = responseTimeStats([]);
    expect(empty.medianMs).toBe(0);
    expect(empty.withinPct.s60).toBe(0);
  });
});

describe("funnelRates", () => {
  it("computes stage-to-stage rates", () => {
    const r = funnelRates({ total: 100, contacted: 90, replied: 45, qualified: 30, booked: 15, won: 6 });
    expect(r.contactRate).toBe(90);
    expect(r.replyRate).toBe(50); // 45/90
    expect(r.bookingRate).toBe(50); // 15/30
    expect(r.closeRate).toBe(40); // 6/15
  });
  it("guards divide-by-zero", () => {
    const r = funnelRates({ total: 0, contacted: 0, replied: 0, qualified: 0, booked: 0, won: 0 });
    expect(r.contactRate).toBe(0);
  });
});

describe("ROI (gross profit, matches blueprint §7 arithmetic)", () => {
  it("computes incremental gross profit and ROI", () => {
    // 100 leads, 8% → 12% close, $30k gross profit/deal = 4 extra deals = $120k
    const gp = incrementalGrossProfit({
      eligibleLeads: 100,
      baselineCloseRate: 0.08,
      postCloseRate: 0.12,
      avgGrossProfitPerDeal: 30_000,
    });
    expect(gp).toBe(120_000);
    // With $20k automation cost → ROI = (120k-20k)/20k = 5.0
    expect(roi({ incrementalGrossProfit: gp, automationCost: 20_000 })).toBe(5);
  });
  it("returns 0 ROI when cost is zero", () => {
    expect(roi({ incrementalGrossProfit: 100, automationCost: 0 })).toBe(0);
  });
});
