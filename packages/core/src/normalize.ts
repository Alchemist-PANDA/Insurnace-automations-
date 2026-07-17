import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Lead normalization (plan: data-model, blueprint §4 "Within 1-3 seconds").
 * Deterministic, pure. Every source's raw payload becomes one canonical shape.
 */

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

/** Split a single "full name" field into first / last on the first space. */
export function splitName(raw: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const cleaned = normalizeName(raw);
  if (!cleaned) return { firstName: null, lastName: null };
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return {
    firstName: parts[0]!,
    lastName: parts.slice(1).join(" "),
  };
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  // Minimal structural check; we do not verify deliverability here.
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return ok ? trimmed : null;
}

/**
 * Normalize to E.164. Returns null when the number cannot be parsed as a valid
 * number — those leads are ineligible for SMS and flagged for review.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "US",
): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

export function normalizePostalCode(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
