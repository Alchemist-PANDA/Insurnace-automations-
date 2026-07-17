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

Planning complete **and Slice 1 (the revenue-critical spine) is built, wired, and
verified end-to-end**: generic signed webhook → lead record → dedup → explainable
scoring → first-touch SMS (via transactional outbox) → inbound reply → conversation
timeline, plus deterministic STOP/opt-out handling and database-enforced tenant
isolation.

### What's implemented

| Area | State | Where |
|---|---|---|
| Monorepo, tooling, CI, Docker | ✅ | root, `.github/workflows/ci.yml` |
| Env validation, structured logging (PII redaction) | ✅ | `packages/config`, `packages/logger` |
| Domain core (normalize, dedup, state machine, scoring, opt-out, **policy gate**) | ✅ 44 tests | `packages/core` |
| DB schema + **row-level tenant isolation** + seed | ✅ 5 tests | `packages/db` |
| Queue topology + Twilio/fake messaging adapter | ✅ 5 tests | `packages/queue`, `packages/adapters/messaging` |
| Signed ingest gateway + Twilio webhooks + read API | ✅ 9 tests | `apps/api` |
| Slice 1 worker processors (ingest→score→first-touch→relay→inbound/opt-out) | ✅ 7 E2E tests | `apps/worker` |
| Dashboard: lead inbox + lead detail/timeline | ✅ | `apps/web` |
| Conversation engine, routing, booking, CRM sync, analytics | ⏳ M5–M10 | see [PLAN.md](docs/PLAN.md) |

**MVP acceptance criteria proven by tests today:** #1 (one lead), #2 (<30s /
<2s ack), #3 (no duplicate messages on replay/retry), #4 (STOP suppresses +
cancels scheduled sends), #5 (replies in dashboard), #11 (audit per action),
#12 (tenant isolation), #13 (AI cannot execute unapproved tools), #14 (AI cannot
invent pricing). Remaining criteria are wired to their milestones in
[docs/testing.md](docs/testing.md).

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
