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

Planning phase complete. Implementation begins with Milestone 0 (repo scaffold) per
[docs/PLAN.md](docs/PLAN.md).
