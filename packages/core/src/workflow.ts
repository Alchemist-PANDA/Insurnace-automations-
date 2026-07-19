import type { LeadState } from "./types.js";

/**
 * Follow-up workflow engine (plan: blueprint §5J, PLAN M8). Sequences are
 * state-triggered, not merely time-based: a trigger starts a run, and each step
 * runs after a delay unless a stop condition has become true. Pure logic here;
 * the worker persists runs/steps and schedules durable delayed jobs.
 */

export type WorkflowTrigger =
  | "lead_received"
  | "no_reply"
  | "replied_not_qualified"
  | "qualified_not_booked"
  | "appointment_booked"
  | "appointment_cancelled"
  | "no_show"
  | "human_takeover"
  | "deal_won"
  | "deal_lost"
  | "opt_out";

export type WorkflowAction =
  | { type: "send_sms"; templateKey: string }
  | { type: "send_email"; templateKey: string }
  | { type: "create_task"; note: string }
  | { type: "notify_user"; note: string }
  | { type: "stop" };

export interface WorkflowStepDef {
  key: string;
  /** Delay from the previous step (or trigger) before this step runs, seconds. */
  afterSeconds: number;
  action: WorkflowAction;
}

export interface WorkflowDefinition {
  key: string;
  version: number;
  trigger: WorkflowTrigger;
  steps: WorkflowStepDef[];
}

/**
 * Stop conditions (plan: blueprint §5J). When any is true, automation for the
 * lead pauses/stops immediately — checked before every step so a booking or
 * opt-out mid-sequence halts it.
 */
const STOP_STATES = new Set<LeadState>([
  "opted_out",
  "booked",
  "human_owned",
  "won",
  "lost",
  "archived",
]);

export interface StopContext {
  state: LeadState;
  complaintDetected?: boolean;
  deliveryFailureLockout?: boolean;
}

export function shouldStop(ctx: StopContext): { stop: boolean; reason?: string } {
  if (STOP_STATES.has(ctx.state)) return { stop: true, reason: `state=${ctx.state}` };
  if (ctx.complaintDetected) return { stop: true, reason: "complaint" };
  if (ctx.deliveryFailureLockout) return { stop: true, reason: "delivery_failures" };
  return { stop: false };
}

/** The step at an index, or null when the sequence is finished. */
export function stepAt(def: WorkflowDefinition, index: number): WorkflowStepDef | null {
  return def.steps[index] ?? null;
}

// ── Default sequences (data; per-tenant override later) ─────────────────────

export const DEFAULT_WORKFLOWS: WorkflowDefinition[] = [
  {
    key: "new_lead_no_reply",
    version: 1,
    trigger: "no_reply",
    steps: [
      { key: "sms_1", afterSeconds: 300, action: { type: "send_sms", templateKey: "followup_1" } },
      { key: "email_1", afterSeconds: 3600, action: { type: "send_email", templateKey: "followup_email_1" } },
      { key: "sms_2", afterSeconds: 86_400, action: { type: "send_sms", templateKey: "followup_2" } },
      { key: "task", afterSeconds: 172_800, action: { type: "create_task", note: "Call lead — no reply after 2 days" } },
      { key: "stop", afterSeconds: 259_200, action: { type: "stop" } },
    ],
  },
  {
    key: "qualified_not_booked",
    version: 1,
    trigger: "qualified_not_booked",
    steps: [
      { key: "sms_1", afterSeconds: 1800, action: { type: "send_sms", templateKey: "book_reminder_1" } },
      { key: "sms_2", afterSeconds: 86_400, action: { type: "send_sms", templateKey: "book_reminder_2" } },
      { key: "task", afterSeconds: 172_800, action: { type: "create_task", note: "Qualified but not booked — call" } },
      { key: "stop", afterSeconds: 259_200, action: { type: "stop" } },
    ],
  },
  {
    key: "no_show_recovery",
    version: 1,
    trigger: "no_show",
    steps: [
      { key: "sms_1", afterSeconds: 3600, action: { type: "send_sms", templateKey: "no_show_1" } },
      { key: "task", afterSeconds: 86_400, action: { type: "create_task", note: "No-show — reschedule" } },
      { key: "stop", afterSeconds: 172_800, action: { type: "stop" } },
    ],
  },
];

export function findWorkflow(trigger: WorkflowTrigger): WorkflowDefinition | null {
  return DEFAULT_WORKFLOWS.find((w) => w.trigger === trigger) ?? null;
}
