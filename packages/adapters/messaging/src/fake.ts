import type {
  MessageChannel,
  SendRequest,
  SendResult,
  InboundMessage,
  DeliveryEvent,
  RawRequest,
} from "./types.js";

/**
 * In-memory SMS channel for offline dev and tests (plan: testing §1). Records
 * every send, enforces dedupeKey idempotency, and lets tests inject inbound
 * replies and delivery callbacks. Scriptable failures exercise retry paths.
 */
export class FakeSmsChannel implements MessageChannel {
  readonly channel = "sms" as const;
  readonly sent: (SendRequest & { providerSid: string })[] = [];
  private readonly seenDedupe = new Set<string>();
  private failNext: SendResult | null = null;

  /** Force the next send() to return this result (e.g. a provider_down error). */
  scriptNextResult(result: SendResult): void {
    this.failNext = result;
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (this.failNext) {
      const r = this.failNext;
      this.failNext = null;
      return r;
    }
    // Provider-side idempotency simulation: a repeated dedupeKey returns the
    // original SID instead of sending twice.
    if (this.seenDedupe.has(req.dedupeKey)) {
      const prior = this.sent.find((s) => s.dedupeKey === req.dedupeKey);
      return { ok: true, providerSid: prior!.providerSid };
    }
    const providerSid = `SM_fake_${this.sent.length + 1}`;
    this.seenDedupe.add(req.dedupeKey);
    this.sent.push({ ...req, providerSid });
    return { ok: true, providerSid };
  }

  parseInboundWebhook(raw: RawRequest): InboundMessage {
    return {
      from: String(raw.body.From ?? ""),
      to: String(raw.body.To ?? ""),
      body: String(raw.body.Body ?? ""),
      providerSid: String(raw.body.MessageSid ?? `SM_in_${Date.now()}`),
    };
  }

  parseStatusWebhook(raw: RawRequest): DeliveryEvent {
    return {
      providerSid: String(raw.body.MessageSid ?? ""),
      status: (raw.body.MessageStatus as DeliveryEvent["status"]) ?? "sent",
      errorCode: raw.body.ErrorCode ? String(raw.body.ErrorCode) : undefined,
    };
  }

  /** Test helper: build a raw inbound request as Twilio would post it. */
  static inbound(from: string, to: string, body: string): RawRequest {
    return {
      url: "https://example.test/webhooks/twilio/inbound",
      headers: {},
      body: { From: from, To: to, Body: body, MessageSid: `SM_in_${Math.random()}` },
    };
  }
}
