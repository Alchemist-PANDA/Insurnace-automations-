# Integration Adapters

Business logic never imports a provider SDK. Every external system sits behind a
typed interface in `packages/adapters/*`, with a fake implementation in
`packages/testing` used by unit/integration tests and offline development.

## 1. Adapter contracts

### MessageChannel (SMS first; email, WhatsApp later)

```ts
interface MessageChannel {
  readonly channel: 'sms' | 'email' | 'whatsapp';
  send(req: {
    tenantSender: TenantSenderConfig;   // per-tenant from/messaging service
    to: string;                          // E.164 / email
    body: string;
    dedupeKey: string;                   // provider-side idempotency where supported
    correlationId: string;
  }): Promise<{ providerSid: string } | ChannelError>;
  parseInboundWebhook(raw: RawRequest): InboundMessage | SignatureError;
  parseStatusWebhook(raw: RawRequest): DeliveryEvent | SignatureError;
  mapError(err: unknown): ChannelError;  // normalized taxonomy below
}
```

Normalized error taxonomy (drives retry policy): `invalid_destination` (no retry,
mark lead phone invalid), `carrier_blocked` (no retry, surface compliance flag),
`rate_limited` (retry with backoff), `provider_down` (retry + circuit breaker),
`unknown` (retry bounded, then DLQ).

### CalendarProvider

```ts
interface CalendarProvider {
  connect(oauthCode: string): Promise<CalendarConnection>;      // encrypted token storage
  freeBusy(conn, window): Promise<BusyInterval[]>;
  createEvent(conn, event): Promise<{ externalEventId: string }>;
  updateEvent(conn, externalEventId, patch): Promise<void>;
  deleteEvent(conn, externalEventId): Promise<void>;
}
```

Slot computation (durations, buffers, travel padding, 2–3 slot selection, holds) is
**core logic**, not adapter logic — the adapter only reports busy intervals and
writes events.

### CrmAdapter

```ts
interface CrmAdapter {
  upsertContact(mapping, contact): Promise<ExternalRef>;
  upsertDeal(mapping, deal): Promise<ExternalRef>;
  addNote(ref, note): Promise<void>;                 // conversation summaries
  createMeeting(ref, appointment): Promise<void>;
  createTask(ref, task): Promise<void>;
  setOwner(ref, ownerMapping): Promise<void>;
  setLifecycleStage(ref, stage): Promise<void>;
  parseWebhook(raw): CrmEvent | SignatureError;      // deal stage changes inbound
}
```

### LlmProvider

```ts
interface LlmProvider {
  complete(req: {
    system: string;
    messages: ChatTurn[];
    responseSchema: ZodSchema;      // structured JSON output, validated by caller
    maxTokens: number;
    temperature: number;
  }): Promise<{ parsed: unknown; raw: string; usage: TokenUsage }>;
}
```

No tool execution surface at all — the LLM proposes, the application disposes. See
[conversation-engine.md](conversation-engine.md).

## 2. Twilio SMS (M3)

- **Outbound:** Messaging Service per tenant (sender pool, opt-out handling
  compatibility). Sends flow only through the outbox relay.
- **Inbound:** `POST /webhooks/twilio/inbound` — validate `X-Twilio-Signature`
  against the exact URL + params; reject otherwise. Store, enqueue, ack fast.
- **Status callbacks:** `POST /webhooks/twilio/status` — upsert
  `message_delivery_events` keyed by MessageSid; status precedence ordering
  prevents out-of-order regressions (`delivered` never downgraded by a late `sent`).
- **At-least-once assumption:** all Twilio webhooks may repeat; handlers are
  idempotent by (MessageSid, status).
- **A2P 10DLC:** registration is an onboarding prerequisite per tenant (brand +
  campaign with documented opt-in/opt-out). Runbook in M11; the platform blocks
  production sends for tenants without a verified campaign.
- **Compliance defaults:** first message per lead includes business identity; opt-out
  footer rules configurable per template class; STOP/HELP handled by us
  deterministically (and Twilio Advanced Opt-Out kept ON as a second net).

## 3. Google Calendar (M7)

- OAuth 2.0 per sales rep; refresh tokens encrypted (AES-GCM via KMS-managed key);
  scopes limited to calendar free/busy + event write on the connected calendar.
- Availability = `freebusy.query` over connected calendars ∩ rep schedule ∩ tenant
  booking windows − buffers/travel padding → core slot engine picks 2–3 offers.
- Booking sequence: acquire `slot_holds` row (unique constraint) → create event →
  confirm hold → send confirmation → schedule reminders. Any failure rolls the hold
  back; expiry sweep releases abandoned holds.
- Never expose full calendars to leads — only the offered slots.
- Watch channels (push notifications) are a post-MVP enhancement; MVP re-validates
  free/busy at booking time, which the hold + re-check makes race-safe.

## 4. HubSpot (M9)

- OAuth app; tokens encrypted; least-privilege scopes (contacts, deals, notes,
  meetings, tasks, owners).
- **Outbound sync:** queue-driven, per-object `crm_sync_jobs` with retries and
  conflict log. External IDs stored in `crm_mappings` — sync is upsert-by-external-id,
  never create-blindly (prevents duplicates on retry).
- **Inbound:** HubSpot webhook subscriptions for deal stage changes; v3 request
  signatures validated; events idempotent by (objectId, occurredAt, subscriptionType).
- Property mapping: standard fields + a namespaced custom property group
  (`stl_score`, `stl_band`, `stl_source`, `stl_urgency`, qualification fields).
- **Direction policy:** we are system of engagement, HubSpot is system of record.
  We write engagement data; we read outcomes (won/lost, amounts). We never
  mass-update fields owned by the customer's team.
- Health screen: last successful sync, error counts by type, backlog depth, oldest
  unsynced item, manual retry/replay buttons.

## 5. Email provider (M3, second channel)

- Resend or Postmark behind `EmailChannel` (decision by deliverability test on our
  sending domain at M3; both have equivalent APIs for our needs).
- Transactional-only in MVP: first-touch fallback, appointment confirmations,
  reminders. No marketing broadcast features.
- Inbound-reply handling via provider inbound webhook → same conversation pipeline
  as SMS.

## 6. Generic ingest & Zapier/Make (M2)

- `POST /v1/ingest/:sourceKey` with per-source HMAC secret; timestamp + signature
  headers; JSON body free-form, mapped by per-source field mapping stored in
  `lead_sources.mapping jsonb`.
- Zapier/Make need no special adapter — they call the generic endpoint. A polished
  Zapier app is post-MVP.
- Facebook/Instagram Lead Ads and Google Lead Forms: post-MVP native adapters; until
  then they arrive via Zapier mapping (documented in the onboarding runbook).

## 7. LLM provider (M6)

- Anthropic first (`claude-sonnet-*` class model for orchestration; configurable per
  tenant tier). Model ID is config, not code.
- Requests: system prompt + conversation window + qualification schema state +
  approved knowledge entries. Response: JSON validated against a zod schema
  (facts, intents, proposed reply, confidence). Invalid JSON → one repair retry →
  deterministic fallback template + rep task.
- Token usage recorded per call in `ai_interactions` → `usage_records` for cost
  visibility on the executive dashboard.
- Provider outage → circuit breaker → conversation degrades to deterministic
  template flow + human alert; leads are never left unanswered because the LLM is
  down.
