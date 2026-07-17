import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  normalizePhone,
  normalizeName,
  splitName,
} from "./normalize.js";

describe("normalizePhone", () => {
  it("converts US national format to E.164", () => {
    expect(normalizePhone("(214) 555-0142")).toBe("+12145550142");
    expect(normalizePhone("214-555-0142")).toBe("+12145550142");
  });
  it("keeps valid E.164 input", () => {
    expect(normalizePhone("+12145550142")).toBe("+12145550142");
  });
  it("returns null for invalid numbers", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("not a phone")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Sarah@Example.COM ")).toBe("sarah@example.com");
  });
  it("rejects malformed", () => {
    expect(normalizeEmail("nope")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("splitName", () => {
  it("splits first and last", () => {
    expect(splitName("Sarah Connor")).toEqual({
      firstName: "Sarah",
      lastName: "Connor",
    });
  });
  it("handles single names and collapses whitespace", () => {
    expect(splitName("  Sarah   ")).toEqual({
      firstName: "Sarah",
      lastName: null,
    });
    expect(normalizeName("  a   b ")).toBe("a b");
  });
});
