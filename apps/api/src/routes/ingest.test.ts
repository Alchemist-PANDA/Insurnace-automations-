import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, withTenant, closeDb, schema } from "@stl/db";
import { closeQueues, getQueue, QUEUE } from "@stl/queue";
import { randomUUID } from "node:crypto";
import { buildServer } from "../server.js";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../signing.js";
import type { FastifyInstance } from "fastify";

const hasInfra = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const d = hasInfra ? describe : describe.skip;

d("POST /v1/ingest/:sourceId", () => {
  let app: FastifyInstance;
  const tenantId = randomUUID();
  const secret = "ingest-test-secret";
  let sourceId: string;

  beforeAll(async () => {
    const db = getDb();
    app = await buildServer({ db });
    await app.ready();
    await withTenant(db, { tenantId }, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId, name: "T", slug: `t-${tenantId.slice(0, 8)}` });
      const [src] = await tx
        .insert(schema.leadSources)
        .values({ tenantId, key: "web", name: "Web", signingSecret: secret })
        .returning({ id: schema.leadSources.id });
      sourceId = src!.id;
    });
    // Drain the ingest queue so counts are clean.
    await getQueue(QUEUE.ingest).drain(true);
  });

  afterAll(async () => {
    await app.close();
    await closeQueues();
    await closeDb();
  });

  const post = (body: string, headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/v1/ingest/${sourceId}`,
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

  function signedHeaders(body: string) {
    const ts = String(Date.now());
    return {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: sign(secret, ts, body),
    };
  }

  it("accepts a validly signed lead in under 2s and stores it exactly once", async () => {
    const body = JSON.stringify({ full_name: "Sarah Connor", phone: "+12145550142", city: "Dallas" });
    const start = Date.now();
    const res = await post(body, signedHeaders(body));
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "accepted", duplicate: false });
    expect(elapsed).toBeLessThan(2000);

    const db = getDb();
    const raws = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.rawWebhooks).where(eq(schema.rawWebhooks.sourceId, sourceId)),
    );
    expect(raws.length).toBe(1);
  });

  it("rejects an invalid signature with 401", async () => {
    const body = JSON.stringify({ phone: "+12145550143" });
    const res = await post(body, {
      [TIMESTAMP_HEADER]: String(Date.now()),
      [SIGNATURE_HEADER]: "deadbeef",
    });
    expect(res.statusCode).toBe(401);
  });

  it("acknowledges a replay without reprocessing (idempotency)", async () => {
    const body = JSON.stringify({ full_name: "Replay Test", phone: "+12145559999" });
    const headers = { ...signedHeaders(body), "x-stl-idempotency-key": "fixed-key-1" };

    const first = await post(body, headers);
    const second = await post(body, headers);

    expect(first.json()).toMatchObject({ duplicate: false });
    expect(second.json()).toMatchObject({ duplicate: true });

    const db = getDb();
    const idem = await withTenant(db, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.ingestIdempotency)
        .where(eq(schema.ingestIdempotency.idempotencyKey, "fixed-key-1")),
    );
    expect(idem.length).toBe(1); // one ledger row despite two requests
  });

  it("returns 404 for an unknown source", async () => {
    const body = "{}";
    const ts = String(Date.now());
    const res = await app.inject({
      method: "POST",
      url: `/v1/ingest/${randomUUID()}`,
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: ts,
        [SIGNATURE_HEADER]: sign(secret, ts, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
  });
});
