import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { randomUUID } from "node:crypto";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

/**
 * Analytics accuracy (plan: PLAN M10, MVP acceptance #15). A golden dataset with
 * hand-computed expected metrics proves response-time and funnel numbers are
 * correct against immutable lead-event timestamps.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("GET /v1/analytics (golden dataset)", () => {
  let app: FastifyInstance;
  const tenantId = randomUUID();

  beforeAll(async () => {
    const db = getDb();
    app = await buildServer({ db });
    await app.ready();

    const base = new Date("2026-07-20T15:00:00Z").getTime();
    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId, name: "T", slug: `t-${tenantId.slice(0, 8)}` });

      // 4 leads. Response times: 10s, 40s, 80s, and one never contacted.
      const specs = [
        { sent: 10_000, replied: true, qualified: true, booked: true, won: true },
        { sent: 40_000, replied: true, qualified: true, booked: false, won: false },
        { sent: 80_000, replied: false, qualified: false, booked: false, won: false },
        { sent: null, replied: false, qualified: false, booked: false, won: false },
      ];
      for (const s of specs) {
        const [lead] = await tx
          .insert(schema.leads)
          .values({ tenantId, state: "new", phoneE164: `+1214555${Math.floor(1000 + Math.random() * 8999)}` })
          .returning({ id: schema.leads.id });
        const leadId = lead!.id;
        const ev = (type: string, at: number) =>
          tx.insert(schema.leadEvents).values({ tenantId, leadId, type, occurredAt: new Date(at) });
        await ev("lead.received", base);
        if (s.sent !== null) await ev("message.sent", base + s.sent);
        if (s.replied) await ev("message.received", base + 200_000);
        if (s.qualified) await ev("lead.qualified", base + 300_000);
        if (s.booked) await ev("appointment.booked", base + 400_000);
        if (s.won) {
          await ev("deal.won", base + 500_000);
          await tx.insert(schema.outcomes).values({ tenantId, leadId, type: "won", grossProfit: 30_000 });
        }
      }
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("computes response-time and funnel metrics exactly", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics",
      headers: { "x-tenant-id": tenantId },
    });
    expect(res.statusCode).toBe(200);
    const a = res.json();

    // 4 leads, 3 contacted.
    expect(a.responseTime.count).toBe(4);
    expect(a.responseTime.contacted).toBe(3);
    // deltas 10s,40s,80s → median 40s.
    expect(a.responseTime.medianMs).toBe(40_000);
    // within 60s: 10s + 40s = 2 of 3 → 66.7%
    expect(a.responseTime.withinPct.s60).toBeCloseTo(66.7, 1);
    // within 90s: all 3 → 100%
    expect(a.responseTime.withinPct.s90).toBe(100);

    // Funnel: total 4, contacted 3, replied 2, qualified 2, booked 1, won 1.
    expect(a.funnel.counts).toMatchObject({ total: 4, contacted: 3, replied: 2, qualified: 2, booked: 1, won: 1 });
    expect(a.funnel.rates.closeRate).toBe(100); // 1 won / 1 booked

    // Attribution: one $30k gross-profit win.
    expect(a.attribution.attributedGrossProfit).toBe(30_000);
    expect(a.attribution.wonDeals).toBe(1);
  });
});
