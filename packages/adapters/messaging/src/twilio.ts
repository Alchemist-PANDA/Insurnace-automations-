import twilio from "twilio";
import type {
  MessageChannel,
  SendRequest,
  SendResult,
  ChannelError,
  InboundMessage,
  DeliveryEvent,
  RawRequest,
} from "./types.js";
import { SignatureError } from "./types.js";

/**
 * Twilio SMS channel (plan: integrations §2). Sends via a Messaging Service,
 * validates inbound/status webhook signatures, and maps Twilio error codes to
 * our normalized taxonomy so the worker's retry policy is provider-agnostic.
 */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
}

// Selected Twilio error codes → normalized taxonomy (integrations §1).
function mapTwilioError(code: number | undefined, message: string): ChannelError {
  switch (code) {
    case 21211: // invalid 'To' number
    case 21614: // not a mobile number
      return { ok: false, code: "invalid_destination", retryable: false, message };
    case 21610: // recipient has opted out / blocked
      return { ok: false, code: "carrier_blocked", retryable: false, message };
    case 20429: // too many requests
      return { ok: false, code: "rate_limited", retryable: true, message };
    case 20500:
    case 20503:
      return { ok: false, code: "provider_down", retryable: true, message };
    default:
      return { ok: false, code: "unknown", retryable: true, message };
  }
}

export class TwilioSmsChannel implements MessageChannel {
  readonly channel = "sms" as const;
  constructor(private readonly cfg: TwilioConfig) {}

  async send(req: SendRequest): Promise<SendResult> {
    const client = twilio(
      req.tenantSender.accountSid ?? this.cfg.accountSid,
      req.tenantSender.authToken ?? this.cfg.authToken,
    );
    try {
      const msg = await client.messages.create({
        to: req.to,
        body: req.body,
        messagingServiceSid: req.tenantSender.sender,
      });
      return { ok: true, providerSid: msg.sid };
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      return mapTwilioError(e.code, e.message ?? "twilio send failed");
    }
  }

  private validate(raw: RawRequest): void {
    const signature = raw.headers["x-twilio-signature"];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (!sig) throw new SignatureError("missing X-Twilio-Signature");
    const valid = twilio.validateRequest(
      this.cfg.authToken,
      sig,
      raw.url,
      raw.body as Record<string, string>,
    );
    if (!valid) throw new SignatureError();
  }

  parseInboundWebhook(raw: RawRequest): InboundMessage {
    this.validate(raw);
    return {
      from: String(raw.body.From ?? ""),
      to: String(raw.body.To ?? ""),
      body: String(raw.body.Body ?? ""),
      providerSid: String(raw.body.MessageSid ?? ""),
    };
  }

  parseStatusWebhook(raw: RawRequest): DeliveryEvent {
    this.validate(raw);
    return {
      providerSid: String(raw.body.MessageSid ?? ""),
      status: (raw.body.MessageStatus as DeliveryEvent["status"]) ?? "sent",
      errorCode: raw.body.ErrorCode ? String(raw.body.ErrorCode) : undefined,
    };
  }
}
