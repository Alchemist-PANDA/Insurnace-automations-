import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

/**
 * Anthropic implementation of LlmProvider (plan: integrations §7). Model id is
 * configuration, not code. The provider only returns text; parsing/validation
 * happens in the caller against the AgentTurn schema.
 */
export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export class AnthropicLlm implements LlmProvider {
  private readonly client: Anthropic;
  constructor(private readonly cfg: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.messages.create({
      model: this.cfg.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      raw: text,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
    };
  }
}
