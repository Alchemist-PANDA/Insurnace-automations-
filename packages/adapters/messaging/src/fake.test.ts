import { describe, it, expect } from "vitest";
import { FakeSmsChannel } from "./fake.js";
import { isStatusNewer } from "./types.js";

describe("FakeSmsChannel", () => {
  it("records sends and returns a provider sid", async () => {
    const ch = new FakeSmsChannel();
    const r = await ch.send({
      tenantSender: { sender: "MG1" },
      to: "+12145550142",
      body: "hi",
      dedupeKey: "lead1:first_touch",
      correlationId: "cid1",
    });
    expect(r.ok).toBe(true);
    expect(ch.sent).toHaveLength(1);
  });

  it("does not send twice for the same dedupeKey (idempotency backstop)", async () => {
    const ch = new FakeSmsChannel();
    const req = {
      tenantSender: { sender: "MG1" },
      to: "+12145550142",
      body: "hi",
      dedupeKey: "lead1:first_touch",
      correlationId: "cid1",
    };
    const a = await ch.send(req);
    const b = await ch.send(req);
    expect(ch.sent).toHaveLength(1);
    if (a.ok && b.ok) expect(a.providerSid).toBe(b.providerSid);
  });

  it("can script a provider failure", async () => {
    const ch = new FakeSmsChannel();
    ch.scriptNextResult({ ok: false, code: "provider_down", retryable: true, message: "down" });
    const r = await ch.send({
      tenantSender: { sender: "MG1" },
      to: "+1",
      body: "x",
      dedupeKey: "k",
      correlationId: "c",
    });
    expect(r.ok).toBe(false);
  });

  it("parses an inbound webhook body", () => {
    const ch = new FakeSmsChannel();
    const msg = ch.parseInboundWebhook(
      FakeSmsChannel.inbound("+12145550142", "+18885550000", "STOP"),
    );
    expect(msg.body).toBe("STOP");
    expect(msg.from).toBe("+12145550142");
  });
});

describe("isStatusNewer", () => {
  it("does not regress delivered → sent", () => {
    expect(isStatusNewer("sent", "delivered")).toBe(false);
    expect(isStatusNewer("delivered", "sent")).toBe(true);
    expect(isStatusNewer("sent", null)).toBe(true);
  });
});
