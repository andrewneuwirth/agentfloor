import type { GenerateRequest, GenerateResult, LLMProvider } from "./types.js";

/**
 * A deterministic, offline LLM provider. Lets `agentfloor up` run end-to-end
 * — schedule, dispatch, recording protocol, budgets, events — with zero API
 * keys. Also the engine behind `dry-run`.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";

  constructor(private readonly opts: { delayMs?: number } = {}) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    const inputTokens = Math.ceil((req.system.length + req.prompt.length) / 4);
    const firstLine = req.prompt.split("\n").find((l) => l.trim()) ?? "";
    const text = [
      "[mock run] No LLM was called. The floor machinery — scheduling, budgets,",
      "slots, heartbeats, events — all ran for real; only this text is canned.",
      "",
      `Brief began: "${firstLine.slice(0, 120)}"`,
      `Prompt size: ~${inputTokens} tokens.`,
    ].join("\n");
    return {
      text,
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) },
      model: "mock",
    };
  }
}
