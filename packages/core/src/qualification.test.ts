import { describe, it, expect } from "vitest";
import {
  nextQuestion,
  isQualificationComplete,
  mergeAnswers,
} from "./qualification.js";
import { roofingHvacQualificationSchema } from "./verticals/roofing-hvac.js";

const schema = roofingHvacQualificationSchema;

describe("qualification flow", () => {
  it("asks the first required field when nothing is answered", () => {
    const q = nextQuestion(schema, {});
    expect(q?.key).toBe("service");
  });

  it("skips answered fields and asks the next required one", () => {
    const q = nextQuestion(schema, { service: "roof_replacement", urgency: "high" });
    expect(q?.key).toBe("property_type");
  });

  it("is not complete until all required fields are answered", () => {
    expect(isQualificationComplete(schema, { service: "x" })).toBe(false);
    const full = {
      service: "roof_replacement",
      urgency: "high",
      property_type: "single_family",
      location_confirmed: true,
      appointment_intent: true,
    };
    expect(isQualificationComplete(schema, full)).toBe(true);
  });

  it("merges extracted facts, ignoring null/empty", () => {
    const merged = mergeAnswers(
      { service: "roof_replacement" },
      { urgency: "high", property_type: null, timeline: "" },
    );
    expect(merged).toEqual({ service: "roof_replacement", urgency: "high" });
  });

  it("returns null when everything (incl. optional) is answered", () => {
    const all: Record<string, unknown> = {};
    for (const f of schema.fields) all[f.key] = "x";
    expect(nextQuestion(schema, all)).toBeNull();
  });
});
