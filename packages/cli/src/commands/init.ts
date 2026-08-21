import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_TEMPLATE = `import { defineConfig } from "@agentfloor/engine";

export default defineConfig({
  // Directory of agent definitions — one markdown file per agent.
  agentsDir: "agents",

  // Storage: everything the floor records lives here.
  store: { adapter: "sqlite", path: "agentfloor.db" },

  // LLM provider. "mock" runs the whole floor offline with canned output —
  // switch to "claude" (needs ANTHROPIC_API_KEY) when you're ready.
  llm: { adapter: "mock" },
  // llm: { adapter: "claude", model: "claude-opus-4-8" },

  // Daily caps by budget kind. "run" gates every agent run, fleet-wide.
  budgets: { run: 100 },

  // How often the floor checks for due agents and claims jobs.
  tickSeconds: 15,
});
`;

const EXAMPLE_AGENT = `---
description: Summarize what happened on the floor and suggest tomorrow's focus
schedule: every 10m
maxTokensPerRun: 2000
---

You are the digest agent. Each run, write a short plain-text digest:

1. Note that you are a starter example agent — your first real edit should be
   replacing this brief with a genuinely useful role.
2. Suggest one concrete task an autonomous agent could usefully do for this
   project every 10 minutes.

Keep it under 10 lines.
`;

const GITIGNORE_LINES = "agentfloor.db\nagentfloor.db-*\n";

export async function init(cwd: string): Promise<void> {
  const configPath = join(cwd, "agentfloor.config.ts");
  if (existsSync(configPath)) {
    console.log("agentfloor.config.ts already exists — nothing to do");
    return;
  }
  writeFileSync(configPath, CONFIG_TEMPLATE);
  const agentsDir = join(cwd, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const agentPath = join(agentsDir, "digest.md");
  if (!existsSync(agentPath)) writeFileSync(agentPath, EXAMPLE_AGENT);
  const gi = join(cwd, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, GITIGNORE_LINES);

  console.log("Scaffolded:");
  console.log("  agentfloor.config.ts   — the fleet config (mock LLM by default)");
  console.log("  agents/digest.md       — a starter agent (edit the brief!)");
  console.log("");
  console.log("Next:  agentfloor up     — start the floor");
  console.log("       agentfloor run digest   — or run the agent once, now");
}
