CREATE TABLE "lead_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"user_id" uuid,
	"role" text DEFAULT 'primary' NOT NULL,
	"reason" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_state" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"round_robin_cursor" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "territories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_schedules" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"workload_cap" integer DEFAULT 10 NOT NULL,
	"specialties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_schedules_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "lead_assignments_lead" ON "lead_assignments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "territories_tenant" ON "territories" USING btree ("tenant_id");