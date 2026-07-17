import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  type PolicyContext,
  type KnowledgeRef,
} from "./policy-gate.js";

const at = (iso: string) => ({ now: () => new Date(iso) });

const baseCtx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  channel: "sms",
  consent: { channel: "sms", status: "granted" },
  isSuppressed: false,
  quietHours: { startHour: 8, endHour: 21, timezone: "America/Chicago" },
  clock: at("2026-07-17T15:00:00Z"), // 10:00 CDT — inside quiet hours
  followUpsSentInWindow: 0,
  followUpCap: 5,
  deliveryLockout: false,
  approvedKnowledge: [],
  ...over,
});

describe("evaluatePolicy — allowlist & AI boundaries", () => {
  it("rejects actions not on the allowlist (AI cannot execute unapproved tools)", () => {
    const v = evaluatePolicy(baseCtx(), { action: "delete_database" });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("action_not_allowlisted");
  });

  it("allows a plain approved reply within quiet hours", () => {
    const v = evaluatePolicy(baseCtx(), {
      action: "send_reply",
      replyText: "Happy to help — what city is the property in?",
    });
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.scheduledFor).toBe("now");
  });
});

describe("evaluatePolicy — consent & suppression", () => {
  it("blocks sends without consent", () => {
    const v = evaluatePolicy(
      baseCtx({ consent: { channel: "sms", status: "unknown" } }),
      { action: "send_reply", replyText: "hi" },
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("no_consent");
  });

  it("blocks everything for a suppressed lead", () => {
    const v = evaluatePolicy(baseCtx({ isSuppressed: true }), {
      action: "send_reply",
      replyText: "hi",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("suppressed");
  });

  it("blocks on delivery lockout and on follow-up cap", () => {
    expect(
      evaluatePolicy(baseCtx({ deliveryLockout: true }), {
        action: "send_reply",
        replyText: "hi",
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(baseCtx({ followUpsSentInWindow: 5, followUpCap: 5 }), {
        action: "send_reply",
        replyText: "hi",
      }).allowed,
    ).toBe(false);
  });
});

describe("evaluatePolicy — claim verification (AI cannot invent pricing/services)", () => {
  const pricing: KnowledgeRef = { id: "k_price", type: "pricing_guidance" };

  it("rejects an unbacked price claim", () => {
    const v = evaluatePolicy(baseCtx(), {
      action: "send_reply",
      replyText: "A new roof is about $12,000.",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("unverified_claim");
  });

  it("allows a price claim backed by approved knowledge", () => {
    const v = evaluatePolicy(baseCtx({ approvedKnowledge: [pricing] }), {
      action: "send_reply",
      replyText: "Roof replacements typically run $8,000–$15,000.",
      knowledgeRefs: ["k_price"],
    });
    expect(v.allowed).toBe(true);
  });

  it("rejects an unbacked guarantee", () => {
    const v = evaluatePolicy(baseCtx(), {
      action: "send_reply",
      replyText: "We guarantee your roof will never leak again.",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("unverified_claim");
  });
});

describe("evaluatePolicy — quiet hours", () => {
  it("defers to next window when outside quiet hours", () => {
    const v = evaluatePolicy(
      baseCtx({ clock: at("2026-07-17T05:00:00Z") }), // 00:00 CDT
      { action: "send_reply", replyText: "hello" },
    );
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.scheduledFor).toBe("next_window");
  });
});

describe("evaluatePolicy — non-sending actions", () => {
  it("allows alert_rep even without consent (no message leaves the system)", () => {
    const v = evaluatePolicy(
      baseCtx({ consent: { channel: "sms", status: "unknown" } }),
      { action: "alert_rep" },
    );
    expect(v.allowed).toBe(true);
  });
});
