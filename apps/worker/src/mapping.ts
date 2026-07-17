import {
  normalizeEmail,
  normalizePhone,
  splitName,
  normalizePostalCode,
} from "@stl/core";
import type { NormalizedLead } from "@stl/core";

/**
 * Map a raw source payload into the canonical NormalizedLead using the source's
 * configured field mapping (plan: blueprint §5A "one standard lead schema").
 * mapping maps our canonical field name → the key in the raw payload.
 */
export interface SourceMapping {
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  service?: string;
}

export function mapRawToNormalized(
  raw: Record<string, unknown>,
  mapping: SourceMapping,
  ctx: { tenantId: string; sourceId: string },
): NormalizedLead {
  const get = (key?: string): string | null =>
    key && raw[key] != null ? String(raw[key]) : null;

  let firstName: string | null;
  let lastName: string | null;
  if (mapping.first_name || mapping.last_name) {
    firstName = get(mapping.first_name);
    lastName = get(mapping.last_name);
  } else {
    const split = splitName(get(mapping.name));
    firstName = split.firstName;
    lastName = split.lastName;
  }

  return {
    tenantId: ctx.tenantId,
    sourceId: ctx.sourceId,
    firstName,
    lastName,
    emailNormalized: normalizeEmail(get(mapping.email)),
    phoneE164: normalizePhone(get(mapping.phone)),
    city: get(mapping.city),
    region: get(mapping.region),
    postalCode: normalizePostalCode(get(mapping.postal_code)),
    serviceRequested: get(mapping.service),
    propertyType: null,
    urgency: null,
    isExistingCustomer: false,
    externalIds: {},
    rawSubmittedAt: new Date().toISOString(),
  };
}
