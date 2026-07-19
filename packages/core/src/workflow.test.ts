import { describe, it, expect } from "vitest";
import { shouldStop, stepAt, findWorkflow, DEFAULT_WORKFLOWS } from "./workflow.js";

describe("workflow stop conditions", () => {
  it("stops when the lead reached a terminal/handoff state", () => {
    for (const state of ["opted_out", "booked", "human_owned", "won", "lost", "archived"] as const) {
      expect(shouldStop({ state }).stop).toBe(true);
    }
  });
  it("continues for active states", () => {
    expect(shouldStop({ state: "contacted" }).stop).toBe(false);
    expect(shouldStop({ state: "engaged" }).stop).toBe(false);
  });
  it("stops on complaint or delivery lockout", () => {
    expect(shouldStop({ state: "contacted", complaintDetected: true }).stop).toBe(true);
    expect(shouldStop({ state: "contacted", deliveryFailureLockout: true }).stop).toBe(true);
  });
});

describe("workflow sequencing", () => {
  it("returns steps in order then null at the end", () => {
    const wf = DEFAULT_WORKFLOWS[0]!;
    expect(stepAt(wf, 0)?.key).toBe(wf.steps[0]!.key);
    expect(stepAt(wf, wf.steps.length)).toBeNull();
  });
  it("finds a workflow by trigger", () => {
    expect(findWorkflow("no_reply")?.key).toBe("new_lead_no_reply");
    expect(findWorkflow("qualified_not_booked")?.key).toBe("qualified_not_booked");
    expect(findWorkflow("deal_won")).toBeNull();
  });
});
