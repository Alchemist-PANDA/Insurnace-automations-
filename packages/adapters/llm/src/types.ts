import { z } from "zod";

/**
 * LLM provider contract (plan: integrations §1/§7, conversation-engine §2).
 * The model returns STRUCTURED JSON validated against a schema. It has no tool
 * surface — it proposes; the application's policy gate disposes.
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: ChatTurn[];
  maxTokens: number;
  temperature: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  /** Raw text the model produced (expected to be JSON). */
  raw: string;
  usage: TokenUsage;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * The agent-turn contract (conversation-engine §2). extracted_facts uses a
 * permissive record so vertical schemas can evolve without breaking the
 * transport; the orchestrator maps them onto the qualification schema.
 */
export const AgentTurn = z.object({
  extracted_facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  detected_intents: z.array(
    z.enum([
      "question_pricing",
      "question_faq",
      "wants_appointment",
      "wants_human",
      "dissatisfied",
      "possible_opt_out",
      "off_topic",
      "objection",
    ]),
  ),
  proposed_reply: z.string().max(560),
  knowledge_refs: z.array(z.string()),
  needs_clarification: z.boolean(),
  internal_summary: z.string().max(400),
  confidence: z.number().min(0).max(1),
});
export type AgentTurn = z.infer<typeof AgentTurn>;

export type ParseResult =
  | { ok: true; turn: AgentTurn }
  | { ok: false; error: string };

/** Validate raw model output against the AgentTurn schema. */
export function parseAgentTurn(raw: string): ParseResult {
  let json: unknown;
  try {
    // Tolerate markdown code fences around the JSON.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    json = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: "output was not valid JSON" };
  }
  const parsed = AgentTurn.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, turn: parsed.data };
}
