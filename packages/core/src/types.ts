import { z } from "zod";

/** Lead lifecycle states (plan: data-model §4). */
export const LeadState = z.enum([
  "received",
  "processing",
  "new",
  "contacted",
  "engaged",
  "qualifying",
  "qualified",
  "appointment_offered",
  "booked",
  "human_owned",
  "nurture",
  "unqualified",
  "opted_out",
  "won",
  "lost",
  "archived",
]);
export type LeadState = z.infer<typeof LeadState>;

/** Score bands (plan: blueprint §5F, data-model). */
export const ScoreBand = z.enum(["hot", "qualified", "nurture", "unqualified"]);
export type ScoreBand = z.infer<typeof ScoreBand>;

export const Channel = z.enum(["sms", "email", "whatsapp", "voice"]);
export type Channel = z.infer<typeof Channel>;

export const ConsentStatus = z.enum(["granted", "revoked", "unknown"]);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

/**
 * Normalized lead facts — the canonical schema every source maps into
 * (plan: blueprint §5A "one standard lead schema").
 */
export const NormalizedLead = z.object({
  tenantId: z.string(),
  sourceId: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  emailNormalized: z.string().nullable(),
  phoneE164: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  serviceRequested: z.string().nullable(),
  propertyType: z
    .enum(["single_family", "multi_family", "commercial", "other"])
    .nullable(),
  urgency: z.enum(["emergency", "high", "medium", "low"]).nullable(),
  isExistingCustomer: z.boolean(),
  externalIds: z.record(z.string()),
  rawSubmittedAt: z.string(),
});
export type NormalizedLead = z.infer<typeof NormalizedLead>;

/** Consent facts consulted by the deterministic sending gate. */
export const ConsentSnapshot = z.object({
  channel: Channel,
  status: ConsentStatus,
});
export type ConsentSnapshot = z.infer<typeof ConsentSnapshot>;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
