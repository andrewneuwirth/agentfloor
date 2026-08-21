import { defineConfig } from "@agentfloor/engine";

export default defineConfig({
  agentsDir: "agents",
  store: { adapter: "sqlite", path: "agentfloor.db" },

  // Start on the mock provider to watch the floor mechanics for free, then
  // switch to claude when you want real output.
  llm: { adapter: "mock" },
  // llm: { adapter: "claude", model: "claude-opus-4-8" },

  budgets: { run: 50 },
  tickSeconds: 15,
});
