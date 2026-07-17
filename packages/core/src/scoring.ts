import type { ScoreBand } from "./types.js";

/**
 * Explainable, rules-based lead scoring (plan: blueprint §5F, PLAN M4).
 * No predictive ML. Every point is attributable to a named rule so a
 * salesperson can read "Score 84: service-area match +20, urgent leak +20…".
 *
 * A ScoringModel is data (shipped per-vertical, overridable per-tenant). The
 * engine is a pure evaluator over a flat fact bag derived from the lead plus
 * its engagement events.
 */

export type ScoreCategory =
  | "fit"
  | "intent"
  | "urgency"
  | "engagement"
  | "negative";

export interface ScoringFacts {
  // fit
  insideServiceArea?: boolean;
  eligibleService?: boolean;
  eligiblePropertyType?: boolean;
  validPhone?: boolean;
  validEmail?: boolean;
  // intent
  askedPricing?: boolean;
  requestedAppointment?: boolean;
  hasClearProject?: boolean;
  repliedQuickly?: boolean;
  providedDetail?: boolean;
  // urgency
  activeEmergency?: boolean;
  within30Days?: boolean;
  insuranceDeadline?: boolean;
  // engagement
  repliedToSms?: boolean;
  clickedBookingLink?: boolean;
  openedEmail?: boolean;
  answeredQualification?: boolean;
  calledBusiness?: boolean;
  // negatives
  isDuplicate?: boolean;
  outsideServiceArea?: boolean;
  jobSeekerOrStudent?: boolean;
  supplierSolicitation?: boolean;
  invalidPhone?: boolean;
  abusiveContent?: boolean;
  obviousSpam?: boolean;
  repeatedNoShows?: boolean;
}

export interface ScoringRule {
  key: string;
  category: ScoreCategory;
  /** Positive for additive rules, negative for penalties. */
  points: number;
  /** Which fact flag turns this rule on. */
  when: keyof ScoringFacts;
  label: string;
}

export interface ScoringModel {
  version: string;
  rules: ScoringRule[];
  /** Category caps enforce the 35/30/20/15 budgets from the blueprint. */
  caps: Partial<Record<ScoreCategory, number>>;
  bands: {
    hot: number; // inclusive lower bound
    qualified: number;
    nurture: number;
  };
}

export interface ScoreLine {
  rule: string;
  label: string;
  category: ScoreCategory;
  points: number;
}

export interface ScoreResult {
  total: number;
  band: ScoreBand;
  breakdown: ScoreLine[];
  /** Human-readable one-liner for the UI and CRM notes. */
  explanation: string;
}

function bandFor(total: number, bands: ScoringModel["bands"]): ScoreBand {
  if (total >= bands.hot) return "hot";
  if (total >= bands.qualified) return "qualified";
  if (total >= bands.nurture) return "nurture";
  return "unqualified";
}

export function scoreLead(
  model: ScoringModel,
  facts: ScoringFacts,
): ScoreResult {
  const lines: ScoreLine[] = [];
  const categoryTotals = new Map<ScoreCategory, number>();

  for (const rule of model.rules) {
    if (facts[rule.when] !== true) continue;

    const cap = model.caps[rule.category];
    const current = categoryTotals.get(rule.category) ?? 0;

    let points = rule.points;
    // Apply positive category caps (negatives are not capped upward).
    if (cap !== undefined && rule.points > 0) {
      const room = Math.max(0, cap - current);
      points = Math.min(rule.points, room);
      if (points === 0) continue; // category budget exhausted
    }

    categoryTotals.set(rule.category, current + points);
    lines.push({
      rule: rule.key,
      label: rule.label,
      category: rule.category,
      points,
    });
  }

  const rawTotal = lines.reduce((sum, l) => sum + l.points, 0);
  const total = Math.max(0, Math.min(100, rawTotal));
  const band = bandFor(total, model.bands);

  const explanation =
    `Score ${total}: ` +
    (lines.length === 0
      ? "no scoring signals"
      : lines
          .map((l) => `${l.label} ${l.points >= 0 ? "+" : ""}${l.points}`)
          .join(", "));

  return { total, band, breakdown: lines, explanation };
}
