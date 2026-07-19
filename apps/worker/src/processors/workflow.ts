import { eq, and } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import {
  findWorkflow,
  stepAt,
  shouldStop,
  type WorkflowDefinition,
  type WorkflowTrigger,
  type LeadState,
} from "@stl/core";
import { QUEUE, type WorkflowJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface WorkflowResult {
  status: "started" | "step_executed" | "stopped" | "completed" | "no_workflow";
  runId?: string;
  stopReason?: string;
}

/**
 * Workflow/follow-up engine (plan: blueprint §5J, PLAN M8). A trigger starts a
 * run; each step runs after a durable delay UNLESS a stop condition has become
 * true (booking, opt-out, takeover, etc.), which is checked before every step.
 * Every run and step is persisted — no follow-up disappears silently.
 */
export async function processWorkflow(
  deps: WorkerDeps,
  job: WorkflowJob,
): Promise<WorkflowResult> {
  const def = findWorkflow(job.trigger as WorkflowTrigger);
  if (!def) return { status: "no_workflow" };

  // Starting a fresh run vs. advancing an existing one.
  if (!job.runId) {
    return startRun(deps, job, def);
  }
  return advanceRun(deps, job, def);
}

async function startRun(
  deps: WorkerDeps,
  job: WorkflowJob,
  def: WorkflowDefinition,
): Promise<WorkflowResult> {
  const { db, clock } = deps;
  const runId = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    // One active run per (lead, workflow) — don't stack duplicate sequences.
    const existing = await tx
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.leadId, job.leadId),
          eq(schema.workflowRuns.workflowKey, def.key),
          eq(schema.workflowRuns.status, "running"),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id;

    const [run] = await tx
      .insert(schema.workflowRuns)
      .values({
        tenantId: job.tenantId,
        leadId: job.leadId,
        workflowKey: def.key,
        version: def.version,
        trigger: def.trigger,
        status: "running",
        currentStep: 0,
      })
      .returning({ id: schema.workflowRuns.id });
    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId: job.leadId,
      type: "workflow.started",
      correlationId: job.correlationId,
      payload: { workflowKey: def.key },
    });
    return run!.id;
  });

  // Schedule the first step.
  const first = stepAt(def, 0);
  if (first) {
    await deps.enqueue(
      QUEUE.workflow,
      `wf:${runId}:0`,
      { tenantId: job.tenantId, leadId: job.leadId, trigger: job.trigger, runId, stepKey: first.key, correlationId: job.correlationId },
      { delay: first.afterSeconds * 1000 },
    );
  }
  void clock;
  return { status: "started", runId };
}

async function advanceRun(
  deps: WorkerDeps,
  job: WorkflowJob,
  def: WorkflowDefinition,
): Promise<WorkflowResult> {
  const { db, clock } = deps;
  const runId = job.runId!;

  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .limit(1);
    if (!run || run.status !== "running") {
      return { status: "stopped" as const, stopReason: run?.stopReason ?? "not_running" };
    }

    const [lead] = await tx
      .select({ state: schema.leads.state })
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    if (!lead) return { status: "stopped" as const, stopReason: "lead_missing" };

    // Stop conditions checked before every step.
    const stop = shouldStop({ state: lead.state as LeadState });
    if (stop.stop) {
      await stopRun(tx, job, runId, stop.reason ?? "stop_condition");
      return { status: "stopped" as const, stopReason: stop.reason };
    }

    const idx = run.currentStep;
    const step = stepAt(def, idx);
    if (!step || step.action.type === "stop") {
      await completeRun(tx, job, runId);
      return { status: "completed" as const, runId };
    }

    // Execute the action.
    await executeAction(tx, deps, job, def, step.key, step.action);
    await tx.insert(schema.workflowSteps).values({
      tenantId: job.tenantId,
      runId,
      stepKey: step.key,
      actionType: step.action.type,
      status: "executed",
      executedAt: clock.now(),
    });
    await tx
      .update(schema.workflowRuns)
      .set({ currentStep: idx + 1 })
      .where(eq(schema.workflowRuns.id, runId));

    // Schedule the next step (durable delayed job).
    const next = stepAt(def, idx + 1);
    if (next) {
      await deps.enqueue(
        QUEUE.workflow,
        `wf:${runId}:${idx + 1}`,
        { tenantId: job.tenantId, leadId: job.leadId, trigger: job.trigger, runId, stepKey: next.key, correlationId: job.correlationId },
        { delay: next.afterSeconds * 1000 },
      );
    } else {
      await completeRun(tx, job, runId);
    }

    return { status: "step_executed" as const, runId };
  });
}

async function executeAction(
  tx: Database,
  deps: WorkerDeps,
  job: WorkflowJob,
  def: WorkflowDefinition,
  stepKey: string,
  action: WorkflowDefinition["steps"][number]["action"],
): Promise<void> {
  switch (action.type) {
    case "create_task":
    case "notify_user": {
      await tx.insert(schema.tasks).values({
        tenantId: job.tenantId,
        leadId: job.leadId,
        note: action.note,
      });
      break;
    }
    case "send_sms":
    case "send_email": {
      // Enqueue through the same outbox path the conversation engine uses, so
      // consent/suppression/quiet-hours still gate the send. Here we record the
      // intent as an event; the message composition reuses templates.
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        type: "workflow.message_requested",
        correlationId: job.correlationId,
        payload: { templateKey: action.templateKey, channel: action.type },
      });
      break;
    }
    case "stop":
      break;
  }
  await audit(tx, {
    tenantId: job.tenantId,
    actorType: "system",
    action: `workflow.${action.type}`,
    entityType: "lead",
    entityId: job.leadId,
    after: { workflowKey: def.key, stepKey },
    correlationId: job.correlationId,
  });
}

async function stopRun(tx: Database, job: WorkflowJob, runId: string, reason: string) {
  await tx
    .update(schema.workflowRuns)
    .set({ status: "stopped", stopReason: reason, endedAt: new Date() })
    .where(eq(schema.workflowRuns.id, runId));
  await emitEvent(tx, {
    tenantId: job.tenantId,
    leadId: job.leadId,
    type: "workflow.stopped",
    correlationId: job.correlationId,
    payload: { runId, reason },
  });
}

async function completeRun(tx: Database, job: WorkflowJob, runId: string) {
  await tx
    .update(schema.workflowRuns)
    .set({ status: "completed", endedAt: new Date() })
    .where(eq(schema.workflowRuns.id, runId));
  await emitEvent(tx, {
    tenantId: job.tenantId,
    leadId: job.leadId,
    type: "workflow.completed",
    correlationId: job.correlationId,
    payload: { runId },
  });
}
