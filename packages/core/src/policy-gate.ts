import type { Channel, ConsentSnapshot, Clock } from "./types.js";

/**
 * The deterministic policy gate (plan: conversation-engine §3).
 *
 * "The LLM interprets and drafts. The application decides and sends."
 *
 * No proposed outbound action reaches a lead without passing every check here.
 * Pure functions only: the clock is injected, nothing does I/O. Even a fully
 * hijacked LLM output can at worst propose an allowlisted action that must
 * still clear these gates.
 */

export const ALLOWED_ACTIONS = [
  "send_reply",
  "offer_slots",
  "alert_rep",
  "create_task",
  "update_facts",
] as const;
export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

export interface QuietHours {
  /** Local hour [0-23] when sending may begin. */
  startHour: number;
  /** Local hour [0-23] after which sending must stop. */
  endHour: number;
  /** IANA timezone the hours are expressed in. */
  timezone: string;
}

export interface KnowledgeRef {
  id: string;
  type:
    | "service"
    | "service_area"
    | "hours"
    | "pricing_guidance"
    | "financing"
    | "warranty"
    | "faq"
    | "exclusion"
    | "escalation_rule"
    | "promotion";
}

export interface PolicyContext {
  channel: Channel;
  consent: ConsentSnapshot;
  isSuppressed: boolean;
  quietHours: QuietHours;
  clock: Clock;
  /** Automated messages already sent to this lead in the rolling window. */
  followUpsSentInWindow: number;
  followUpCap: number;
  deliveryLockout: boolean; // repeated delivery failures on this channel
  approvedKnowledge: KnowledgeRef[];
}

export interface ProposedAction {
  action: string; // may be anything the LLM produced — validated here
  replyText?: string;
  knowledgeRefs?: string[]; // ids the reply relies on
}

export type GateVerdict =
  | { allowed: true; scheduledFor?: "now" | "next_window" }
  | { allowed: false; reason: string; code: GateRejectCode };

export type GateRejectCode =
  | "action_not_allowlisted"
  | "no_consent"
  | "suppressed"
  | "delivery_lockout"
  | "follow_up_cap"
  | "unverified_claim"
  | "empty_reply";

// Patterns that indicate a claim requiring approved knowledge to back it.
const CLAIM_PATTERNS: { pattern: RegExp; requires: KnowledgeRef["type"] }[] = [
  { pattern: /\$\s?\d|\d+\s?(dollars|usd)\b/i, requires: "pricing_guidance" },
  { pattern: /\b\d+\s?%\s?(off|discount)\b/i, requires: "promotion" },
  { pattern: /\bwe\s+guarantee\b|\bguaranteed\b|\bwe\s+promise\b/i, requires: "warranty" },
  { pattern: /\bfinanc(e|ing)\b|\bmonthly\s+payment\b|\b0%\s+apr\b/i, requires: "financing" },
];

function hasKnowledgeOfType(
  refs: string[] | undefined,
  approved: KnowledgeRef[],
  type: KnowledgeRef["type"],
): boolean {
  if (!refs || refs.length === 0) return false;
  const approvedById = new Map(approved.map((k) => [k.id, k]));
  return refs.some((id) => approvedById.get(id)?.type === type);
}

function isWithinQuietHours(clock: Clock, qh: QuietHours): boolean {
  // Compute the local hour in the configured timezone deterministically.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: qh.timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(clock.now());
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = Number(hourStr) % 24;
  return hour >= qh.startHour && hour < qh.endHour;
}

/**
 * Evaluate a proposed outbound action. Checks run in a fixed order; the first
 * failure wins and is recorded (caller writes it to messages.policy_snapshot).
 */
export function evaluatePolicy(
  ctx: PolicyContext,
  proposed: ProposedAction,
): GateVerdict {
  // 1. Tool allowlist — the LLM has no verbs beyond these.
  if (!ALLOWED_ACTIONS.includes(proposed.action as AllowedAction)) {
    return {
      allowed: false,
      code: "action_not_allowlisted",
      reason: `action '${proposed.action}' is not on the allowlist`,
    };
  }

  // Non-sending actions (alert_rep, create_task, update_facts) still must not
  // fire for suppressed leads, but they don't need consent/quiet-hours.
  const isSend = proposed.action === "send_reply" || proposed.action === "offer_slots";

  if (ctx.isSuppressed) {
    return { allowed: false, code: "suppressed", reason: "lead is suppressed" };
  }

  if (!isSend) {
    return { allowed: true };
  }

  // 2. Consent for the channel.
  if (ctx.consent.status !== "granted") {
    return {
      allowed: false,
      code: "no_consent",
      reason: `no granted consent for channel '${ctx.channel}'`,
    };
  }

  // 3. Delivery lockout after repeated failures.
  if (ctx.deliveryLockout) {
    return {
      allowed: false,
      code: "delivery_lockout",
      reason: "channel is in delivery-failure lockout",
    };
  }

  // 4. Follow-up caps.
  if (ctx.followUpsSentInWindow >= ctx.followUpCap) {
    return {
      allowed: false,
      code: "follow_up_cap",
      reason: `follow-up cap (${ctx.followUpCap}) reached`,
    };
  }

  const reply = (proposed.replyText ?? "").trim();
  if (reply.length === 0) {
    return { allowed: false, code: "empty_reply", reason: "reply is empty" };
  }

  // 5. Claim verification — any priced/guaranteed/discount/financing claim must
  // be backed by an approved knowledge entry of the matching type.
  for (const { pattern, requires } of CLAIM_PATTERNS) {
    if (pattern.test(reply)) {
      if (!hasKnowledgeOfType(proposed.knowledgeRefs, ctx.approvedKnowledge, requires)) {
        return {
          allowed: false,
          code: "unverified_claim",
          reason: `reply makes a '${requires}' claim not backed by approved knowledge`,
        };
      }
    }
  }

  // 6. Quiet hours — schedulable to the next allowed window if outside.
  const scheduledFor = isWithinQuietHours(ctx.clock, ctx.quietHours)
    ? "now"
    : "next_window";

  return { allowed: true, scheduledFor };
}
