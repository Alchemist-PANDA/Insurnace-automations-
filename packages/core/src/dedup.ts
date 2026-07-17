/**
 * Identity resolution and deduplication (plan: blueprint §5B, data-model).
 *
 * Pure decision function: given the incoming normalized lead and a set of
 * candidate existing leads (already fetched by the caller within the tenant +
 * recency window), decide what to do. Storage and querying live in the worker;
 * the *policy* lives here so it is unit-testable.
 */

export interface DedupCandidate {
  leadId: string;
  phoneE164: string | null;
  emailNormalized: string | null;
  externalIds: Record<string, string>;
  state: string;
  createdAt: string; // ISO
}

export interface DedupInput {
  phoneE164: string | null;
  emailNormalized: string | null;
  externalIds: Record<string, string>;
  isExistingCustomer: boolean;
}

export type DedupOutcome =
  | { action: "create" }
  | { action: "merge"; leadId: string; reason: string }
  | { action: "reopen"; leadId: string; reason: string }
  | { action: "attach_to_customer"; leadId: string; reason: string }
  | { action: "flag_for_review"; leadIds: string[]; reason: string };

const OPEN_STATES = new Set([
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
]);

const CLOSED_REOPENABLE = new Set(["unqualified", "lost", "archived"]);

function matches(c: DedupCandidate, input: DedupInput): boolean {
  if (input.phoneE164 && c.phoneE164 === input.phoneE164) return true;
  if (input.emailNormalized && c.emailNormalized === input.emailNormalized)
    return true;
  for (const [k, v] of Object.entries(input.externalIds)) {
    if (c.externalIds[k] && c.externalIds[k] === v) return true;
  }
  return false;
}

export function resolveDuplicate(
  input: DedupInput,
  candidates: DedupCandidate[],
): DedupOutcome {
  const matched = candidates.filter((c) => matches(c, input));
  if (matched.length === 0) return { action: "create" };

  // More than one distinct open lead matches → ambiguous, needs a human.
  const openMatches = matched.filter((c) => OPEN_STATES.has(c.state));
  if (openMatches.length > 1) {
    return {
      action: "flag_for_review",
      leadIds: openMatches.map((c) => c.leadId),
      reason: "multiple open leads match this identity",
    };
  }

  const primary = openMatches[0] ?? matched[0]!;

  if (input.isExistingCustomer) {
    return {
      action: "attach_to_customer",
      leadId: primary.leadId,
      reason: "matched an existing customer identity",
    };
  }

  if (OPEN_STATES.has(primary.state)) {
    return {
      action: "merge",
      leadId: primary.leadId,
      reason: "merged into an existing open lead",
    };
  }

  if (CLOSED_REOPENABLE.has(primary.state)) {
    return {
      action: "reopen",
      leadId: primary.leadId,
      reason: "reopened a previously closed lead",
    };
  }

  // e.g. opted_out / won — do not silently reopen; flag it.
  return {
    action: "flag_for_review",
    leadIds: [primary.leadId],
    reason: `matched a lead in terminal state '${primary.state}'`,
  };
}
