import type { Database } from "@stl/db";
import type { MessageChannel } from "@stl/messaging";
import type { LlmProvider } from "@stl/llm";
import type { Clock } from "@stl/core";
import { systemClock } from "@stl/core";

/**
 * Dependency container for processors. Injecting db, the message channel, the
 * clock, and the enqueue function keeps every processor a testable unit and
 * lets the E2E test drive them with a FakeSmsChannel and a controlled clock.
 */
export interface WorkerDeps {
  db: Database;
  sms: MessageChannel;
  llm: LlmProvider;
  clock: Clock;
  /** Enqueue a follow-on job; the E2E test replaces this with a collector. */
  enqueue: (queue: string, jobId: string, data: unknown) => Promise<void>;
}

export function makeDeps(
  partial: Partial<WorkerDeps> & { db: Database; sms: MessageChannel; llm: LlmProvider },
): WorkerDeps {
  return {
    clock: systemClock,
    enqueue: async () => {},
    ...partial,
  };
}
