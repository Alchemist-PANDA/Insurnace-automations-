import { describe, it, expect } from "vitest";
import { parseAgentTurn } from "./types.js";
import { FakeLlm } from "./fake.js";

describe("parseAgentTurn", () => {
  it("parses a well-formed agent turn", () => {
    const raw = JSON.stringify({
      extracted_facts: { service: "roof_replacement", urgency: "high" },
      detected_intents: ["wants_appointment"],
      proposed_reply: "Great — what city is the property in?",
      knowledge_refs: [],
      needs_clarification: false,
      internal_summary: "Homeowner with storm damage.",
      confidence: 0.92,
    });
    const res = parseAgentTurn(raw);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.turn.extracted_facts.service).toBe("roof_replacement");
  });

  it("tolerates markdown code fences", () => {
    const res = parseAgentTurn(
      '```json\n{"extracted_facts":{},"detected_intents":[],"proposed_reply":"hi","knowledge_refs":[],"needs_clarification":false,"internal_summary":"s","confidence":0.5}\n```',
    );
    expect(res.ok).toBe(true);
  });

  it("rejects malformed JSON", () => {
    expect(parseAgentTurn("not json at all").ok).toBe(false);
  });

  it("rejects schema-invalid output (e.g. reply too long / missing fields)", () => {
    const res = parseAgentTurn(JSON.stringify({ proposed_reply: "hi" }));
    expect(res.ok).toBe(false);
  });
});

describe("FakeLlm", () => {
  it("returns scripted turns in order and records requests", async () => {
    const llm = new FakeLlm().scriptTurn({ proposed_reply: "one" }).scriptTurn({ proposed_reply: "two" });
    const a = await llm.complete({ system: "s", messages: [], maxTokens: 100, temperature: 0 });
    const b = await llm.complete({ system: "s", messages: [], maxTokens: 100, temperature: 0 });
    expect(JSON.parse(a.raw).proposed_reply).toBe("one");
    expect(JSON.parse(b.raw).proposed_reply).toBe("two");
    expect(llm.requests).toHaveLength(2);
  });
});
