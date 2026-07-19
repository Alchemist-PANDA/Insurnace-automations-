# Operational Runbooks

Pilot-readiness procedures (plan: PLAN M11). These are the on-call playbooks for
running the platform against real leads.

## 1. Twilio A2P 10DLC onboarding (per tenant)

Production SMS is **blocked** until a tenant's campaign is verified
(`tenants.sms_campaign_verified = true`). Do not flip this flag manually — it is
set only after the steps below.

1. Register the tenant's **brand** (legal business name, EIN, address) in Twilio.
2. Register a **campaign** with the use case and sample messages generated from
   the tenant's actual configured templates (no drift between registered and
   sent copy).
3. Document the opt-in source (web form disclosure text + version) and the
   opt-out/HELP behavior — both already implemented deterministically.
4. Attach the tenant's Messaging Service to the campaign.
5. Once Twilio approves, set `sms_campaign_verified = true`.

**If registration is rejected twice** (see risks R1): fall back to email-first
first-touch + a toll-free verified number while re-working the brand submission.

## 2. Opt-out verification

Opt-out is the highest-severity compliance path. Verify quarterly and after any
messaging change:

- Send `STOP` from a test number → within 5s the lead is `opted_out`, a
  suppression entry exists, consent is revoked, and any scheduled sends are
  voided (covered by the M3 + conversation tests).
- Confirm Twilio Advanced Opt-Out is still enabled as the provider-level net.
- Spot-check the compliance dashboard's opt-out log against the consent ledger.

## 3. Dead-letter queue triage

When the System Health page shows failed messages or a growing DLQ:

1. Open **System Health** → Dead-letter queue. Each item shows the message body
   and failure time.
2. Identify the failure class from `message_delivery_events.error_code`:
   - `invalid_destination` / `carrier_blocked` → do **not** retry; the number is
     bad or opted out. Verify suppression.
   - `rate_limited` / `provider_down` → transient; retry.
3. Retry a transient failure via `POST /v1/messages/:id/retry` (or the dashboard
   button). This re-opens the outbox row for the relay.
4. If many messages fail at once, check the provider circuit-breaker / status
   page before mass-retrying.

## 4. Integration outage (Twilio / HubSpot / LLM)

- Circuit breakers park jobs; nothing is lost, only delayed. The health screen
  shows the degraded integration.
- **LLM down:** conversations degrade to deterministic template flow + human
  alert; leads are never left unanswered.
- **HubSpot down:** `crm_sync_jobs` accumulate as `failed` and retry with
  backoff; no duplicates on recovery (upsert-by-external-id).
- **Twilio down:** outbox rows stay `pending`; the relay drains them on recovery.

## 5. Incident response — opt-out processing failure

Opt-out failure is a **P1**. If opt-out processing latency exceeds 5s or the
opt-out queue backs up:

1. Page on-call immediately.
2. Halt outbound sending for the affected tenant (disable the Messaging Service
   or set a tenant send-pause flag).
3. Process the opt-out backlog manually from `messages` where inbound body
   matches an opt-out keyword.
4. Post-incident: confirm every affected lead is suppressed and consent-revoked.

## 6. Backup / restore drill

- Managed Postgres runs PITR backups. Quarterly, restore the latest snapshot to
  a scratch instance and run the tenant-isolation + analytics suites against it
  to confirm integrity.
- Verify RLS + the `stl_app` role exist after restore (migrations re-apply both).

## 7. Tenant onboarding checklist

Before pointing real leads at a tenant:

- [ ] Lead source(s) configured with signing secret; test webhook creates one lead
- [ ] Twilio Messaging Service connected; A2P campaign verified (§1)
- [ ] Knowledge base populated + approved (pricing/warranty entries in place)
- [ ] Qualification schema + scoring model reviewed
- [ ] Message templates + opt-in disclosure reviewed by counsel
- [ ] Reps added with schedules + territories; routing verified
- [ ] Google Calendar connected per rep
- [ ] HubSpot connected; test lead syncs contact + deal
- [ ] Quiet hours + follow-up caps set for the tenant timezone
