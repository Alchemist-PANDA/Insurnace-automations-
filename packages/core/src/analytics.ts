/**
 * Analytics engine (plan: blueprint §6/§7, PLAN M10). Pure functions computing
 * response-time percentiles, funnel rates, and gross-profit ROI from immutable
 * lead-event timestamps. No I/O — the caller loads events; this computes.
 */

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const frac = rank - low;
  return sorted[low]! * (1 - frac) + sorted[high]! * frac;
}

export interface ResponsePair {
  receivedAt: number; // ms epoch of lead.received
  firstSentAt: number | null; // ms epoch of first message.sent
}

export interface ResponseTimeStats {
  count: number;
  contacted: number;
  medianMs: number;
  p90Ms: number;
  withinPct: { s30: number; s60: number; s90: number };
}

export function responseTimeStats(pairs: ResponsePair[]): ResponseTimeStats {
  const deltas = pairs
    .filter((p) => p.firstSentAt !== null)
    .map((p) => p.firstSentAt! - p.receivedAt)
    .filter((d) => d >= 0);
  const within = (ms: number) => deltas.filter((d) => d <= ms).length;
  const pct = (n: number) => (deltas.length === 0 ? 0 : Math.round((n / deltas.length) * 1000) / 10);
  return {
    count: pairs.length,
    contacted: deltas.length,
    medianMs: Math.round(percentile(deltas, 50)),
    p90Ms: Math.round(percentile(deltas, 90)),
    withinPct: {
      s30: pct(within(30_000)),
      s60: pct(within(60_000)),
      s90: pct(within(90_000)),
    },
  };
}

export interface FunnelCounts {
  total: number;
  contacted: number;
  replied: number;
  qualified: number;
  booked: number;
  won: number;
}

export interface FunnelRates {
  contactRate: number;
  replyRate: number;
  qualificationRate: number;
  bookingRate: number;
  closeRate: number;
}

const rate = (num: number, den: number) => (den === 0 ? 0 : Math.round((num / den) * 1000) / 10);

export function funnelRates(c: FunnelCounts): FunnelRates {
  return {
    contactRate: rate(c.contacted, c.total),
    replyRate: rate(c.replied, c.contacted),
    qualificationRate: rate(c.qualified, c.total),
    bookingRate: rate(c.booked, c.qualified),
    closeRate: rate(c.won, c.booked),
  };
}

/**
 * Gross-profit ROI (plan: blueprint §7). Uses gross profit, not top-line
 * revenue, and separates automation cost. Returns a ratio (e.g. 3.0 = 300%).
 */
export interface RoiInput {
  incrementalGrossProfit: number;
  automationCost: number;
}

export function roi(input: RoiInput): number {
  if (input.automationCost <= 0) return 0;
  return Math.round(((input.incrementalGrossProfit - input.automationCost) / input.automationCost) * 100) / 100;
}

export function incrementalGrossProfit(args: {
  eligibleLeads: number;
  baselineCloseRate: number; // 0..1
  postCloseRate: number; // 0..1
  avgGrossProfitPerDeal: number;
}): number {
  const incrementalDeals =
    args.eligibleLeads * Math.max(0, args.postCloseRate - args.baselineCloseRate);
  return Math.round(incrementalDeals * args.avgGrossProfitPerDeal);
}
