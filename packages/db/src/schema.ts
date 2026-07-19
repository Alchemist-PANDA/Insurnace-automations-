import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Database schema (plan: data-model.md). Every operational table carries
 * tenant_id and is covered by row-level security (see rls.sql). Timestamps are
 * timestamptz; ids are UUID (v7 generated in app; DB default is a fallback).
 */

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () => uuid("tenant_id").notNull();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ─── Tenancy & access ─────────────────────────────────────────────────────

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  vertical: text("vertical").notNull().default("roofing_hvac"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  // A2P 10DLC gate: production SMS blocked until a campaign is verified.
  smsCampaignVerified: boolean("sms_campaign_verified").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    // platform_admin | tenant_owner | sales_manager | sales_rep | analyst
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: tenantId().primaryKey(),
  quietHoursStart: integer("quiet_hours_start").notNull().default(8),
  quietHoursEnd: integer("quiet_hours_end").notNull().default(21),
  followUpCap: integer("follow_up_cap").notNull().default(5),
  businessName: text("business_name").notNull().default(""),
  agentName: text("agent_name").notNull().default("Ava"),
  updatedAt: updatedAt(),
});

// ─── Ingestion ────────────────────────────────────────────────────────────

export const leadSources = pgTable(
  "lead_sources",
  {
    id: id(),
    tenantId: tenantId(),
    key: text("key").notNull(), // used in the ingest URL
    name: text("name").notNull(),
    // HMAC secret for signature verification of inbound webhooks.
    signingSecret: text("signing_secret").notNull(),
    // Field mapping from raw payload → normalized lead.
    mapping: jsonb("mapping").notNull().default({}),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("lead_sources_tenant_key").on(t.tenantId, t.key)],
);

export const rawWebhooks = pgTable(
  "raw_webhooks",
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid("source_id").notNull(),
    payload: jsonb("payload").notNull(),
    headers: jsonb("headers").notNull().default({}),
    receivedAt: createdAt(),
  },
  (t) => [index("raw_webhooks_tenant_source").on(t.tenantId, t.sourceId)],
);

// Idempotency ledger — replays are acknowledged but never reprocessed.
export const ingestIdempotency = pgTable(
  "ingest_idempotency",
  {
    tenantId: tenantId(),
    sourceId: uuid("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    leadId: uuid("lead_id"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sourceId, t.idempotencyKey] }),
  ],
);

// ─── Leads ────────────────────────────────────────────────────────────────

export const leads = pgTable(
  "leads",
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid("source_id"),
    state: text("state").notNull().default("received"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    emailNormalized: text("email_normalized"),
    phoneE164: text("phone_e164"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    serviceRequested: text("service_requested"),
    propertyType: text("property_type"),
    urgency: text("urgency"),
    isExistingCustomer: boolean("is_existing_customer").notNull().default(false),
    scoreCurrent: integer("score_current"),
    scoreBand: text("score_band"),
    assignedUserId: uuid("assigned_user_id"),
    externalIds: jsonb("external_ids").notNull().default({}),
    customFields: jsonb("custom_fields").notNull().default({}),
    firstTouchAt: timestamp("first_touch_at", { withTimezone: true }),
    firstReplyAt: timestamp("first_reply_at", { withTimezone: true }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Open-lead dedup enforced by the database, not just application code.
    uniqueIndex("leads_open_phone")
      .on(t.tenantId, t.phoneE164)
      .where(sql`state not in ('archived','lost','won','opted_out') and phone_e164 is not null`),
    index("leads_tenant_state").on(t.tenantId, t.state),
  ],
);

// Append-only event log — the analytics source of truth.
export const leadEvents = pgTable(
  "lead_events",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    correlationId: text("correlation_id"),
    actor: text("actor").notNull().default("system"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("lead_events_lead").on(t.leadId),
    index("lead_events_tenant_type").on(t.tenantId, t.type),
  ],
);

export const leadIdentities = pgTable(
  "lead_identities",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    kind: text("kind").notNull(), // phone | email | external
    value: text("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("lead_identities_lookup").on(t.tenantId, t.kind, t.value),
  ],
);

// ─── Routing & assignment (plan: blueprint §5G, PLAN M5) ───────────────────

export const territories = pgTable(
  "territories",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    // ZIP prefix or region code this rep covers.
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("territories_tenant").on(t.tenantId)],
);

export const userSchedules = pgTable(
  "user_schedules",
  {
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    available: boolean("available").notNull().default(true),
    workloadCap: integer("workload_cap").notNull().default(10),
    specialties: jsonb("specialties").notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const leadAssignments = pgTable(
  "lead_assignments",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    userId: uuid("user_id"),
    role: text("role").notNull().default("primary"), // primary|fallback
    reason: text("reason"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("lead_assignments_lead").on(t.leadId)],
);

// Rolling round-robin cursor per tenant (single row).
export const routingState = pgTable("routing_state", {
  tenantId: tenantId().primaryKey(),
  roundRobinCursor: integer("round_robin_cursor").notNull().default(0),
  updatedAt: updatedAt(),
});

// ─── Compliance ───────────────────────────────────────────────────────────

export const consentRecords = pgTable(
  "consent_records",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull(), // granted | revoked | unknown
    consentSource: text("consent_source"),
    disclosureTextVersion: text("disclosure_text_version"),
    sourceUrlOrFormId: text("source_url_or_form_id"),
    ipAddress: text("ip_address"),
    externalEvidence: jsonb("external_evidence"),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationMethod: text("revocation_method"),
  },
  (t) => [index("consent_lead_channel").on(t.leadId, t.channel)],
);

export const suppressionEntries = pgTable(
  "suppression_entries",
  {
    id: id(),
    // tenant_id null = platform-level suppression
    tenantId: uuid("tenant_id"),
    channel: text("channel").notNull(),
    value: text("value").notNull(), // phone/email
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("suppression_scope_value").on(t.tenantId, t.channel, t.value),
  ],
);

// ─── Conversation ─────────────────────────────────────────────────────────

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    channel: text("channel").notNull().default("sms"),
    aiPaused: boolean("ai_paused").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversation_lead_channel").on(t.leadId, t.channel)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id").notNull(),
    direction: text("direction").notNull(), // in | out
    channel: text("channel").notNull(),
    body: text("body").notNull(),
    templateKey: text("template_key"),
    dedupeKey: text("dedupe_key"),
    providerSid: text("provider_sid"),
    status: text("status").notNull().default("queued"),
    policySnapshot: jsonb("policy_snapshot"),
    createdAt: createdAt(),
  },
  (t) => [
    // No duplicate first-touch (or any dedupe-keyed message), ever.
    uniqueIndex("messages_dedupe")
      .on(t.tenantId, t.conversationId, t.dedupeKey)
      .where(sql`dedupe_key is not null`),
    index("messages_conversation").on(t.conversationId),
  ],
);

export const messageDeliveryEvents = pgTable(
  "message_delivery_events",
  {
    id: id(),
    tenantId: tenantId(),
    messageId: uuid("message_id").notNull(),
    providerSid: text("provider_sid"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("delivery_events_message").on(t.messageId)],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    channel: text("channel").notNull().default("sms"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("templates_tenant_key").on(t.tenantId, t.key)],
);

// ─── Reliability: transactional outbox ─────────────────────────────────────

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    tenantId: tenantId(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    intentType: text("intent_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending|dispatched|failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_pending").on(t.status, t.nextAttemptAt)],
);

// ─── Scoring ──────────────────────────────────────────────────────────────

export const leadScores = pgTable(
  "lead_scores",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    modelVersion: text("model_version").notNull(),
    total: integer("total").notNull(),
    band: text("band").notNull(),
    breakdown: jsonb("breakdown").notNull(),
    triggeredByEventId: uuid("triggered_by_event_id"),
    createdAt: createdAt(),
  },
  (t) => [index("lead_scores_lead").on(t.leadId)],
);

// ─── Scheduling (plan: integrations §3, PLAN M7) ───────────────────────────

export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    provider: text("provider").notNull().default("google"),
    calendarId: text("calendar_id").notNull(),
    // Encrypted at rest in the app layer before storage.
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("calendar_conn_user").on(t.tenantId, t.userId)],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    userId: uuid("user_id"),
    calendarConnectionId: uuid("calendar_connection_id"),
    externalEventId: text("external_event_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("booked"), // booked|cancelled|no_show|completed
    createdAt: createdAt(),
  },
  (t) => [index("appointments_lead").on(t.leadId)],
);

export const slotHolds = pgTable(
  "slot_holds",
  {
    id: id(),
    tenantId: tenantId(),
    calendarConnectionId: uuid("calendar_connection_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("held"), // held|confirmed|released
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Two leads cannot hold/confirm the same calendar slot concurrently.
    uniqueIndex("slot_holds_unique")
      .on(t.calendarConnectionId, t.startsAt)
      .where(sql`status in ('held','confirmed')`),
  ],
);

// ─── Knowledge & qualification (plan: conversation-engine §5/§6) ───────────

export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: id(),
    tenantId: tenantId(),
    // service | service_area | hours | pricing_guidance | financing | warranty
    // | faq | exclusion | escalation_rule | promotion
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    approved: boolean("approved").notNull().default(false),
    approvedBy: uuid("approved_by"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("knowledge_tenant_type").on(t.tenantId, t.type)],
);

export const qualificationAnswers = pgTable(
  "qualification_answers",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    schemaKey: text("schema_key").notNull(),
    answers: jsonb("answers").notNull().default({}),
    complete: boolean("complete").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("qualification_lead").on(t.leadId)],
);

export const aiInteractions = pgTable(
  "ai_interactions",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    conversationId: uuid("conversation_id"),
    promptHash: text("prompt_hash"),
    rawResponse: text("raw_response"),
    parsed: jsonb("parsed"),
    gateVerdict: jsonb("gate_verdict"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_interactions_lead").on(t.leadId)],
);

// ─── Workflows & tasks (plan: blueprint §5J, PLAN M8) ──────────────────────

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    workflowKey: text("workflow_key").notNull(),
    version: integer("version").notNull().default(1),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"), // running|completed|stopped|failed
    stopReason: text("stop_reason"),
    currentStep: integer("current_step").notNull().default(0),
    startedAt: createdAt(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("workflow_runs_lead").on(t.leadId)],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    stepKey: text("step_key").notNull(),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("scheduled"), // scheduled|executed|skipped|failed
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    output: jsonb("output"),
    error: text("error"),
  },
  (t) => [index("workflow_steps_run").on(t.runId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    assigneeUserId: uuid("assignee_user_id"),
    note: text("note").notNull(),
    status: text("status").notNull().default("open"), // open|done
    createdAt: createdAt(),
  },
  (t) => [index("tasks_lead").on(t.leadId)],
);

// ─── CRM (plan: integrations §4, PLAN M9) ──────────────────────────────────

export const crmConnections = pgTable(
  "crm_connections",
  {
    id: id(),
    tenantId: tenantId(),
    provider: text("provider").notNull().default("hubspot"),
    accessTokenEnc: text("access_token_enc").notNull(),
    portalId: text("portal_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("crm_conn_tenant_provider").on(t.tenantId, t.provider)],
);

export const crmMappings = pgTable(
  "crm_mappings",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    contactExternalId: text("contact_external_id"),
    dealExternalId: text("deal_external_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("crm_mapping_lead").on(t.leadId)],
);

export const crmSyncJobs = pgTable(
  "crm_sync_jobs",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    status: text("status").notNull().default("pending"), // pending|synced|failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: updatedAt(),
  },
  (t) => [index("crm_sync_lead").on(t.leadId)],
);

// ─── Audit ────────────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    tenantId: tenantId(),
    actorType: text("actor_type").notNull(), // user|system|ai|integration
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_tenant_created").on(t.tenantId, t.createdAt)],
);

// Tables that carry a tenant_id and must be covered by RLS.
export const TENANT_SCOPED_TABLES = [
  "tenant_settings",
  "memberships",
  "lead_sources",
  "raw_webhooks",
  "ingest_idempotency",
  "leads",
  "lead_events",
  "lead_identities",
  "consent_records",
  "conversations",
  "messages",
  "message_delivery_events",
  "message_templates",
  "outbox",
  "lead_scores",
  "territories",
  "user_schedules",
  "lead_assignments",
  "routing_state",
  "knowledge_entries",
  "qualification_answers",
  "ai_interactions",
  "calendar_connections",
  "appointments",
  "slot_holds",
  "crm_connections",
  "crm_mappings",
  "crm_sync_jobs",
  "workflow_runs",
  "workflow_steps",
  "tasks",
  "audit_logs",
] as const;
