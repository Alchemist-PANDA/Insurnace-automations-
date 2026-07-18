/**
 * Lead routing engine (plan: blueprint §5G, PLAN M5). Pure decision function:
 * given a lead and the candidate reps (already loaded by the worker), pick the
 * primary assignee and the ordered fallback chain. Strategies compose in
 * priority order; an unavailable rep never traps a hot lead.
 */

export interface RepCandidate {
  userId: string;
  active: boolean;
  /** Territories (e.g. ZIP prefixes or region codes) this rep covers. */
  territories: string[];
  /** Services this rep specializes in; empty = generalist. */
  specialties: string[];
  /** Is the rep currently within working hours + marked available. */
  available: boolean;
  /** Open leads currently assigned — used for workload balancing. */
  workload: number;
  /** Max concurrent open leads before the rep is skipped for new ones. */
  workloadCap: number;
  /** True if this rep already owns the lead's contact (existing customer). */
  ownsContact?: boolean;
}

export interface RoutingInput {
  postalCode: string | null;
  region: string | null;
  serviceRequested: string | null;
  band: string;
}

export interface RoutingConfig {
  /** Ordered strategies to apply as filters/preferences. */
  strategies: ("territory" | "specialization" | "availability" | "workload" | "round_robin")[];
  /** Rolling round-robin cursor (index into the sorted candidate list). */
  roundRobinCursor: number;
}

export interface RoutingResult {
  primaryUserId: string | null;
  fallbackUserIds: string[];
  reason: string;
  /** Next round-robin cursor to persist. */
  nextCursor: number;
}

function territoryMatch(rep: RepCandidate, input: RoutingInput): boolean {
  if (rep.territories.length === 0) return true; // no territory = covers all
  const keys = [input.postalCode ?? "", input.region ?? ""].filter(Boolean);
  return rep.territories.some((t) =>
    keys.some((k) => k === t || k.startsWith(t)),
  );
}

function specialtyMatch(rep: RepCandidate, input: RoutingInput): boolean {
  if (rep.specialties.length === 0) return true; // generalist
  if (!input.serviceRequested) return true;
  const svc = input.serviceRequested.toLowerCase();
  return rep.specialties.some((s) => svc.includes(s.toLowerCase()) || s.toLowerCase().includes(svc));
}

export function routeLead(
  input: RoutingInput,
  candidates: RepCandidate[],
  config: RoutingConfig,
): RoutingResult {
  const active = candidates.filter((c) => c.active);

  // Existing-customer ownership wins outright.
  const owner = active.find((c) => c.ownsContact);
  if (owner) {
    return {
      primaryUserId: owner.userId,
      fallbackUserIds: active.filter((c) => c.userId !== owner.userId).map((c) => c.userId),
      reason: "existing-customer ownership",
      nextCursor: config.roundRobinCursor,
    };
  }

  // Apply hard filters from the configured strategies.
  let pool = active;
  const reasons: string[] = [];

  if (config.strategies.includes("territory")) {
    const filtered = pool.filter((c) => territoryMatch(c, input));
    if (filtered.length > 0) {
      pool = filtered;
      reasons.push("territory");
    }
  }
  if (config.strategies.includes("specialization")) {
    const filtered = pool.filter((c) => specialtyMatch(c, input));
    if (filtered.length > 0) {
      pool = filtered;
      reasons.push("specialization");
    }
  }

  // Prefer available reps under their workload cap, but keep others as fallback.
  const eligible = pool.filter(
    (c) => c.available && c.workload < c.workloadCap,
  );
  const orderedFallback = [...pool].sort((a, b) => a.workload - b.workload);

  const primaryPool = eligible.length > 0 ? eligible : orderedFallback;
  if (primaryPool.length === 0) {
    return {
      primaryUserId: null,
      fallbackUserIds: [],
      reason: "no eligible reps — route to fallback queue",
      nextCursor: config.roundRobinCursor,
    };
  }

  // Workload-weighted, then round-robin as the final tie-breaker for fairness.
  let primary: RepCandidate;
  let nextCursor = config.roundRobinCursor;
  if (config.strategies.includes("workload")) {
    const sorted = [...primaryPool].sort((a, b) => a.workload - b.workload);
    primary = sorted[0]!;
    reasons.push("workload");
  } else if (config.strategies.includes("round_robin")) {
    const idx = config.roundRobinCursor % primaryPool.length;
    primary = primaryPool[idx]!;
    nextCursor = config.roundRobinCursor + 1;
    reasons.push("round_robin");
  } else {
    primary = primaryPool[0]!;
  }

  return {
    primaryUserId: primary.userId,
    fallbackUserIds: orderedFallback
      .filter((c) => c.userId !== primary.userId)
      .map((c) => c.userId),
    reason: reasons.join("+") || "default",
    nextCursor,
  };
}

/**
 * SLA escalation ladder (plan: blueprint §5G). Time-offset steps for a hot lead;
 * each step is scheduled as a durable delayed job and cancelled on acknowledgment.
 */
export interface EscalationStep {
  afterSeconds: number;
  action: "assign_primary" | "notify_primary" | "notify_secondary" | "notify_manager" | "fallback_queue";
}

export const DEFAULT_ESCALATION: EscalationStep[] = [
  { afterSeconds: 0, action: "assign_primary" },
  { afterSeconds: 30, action: "notify_primary" },
  { afterSeconds: 60, action: "notify_secondary" },
  { afterSeconds: 120, action: "notify_manager" },
  { afterSeconds: 300, action: "fallback_queue" },
];
