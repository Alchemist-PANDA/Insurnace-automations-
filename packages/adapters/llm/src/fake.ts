import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

/**
 * Scriptable fake LLM (plan: testing §1/§4). Tests queue exact raw outputs —
 * including malformed JSON and adversarial/hijacked outputs — to exercise the
 * orchestrator's validation and the policy gate.
 */
export class FakeLlm implements LlmProvider {
  private queue: string[] = [];
  readonly requests: LlmRequest[] = [];

  /** Queue a raw response string (may be malformed to test the failure path). */
  script(...raw: string[]): this {
    this.queue.push(...raw);
    return this;
  }

  /** Convenience: queue a well-formed AgentTurn. */
  scriptTurn(turn: {
    extracted_facts?: Record<string, string | number | boolean | null>;
    detected_intents?: string[];
    proposed_reply: string;
    knowledge_refs?: string[];
    needs_clarification?: boolean;
    internal_summary?: string;
    confidence?: number;
  }): this {
    this.queue.push(
      JSON.stringify({
        extracted_facts: turn.extracted_facts ?? {},
        detected_intents: turn.detected_intents ?? [],
        proposed_reply: turn.proposed_reply,
        knowledge_refs: turn.knowledge_refs ?? [],
        needs_clarification: turn.needs_clarification ?? false,
        internal_summary: turn.internal_summary ?? "summary",
        confidence: turn.confidence ?? 0.9,
      }),
    );
    return this;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const raw = this.queue.shift() ?? "{}";
    return { raw, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}
