/**
 * Claude LLM provider. Auth comes from the environment (ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile) — AgentFloor never
 * stores or logs the key; the secret-provider surface is the SDK's own
 * credential resolution.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { GenerateRequest, GenerateResult, LLMProvider } from "@agentfloor/engine";

export interface ClaudeProviderOptions {
  /** Default model when the agent doesn't set one. */
  model?: string;
  /** Default per-run output-token ceiling. */
  maxTokens?: number;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  private readonly client: Anthropic;

  constructor(private readonly opts: ClaudeProviderOptions = {}) {
    this.client = new Anthropic(); // credentials resolved from the environment
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = req.model ?? this.opts.model ?? "claude-opus-4-8";
    const maxTokens = req.maxTokens ?? this.opts.maxTokens ?? 16000;
    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      });
      if (response.stop_reason === "refusal") {
        throw new Error(`model declined the request (stop_reason: refusal)`);
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return {
        text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
      };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error("Anthropic auth failed — set ANTHROPIC_API_KEY (or run `ant auth login`)");
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error ${error.status}: ${error.message}`);
      }
      throw error;
    }
  }
}
