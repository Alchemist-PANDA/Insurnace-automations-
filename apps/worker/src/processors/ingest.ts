import { eq, or, and } from "drizzle-orm";
import { withTenant, schema, type Database } from "@stl/db";
import {
  resolveDuplicate,
  scoreLead,
  roofingHvacScoringModel,
  ROOFING_HVAC_SERVICES,
  type ScoringFacts,
  type NormalizedLead,
} from "@stl/core";
import type { IngestJob } from "@stl/queue";
import { QUEUE } from "@stl/queue";
import type { WorkerDeps } from "../deps.js";
import { mapRawToNormalized, type SourceMapping } from "../mapping.js";
import { emitEvent, audit } from "../events.js";

export interface IngestResult {
  leadId: string | null;
  action: string;
  band?: string;
  consentGranted: boolean;
  enqueuedFirstTouch: boolean;
}

/**
 * Ingest processor (plan: architecture §6.2). Raw webhook → normalized, deduped
 * lead → consent recorded → scored → first-touch enqueued when eligible. All DB
 * work runs under the tenant's RLS context.
 */
export async function processIngest(
  deps: WorkerDeps,
  job: IngestJob,
): Promise<IngestResult> {
  const { db } = deps;

  const result = await withTenant(db, { tenantId: job.tenantId }, async (tx) => {
    const [raw] = await tx
      .select()
      .from(schema.rawWebhooks)
      .where(eq(schema.rawWebhooks.id, job.rawWebhookId))
      .limit(1);
    if (!raw) throw new Error(`raw webhook ${job.rawWebhookId} not found`);

    const [source] = await tx
      .select()
      .from(schema.leadSources)
      .where(eq(schema.leadSources.id, job.sourceId))
      .limit(1);
    if (!source) throw new Error(`source ${job.sourceId} not found`);

    const payload = raw.payload as Record<string, unknown>;
    const normalized = mapRawToNormalized(
      payload,
      source.mapping as SourceMapping,
      { tenantId: job.tenantId, sourceId: job.sourceId },
    );

    // Deduplicate against existing leads matching phone/email in this tenant.
    const candidates = await loadCandidates(tx, normalized);
    const outcome = resolveDuplicate(
      {
        phoneE164: normalized.phoneE164,
        emailNormalized: normalized.emailNormalized,
        externalIds: normalized.externalIds,
        isExistingCustomer: normalized.isExistingCustomer,
      },
      candidates.map((c) => ({
        leadId: c.id,
        phoneE164: c.phoneE164,
        emailNormalized: c.emailNormalized,
        externalIds: (c.externalIds as Record<string, string>) ?? {},
        state: c.state,
        createdAt: c.createdAt.toISOString(),
      })),
    );

    if (outcome.action === "flag_for_review") {
      // Slice 1: record the decision; a human-review queue lands in a later
      // milestone. We do not create a competing conversation.
      return {
        leadId: outcome.leadIds[0] ?? null,
        action: outcome.action,
        band: undefined as string | undefined,
        consentGranted: false,
      };
    }

    // create / merge / reopen / attach — resolve the target lead id.
    let leadId: string;
    let isNewLead = false;
    if (outcome.action === "create") {
      const [lead] = await tx
        .insert(schema.leads)
        .values({
          tenantId: job.tenantId,
          sourceId: job.sourceId,
          state: "new",
          firstName: normalized.firstName,
          lastName: normalized.lastName,
          emailNormalized: normalized.emailNormalized,
          phoneE164: normalized.phoneE164,
          city: normalized.city,
          region: normalized.region,
          postalCode: normalized.postalCode,
          serviceRequested: normalized.serviceRequested,
        })
        .returning({ id: schema.leads.id });
      leadId = lead!.id;
      isNewLead = true;
      await insertIdentities(tx, job.tenantId, leadId, normalized);
    } else {
      leadId = outcome.leadId;
    }

    // Link the idempotency ledger row to the resolved lead.
    await tx
      .update(schema.ingestIdempotency)
      .set({ leadId })
      .where(
        and(
          eq(schema.ingestIdempotency.sourceId, job.sourceId),
          eq(schema.ingestIdempotency.idempotencyKey, job.idempotencyKey),
        ),
      );

    const receivedEventId = await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId,
      type: "lead.received",
      correlationId: job.correlationId,
      payload: { action: outcome.action, sourceId: job.sourceId },
    });
    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId,
      type: "lead.normalized",
      correlationId: job.correlationId,
    });

    // Consent: read from the raw payload. No evidence → unknown → no SMS.
    const consentGranted = readSmsConsent(payload);
    if (isNewLead) {
      await tx.insert(schema.consentRecords).values({
        tenantId: job.tenantId,
        leadId,
        channel: "sms",
        status: consentGranted ? "granted" : "unknown",
        consentSource: source.key,
        disclosureTextVersion: consentGranted ? "web-form-v1" : null,
        sourceUrlOrFormId: source.key,
      });
    }

    // Score.
    const facts = deriveFacts(normalized);
    const score = scoreLead(roofingHvacScoringModel, facts);
    await tx.insert(schema.leadScores).values({
      tenantId: job.tenantId,
      leadId,
      modelVersion: roofingHvacScoringModel.version,
      total: score.total,
      band: score.band,
      breakdown: score.breakdown,
      triggeredByEventId: receivedEventId,
    });
    await tx
      .update(schema.leads)
      .set({ scoreCurrent: score.total, scoreBand: score.band, updatedAt: new Date() })
      .where(eq(schema.leads.id, leadId));
    await emitEvent(tx, {
      tenantId: job.tenantId,
      leadId,
      type: "lead.scored",
      correlationId: job.correlationId,
      payload: { total: score.total, band: score.band },
    });

    await audit(tx, {
      tenantId: job.tenantId,
      actorType: "system",
      action: "lead.ingested",
      entityType: "lead",
      entityId: leadId,
      after: { action: outcome.action, band: score.band, total: score.total },
      correlationId: job.correlationId,
    });

    return {
      leadId,
      action: outcome.action,
      band: score.band as string | undefined,
      consentGranted,
    };
  });

  // First-touch is enqueued only for eligible leads (consent + not unqualified).
  let enqueuedFirstTouch = false;
  if (
    result.leadId &&
    result.consentGranted &&
    result.band &&
    result.band !== "unqualified"
  ) {
    await deps.enqueue(QUEUE.firstTouch, `first-touch:${result.leadId}`, {
      tenantId: job.tenantId,
      leadId: result.leadId,
      correlationId: job.correlationId,
    });
    enqueuedFirstTouch = true;
  }

  return { ...result, band: result.band, enqueuedFirstTouch };
}

// (helpers below)

async function loadCandidates(tx: Database, n: NormalizedLead) {
  const clauses = [];
  if (n.phoneE164) clauses.push(eq(schema.leads.phoneE164, n.phoneE164));
  if (n.emailNormalized) clauses.push(eq(schema.leads.emailNormalized, n.emailNormalized));
  if (clauses.length === 0) return [];
  return tx.select().from(schema.leads).where(or(...clauses)).limit(25);
}

async function insertIdentities(
  tx: Database,
  tenantId: string,
  leadId: string,
  n: NormalizedLead,
) {
  const rows: { tenantId: string; leadId: string; kind: string; value: string }[] = [];
  if (n.phoneE164) rows.push({ tenantId, leadId, kind: "phone", value: n.phoneE164 });
  if (n.emailNormalized) rows.push({ tenantId, leadId, kind: "email", value: n.emailNormalized });
  if (rows.length) await tx.insert(schema.leadIdentities).values(rows);
}

function readSmsConsent(payload: Record<string, unknown>): boolean {
  const v = payload.sms_consent ?? payload.consent ?? payload.tcpa_consent;
  return v === true || v === "true" || v === "yes" || v === "1" || v === 1;
}

/** Derive scoring facts from normalized data (plan: scoring; expanded in M4). */
function deriveFacts(n: NormalizedLead): ScoringFacts {
  const service = (n.serviceRequested ?? "").toLowerCase().replace(/\s+/g, "_");
  const eligibleService = (ROOFING_HVAC_SERVICES as readonly string[]).some((s) =>
    service.includes(s) || s.includes(service),
  );
  return {
    insideServiceArea: !!n.city, // refined by real territory rules in M5
    eligibleService: eligibleService || !!n.serviceRequested,
    eligiblePropertyType: true,
    validPhone: !!n.phoneE164,
    validEmail: !!n.emailNormalized,
    invalidPhone: !n.phoneE164,
    hasClearProject: !!n.serviceRequested,
  };
}
