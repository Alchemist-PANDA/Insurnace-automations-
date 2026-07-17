import { describe, it, expect } from "vitest";
import { sign, verifySignature } from "./signing.js";

const secret = "source-secret";
const now = 1_700_000_000_000;
const body = JSON.stringify({ full_name: "Sarah", phone: "+12145550142" });

describe("verifySignature", () => {
  it("accepts a correctly signed, fresh request", () => {
    const ts = String(now);
    const sig = sign(secret, ts, body);
    expect(verifySignature(secret, ts, sig, body, now)).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const ts = String(now);
    const sig = sign(secret, ts, body);
    const r = verifySignature(secret, ts, sig, body + "x", now);
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a stale timestamp (replay window)", () => {
    const ts = String(now - 10 * 60 * 1000);
    const sig = sign(secret, ts, body);
    expect(verifySignature(secret, ts, sig, body, now)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("rejects missing signature/timestamp", () => {
    expect(verifySignature(secret, undefined, undefined, body, now)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects a signature made with the wrong secret", () => {
    const ts = String(now);
    const sig = sign("wrong-secret", ts, body);
    expect(verifySignature(secret, ts, sig, body, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});
