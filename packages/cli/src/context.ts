/**
 * Config loading + adapter resolution. The config file is plain data —
 * adapters are named by string and resolved here, so a config never needs
 * to import framework packages (code-optional by default).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import {
  loadAgents,
  MockProvider,
  type AgentDef,
  type AgentFloorConfig,
  type LLMProvider,
  type Store,
} from "@agentfloor/engine";
import { SqliteStore } from "@agentfloor/store-sqlite";
import { ClaudeProvider } from "@agentfloor/llm-claude";

const CONFIG_NAMES = ["agentfloor.config.ts", "agentfloor.config.mts", "agentfloor.config.mjs", "agentfloor.config.js"];

export interface FloorContext {
  config: AgentFloorConfig;
  configDir: string;
  agentsDir: string;
  agents: Map<string, AgentDef>;
  store: Store;
  llm: LLMProvider;
}

export function findConfig(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(file: string): Promise<AgentFloorConfig> {
  // Resolve framework imports in the config against the CLI's own install, so
  // a config works even when the project has no local node_modules.
  const require = createRequire(import.meta.url);
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    alias: { "@agentfloor/engine": require.resolve("@agentfloor/engine") },
  });
  const mod = await jiti.import(file);
  const config = (mod as { default?: AgentFloorConfig }).default ?? (mod as AgentFloorConfig);
  if (typeof config !== "object" || config === null) {
    throw new Error(`${file}: config must export a default object (use defineConfig)`);
  }
  return config;
}

function resolveStore(config: AgentFloorConfig, configDir: string): Store {
  const spec = config.store ?? { adapter: "sqlite" };
  switch (spec.adapter) {
    case "sqlite": {
      const path = typeof spec.path === "string" ? resolve(configDir, spec.path) : join(configDir, "agentfloor.db");
      return new SqliteStore({ path });
    }
    default:
      throw new Error(`unknown store adapter "${spec.adapter}" (available: sqlite)`);
  }
}

function resolveLLM(config: AgentFloorConfig, override?: string): LLMProvider {
  const spec = override ? { adapter: override } : (config.llm ?? { adapter: "mock" });
  switch (spec.adapter) {
    case "mock":
      return new MockProvider();
    case "claude":
      return new ClaudeProvider({
        model: typeof (spec as Record<string, unknown>).model === "string" ? String((spec as Record<string, unknown>).model) : undefined,
        maxTokens:
          (spec as Record<string, unknown>).maxTokens != null ? Number((spec as Record<string, unknown>).maxTokens) : undefined,
      });
    default:
      throw new Error(`unknown llm adapter "${spec.adapter}" (available: claude, mock)`);
  }
}

export async function openFloor(cwd: string, opts: { llmOverride?: string } = {}): Promise<FloorContext> {
  const configFile = findConfig(cwd);
  if (!configFile) {
    throw new Error("no agentfloor.config.{ts,mjs,js} found — run `agentfloor init` first");
  }
  const configDir = dirname(configFile);
  const config = await loadConfig(configFile);
  const agentsDir = resolve(configDir, config.agentsDir ?? "agents");
  const agents = loadAgents(agentsDir);

  const store = resolveStore(config, configDir);
  await store.init();
  for (const [kind, cap] of Object.entries(config.budgets ?? {})) {
    await store.setBudgetCap(kind, cap);
  }

  const llm = resolveLLM(config, opts.llmOverride);
  return { config, configDir, agentsDir, agents, store, llm };
}
