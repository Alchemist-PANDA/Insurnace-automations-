import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
  roleAtLeast,
} from "./auth.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });
  it("produces a unique salt per hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
  it("rejects malformed / empty stored values", () => {
    expect(verifyPassword("x", null)).toBe(false);
    expect(verifyPassword("x", "bogus")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
  });
});

describe("session tokens", () => {
  it("stores only a hash; the raw token verifies against it", () => {
    const { raw, hash } = generateSessionToken();
    expect(hash).not.toBe(raw);
    expect(hashToken(raw)).toBe(hash);
    expect(hashToken("tampered")).not.toBe(hash);
  });
});

describe("RBAC ranks", () => {
  it("orders roles correctly", () => {
    expect(roleAtLeast("tenant_owner", "sales_rep")).toBe(true);
    expect(roleAtLeast("sales_rep", "sales_rep")).toBe(true);
    expect(roleAtLeast("analyst", "sales_rep")).toBe(false);
    expect(roleAtLeast("platform_admin", "tenant_owner")).toBe(true);
    expect(roleAtLeast("nonsense", "analyst")).toBe(false);
  });
});
