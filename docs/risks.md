# Risks, Assumptions, and Open Decisions

## 1. Top risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **A2P 10DLC registration delays** block pilot SMS (brand/campaign vetting can take days–weeks; a home-services tenant with thin web presence can be rejected) | High | High | Start pilot tenant's registration during M5, not M11; runbook with pre-vetted campaign copy; email channel as interim first-touch; toll-free verification as fallback path |
| R2 | **Duplicate or non-compliant message reaches a consumer** (TCPA exposure, carrier filtering, brand damage) | Medium | Critical | Outbox + unique dedupe constraints + deterministic gate + opt-out corpus tests; Twilio Advanced Opt-Out as second net; counsel review gate before production |
| R3 | **Cross-tenant data leak** | Low (with RLS) | Critical | Three-layer isolation (RLS, typed repositories, permanent attack suite); no BYPASSRLS app role; audited admin elevation |
| R4 | **LLM output quality**: bad extraction or tone alienates leads | Medium | Medium | Structured-output contract + claim verification + fallback templates; every turn auditable; pilot-phase human review queue for low-confidence turns; model swap is config |
| R5 | **First-touch latency SLO missed** under real load | Medium | High | Latency budget per stage (ack <2s, normalize <5s, gate+compose <5s, provider <10s); priority queue for first-touch; load tests in M11 with alerting on p95 |
| R6 | **Google/HubSpot OAuth app verification** friction (unverified-app warnings, scope reviews) | Medium | Medium | Begin verification processes at M7/M9 start; pilot can run on test-user allowlists meanwhile |
| R7 | **Scope creep toward the "do not build" list** (workflow builder, more CRMs, voice AI) | High | Medium | PLAN.md scope statement is the contract; changes require explicit re-plan; vertical-slice ordering keeps the revenue path first |
| R8 | **Estimates slip** (~18 engineer-weeks is aggressive for this surface) | High | Medium | Milestones are independently shippable; pilot can start after M9 with manual analytics if needed; M10 dashboards are the only milestone deferrable without breaking the core promise |
| R9 | **Consent quality of real-world lead sources** (tenant's forms lack proper disclosure language) | High | High | Onboarding checklist includes disclosure review; leads without evidence auto-quarantined from SMS; template disclosure copy provided to tenants |
| R10 | **Provider outage** (Twilio/LLM/HubSpot down) | Medium | Medium | Circuit breakers, DLQ, degraded deterministic modes; leads never dropped, only delayed — and visibly so on the health screen |

## 2. Assumptions

1. One pilot tenant (roofing/HVAC), US-only, English-only for MVP. i18n deferred.
2. Lead volume at pilot scale: ≤ 2,000 leads/month/tenant, ≤ 10 tenants — a single
   Postgres + Redis handles this with wide margin; no sharding work needed.
3. WhatsApp and AI voice are interface stubs only in MVP (channel enum + adapter
   interface exist; no implementation).
4. Facebook/Google lead forms arrive via Zapier → generic webhook during pilot;
   native adapters are Phase 2.
5. The pilot tenant uses HubSpot (or accepts CRM-less operation with our dashboard
   as interim record) — GoHighLevel is explicitly Phase 3.
6. Billing is invoiced manually during pilot; no billing engine.
7. Sales reps have Google Calendar; Outlook/Microsoft 365 is Phase 3.
8. Anthropic API is the initial LLM provider; the abstraction keeps this swappable.
9. Deployment target is a container platform (Fly.io / Render / ECS — final choice
   at M0 by ops preference); nothing in the architecture depends on the choice.
10. "Insurance claim" data collected for roofing leads is claim *status* only
    (yes/no/deadline) — no policy documents, keeping us clear of regulated-data
    handling in MVP.

## 3. Open decisions (with owners and deadlines)

| Decision | Options | Decide by | Default if undecided |
|---|---|---|---|
| Email provider | Resend vs Postmark | M3 start | Postmark (deliverability track record) |
| Deployment platform | Fly.io / Render / AWS ECS | M0 | Render (fastest managed PG+Redis path) |
| Auth library final check | better-auth vs Auth.js v5 | M1 start | better-auth (org plugin fit) |
| Error monitoring | Sentry vs self-hosted GlitchTip | M0 | Sentry |
| Pilot tenant | real prospect TBD | M5 | internal demo tenant doubles as staging |
| LLM model tier per turn | single model vs cheap-classify + strong-converse split | M6 | single model, optimize later with usage data |

## 4. Kill criteria / re-plan triggers

Re-open this plan (do not push through) if any of these occur:

- A2P registration for the pilot tenant is rejected twice → re-plan channel
  strategy (email-first + toll-free) before building more SMS surface.
- Policy-gate false-reject rate in pilot > 20% of AI turns → the claim-verification
  heuristics are too blunt; invest in gate quality before adding features.
- First-touch p95 > 90 s after M11 tuning → architecture review of the ingest →
  send path before onboarding tenant #2.
- Pilot tenant's close-rate data too noisy to attribute anything after 60 days →
  revisit the analytics design with matched-cohort methodology before selling
  reporting as a differentiator.
