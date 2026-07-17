import { describe, it, expect } from "vitest";
import { renderTemplate } from "./templating.js";
import { roofingHvacFirstTouchTemplate } from "./verticals/roofing-hvac.js";

describe("renderTemplate", () => {
  it("substitutes variables and trims", () => {
    const { text, missing } = renderTemplate(roofingHvacFirstTouchTemplate, {
      firstName: "Sarah",
      agentName: "Ava",
      businessName: "Summit Roofing",
      serviceLabel: "a roof replacement",
      city: "Dallas",
    });
    expect(text).toContain("Hi Sarah, this is Ava from Summit Roofing.");
    expect(text).toContain("a roof replacement in Dallas");
    expect(missing).toEqual([]);
  });

  it("reports missing variables instead of shipping {{placeholders}}", () => {
    const { text, missing } = renderTemplate("Hi {{firstName}} {{unknown}}", {
      firstName: "Sarah",
    });
    expect(text).toBe("Hi Sarah");
    expect(missing).toContain("unknown");
  });
});
