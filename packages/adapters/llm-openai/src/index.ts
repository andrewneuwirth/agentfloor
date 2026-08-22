/**
 * OpenAI LLM provider. Auth from OPENAI_API_KEY in the environment —
 * AgentFloor never stores or logs the key. A model must be configured
 * explicitly (OpenAI's lineup changes too often for a baked-in default to
 * age well).
 */
import OpenAI from "openai";
import type { GenerateRequest, GenerateResult, LLMProvider } from "@agentfloor/engine";

export interface OpenAIProviderOptions {
  /** Default model for agents that don't set one, e.g. "gpt-5.2". */
  model?: string;
  maxTokens?: number;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAIProviderOptions = {}) {
    this.client = new OpenAI(); // reads OPENAI_API_KEY from the environment
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = req.model ?? this.opts.model;
    if (!model) {
      throw new Error('openai adapter needs a model — set llm: { adapter: "openai", model: "..." } or model: in the agent frontmatter');
    }
    const response = await this.client.chat.completions.create({
      model,
      max_completion_tokens: req.maxTokens ?? this.opts.maxTokens ?? 8000,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    const choice = response.choices[0];
    return {
      text: choice?.message?.content ?? "",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }
}
