import { pino, type Logger } from "pino";

/**
 * Structured logging with PII redaction at the serializer boundary
 * (plan: architecture §7, compliance §3 "PII handling").
 *
 * Phone numbers, emails, names, and message bodies must never appear in logs
 * in cleartext. Content lives only in the database under RLS.
 */
const REDACT_PATHS = [
  "*.phone",
  "*.phone_e164",
  "*.phoneE164",
  "*.email",
  "*.email_normalized",
  "*.emailNormalized",
  "*.first_name",
  "*.firstName",
  "*.last_name",
  "*.lastName",
  "*.body",
  "*.message_body",
  "*.messageBody",
  "*.to",
  "*.from",
  "req.headers.authorization",
  "req.headers['x-twilio-signature']",
];

export interface LoggerContext {
  service: string;
  level?: string;
}

export function createLogger(ctx: LoggerContext): Logger {
  return pino({
    name: ctx.service,
    level: ctx.level ?? process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: REDACT_PATHS,
      censor: "[redacted]",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * A correlation id ties a lead's full journey together across the ingest
 * request, every queue job, and every provider call (plan: architecture §7).
 */
export function newCorrelationId(): string {
  return `cid_${crypto.randomUUID()}`;
}

export type { Logger };
