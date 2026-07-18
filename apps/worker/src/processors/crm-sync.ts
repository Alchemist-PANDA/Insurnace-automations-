import { eq } from "drizzle-orm";
import { withTenant, schema } from "@stl/db";
import type { CrmSyncJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface CrmSyncResult {
  status: "synced" | "no_connection";
  contactExternalId?: string;
  dealExternalId?: string;
}

/**
 * CRM sync (plan: integrations §4, PLAN M9). Mirrors the lead into the CRM as a
 * contact + deal + note + (if booked) meeting. Upsert-by-external-id via the
 * crm_mappings table means retries never duplicate. Failures throw so BullMQ
 * retries; the crm_sync_jobs row records status for the health screen.
 */
export async function processCrmSync(
  deps: WorkerDeps,
  job: CrmSyncJob,
): Promise<CrmSyncResult> {
  const { db, crm, clock } = deps;

  // Load everything we need under RLS.
  const ctx = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [conn] = await tx
      .select()
      .from(schema.crmConnections)
      .where(eq(schema.crmConnections.tenantId, job.tenantId))
      .limit(1);
    const [lead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    const [mapping] = await tx
      .select()
      .from(schema.crmMappings)
      .where(eq(schema.crmMappings.leadId, job.leadId))
      .limit(1);
    const [appt] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.leadId, job.leadId))
      .limit(1);
    const [qa] = await tx
      .select()
      .from(schema.qualificationAnswers)
      .where(eq(schema.qualificationAnswers.leadId, job.leadId))
      .limit(1);
    // Mark the sync attempt.
    await tx
      .insert(schema.crmSyncJobs)
      .values({ tenantId: job.tenantId, leadId: job.leadId, status: "pending" })
      .onConflictDoNothing();
    return { conn, lead, mapping, appt, qa };
  });

  if (!ctx.conn) return { status: "no_connection" };
  if (!ctx.lead) throw new Error(`lead ${job.leadId} not found`);

  const connection = { accessToken: ctx.conn.accessTokenEnc, portalId: ctx.conn.portalId ?? undefined };

  try {
    // Contact (upsert-by-external-id / email).
    const contact = await crm.upsertContact(connection, {
      externalId: ctx.mapping?.contactExternalId ?? null,
      firstName: ctx.lead.firstName,
      lastName: ctx.lead.lastName,
      email: ctx.lead.emailNormalized,
      phone: ctx.lead.phoneE164,
      source: ctx.lead.sourceId,
    });

    // Deal reflecting current stage/score.
    const deal = await crm.upsertDeal(connection, {
      externalId: ctx.mapping?.dealExternalId ?? null,
      contactExternalId: contact.externalId,
      name: `${ctx.lead.firstName ?? "Lead"} — ${ctx.lead.serviceRequested ?? "service"}`,
      stage: mapStage(ctx.lead.state),
      score: ctx.lead.scoreCurrent,
      band: ctx.lead.scoreBand,
    });

    // Qualification summary note.
    if (ctx.qa) {
      await crm.addNote(connection, {
        contactExternalId: contact.externalId,
        body: `Qualification: ${JSON.stringify(ctx.qa.answers)}`,
      });
    }

    // Meeting for a booked appointment.
    if (ctx.appt) {
      await crm.createMeeting(connection, {
        contactExternalId: contact.externalId,
        title: "Inspection",
        startsAt: ctx.appt.startsAt,
        endsAt: ctx.appt.endsAt,
      });
    }

    await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
      await tx
        .insert(schema.crmMappings)
        .values({
          tenantId: job.tenantId,
          leadId: job.leadId,
          contactExternalId: contact.externalId,
          dealExternalId: deal.externalId,
          lastSyncedAt: clock.now(),
        })
        .onConflictDoUpdate({
          target: schema.crmMappings.leadId,
          set: {
            contactExternalId: contact.externalId,
            dealExternalId: deal.externalId,
            lastSyncedAt: clock.now(),
          },
        });
      await tx
        .update(schema.crmSyncJobs)
        .set({ status: "synced", updatedAt: clock.now() })
        .where(eq(schema.crmSyncJobs.leadId, job.leadId));
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        type: "crm.synced",
        correlationId: job.correlationId,
        payload: { contactExternalId: contact.externalId, dealExternalId: deal.externalId },
      });
      await audit(tx, {
        tenantId: job.tenantId,
        actorType: "integration",
        action: "crm.synced",
        entityType: "lead",
        entityId: job.leadId,
        after: { contactExternalId: contact.externalId, dealExternalId: deal.externalId },
        correlationId: job.correlationId,
      });
    });

    return {
      status: "synced",
      contactExternalId: contact.externalId,
      dealExternalId: deal.externalId,
    };
  } catch (err) {
    await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
      await tx
        .update(schema.crmSyncJobs)
        .set({ status: "failed", lastError: (err as Error).message, updatedAt: clock.now() })
        .where(eq(schema.crmSyncJobs.leadId, job.leadId));
      await emitEvent(tx, {
        tenantId: job.tenantId,
        leadId: job.leadId,
        type: "crm.sync_failed",
        correlationId: job.correlationId,
        payload: { error: (err as Error).message },
      });
    });
    throw err; // let BullMQ retry
  }
}

/** Map our lead state to a generic CRM deal stage. */
function mapStage(state: string): string {
  switch (state) {
    case "qualified":
    case "appointment_offered":
      return "qualifiedtobuy";
    case "booked":
      return "presentationscheduled";
    case "won":
      return "closedwon";
    case "lost":
      return "closedlost";
    default:
      return "appointmentscheduled";
  }
}
