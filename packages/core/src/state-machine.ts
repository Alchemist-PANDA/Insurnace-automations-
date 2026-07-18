import type { LeadState } from "./types.js";

/**
 * Lead state machine (plan: data-model §4). Invalid transitions are rejected
 * and audited by the caller — there is no undefined behavior.
 */

/** Allowed transitions between "normal flow" states. */
const TRANSITIONS: Record<LeadState, LeadState[]> = {
  received: ["processing", "archived"],
  processing: ["new", "unqualified", "archived"],
  new: ["contacted", "nurture", "unqualified", "archived"],
  contacted: ["engaged", "nurture", "unqualified", "archived"],
  // A single substantive reply can fully qualify a lead, so engaged → qualified
  // is permitted in addition to the stepwise engaged → qualifying → qualified.
  engaged: ["qualifying", "qualified", "unqualified", "nurture", "archived"],
  qualifying: ["qualified", "unqualified", "nurture", "archived"],
  qualified: ["appointment_offered", "lost", "nurture", "archived"],
  appointment_offered: ["booked", "qualified", "lost", "nurture", "archived"],
  booked: ["won", "lost", "appointment_offered", "archived"],
  nurture: ["engaged", "contacted", "unqualified", "archived"],
  unqualified: ["archived", "new"],
  won: ["archived"],
  lost: ["archived", "nurture"],
  // human_owned and opted_out are handled as cross-cutting transitions below.
  human_owned: [
    "contacted",
    "engaged",
    "qualifying",
    "qualified",
    "appointment_offered",
    "booked",
    "nurture",
    "unqualified",
    "lost",
    "won",
    "archived",
  ],
  opted_out: ["archived"],
  archived: [],
};

/**
 * Cross-cutting transitions allowed from any active (non-terminal) state.
 * - Takeover moves to human_owned from anywhere.
 * - Opt-out moves to opted_out from anywhere and is terminal for automation.
 */
const ACTIVE_STATES = new Set<LeadState>([
  "received",
  "processing",
  "new",
  "contacted",
  "engaged",
  "qualifying",
  "qualified",
  "appointment_offered",
  "booked",
  "nurture",
  "human_owned",
]);

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

export function canTransition(from: LeadState, to: LeadState): TransitionResult {
  if (from === to) return { ok: true };

  // Opt-out: always allowed from any active state; terminal thereafter.
  if (to === "opted_out") {
    return ACTIVE_STATES.has(from)
      ? { ok: true }
      : { ok: false, reason: `cannot opt out from terminal state '${from}'` };
  }

  // Human takeover: allowed from any active state.
  if (to === "human_owned") {
    return ACTIVE_STATES.has(from)
      ? { ok: true }
      : {
          ok: false,
          reason: `cannot take over from terminal state '${from}'`,
        };
  }

  const allowed = TRANSITIONS[from];
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    reason: `illegal transition ${from} → ${to}`,
  };
}

/** Throwing variant for call sites that treat an illegal transition as a bug. */
export function assertTransition(from: LeadState, to: LeadState): void {
  const result = canTransition(from, to);
  if (!result.ok) {
    throw new Error(result.reason ?? `illegal transition ${from} → ${to}`);
  }
}

export const TERMINAL_STATES: ReadonlySet<LeadState> = new Set([
  "won",
  "lost",
  "opted_out",
  "archived",
]);
