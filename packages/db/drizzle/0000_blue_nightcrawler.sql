CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"consent_source" text,
	"disclosure_text_version" text,
	"source_url_or_form_id" text,
	"ip_address" text,
	"external_evidence" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_method" text
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"ai_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_idempotency" (
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_idempotency_tenant_id_source_id_idempotency_key_pk" PRIMARY KEY("tenant_id","source_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"model_version" text NOT NULL,
	"total" integer NOT NULL,
	"band" text NOT NULL,
	"breakdown" jsonb NOT NULL,
	"triggered_by_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"signing_secret" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"state" text DEFAULT 'received' NOT NULL,
	"first_name" text,
	"last_name" text,
	"email_normalized" text,
	"phone_e164" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"service_requested" text,
	"property_type" text,
	"urgency" text,
	"is_existing_customer" boolean DEFAULT false NOT NULL,
	"score_current" integer,
	"score_band" text,
	"assigned_user_id" uuid,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_touch_at" timestamp with time zone,
	"first_reply_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"provider_sid" text,
	"status" text NOT NULL,
	"error_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"template_key" text,
	"dedupe_key" text,
	"provider_sid" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"policy_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"intent_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"channel" text NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"quiet_hours_start" integer DEFAULT 8 NOT NULL,
	"quiet_hours_end" integer DEFAULT 21 NOT NULL,
	"follow_up_cap" integer DEFAULT 5 NOT NULL,
	"business_name" text DEFAULT '' NOT NULL,
	"agent_name" text DEFAULT 'Ava' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"vertical" text DEFAULT 'roofing_hvac' NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"sms_campaign_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "audit_tenant_created" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_lead_channel" ON "consent_records" USING btree ("lead_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_lead_channel" ON "conversations" USING btree ("lead_id","channel");--> statement-breakpoint
CREATE INDEX "lead_events_lead" ON "lead_events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_events_tenant_type" ON "lead_events" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "lead_identities_lookup" ON "lead_identities" USING btree ("tenant_id","kind","value");--> statement-breakpoint
CREATE INDEX "lead_scores_lead" ON "lead_scores" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_sources_tenant_key" ON "lead_sources" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_open_phone" ON "leads" USING btree ("tenant_id","phone_e164") WHERE state not in ('archived','lost','won','opted_out') and phone_e164 is not null;--> statement-breakpoint
CREATE INDEX "leads_tenant_state" ON "leads" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "delivery_events_message" ON "message_delivery_events" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_tenant_key" ON "message_templates" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_dedupe" ON "messages" USING btree ("tenant_id","conversation_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "outbox_pending" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "raw_webhooks_tenant_source" ON "raw_webhooks" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_scope_value" ON "suppression_entries" USING btree ("tenant_id","channel","value");