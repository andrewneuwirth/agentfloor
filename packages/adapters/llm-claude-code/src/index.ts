/**
 * Claude Code provider — runs each generation through the local `claude`
 * CLI in headless print mode. Opt-in for people who WANT runs billed to
 * their Claude subscription (the login the CLI holds) instead of an API
 * key. Requires Claude Code installed and logged in on this machine.
 *
 * By default the CLI is invoked with no tools enabled, so a run is a pure
 * generation — same contract as every other provider. Granting tools to
 * floor agents is a deliberate escalation; pass `allowedTools` explicitly
 * if you mean it.
 */
import { execFile } from "node:child_process";
import type { GenerateRequest, GenerateResult, LLMProvider } from "@agentfloor/engine";

export interface ClaudeCodeProviderOptions {
  /** Path to the claude binary (default: "claude" on PATH). */
  bin?: string;
  /** Model override passed to the CLI (default: the CLI's own default). */
  model?: string;
  /** Wall-clock cap per generation, seconds (default 600). */
  timeoutSeconds?: number;
  /** Tool allowlist, e.g. ["WebSearch"]. Default: none — pure generation. */
  allowedTools?: string[];
}

interface ClaudeCliOutput {
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly name = "claude-code";

  constructor(private readonly opts: ClaudeCodeProviderOptions = {}) {}

  generate(req: GenerateRequest): Promise<GenerateResult> {
    const bin = this.opts.bin ?? "claude";
    const prompt = `${req.system}\n\n---\n\n${req.prompt}`;
    const args = ["-p", prompt, "--output-format", "json", "--allowedTools", (this.opts.allowedTools ?? []).join(",")];
    const model = req.model ?? this.opts.model;
    if (model) args.push("--model", model);

    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: (this.opts.timeoutSeconds ?? 600) * 1000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            const hint = /ENOENT/.test(String(err)) ? " — is Claude Code installed and on PATH?" : "";
            reject(new Error(`claude CLI failed: ${err.message}${hint}`));
            return;
          }
          let out: ClaudeCliOutput;
          try {
            out = JSON.parse(stdout) as ClaudeCliOutput;
          } catch {
            reject(new Error(`claude CLI returned non-JSON output (first 200 chars): ${stdout.slice(0, 200)}`));
            return;
          }
          if (out.is_error) {
            reject(new Error(`claude CLI reported an error: ${(out.result ?? "unknown").slice(0, 300)}`));
            return;
          }
          const u = out.usage ?? {};
          resolve({
            text: out.result ?? "",
            usage: {
              // cache tokens count toward input — this is what the run cost
              inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
            },
            model: model ?? "claude-code-default",
          });
        },
      );
    });
  }
}
