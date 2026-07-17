# Master Implementation Plan

Speed-to-Lead Automation Platform — from empty repository to first paid pilot.

This document is the single source of truth for **what gets built, in what order, and
when it is done**. Companion documents cover the how:
[architecture](architecture.md), [data model](data-model.md),
[integrations](integrations.md), [conversation engine](conversation-engine.md),
[compliance & security](compliance-security.md), [testing](testing.md),
[risks](risks.md).

---

## 1. Scope statement

### In scope (MVP → first paid pilot)

- Multi-tenant foundation with RBAC and database-level tenant isolation
- Generic signed lead webhook + manual lead creation + CSV import foundation
- Lead normalization, identity resolution, deduplication, idempotent ingestion
- Explicit lead state machine
- Consent ledger, suppression lists, deterministic opt-out handling (STOP et al.)
- Explainable rules-based lead scoring with score bands and history
- Routing: round robin, territory, availability, business hours, SLA escalation
- Twilio SMS: outbound, inbound, status callbacks, retries, quiet hours, templates
- Email channel (transactional provider) as second channel
- AI qualification conversation engine with policy gate and tenant knowledge base
- Google Calendar booking: free/busy, slot offers, holds, booking, reminders
- Human takeover with AI pause/resume
- State-triggered follow-up workflow engine (versioned, durable, replayable)
- HubSpot CRM sync (contacts, deals, notes, meetings, tasks, outcomes)
- Dashboards: executive, lead inbox, lead detail/conversation, hot-lead queue,
  compliance, system health
- Analytics: response-time percentiles, funnel rates, SLA breaches, attribution
- Audit log covering every automated action
- Roofing/HVAC vertical template (qualification schema, scoring defaults, messages)

### Explicitly out of scope until after pilot results

Drag-and-drop workflow builder, >1 CRM integration, autonomous AI voice calling,
predictive ML, mobile apps, social posting, prospect scraping, cold calling, call
sentiment analysis, marketplace, mass white-labelling, usage-based billing engine,
custom analytics warehouse, verticals beyond roofing/HVAC.

---

## 2. Delivery strategy: working vertical slices

We do **not** build layer-by-layer (all schema, then all APIs, then all UI). We build
end-to-end slices that each produce a demonstrable, tested behavior. Placeholder-only
pages across the app are forbidden until the revenue-critical workflow works.

**Slice 1 (revenue-critical spine):**
generic webhook → lead record → scoring → Twilio SMS first-touch → inbound reply →
conversation timeline in dashboard.

**Slice 2 (conversion loop):**
AI qualification → routing/assignment → Google Calendar booking → HubSpot sync.

**Slice 3 (durability loop):**
follow-up workflows → SLA escalation → analytics/attribution → compliance dashboard.

---

## 3. Milestones

Each milestone ends with: green CI, migrations applied, seed data updated, demo
script runnable, and its acceptance checks (§5 traceability in [testing.md](testing.md))
passing. Estimates assume one focused engineer/agent working full-time; treat them as
sequencing weights, not promises.

### M0 — Repository scaffold and platform plumbing (est. 1 week)

**Goal:** a running skeleton: web app, API service, worker, database, queue — all in
Docker, all typed, all tested in CI.

- pnpm + Turborepo monorepo per [architecture.md §3](architecture.md)
- `apps/web` (Next.js, App Router), `apps/api` (Fastify), `apps/worker` (BullMQ consumers)
- `packages/db` (Drizzle ORM + migrations), `packages/core` (domain types, zod schemas),
  `packages/queue`, `packages/config` (env validation), `packages/logger` (pino),
  `packages/adapters/*` (empty interfaces committed)
- Docker Compose: Postgres 16, Redis 7, mailpit (local email), app services
- Environment validation fails fast on boot; `.env.example` complete
- Structured JSON logging with correlation IDs; request IDs propagated to jobs
- Health endpoints (`/healthz`, `/readyz`) on api + worker
- CI: typecheck, lint, unit tests, migration check on every push
- Seed script creates a demo tenant, users for each role, and a demo lead source

**Exit demo:** `docker compose up` → sign-in page renders, API health green, worker
consumes a test job, CI green.

### M1 — Tenancy, auth, RBAC, audit foundation (est. 1.5 weeks)

**Goal:** multi-tenant security substrate everything else sits on.

- Tables: `tenants`, `users`, `memberships`, `roles`, `tenant_settings`, `audit_logs`
- Auth: better-auth with organization plugin; session cookies; CSRF protection
- Roles: `platform_admin`, `tenant_owner`, `sales_manager`, `sales_rep`, `analyst`
- Postgres **row-level security** on every tenant-scoped table; app sets
  `app.tenant_id` per transaction (see [data-model.md §5](data-model.md))
- `auditedAction()` helper: every mutation writes an audit entry in the same transaction
- Pages: sign-in, organization onboarding, organization settings, team management
- Tenant-isolation test suite: cross-tenant reads/writes fail at the DB layer even
  when application code "forgets" a filter

**Exit demo:** two tenants seeded; tenant A user cannot see tenant B data through any
API route or direct query path; every settings change appears in the audit log.

### M2 — Lead ingestion, normalization, dedup, state machine (est. 2 weeks)

**Goal:** any lead source → exactly one clean lead record, always asynchronously.

- Tables: `lead_sources`, `leads`, `lead_identities`, `lead_events`, `raw_webhooks`
- `POST /v1/ingest/:sourceKey` — HMAC-signed generic webhook:
  verify signature → store raw payload → write idempotency record → enqueue → **202 in <2s**
- Idempotency: unique `(tenant_id, source_id, external_event_id)` +
  payload-hash fallback; replays acknowledged but never reprocessed
- Normalization worker: names, emails (lowercase/trim), phones (E.164 via
  libphonenumber-js), locations, timestamps, consent metadata, source mapping
- Identity resolution: match on normalized phone → email → CRM contact id →
  external lead id, within tenant + configurable recency window; outcomes: create /
  merge / reopen / attach-to-customer / flag-for-review / reject-replay
- Lead state machine (`received → processing → new → …`) as an explicit transition
  table; invalid transitions throw and are audited
- Manual lead creation form + CSV import foundation (parse, map, dry-run, commit)
- Lead inbox page: real data, filters by state/source/assignee, live updates

**Exit demo:** replaying the same webhook 5× yields one lead and one `lead.received`
event; a second inquiry from the same phone merges; the inbox shows it all.

### M3 — Consent, suppression, and messaging spine (Twilio SMS) (est. 2 weeks)

**Goal:** the platform can legally and reliably hold an SMS conversation.

- Tables: `consent_records`, `suppression_entries`, `conversations`, `messages`,
  `message_delivery_events`, `message_templates`, `outbox`
- Consent ledger populated at ingestion from source metadata; **no consent evidence →
  no automated outbound** (deterministic gate, see [compliance-security.md](compliance-security.md))
- Suppression: tenant-level + platform-level; checked before every send
- Twilio SMS adapter behind `MessageChannel` interface: outbound send, inbound
  webhook, status callbacks, provider error mapping, retry with backoff
- **Transactional outbox**: message intents written in the same transaction as domain
  state; a relay publishes to the queue; unique constraint on
  `(lead_id, template_key, dedupe_key)` guarantees no duplicate first-touch even
  under job retries
- Opt-out engine: STOP/UNSUBSCRIBE/CANCEL/END/QUIT keywords + free-text withdrawal
  detection; on opt-out: consent revoked, suppression entry written, **all pending
  scheduled messages for that lead cancelled in the same transaction**, state →
  `opted_out`
- Quiet hours per tenant timezone; sends scheduled to next allowed window
- First-touch personalization: template variables (first name, service, city, business
  identity, business-hours context) + single opening qualification question
- Lead detail page v1: full message timeline with delivery states
- Failed-message visibility: dead-letter queue admin view with manual retry

**Exit demo (Slice 1 complete):** test webhook → lead → scored (M4 stub: source
defaults) → SMS initiated within 30s in dev → reply appears in timeline → STOP kills
everything scheduled, instantly and provably.

### M4 — Explainable lead scoring (est. 1 week)

**Goal:** every lead gets a 0–100 score a salesperson can read and trust.

- Tables: `scoring_models`, `scoring_rules`, `lead_scores`
- Rules engine over normalized lead facts + engagement events:
  fit (0–35), intent (0–30), urgency (0–20), engagement (0–15), negative adjustments
- Score bands: Hot 80–100, Qualified 55–79, Nurture 25–54, Unqualified 0–24
- Every score row stores its per-rule breakdown → rendered as
  “Score 84: service-area match +20, urgent leak +20, …”
- Rescoring on every material event (reply, qualification answer, booking click);
  full score history on the lead detail page
- Roofing/HVAC default rule set shipped as the vertical template; per-tenant overrides
- Score decay job for aging leads
- Scoring configuration page (rules list, weights, band thresholds — forms, not a
  visual builder)

**Exit demo:** seeded leads score deterministically; unit test suite covers every rule;
changing a weight re-scores and logs an audit entry.

### M5 — Routing, assignment, SLA escalation (est. 1.5 weeks)

**Goal:** the right human is chasing every hot lead within seconds, with no dead ends.

- Tables: `routing_rules`, `lead_assignments`, `user_schedules`, `territories`
- Strategies (composable, priority-ordered): territory (ZIP/radius), service
  specialization, availability/schedule, workload cap, round robin as final
  tie-breaker; existing-customer ownership wins outright
- Business-hours awareness: after hours → AI-only qualification + booking, alerts
  deferred to opening unless lead is Hot + emergency
- SLA escalation ladder as durable delayed jobs: 0s assign → 30s notify (in-app +
  SMS to rep) → 60s secondary rep → 120s manager → 5min fallback queue; each step
  cancels itself when the rep acknowledges
- Reassignment history preserved; hot-lead queue page (unacknowledged Hot leads,
  SLA countdown timers)
- Internal notification channel (in-app + SMS via existing adapter)

**Exit demo:** a Hot lead with an unresponsive primary rep escalates through the full
ladder on schedule; acknowledgment halts escalation; everything is in the audit log.

### M6 — Conversation engine: AI qualification with policy gate (est. 2.5 weeks)

**Goal:** the AI holds a useful qualification conversation and can never break policy.

- Tables: `qualification_schemas`, `qualification_answers`, `knowledge_entries`,
  `ai_interactions`
- LLM provider abstraction (`LlmProvider` interface; Anthropic first, model configurable)
- Orchestrator loop per inbound message (full design in
  [conversation-engine.md](conversation-engine.md)):
  1. deterministic pre-checks (opt-out language, human-request keywords, abuse)
  2. build context: qualification schema state + approved knowledge entries only
  3. LLM call → **structured JSON** (extracted facts, proposed reply, intents,
     confidence) validated against zod schema; invalid → one retry → fallback template
  4. **policy gate** (pure functions): consent/suppression re-check, quiet hours,
     follow-up cap, claim-verification (proposed reply may only assert facts present
     in approved knowledge), tool allowlist
  5. persist facts, update score, transition state, enqueue approved reply via outbox
- Human-handoff detection, dissatisfaction detection, opt-out language detection —
  all route to deterministic handlers, never to the LLM's discretion
- Uncertainty response: “A specialist will confirm that for you” + rep task
- Internal lead summary generation for takeover cards
- Roofing/HVAC qualification schema: service type, urgency, property type, location
  confirmation, insurance claim, timeline, appointment intent
- Knowledge base pages: CRUD for approved entries (services, areas, hours, pricing
  ranges, financing, warranties, FAQs, exclusions, escalation rules)
- Qualification configuration page
- `ai_interactions` stores prompt/response payloads with PII controls for audit

**Exit demo:** scripted conversation: lead replies free-text → facts extracted to
structured columns → next question asked → pricing question answered *only* from the
knowledge base → off-book question gets the uncertainty response → “can I talk to a
person” pauses AI and alerts the rep.

### M7 — Appointment booking (Google Calendar) (est. 2 weeks)

**Goal:** qualified leads book real appointments without double-booking or calendar
exposure.

- Tables: `appointments`, `appointment_types`, `calendar_connections`, `slot_holds`
- Google OAuth connection per rep; encrypted token storage; refresh handling
- Availability engine: free/busy query + appointment type duration + buffers +
  travel-time padding + tenant booking windows → offer 2–3 slots (never the full
  calendar)
- **Slot holds with TTL + unique constraint** `(calendar_id, start_at)` → two leads
  cannot book the same slot; concurrency test required
- Book → calendar event created → confirmation SMS/email → reminder jobs scheduled
  (24h, 2h) → state `booked` → follow-up sequences paused
- Reschedule / cancel flows (lead-initiated via link, rep-initiated via UI); no-show
  marking feeds workflows and scoring
- Timezone correctness end-to-end (tenant TZ, rep TZ, lead TZ inferred from location)
- Calendar & appointments page

**Exit demo (Slice 2 core):** qualified lead is offered 3 real slots, books one, event
appears in Google Calendar, confirmation and reminders scheduled; a simulated
concurrent booking of the same slot fails cleanly.

### M8 — Human takeover + workflow engine (est. 2 weeks)

**Goal:** humans can seize any conversation instantly; follow-ups run themselves.

- Takeover: one-click button → AI paused (state `human_owned`), full timeline, AI
  summary card, qualification fields, score explanation, suggested next action;
  manual SMS/email send; call-now button (tel: + logged); book-for-lead; disqualify;
  resume-automation control
- Tables: `workflows`, `workflow_versions`, `workflow_runs`, `workflow_steps`
- Workflow engine: versioned definitions (JSON, zod-validated), state-based triggers
  (lead received, message received, no reply, qualified, booked, cancelled, no-show,
  takeover, won, lost, opt-out), actions (send SMS/email, score, assign, notify,
  CRM task, offer appointment, wait, branch, stop, update state)
- Durable delayed jobs; every run + step persisted; failed steps → retries → DLQ →
  admin retry; **stop conditions enforced centrally** (opt-out, booked, takeover,
  lost, complaint, delivery failures)
- Shipped default sequences: new-lead-no-reply, replied-not-qualified,
  qualified-not-booked, booked-reminders, no-show recovery, post-estimate follow-up
- Follow-up configuration page (structured forms; versioning on publish)

**Exit demo:** silent lead receives the no-reply sequence exactly as configured;
booking mid-sequence halts it; takeover halts it; resume restarts cleanly; every step
visible in the run history.

### M9 — HubSpot CRM sync (est. 1.5 weeks)

**Goal:** the customer's CRM mirrors everything; our platform stays the orchestration
layer, never the system of record.

- Tables: `crm_connections`, `crm_mappings`, `crm_sync_jobs`, `deals`, `outcomes`
- `CrmAdapter` interface; HubSpot implementation: contacts, deals, notes
  (conversation summaries), meetings (appointments), tasks, owner mapping, lifecycle
  stage, custom qualification properties, lead score, source attribution
- Outbound sync via queue with retries, conflict handling (last-write-wins +
  conflict log), external-ID mapping table
- Inbound: HubSpot webhooks (signature-validated) for deal stage changes →
  closed-won/lost outcomes feed attribution
- Integration health screen: last sync, error counts, backlog, manual retry/replay
- Integrations page: connect HubSpot (OAuth), connect Twilio sender config, connect
  Google Calendar

**Exit demo (Slice 2 complete):** full journey — webhook → SMS → qualification →
booking — lands in HubSpot as contact + deal + note + meeting; closing the deal in
HubSpot flows back as a `deal.won` outcome.

### M10 — Analytics, attribution, dashboards (est. 2 weeks)

**Goal:** prove the response SLA and show the money.

- Tables: `daily_metrics`, `usage_records`; metrics computed from immutable
  `lead_events` timestamps (never mutable lead rows)
- Response-time metrics: median, p90, % within 30/60/90s; contact, reply,
  qualification, booking, show, close rates; conversion by source/service/rep;
  SLA breaches; message failure and opt-out rates
- Attribution: automation-influenced vs automation-attributed vs total revenue;
  gross-profit-based ROI per [blueprint §7] formula; cohort comparison view
- Executive dashboard, sales manager dashboard, analytics page with exports (CSV)
- Compliance dashboard: consent evidence, opt-outs, suppressions, failed deliveries,
  complaint indicators, deletion requests
- System health page: queue depths, DLQ counts, integration status, worker heartbeats

**Exit demo:** dashboards show correct numbers against a seeded scenario with known
expected values (golden dataset test).

### M11 — Pilot hardening (est. 1.5 weeks)

**Goal:** everything on the MVP acceptance list green; safe to point real leads at it.

- Full MVP acceptance-criteria pass (see [testing.md §2](testing.md) traceability)
- Load test: 50 concurrent webhook bursts, sustained inbound reply traffic
- Rate limiting on all public endpoints; secrets audit; PII-masking audit of logs
- Twilio A2P 10DLC registration runbook + tenant onboarding checklist
- Backup/restore drill; staging environment mirroring production
- Onboarding wizard (tenant setup: sources, sender, calendar, knowledge base,
  templates, routing) — minimum viable version
- Runbooks: DLQ triage, opt-out verification, integration outage, incident response

**Exit:** pilot go/no-go review against the acceptance criteria.

Total estimated effort: **~18 engineer-weeks** to pilot-ready.

---

## 4. Post-pilot roadmap (Phases 2–4, summarized)

- **Phase 2 (pilot feedback):** territory refinement, rep schedules UI, manager
  escalation tuning, richer reporting, onboarding polish, integration health
  alerting.
- **Phase 3 (productization):** more OAuth integrations (GoHighLevel next), reusable
  vertical templates (solar — with TCPA counsel review first), team permissions
  granularity, billing, workflow versioning UI, white-label controls, usage limits.
- **Phase 4 (intelligence):** only after sufficient closed-won/lost volume:
  conversion-probability, source-quality, best-contact-time, no-show prediction,
  message experimentation. All gated on data volume thresholds, not calendar dates.

---

## 5. MVP acceptance criteria

The pilot ships only when all fifteen hold (test traceability in
[testing.md](testing.md)):

1. A test web lead creates exactly one lead.
2. First SMS normally initiated within thirty seconds.
3. Replayed webhooks never send duplicate messages.
4. STOP immediately suppresses future messages and cancels scheduled ones.
5. Inbound replies appear in the dashboard.
6. Qualification answers are saved as structured data.
7. A qualified lead can book a real calendar slot.
8. Human takeover pauses automation.
9. Failed messages are visible and retryable.
10. HubSpot receives the contact, notes and appointment.
11. Every automated action has an audit entry.
12. Tenant A can never access Tenant B's data.
13. AI cannot execute unapproved tools.
14. AI cannot invent unsupported pricing or services.
15. Response-time and booking metrics are calculated accurately.

---

## 6. Performance targets (engineering SLOs)

| Target | Value |
|---|---|
| Webhook acknowledgement | < 2 s |
| First automated response | < 30 s normal operation |
| Eligible leads contacted | 95% within 90 s |
| Duplicate first messages | zero |
| Provider failures | 100% visible in dashboard/DLQ |
| Silent workflow loss | zero |
| Opt-out → scheduled sends blocked | immediate (same transaction) |

---

## 7. Commercial framing (context for build decisions)

Sold as a **productized implementation service**: setup $3,000–$8,000; platform
$750–$2,000/mo; usage passed through. No revenue guarantees — operational SLA plus
transparent reporting. This is why the analytics/attribution milestone (M10) is a
first-class deliverable and not a nice-to-have: the report *is* the retention
mechanism. Marketing claims must follow the corrected statistics guidance in the
product blueprint — sell the 90-second response promise, never a conversion
guarantee.
