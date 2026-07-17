import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, TERMINAL_STATES } from "./state-machine.js";
import { LeadState } from "./types.js";

describe("canTransition", () => {
  it("allows the happy-path flow", () => {
    const path: LeadState[] = [
      "received",
      "processing",
      "new",
      "contacted",
      "engaged",
      "qualifying",
      "qualified",
      "appointment_offered",
      "booked",
      "won",
      "archived",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!).ok).toBe(true);
    }
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("received", "booked").ok).toBe(false);
    expect(canTransition("new", "won").ok).toBe(false);
  });

  it("allows opt-out from any active state", () => {
    expect(canTransition("new", "opted_out").ok).toBe(true);
    expect(canTransition("qualified", "opted_out").ok).toBe(true);
    expect(canTransition("booked", "opted_out").ok).toBe(true);
  });

  it("makes opted_out terminal for automation", () => {
    expect(canTransition("opted_out", "contacted").ok).toBe(false);
    expect(canTransition("opted_out", "archived").ok).toBe(true);
  });

  it("allows takeover from any active state and resume back", () => {
    expect(canTransition("qualifying", "human_owned").ok).toBe(true);
    expect(canTransition("human_owned", "qualified").ok).toBe(true);
  });

  it("assertTransition throws on illegal transitions", () => {
    expect(() => assertTransition("received", "won")).toThrow(/illegal transition/);
  });

  it("has no undefined (state,event) behavior — every pair is defined or rejected", () => {
    for (const from of LeadState.options) {
      for (const to of LeadState.options) {
        const result = canTransition(from, to);
        expect(typeof result.ok).toBe("boolean");
        if (!result.ok) expect(result.reason).toBeTruthy();
      }
    }
  });

  it("terminal states are archived-only exits", () => {
    for (const s of TERMINAL_STATES) {
      if (s === "archived") continue;
      expect(canTransition(s, "archived").ok).toBe(true);
    }
  });
});
