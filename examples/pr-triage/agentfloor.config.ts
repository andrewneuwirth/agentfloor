import { defineConfig } from "@agentfloor/engine";

export default defineConfig({
  agentsDir: "agents",
  store: { adapter: "sqlite", path: "agentfloor.db" },
  llm: { adapter: "mock" },
  // llm: { adapter: "claude", model: "claude-opus-4-8" },
  budgets: { run: 60 },
  tickSeconds: 15,
});
