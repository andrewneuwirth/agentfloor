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
  ThrottledNotifier,
  type AgentDef,
  type AgentFloorConfig,
  type LLMProvider,
  type Notifier,
  type Store,
} from "@agentfloor/engine";
import { SqliteStore } from "@agentfloor/store-sqlite";
import { PostgresStore } from "@agentfloor/store-postgres";
import { ClaudeProvider } from "@agentfloor/llm-claude";
import { OpenAIProvider } from "@agentfloor/llm-openai";
import { OllamaProvider } from "@agentfloor/llm-ollama";
import { ClaudeCodeProvider } from "@agentfloor/llm-claude-code";
import { SlackNotifier, TelegramNotifier } from "@agentfloor/notify";

const CONFIG_NAMES = ["agentfloor.config.ts", "agentfloor.config.mts", "agentfloor.config.mjs", "agentfloor.config.js"];

export interface FloorContext {
  config: AgentFloorConfig;
  configDir: string;
  agentsDir: string;
  agents: Map<string, AgentDef>;
  store: Store;
  llm: LLMProvider;
  notifier?: Notifier;
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

function str(spec: Record<string, unknown>, key: string): string | undefined {
  return typeof spec[key] === "string" ? (spec[key] as string) : undefined;
}
function n(spec: Record<string, unknown>, key: string): number | undefined {
  return spec[key] != null ? Number(spec[key]) : undefined;
}

function resolveStore(config: AgentFloorConfig, configDir: string): Store {
  const spec = config.store ?? { adapter: "sqlite" };
  switch (spec.adapter) {
    case "sqlite": {
      const path = typeof spec.path === "string" ? resolve(configDir, spec.path) : join(configDir, "agentfloor.db");
      return new SqliteStore({ path });
    }
    case "postgres":
      return new PostgresStore({ url: str(spec, "url") });
    default:
      throw new Error(`unknown store adapter "${spec.adapter}" (available: sqlite, postgres)`);
  }
}

function resolveLLM(config: AgentFloorConfig, override?: string): LLMProvider {
  const spec: { adapter: string; [key: string]: unknown } = override
    ? { adapter: override }
    : (config.llm ?? { adapter: "mock" });
  switch (spec.adapter) {
    case "mock":
      return new MockProvider();
    case "claude":
      return new ClaudeProvider({ model: str(spec, "model"), maxTokens: n(spec, "maxTokens") });
    case "openai":
      return new OpenAIProvider({ model: str(spec, "model"), maxTokens: n(spec, "maxTokens") });
    case "ollama":
      return new OllamaProvider({ model: str(spec, "model"), baseUrl: str(spec, "baseUrl"), maxTokens: n(spec, "maxTokens") });
    case "claude-code":
      // deliberate opt-in: runs bill the local Claude Code login (a Claude
      // subscription), not an API key
      return new ClaudeCodeProvider({
        model: str(spec, "model"),
        bin: str(spec, "bin"),
        timeoutSeconds: n(spec, "timeoutSeconds"),
        allowedTools: Array.isArray(spec.allowedTools) ? (spec.allowedTools as string[]) : undefined,
      });
    default:
      throw new Error(`unknown llm adapter "${spec.adapter}" (available: claude, openai, ollama, claude-code, mock)`);
  }
}

function resolveNotifier(config: AgentFloorConfig): Notifier | undefined {
  const spec = config.notify;
  if (!spec) return undefined;
  let inner: Notifier;
  switch (spec.adapter) {
    case "slack":
      inner = new SlackNotifier();
      break;
    case "telegram":
      inner = new TelegramNotifier();
      break;
    default:
      throw new Error(`unknown notify adapter "${spec.adapter}" (available: slack, telegram)`);
  }
  // identical alerts are sent at most once per window — a capped floor
  // re-skips every tick and the human needs one message, not hundreds
  return new ThrottledNotifier(inner, n(spec, "throttleSeconds") ?? 1800);
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
  const notifier = resolveNotifier(config);
  return { config, configDir, agentsDir, agents, store, llm, notifier };
}
