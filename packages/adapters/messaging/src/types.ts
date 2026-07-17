/**
 * MessageChannel contract (plan: integrations §1). Business logic never imports
 * a provider SDK — it depends only on this interface. A fake and a Twilio
 * implementation both satisfy it.
 */

export type ChannelKind = "sms" | "email" | "whatsapp";

export interface TenantSenderConfig {
  /** Twilio Messaging Service SID, or a from-number / from-email. */
  sender: string;
  accountSid?: string;
  authToken?: string;
}

export interface SendRequest {
  tenantSender: TenantSenderConfig;
  to: string;
  body: string;
  /** Provider-side idempotency where supported; always our dedupe backstop. */
  dedupeKey: string;
  correlationId: string;
}

/** Normalized provider-error taxonomy → drives retry policy (integrations §1). */
export type ChannelErrorCode =
  | "invalid_destination"
  | "carrier_blocked"
  | "rate_limited"
  | "provider_down"
  | "unknown";

export interface ChannelError {
  ok: false;
  code: ChannelErrorCode;
  retryable: boolean;
  message: string;
}

export interface SendSuccess {
  ok: true;
  providerSid: string;
}

export type SendResult = SendSuccess | ChannelError;

export interface InboundMessage {
  from: string;
  to: string;
  body: string;
  providerSid: string;
}

export interface DeliveryEvent {
  providerSid: string;
  status: "queued" | "sent" | "delivered" | "failed" | "undelivered";
  errorCode?: string;
}

export interface RawRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed form/JSON body. */
  body: Record<string, unknown>;
  /** Raw body bytes when signature validation needs them. */
  rawBody?: string;
}

export class SignatureError extends Error {
  constructor(message = "invalid webhook signature") {
    super(message);
    this.name = "SignatureError";
  }
}

export interface MessageChannel {
  readonly channel: ChannelKind;
  send(req: SendRequest): Promise<SendResult>;
  /** Throws SignatureError when the request is not authentic. */
  parseInboundWebhook(raw: RawRequest): InboundMessage;
  parseStatusWebhook(raw: RawRequest): DeliveryEvent;
}

/** Status precedence so out-of-order callbacks never regress (integrations §2). */
const STATUS_RANK: Record<DeliveryEvent["status"], number> = {
  queued: 0,
  sent: 1,
  delivered: 3,
  undelivered: 2,
  failed: 2,
};

export function isStatusNewer(
  incoming: DeliveryEvent["status"],
  current: DeliveryEvent["status"] | null | undefined,
): boolean {
  if (!current) return true;
  return STATUS_RANK[incoming] > STATUS_RANK[current];
}
