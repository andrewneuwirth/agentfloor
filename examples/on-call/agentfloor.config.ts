import { defineConfig } from "@agentfloor/engine";

export default defineConfig({
  agentsDir: "agents",
  store: { adapter: "sqlite", path: "agentfloor.db" },
  llm: { adapter: "mock" },
  // llm: { adapter: "ollama", model: "llama3.2" },   // fully local option
  budgets: { run: 80 },
  // Alerts for run failures + exhausted budgets (set SLACK_WEBHOOK_URL):
  // notify: { adapter: "slack" },
  tickSeconds: 15,
});
