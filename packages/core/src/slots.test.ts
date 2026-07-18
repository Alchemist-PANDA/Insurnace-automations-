import { describe, it, expect } from "vitest";
import { computeSlots, type Interval } from "./slots.js";

const D = (h: number, m = 0) => new Date(`2026-07-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
const now = D(8); // 8:00, before the window

describe("computeSlots", () => {
  const window: Interval[] = [{ start: D(9), end: D(12) }];
  const config = { durationMinutes: 60, bufferMinutes: 15, stepMinutes: 30, maxOffers: 3 };

  it("offers evenly spaced slots in an empty calendar", () => {
    const slots = computeSlots(window, [], config, now);
    expect(slots).toHaveLength(3);
    expect(slots[0]!.start.toISOString()).toBe(D(9).toISOString());
    expect(slots[1]!.start.toISOString()).toBe(D(9, 30).toISOString());
  });

  it("avoids busy intervals expanded by the buffer", () => {
    const busy: Interval[] = [{ start: D(9, 30), end: D(10, 30) }];
    const slots = computeSlots(window, busy, config, now);
    // 9:00-10:00 collides with (9:15-10:45 expanded) → excluded.
    // First free start is 10:45 aligned to step → 11:00.
    expect(slots.every((s) => s.start >= D(10, 30))).toBe(true);
  });

  it("never offers a slot in the past", () => {
    const slots = computeSlots(window, [], config, D(10, 15));
    expect(slots.every((s) => s.start >= D(10, 15))).toBe(true);
  });

  it("respects maxOffers", () => {
    const slots = computeSlots(window, [], { ...config, maxOffers: 1 }, now);
    expect(slots).toHaveLength(1);
  });

  it("returns nothing when the window is fully busy", () => {
    const busy: Interval[] = [{ start: D(8), end: D(13) }];
    expect(computeSlots(window, busy, config, now)).toHaveLength(0);
  });
});
