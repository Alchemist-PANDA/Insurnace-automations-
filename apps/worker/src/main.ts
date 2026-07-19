import { loadEnv } from "@stl/config";
import { createLogger } from "@stl/logger";
import { getDb } from "@stl/db";
import {
  createWorker,
  enqueue as realEnqueue,
  QUEUE,
  type IngestJob,
  type FirstTouchJob,
  type MessagingOutJob,
  type MessagingEventJob,
  type ConversationJob,
  type BookingJob,
  type CrmSyncJob,
  type AssignJob,
  type EscalationJob,
  type WorkflowJob,
} from "@stl/queue";
import { FakeSmsChannel, TwilioSmsChannel, type MessageChannel } from "@stl/messaging";
import { FakeLlm, AnthropicLlm, type LlmProvider } from "@stl/llm";
import { FakeCalendar, type CalendarProvider } from "@stl/calendar";
import { FakeCrm, HubSpotCrm, type CrmAdapter } from "@stl/crm";
import { systemClock } from "@stl/core";
import { makeDeps } from "./deps.js";
import { processIngest } from "./processors/ingest.js";
import { processFirstTouch } from "./processors/first-touch.js";
import { processMessagingOut } from "./processors/relay.js";
import { processMessagingEvent } from "./processors/messaging-events.js";
import { processConversation } from "./processors/conversation.js";
import { processBooking } from "./processors/booking.js";
import { processCrmSync } from "./processors/crm-sync.js";
import { processAssignment } from "./processors/assignment.js";
import { processEscalation } from "./processors/escalation.js";
import { processWorkflow } from "./processors/workflow.js";

/**
 * Worker entrypoint — wires processors to BullMQ queues (plan: architecture
 * §5.2). Business logic lives in the processors; this file is just plumbing.
 */
async function main() {
  const env = loadEnv();
  const log = createLogger({ service: "worker" });
  const db = getDb();

  const sms: MessageChannel =
    env.USE_FAKE_ADAPTERS || !env.TWILIO_ACCOUNT_SID
      ? new FakeSmsChannel()
      : new TwilioSmsChannel({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
        });

  const llm: LlmProvider =
    env.USE_FAKE_ADAPTERS || !env.ANTHROPIC_API_KEY
      ? new FakeLlm()
      : new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL });

  const calendar: CalendarProvider = new FakeCalendar();
  const crm: CrmAdapter = env.USE_FAKE_ADAPTERS ? new FakeCrm() : new HubSpotCrm();

  const deps = makeDeps({
    db,
    sms,
    llm,
    calendar,
    crm,
    clock: systemClock,
    enqueue: (queue, jobId, data, opts) =>
      realEnqueue(queue as never, jobId, data as never, opts ?? {}),
  });

  const workers = [
    createWorker(QUEUE.ingest, (job) => processIngest(deps, job.data as IngestJob)),
    createWorker(QUEUE.firstTouch, (job) =>
      processFirstTouch(deps, job.data as FirstTouchJob),
    ),
    createWorker(QUEUE.messagingOut, (job) =>
      processMessagingOut(deps, job.data as MessagingOutJob),
    ),
    createWorker(QUEUE.messagingEvents, (job) =>
      processMessagingEvent(deps, job.data as MessagingEventJob),
    ),
    createWorker(QUEUE.conversation, (job) =>
      processConversation(deps, job.data as ConversationJob),
    ),
    createWorker(QUEUE.calendar, (job) => processBooking(deps, job.data as BookingJob)),
    createWorker(QUEUE.crmSync, (job) => processCrmSync(deps, job.data as CrmSyncJob)),
    createWorker(QUEUE.routing, (job) => processAssignment(deps, job.data as AssignJob)),
    createWorker(QUEUE.escalation, (job) => processEscalation(deps, job.data as EscalationJob)),
    createWorker(QUEUE.workflow, (job) => processWorkflow(deps, job.data as WorkflowJob)),
  ];

  for (const w of workers) {
    w.on("failed", (job, err) =>
      log.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"),
    );
  }

  log.info(
    { adapters: env.USE_FAKE_ADAPTERS ? "fake" : "twilio" },
    "worker started; consuming queues",
  );

  const shutdown = async () => {
    log.info("shutting down workers…");
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
