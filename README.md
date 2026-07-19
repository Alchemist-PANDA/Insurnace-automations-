# Speed-to-Lead Automation Platform

A multi-tenant, event-driven **AI lead-response and appointment-conversion platform** for
high-ticket service businesses. First vertical: **roofing / HVAC / remodeling**.

**The promise we build toward (and the only promise we sell):**

> Every legitimate inbound lead receives an intelligent, personalized response within 90
> seconds, is qualified automatically, and is routed to the correct salesperson before
> buying intent disappears.

This is not a chatbot. It is a measurable inbound-revenue recovery system with response
SLAs, qualification, routing, booking, and attribution.

## Planning documents

The full engineering plan lives in [`docs/`](docs/). Read in this order:

| # | Document | Contents |
|---|----------|----------|
| 0 | [PLAN.md](docs/PLAN.md) | Master plan: scope, milestones, vertical slices, MVP acceptance criteria, timeline |
| 1 | [architecture.md](docs/architecture.md) | System architecture, monorepo layout, stack decisions, event catalog, reliability patterns |
| 2 | [data-model.md](docs/data-model.md) | Full entity design, ERD, lead state machine, tenant isolation / RLS strategy |
| 3 | [integrations.md](docs/integrations.md) | Adapter contracts: Twilio, HubSpot, Google Calendar, LLM provider abstraction |
| 4 | [conversation-engine.md](docs/conversation-engine.md) | AI qualification agent design, policy gate, knowledge base, prompt-injection defenses |
| 5 | [compliance-security.md](docs/compliance-security.md) | Consent ledger, TCPA/A2P 10DLC, opt-out handling, RBAC, audit, PII controls |
| 6 | [testing.md](docs/testing.md) | Test strategy, acceptance-criteria traceability, primary end-to-end test |
| 7 | [risks.md](docs/risks.md) | Risks, assumptions, and open decisions |

## Product principles (non-negotiable)

1. Reliability over visual complexity.
2. Compliance decisions are **deterministic** — never delegated to the LLM.
3. AI interprets and drafts; application policy decides and sends.
4. Every side effect is idempotent and auditable.
5. No workflow failure disappears silently.
6. All data is tenant-isolated, enforced at the database layer.
7. The customer's CRM remains the system of record.
8. Rules-based, explainable lead scoring first; predictive ML only after real outcome data exists.
9. Provider adapters everywhere — no business logic coupled to Twilio, HubSpot, Google, or one LLM.
10. Build the smallest system capable of supporting a real paid pilot.

## Status

**All plan milestones (M0–M11) are built and verified end-to-end** against a real
Postgres + Redis — **137 tests across 12 packages, all 15 MVP acceptance criteria
proven by tests.** The full lead lifecycle runs: capture → dedup → score →
respond → AI-qualify → route/escalate → book → sync to CRM → follow up → take
over → measure.

### What's implemented

| Area | State | Where |
|---|---|---|
| Monorepo, tooling, CI, Docker | ✅ | root, `.github/workflows/ci.yml` |
| Env validation, structured logging (PII redaction) | ✅ | `packages/config`, `packages/logger` |
| Domain core — normalize, dedup, state machine, scoring, routing, opt-out, **policy gate**, qualification, slot engine, **workflow engine**, **analytics** | ✅ 73 tests | `packages/core` |
| DB schema + **row-level tenant isolation** + seed | ✅ 5 tests | `packages/db` |
| Queue topology + Twilio/fake messaging adapter | ✅ 5 tests | `packages/queue`, `packages/adapters/messaging` |
| LLM (Anthropic) · Calendar (Google) · CRM (HubSpot) adapters + fakes | ✅ 9 tests | `packages/adapters/*` |
| API — signed ingest, Twilio + HubSpot webhooks, reads, lead actions, analytics, rate limiting | ✅ 10 tests | `apps/api` |
| Worker — ingest→score→first-touch→relay→inbound/opt-out, conversation engine, **assignment + SLA escalation**, booking, CRM sync + inbound, **workflow/follow-up**, **human takeover**, **DLQ retry** | ✅ 31 E2E tests | `apps/worker` |
| Dashboard — inbox, lead detail + timeline + **takeover actions**, **analytics**, **system health/DLQ**, hot-lead queue, compliance | ✅ | `apps/web` |
| Operational runbooks (A2P 10DLC, opt-out, DLQ, incident, onboarding) | ✅ | [docs/runbooks.md](docs/runbooks.md) |

**All 15 MVP acceptance criteria are proven by tests:** #1 one lead · #2 <30s /
<2s ack · #3 no duplicate messages · #4 STOP suppresses + cancels scheduled ·
#5 replies in dashboard · #6 structured qualification · #7 booking + concurrency
guard · #8 human takeover pauses automation · #9 failed messages visible +
retryable · #10 HubSpot contact/note/meeting · #11 audit per action · #12 tenant
isolation · #13 AI cannot execute unapproved tools · #14 AI cannot invent
pricing · #15 accurate response-time + booking metrics (golden dataset).

### Still deferred (intentionally, per plan §12)

Real session auth (better-auth — dashboard uses a documented `x-tenant-id` dev
shim today), the onboarding wizard UI, email/WhatsApp channel implementations
(interfaces exist; SMS is the implemented channel), OAuth connect flows for
Google/HubSpot (adapters use stored tokens), and predictive ML (Phase 4).

### Run it locally

```bash
pnpm install
docker compose up -d postgres redis        # or a local Postgres + Redis
cp .env.example .env                        # services use the restricted stl_app role
DATABASE_URL=$MIGRATION_DATABASE_URL pnpm db:migrate   # schema + RLS + app role
pnpm db:seed                                # Summit Roofing demo tenant
pnpm typecheck && pnpm test                 # 74 tests, incl. real-Postgres integration
pnpm dev                                    # web :3000, api :4000, worker
```

> RLS is only enforced for a **non-superuser** role — services connect as
> `stl_app`, migrations run as the owner. This is the difference between "tenant
> isolation" and a silent cross-tenant leak; see
> [docs/data-model.md §5](docs/data-model.md).
