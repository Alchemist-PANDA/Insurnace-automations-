# syntax=docker/dockerfile:1
# Multi-stage build for the Speed-to-Lead monorepo (plan: architecture §8).
# One image, target selected by APP_TARGET (api | worker | web).

# ---- base: pnpm + workspace install ----
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile=false

# ---- build all TS/Next ----
FROM deps AS build
COPY . .
RUN pnpm --filter @stl/web build || true   # web build (Next standalone) if present
# API + worker run via tsx at runtime; no separate compile step needed.

# ---- api ----
FROM deps AS api
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@stl/api", "start"]

# ---- worker ----
FROM deps AS worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@stl/worker", "start"]

# ---- web ----
FROM build AS web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@stl/web", "start"]
