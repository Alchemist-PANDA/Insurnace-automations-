import { Queue, Worker, type ConnectionOptions, type Processor } from "bullmq";

/**
 * Queue topology (plan: architecture §5.2). Job payload types are the contract
 * between the API (producers) and the worker (consumers).
 */

export const QUEUE = {
  ingest: "ingest",
  firstTouch: "first-touch",
  messagingOut: "messaging-out",
  messagingEvents: "messaging-events",
  conversation: "conversation",
  workflow: "workflow",
  escalation: "escalation",
  crmSync: "crm-sync",
  calendar: "calendar",
  rollup: "rollup",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// ─── Job payloads ───────────────────────────────────────────────────────────

export interface IngestJob {
  tenantId: string;
  sourceId: string;
  rawWebhookId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface FirstTouchJob {
  tenantId: string;
  leadId: string;
  correlationId: string;
}

export interface MessagingOutJob {
  tenantId: string;
  outboxId: string;
  correlationId: string;
}

export interface MessagingEventJob {
  tenantId: string;
  kind: "inbound" | "status";
  payload: Record<string, unknown>;
  correlationId: string;
}

export interface ConversationJob {
  tenantId: string;
  leadId: string;
  correlationId: string;
}

export interface CrmSyncJob {
  tenantId: string;
  leadId: string;
  correlationId: string;
}

export interface BookingJob {
  tenantId: string;
  leadId: string;
  calendarConnectionId: string;
  startsAt: string; // ISO
  endsAt: string; // ISO
  correlationId: string;
}

export interface JobMap {
  [QUEUE.ingest]: IngestJob;
  [QUEUE.firstTouch]: FirstTouchJob;
  [QUEUE.messagingOut]: MessagingOutJob;
  [QUEUE.messagingEvents]: MessagingEventJob;
  [QUEUE.conversation]: ConversationJob;
  [QUEUE.crmSync]: CrmSyncJob;
  [QUEUE.calendar]: BookingJob;
}

// ─── Connection ─────────────────────────────────────────────────────────────

export function redisConnection(url = process.env.REDIS_URL): ConnectionOptions {
  if (!url) throw new Error("REDIS_URL is required");
  return { url } as unknown as ConnectionOptions;
}

// Sensible retry defaults everywhere (plan: reliability §5.3).
export const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: false, // keep failures for the DLQ view
};

const queues = new Map<string, Queue>();

export function getQueue<N extends keyof JobMap>(
  name: N,
  connection = redisConnection(),
): Queue<JobMap[N]> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<JobMap[N]>;
  const q = new Queue<JobMap[N]>(name, { connection });
  queues.set(name, q);
  return q;
}

/**
 * Enqueue with a deterministic job id so retries/replays of the same logical
 * event collapse to one job (plan: reliability — idempotency keys).
 */
export async function enqueue<N extends keyof JobMap>(
  name: N,
  jobId: string,
  data: JobMap[N],
  connection = redisConnection(),
): Promise<void> {
  const q = getQueue(name, connection);
  // BullMQ types the job-name parameter narrowly; our queues use one name each.
  await (q.add as (n: string, d: JobMap[N], o: object) => Promise<unknown>)(
    name,
    data,
    { ...DEFAULT_JOB_OPTS, jobId },
  );
}

export function createWorker<N extends keyof JobMap>(
  name: N,
  processor: Processor<JobMap[N]>,
  connection = redisConnection(),
): Worker<JobMap[N]> {
  return new Worker<JobMap[N]>(name, processor, { connection, concurrency: 8 });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

export { Queue, Worker };
