import { eq, and, lt } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import { assertTransition } from "@stl/core";
import type { BookingJob } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { emitEvent, audit } from "../events.js";

export interface BookingResult {
  status: "booked" | "slot_taken" | "no_calendar";
  appointmentId?: string;
  externalEventId?: string;
}

/**
 * Booking processor (plan: integrations §3, PLAN M7). Protects against two
 * leads booking the same slot concurrently: the slot_holds unique partial index
 * is the authority. We acquire the hold FIRST (in a tx); only the winner then
 * creates the calendar event and confirms. A loser gets slot_taken cleanly.
 */
export async function processBooking(
  deps: WorkerDeps,
  job: BookingJob,
): Promise<BookingResult> {
  const { db, calendar, clock } = deps;
  const startsAt = new Date(job.startsAt);
  const endsAt = new Date(job.endsAt);

  // Look up the calendar connection first (read-only tx).
  const conn = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [c] = await tx
      .select()
      .from(schema.calendarConnections)
      .where(eq(schema.calendarConnections.id, job.calendarConnectionId))
      .limit(1);
    return c ?? null;
  });
  if (!conn) return { status: "no_calendar" };

  // Step 1: acquire the hold in ITS OWN transaction. The unique partial index
  // is the race arbiter. A unique violation aborts that transaction, so the
  // catch MUST be outside it — catching inside a live tx and continuing would
  // fail at commit. This is why the hold insert is isolated here.
  let holdId: string;
  try {
    holdId = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
      const [row] = await tx
        .insert(schema.slotHolds)
        .values({
          tenantId: job.tenantId,
          calendarConnectionId: job.calendarConnectionId,
          leadId: job.leadId,
          startsAt,
          endsAt,
          status: "held",
          expiresAt: new Date(clock.now().getTime() + 5 * 60_000),
        })
        .returning({ id: schema.slotHolds.id });
      return row!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "slot_taken" };
    throw err;
  }
  const hold = { holdId, conn };

  // Step 2: create the external calendar event (outside the tx — no network in
  // a transaction). If this throws, the hold is released for a retry.
  let externalEventId: string;
  try {
    const [lead] = await withTenant(db, { tenantId: job.tenantId }, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.id, job.leadId)).limit(1),
    );
    const result = await calendar.createEvent(
      { calendarId: hold.conn.calendarId, accessToken: hold.conn.accessTokenEnc },
      {
        summary: `Inspection — ${lead?.firstName ?? "Lead"} (${lead?.serviceRequested ?? "service"})`,
        start: startsAt,
        end: endsAt,
        attendeeEmail: lead?.emailNormalized,
      },
    );
    externalEventId = result.externalEventId;
  } catch (err) {
    await withTenant(db, { tenantId: job.tenantId }, (tx) =>
      tx
        .update(schema.slotHolds)
        .set({ status: "released" })
        .where(eq(schema.slotHolds.id, hold.holdId)),
    );
    throw err;
  }

  // Step 3: confirm the hold, create the appointment, advance the lead — atomic.
  return withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    await tx
      .update(schema.slotHolds)
      .set({ status: "confirmed" })
      .where(eq(schema.slotHolds.id, hold.holdId));

    const [appt] = await tx
      .insert(schema.appointments)
      .values({
        tenantId: job.tenantId,
        leadId: job.leadId,
        calendarConnectionId: job.calendarConnectionId,
        externalEventId,
        startsAt,
        endsAt,
        status: "booked",
      })
      .returning({ id: schema.appointments.id });

    const [lead] = await tx
      .select({ state: schema.leads.state })
      .from(schema.leads)
      .where(eq(schema.leads.id, job.leadId))
      .limit(1);
    if (lead) {
      // qualified/appointment_offered → booked.
      if (lead.state !== "booked") {
        assertTransition(lead.state as never, "booked");
        await tx
          .update(schema.leads)
          .set({ state: "booked", bookedAt: clock.now() })
          .where(eq(schema.leads.id, job.leadId));
      }
    }

    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId: job.leadId,
      type: "appointment.booked",
      correlationId: job.correlationId,
      payload: { appointmentId: appt!.id, externalEventId, startsAt: job.startsAt },
    });
    await audit(tx, {
      tenantId: job.tenantId,
      actorType: "system",
      action: "appointment.booked",
      entityType: "appointment",
      entityId: appt!.id,
      after: { startsAt: job.startsAt, externalEventId },
      correlationId: job.correlationId,
    });

    // Booking pauses further automated follow-ups; enqueue CRM sync.
    await deps.enqueue("crm-sync", `crm:${job.leadId}`, {
      tenantId: job.tenantId,
      leadId: job.leadId,
      correlationId: job.correlationId,
    });

    return { status: "booked" as const, appointmentId: appt!.id, externalEventId };
  });
}

/** Postgres unique-violation detection (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === "23505";
}

/** Release expired holds (plan: PLAN M7 expiry sweep). Repeatable job. */
export async function releaseExpiredHolds(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<number> {
  return withTenant(db, { tenantId }, async (tx) => {
    const released = await tx
      .update(schema.slotHolds)
      .set({ status: "released" })
      .where(and(eq(schema.slotHolds.status, "held"), lt(schema.slotHolds.expiresAt, now)))
      .returning({ id: schema.slotHolds.id });
    return released.length;
  });
}
