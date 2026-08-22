/**
 * Ollama provider — fully local models, zero API cost. Talks to the Ollama
 * HTTP API (default http://127.0.0.1:11434); no SDK needed. A model must be
 * configured explicitly and already pulled (`ollama pull <model>`).
 */
import type { GenerateRequest, GenerateResult, LLMProvider } from "@agentfloor/engine";

export interface OllamaProviderOptions {
  /** Default model for agents that don't set one, e.g. "llama3.2". */
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  constructor(private readonly opts: OllamaProviderOptions = {}) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = req.model ?? this.opts.model;
    if (!model) {
      throw new Error('ollama adapter needs a model — set llm: { adapter: "ollama", model: "..." } (and `ollama pull` it first)');
    }
    const baseUrl = this.opts.baseUrl ?? "http://127.0.0.1:11434";
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
          options: { num_predict: req.maxTokens ?? this.opts.maxTokens ?? 4000 },
        }),
      });
    } catch {
      throw new Error(`could not reach Ollama at ${baseUrl} — is \`ollama serve\` running?`);
    }
    const body = (await res.json()) as OllamaChatResponse;
    if (!res.ok || body.error) {
      throw new Error(`ollama error: ${body.error ?? res.statusText}`);
    }
    return {
      text: body.message?.content ?? "",
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      },
      model: body.model ?? model,
    };
  }
}
