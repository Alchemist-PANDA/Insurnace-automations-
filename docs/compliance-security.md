# Compliance & Security

Compliance decisions are deterministic application logic. The LLM is never in the
consent, opt-out, or sending-permission loop. Legal counsel reviews the final
messaging/calling/consent implementation before production — this document defines
what we build so that review has something concrete to approve.

## 1. Consent model (TCPA / A2P 10DLC posture)

### Consent ledger

Append-only `consent_records` per (lead, channel):

| Field | Purpose |
|---|---|
| `status` | granted / revoked / unknown |
| `consent_source` | web_form, fb_lead_ad, inbound_sms, verbal_logged, import |
| `disclosure_text_version` | exact opt-in language shown, versioned |
| `source_url_or_form_id` | where consent was captured |
| `ip_address` | when available (web forms) |
| `external_evidence` | vendor payload proving opt-in |
| `captured_at` / `revoked_at` / `revocation_method` | full timeline |

### Deterministic sending gate

Before any automated outbound message:

```text
has current granted consent for channel?
  AND lead not in tenant suppression list
  AND lead not in platform suppression list
  AND channel delivery not in repeated-failure lockout
  AND within quiet hours OR schedulable to next window
  AND under follow-up caps
→ else: no send. No exceptions, no LLM involvement, no override flag.
```

Leads arriving without consent evidence (e.g. CSV import of unknown provenance) are
marked `unknown` and are **not eligible for automated SMS**; they surface in a
manual-review queue. Purchased-lead consent complexity is a documented reason we
defer the solar vertical.

### Opt-out handling

- Keywords (case/whitespace-insensitive): STOP, UNSUBSCRIBE, CANCEL, END, QUIT —
  matched deterministically before the LLM ever sees the message.
- Free-text withdrawal ("don't contact me again", "remove my number", "stop
  texting") detected by a deterministic pattern set **plus** LLM `possible_opt_out`
  intent as a secondary net; any positive from either → treated as opt-out.
  Ambiguity resolves toward opting out.
- On opt-out, in one transaction: consent revocation appended → suppression entry
  written → **all scheduled/queued messages for the lead cancelled** (outbox rows
  voided, delayed jobs removed) → state `opted_out` → audit entry → confirmation
  reply (single, compliant, final).
- HELP keyword returns tenant identification + contact info.
- Twilio Advanced Opt-Out stays enabled as a provider-level second net; our ledger
  remains the source of truth and reconciles provider opt-out webhooks.

### A2P 10DLC operational requirements

- Per-tenant brand + campaign registration is an onboarding gate; unregistered
  tenants cannot enable production SMS (enforced by a tenant flag the platform
  checks at send time).
- Campaign registration content (use case, sample messages, opt-in/opt-out
  descriptions) generated from the tenant's actual configured templates — no drift
  between what's registered and what's sent.
- Quiet hours default 8am–9pm lead-local time, tenant-tightenable, never
  tenant-loosenable beyond platform bounds.

## 2. Vertical compliance boundaries

- Roofing/HVAC first **because** it avoids PHI and professional-ethics complexity.
- Hard product guard: healthcare-adjacent tenants (dental, med spa) cannot be
  provisioned until a HIPAA mode exists (BAA, PHI handling, restricted logging).
  This is a platform-admin-enforced tenant type, not a sales-side promise.
- Solar (purchased leads, aggressive dialing norms) deferred until consent-evidence
  tooling for third-party lead vendors is built and counsel-reviewed.

## 3. Security architecture

### Identity & access

- better-auth sessions: httpOnly, Secure, SameSite=Lax cookies; CSRF tokens on
  state-changing browser routes; session rotation on privilege change.
- RBAC roles: `platform_admin`, `tenant_owner`, `sales_manager`, `sales_rep`,
  `analyst` (read-only). Permission checks server-side per route + per repository
  call; UI hides what the server already forbids.
- Platform-admin cross-tenant access requires explicit, audited elevation
  (reason string recorded), never ambient.

### Tenant isolation

Three layers (detailed in [data-model.md §5](data-model.md)): Postgres RLS with
`SET LOCAL app.tenant_id`, type-enforced repository scoping, and a permanent
cross-tenant attack test suite. App DB role has no `BYPASSRLS`.

### Secrets & credentials

- No secrets in source control; local dev via `.env` (gitignored) validated by
  `packages/config`; production via cloud secret manager.
- OAuth tokens (Google, HubSpot) and Twilio credentials encrypted at rest
  (AES-256-GCM, key in KMS, per-tenant data keys); decrypted only in adapter
  memory, never logged, never sent to the web app.
- Least-privilege OAuth scopes; scope list documented per integration and reviewed
  at connect time.

### Inbound surface hardening

- Signature verification on every webhook (Twilio signature, HubSpot v3, HMAC for
  generic ingest) + timestamp window (±5 min) against replay.
- Rate limiting: per-source-key on ingest, per-IP on auth routes, global limits on public
  endpoints via Redis counters.
- Input validation with zod on every payload; output escaping in the web app
  (React defaults + no `dangerouslySetInnerHTML` policy, lint-enforced).
- Idempotency everywhere a retry can occur (see architecture §5.3).

### PII handling

- pino redaction: phone numbers, emails, message bodies, and names masked in
  application logs; full content lives only in the database under RLS.
- `ai_interactions` prompt/response storage follows tenant retention config.
- Export workflow: tenant-owner-initiated, produces a per-lead JSON/CSV bundle.
- Deletion workflow: lead-level erasure with tombstone audit entry; consent and
  suppression records are retained (legal-basis records), contact fields hashed.

### Audit

`audit_logs` covers: auth events, configuration changes, workflow publishes,
assignments, score model changes, every message send decision (with policy
snapshot), AI interactions, integration actions, opt-outs, takeovers, appointment
changes, data export/deletion. Append-only; the compliance dashboard and the
System Health page read from it.

## 4. Compliance dashboard (M10)

Surfaces: consent evidence per lead, opt-out log, suppression list management
(add/search; removals require reason + audit), failed deliveries, complaint
indicators (carrier error codes, angry-lead flags), active message templates with
version history, retention settings, deletion-request tracker, full audit search.

## 5. Pre-production compliance checklist (gates the pilot)

- [ ] Counsel review of message templates, opt-in disclosures, opt-out flows
- [ ] A2P 10DLC brand + campaign approved for the pilot tenant
- [ ] STOP handled end-to-end in < 5 s in staging (measured, not assumed)
- [ ] Opt-out cancels every scheduled send (verified by the M3 test suite)
- [ ] Quiet-hours enforcement verified across timezones
- [ ] Cross-tenant test suite green
- [ ] PII redaction verified by log inspection in staging
- [ ] Secrets audit: no credentials in repo history, env files, or logs
- [ ] Backup restore drill completed
- [ ] Incident-response runbook: who is paged when opt-out processing fails
