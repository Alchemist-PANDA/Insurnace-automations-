import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Generic ingest webhook signing (plan: integrations §6, architecture §6.1).
 * HMAC-SHA256 over the raw request body with the per-source secret, plus a
 * timestamp header inside a ±5-minute window to reject replays.
 */

export const SIGNATURE_HEADER = "x-stl-signature";
export const TIMESTAMP_HEADER = "x-stl-timestamp";
const MAX_SKEW_MS = 5 * 60 * 1000;

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "stale" | "mismatch" };

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  now: number = Date.now(),
): VerifyResult {
  if (!timestamp || !signature) return { ok: false, reason: "missing" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale" };
  }

  const expected = sign(secret, timestamp, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
