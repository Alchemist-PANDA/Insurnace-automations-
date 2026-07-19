# Deployment

How the platform ships to staging/production (plan: architecture §8, PLAN M11).

## Topology

Three services from one image (target-selected), plus managed data services:

- **api** (`apps/api`) — public REST, ingest, provider webhooks. Port 4000.
- **worker** (`apps/worker`) — BullMQ consumers. No public port.
- **web** (`apps/web`) — Next.js dashboard. Port 3000.
- **PostgreSQL 16** and **Redis 7** — managed (PITR backups on Postgres).

Build once, run each target:

```bash
docker build --target api    -t stl-api    .
docker build --target worker -t stl-worker .
docker build --target web    -t stl-web    .
```

## Database roles (non-negotiable)

RLS is only enforced for a **non-superuser, non-BYPASSRLS** role. Services connect
as `stl_app`; migrations run as the owner.

- `DATABASE_URL` → `stl_app` (api, worker, web)
- `MIGRATION_DATABASE_URL` → owner (migrate step only)

`pnpm db:migrate` applies schema → RLS policies → the `stl_app` role/grants,
idempotently. Run it as a **gated step before** new code goes live (see
`.github/workflows/deploy.yml`).

## Required environment (production)

| Var | Notes |
|---|---|
| `NODE_ENV=production` | Forces `AUTH_ALLOW_DEV_HEADERS` off — the x-tenant-id shim is refused. |
| `DATABASE_URL` | `stl_app` role |
| `MIGRATION_DATABASE_URL` | owner role (migrate only) |
| `REDIS_URL` | managed Redis |
| `AUTH_SECRET` | ≥16 chars, session signing |
| `CREDENTIAL_ENCRYPTION_KEY` | base64 32-byte, encrypts OAuth/provider creds at rest |
| `WEB_ORIGIN` | dashboard origin(s) for CORS, comma-separated |
| `USE_FAKE_ADAPTERS=false` | use real Twilio/HubSpot/LLM |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_MESSAGING_SERVICE_SID` | per-tenant sender config layers on top |
| `ANTHROPIC_API_KEY`, `LLM_MODEL` | conversation engine |

Secrets come from the platform's secret manager — never the repo. `.env.example`
lists everything with safe local defaults.

## Pipeline

`.github/workflows/deploy.yml` (on push to `main`):

1. **build** — buildx builds + pushes `api`/`worker`/`web` images to GHCR, tagged
   with the commit SHA.
2. **migrate** — gated on the `production` GitHub environment (manual approval +
   prod secrets); runs `pnpm db:migrate` against `MIGRATION_DATABASE_URL`.
3. **deploy** — wire to your platform (Fly.io / Render / ECS) using the pushed
   image tags. The step is a labeled placeholder; drop in your platform's action.

CI (`.github/workflows/ci.yml`) already gates every push on typecheck + lint +
the full test suite (migrations applied as owner, suite run as `stl_app`).

## Pre-production smoke test

Before pointing real leads at a new environment, prove the live provider wiring:

```bash
USE_FAKE_ADAPTERS=false \
TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_MESSAGING_SERVICE_SID=... \
HUBSPOT_TOKEN=... SMOKE_TO=+1XXXXXXXXXX \
pnpm --filter @stl/worker smoke
```

It sends a real SMS and creates a real HubSpot contact (Google Calendar is
verified via the per-rep OAuth connect flow in staging). A green Twilio + HubSpot
line means the wiring works. Then complete the tenant's A2P 10DLC registration
and the onboarding checklist in [runbooks.md](runbooks.md) before go-live.

## Rollback

Images are immutable per SHA — redeploy the previous tag. Migrations are
forward-only; a bad migration is fixed forward with a new migration, never by
rolling the schema back under live traffic.
