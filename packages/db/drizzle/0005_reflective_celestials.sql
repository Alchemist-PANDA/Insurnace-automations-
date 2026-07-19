CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"assignee_user_id" uuid,
	"note" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"workflow_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stop_reason" text,
	"current_step" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"output" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "tasks_lead" ON "tasks" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_lead" ON "workflow_runs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "workflow_steps_run" ON "workflow_steps" USING btree ("run_id");