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
} from "@stl/queue";
import { FakeSmsChannel, TwilioSmsChannel, type MessageChannel } from "@stl/messaging";
import { systemClock } from "@stl/core";
import { makeDeps } from "./deps.js";
import { processIngest } from "./processors/ingest.js";
import { processFirstTouch } from "./processors/first-touch.js";
import { processMessagingOut } from "./processors/relay.js";
import { processMessagingEvent } from "./processors/messaging-events.js";

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

  const deps = makeDeps({
    db,
    sms,
    clock: systemClock,
    enqueue: (queue, jobId, data) =>
      realEnqueue(queue as never, jobId, data as never),
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
