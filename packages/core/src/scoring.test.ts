import { describe, it, expect } from "vitest";
import { scoreLead } from "./scoring.js";
import { roofingHvacScoringModel } from "./verticals/roofing-hvac.js";

describe("scoreLead (roofing/HVAC model)", () => {
  it("produces an explainable hot lead", () => {
    const result = scoreLead(roofingHvacScoringModel, {
      insideServiceArea: true, // fit 15
      eligibleService: true, // fit 10
      eligiblePropertyType: true, // fit 5
      validPhone: true, // fit 3  (fit=33)
      requestedAppointment: true, // intent 12
      askedPricing: true, // intent 8
      hasClearProject: true, // intent 6  (intent=26)
      activeEmergency: true, // urgency 20
      repliedToSms: true, // engagement 6
      answeredQualification: true, // engagement 4  (eng=10) → total 89
    });
    expect(result.band).toBe("hot");
    expect(result.total).toBeGreaterThanOrEqual(80);
    expect(result.explanation).toContain("Score");
    expect(result.explanation).toContain("service-area match +15");
    // breakdown is attributable per rule
    expect(result.breakdown.every((l) => l.label && typeof l.points === "number")).toBe(true);
  });

  it("enforces category caps (urgency ≤ 20)", () => {
    const result = scoreLead(roofingHvacScoringModel, {
      activeEmergency: true, // 20
      within30Days: true, // 10
      insuranceDeadline: true, // 8  → raw 38, capped to 20
    });
    const urgency = result.breakdown
      .filter((l) => l.category === "urgency")
      .reduce((s, l) => s + l.points, 0);
    expect(urgency).toBeLessThanOrEqual(20);
  });

  it("applies negatives and clamps to 0", () => {
    const result = scoreLead(roofingHvacScoringModel, {
      insideServiceArea: true,
      obviousSpam: true,
      abusiveContent: true,
    });
    expect(result.total).toBe(0);
    expect(result.band).toBe("unqualified");
  });

  it("bands a mid lead as qualified/nurture correctly", () => {
    const qualified = scoreLead(roofingHvacScoringModel, {
      insideServiceArea: true, // 15
      eligibleService: true, // 10
      eligiblePropertyType: true, // 5
      requestedAppointment: true, // 12
      within30Days: true, // 10
      repliedToSms: true, // 6 → 58
    });
    expect(qualified.band).toBe("qualified");

    const nurture = scoreLead(roofingHvacScoringModel, {
      insideServiceArea: true, // 15
      eligibleService: true, // 10
      openedEmail: true, // 2 → 27
    });
    expect(nurture.band).toBe("nurture");
  });

  it("scores an empty fact bag as unqualified with no signals", () => {
    const result = scoreLead(roofingHvacScoringModel, {});
    expect(result.total).toBe(0);
    expect(result.explanation).toContain("no scoring signals");
  });
});
