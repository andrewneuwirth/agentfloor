import { defineConfig } from "@agentfloor/engine";

export default defineConfig({
  // One markdown file per agent lives here (see docs/agents.md).
  agentsDir: "agents",

  // Storage adapter. SQLite is zero-setup; the whole floor is one file.
  store: { adapter: "sqlite", path: "agentfloor.db" },

  // LLM provider adapter.
  //   mock   — offline, canned output; the floor machinery still runs for real
  //   claude — Anthropic API; auth from ANTHROPIC_API_KEY / `ant auth login`
  llm: { adapter: "claude", model: "claude-opus-4-8" },

  // Daily caps by budget kind, enforced before any work starts.
  // "run" gates every agent run, fleet-wide.
  budgets: { run: 100 },

  // Scheduler cadence: how often the floor checks for due agents and claims
  // pending jobs, and how many jobs one tick may dispatch.
  tickSeconds: 15,
  dispatchLimit: 3,
});
