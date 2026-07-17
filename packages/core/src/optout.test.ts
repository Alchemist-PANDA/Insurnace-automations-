import { describe, it, expect } from "vitest";
import { detectOptOut } from "./optout.js";

describe("detectOptOut", () => {
  it("matches standard keywords in any case with punctuation", () => {
    for (const kw of ["STOP", "stop.", "Unsubscribe", "CANCEL", "quit", "END", "stopall"]) {
      expect(detectOptOut(kw).isOptOut).toBe(true);
    }
  });

  it("matches free-text withdrawal", () => {
    const phrases = [
      "please don't contact me again",
      "stop texting me",
      "remove my number",
      "take me off your list",
      "no more messages please",
      "leave me alone",
    ];
    for (const p of phrases) {
      expect(detectOptOut(p).isOptOut, p).toBe(true);
    }
  });

  it("detects a keyword as the first word of a sentence", () => {
    expect(detectOptOut("STOP messaging me").isOptOut).toBe(true);
  });

  it("recognizes HELP separately from opt-out", () => {
    const h = detectOptOut("help");
    expect(h.isHelp).toBe(true);
    expect(h.isOptOut).toBe(false);
  });

  it("does not opt out normal replies", () => {
    for (const p of ["Yes I have a leak", "Can we book tomorrow?", "How much for a new roof?"]) {
      expect(detectOptOut(p).isOptOut, p).toBe(false);
    }
  });
});
