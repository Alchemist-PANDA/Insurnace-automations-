# Testing Strategy

Reliability and compliance are the product. Tests are not a quality gate bolted on
at the end — the milestone plan in [PLAN.md](PLAN.md) makes each milestone's tests
part of its exit criteria.

## 1. Test pyramid

| Layer | Tooling | Scope | Runs |
|---|---|---|---|
| Unit | Vitest | `packages/core`: scoring, routing, policy gate, state machine, slot math, workflow evaluation — pure functions, no I/O | every push, seconds |
| Integration | Vitest + Testcontainers (Postgres, Redis) | repositories under RLS, outbox relay, queue processors, idempotency, opt-out transaction, adapters against fakes | every push |
| Contract | Vitest + recorded fixtures | Twilio/HubSpot/Google webhook parsing + signature validation against captured real payloads | every push |
| E2E | Playwright + full compose stack (fake providers) | the primary lead-to-booking journey through real HTTP + queues + UI | main + release branches |
| Load | k6 | webhook burst (50 concurrent), sustained inbound replies; asserts ack < 2s, first-touch p95 | M11, then scheduled |

Provider fakes live in `packages/testing`: `FakeSmsChannel` (records sends, can
inject delivery events and inbound replies), `FakeCrm`, `FakeCalendar` (scriptable
busy intervals, race injection), `FakeLlm` (scripted structured outputs, including
malformed and adversarial ones).

## 2. MVP acceptance criteria → test traceability

| # | Criterion | Proving test(s) | Milestone |
|---|---|---|---|
| 1 | Test web lead creates exactly one lead | integration: replay same webhook 5×, count leads/events | M2 |
| 2 | First SMS initiated within 30 s | E2E timing assertion + load-test p95 | M3/M11 |
| 3 | Replayed webhooks send no duplicate messages | integration: replay + retry job storms; unique dedupe constraint hit | M3 |
| 4 | STOP immediately suppresses future messages | integration: STOP mid-sequence → scheduled jobs gone, outbox voided, consent revoked, state opted_out — all in one assertion set | M3 |
| 5 | Inbound replies appear in dashboard | E2E: reply → timeline render | M3 |
| 6 | Qualification answers saved as structured data | integration: scripted FakeLlm turns → `qualification_answers` rows | M6 |
| 7 | Qualified lead books a real calendar slot | E2E with FakeCalendar; manual verification against real Google in staging | M7 |
| 8 | Human takeover pauses automation | integration: takeover → conversation jobs dropped, workflow stopped | M8 |
| 9 | Failed messages visible and retryable | integration: injected provider failure → DLQ → admin retry succeeds | M3 |
| 10 | HubSpot receives contact, notes, appointment | integration vs FakeCrm; staging test vs sandbox portal | M9 |
| 11 | Every automated action has an audit entry | integration: E2E journey → audit completeness assertion (action inventory diff) | M2–M10 |
| 12 | Tenant A cannot access Tenant B data | dedicated cross-tenant attack suite (API + repository level) | M1, permanent |
| 13 | AI cannot execute unapproved tools | unit: policy gate rejects non-allowlisted actions; adversarial FakeLlm outputs | M6 |
| 14 | AI cannot invent pricing/services | unit: claim-verification corpus (pricing, guarantees, discounts, off-book services) | M6 |
| 15 | Response-time and booking metrics accurate | golden dataset: seeded scenario with hand-computed expected metrics | M10 |

## 3. Primary end-to-end test (the release gate)

One Playwright + API test proves the full revenue path against the compose stack
with fake providers:

1. Signed webhook POST → 202 in < 2 s.
2. Lead appears normalized in inbox (name, E.164 phone, source).
3. Lead scored; band and breakdown visible; assignment recorded.
4. First-touch SMS job created; FakeSms records exactly one send with correct
   personalization.
5. Injected delivery callback → timeline shows `delivered`.
6. Injected lead reply → orchestrator runs → next question sent.
7. Scripted answers complete the schema → `qualification_answers` populated,
   state `qualified`.
8. Slot offer sent; booking chosen → FakeCalendar event exists; state `booked`;
   reminders scheduled.
9. FakeCrm holds contact + deal + note + meeting.
10. Metrics endpoint reflects the journey (response time, funnel counters).
11. Audit log contains an entry for every automated action in the journey
    (asserted against an action inventory, so new actions can't silently skip
    auditing).

## 4. Adversarial & property-based suites

- **Policy gate fuzzing:** property tests feed randomized/adversarial LLM outputs
  (prompt-injection attempts, oversized replies, fake knowledge refs, disallowed
  actions) — gate must never approve an invalid action.
- **Opt-out corpus:** 100+ phrasings of withdrawal (typos, mixed case, mid-sentence)
  → detector recall measured; ambiguous cases must resolve to opt-out.
- **State machine exhaustion:** every (state, event) pair asserted as either a
  defined transition or a rejected+audited one — no undefined behavior.
- **Calendar race:** two concurrent bookings for one slot — exactly one wins,
  the loser gets a clean re-offer, no orphan holds.
- **Out-of-order events:** delivery callbacks delivered shuffled and duplicated —
  final status correct.
- **Clock control:** all time-dependent logic (quiet hours, SLA ladders, decay,
  holds) takes an injected clock; tests never sleep.

## 5. CI pipeline

```text
push → typecheck → lint (incl. no-raw-db-access, no-dangerouslySetInnerHTML rules)
     → unit → integration (Testcontainers) → migration drift check → build
main → + E2E (compose) → + docker image publish → staging deploy
release → + load test → production deploy (migrations gated)
```

Flaky-test policy: a flaky reliability test is a P1 bug, not a retry candidate —
flakiness in idempotency/opt-out/RLS suites usually means a real race.
