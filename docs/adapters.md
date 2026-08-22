# Authoring adapters

Everything in AgentFloor plugs in behind three small interfaces from
`@agentfloor/engine`: **Store** (where the floor records), **LLMProvider**
(who generates), and **Notifier** (how humans get alerted). A fleet picks
adapters by name in `agentfloor.config.ts`; the CLI resolves names to
implementations.

## What ships today

| Kind     | Adapter       | Config                                              | Credentials (env only)               |
| -------- | ------------- | --------------------------------------------------- | ------------------------------------ |
| store    | `sqlite`      | `{ adapter: "sqlite", path: "agentfloor.db" }`      | —                                    |
| store    | `postgres`    | `{ adapter: "postgres" }`                           | `AGENTFLOOR_DB_URL`                  |
| llm      | `mock`        | `{ adapter: "mock" }`                               | — (free, offline)                    |
| llm      | `claude`      | `{ adapter: "claude", model: "claude-opus-4-8" }`   | `ANTHROPIC_API_KEY`                  |
| llm      | `openai`      | `{ adapter: "openai", model: "..." }`               | `OPENAI_API_KEY`                     |
| llm      | `ollama`      | `{ adapter: "ollama", model: "llama3.2" }`          | — (local models, zero API cost)      |
| llm      | `claude-code` | `{ adapter: "claude-code" }`                        | the local Claude Code login          |
| notify   | `slack`       | `{ adapter: "slack" }`                              | `SLACK_WEBHOOK_URL`                  |
| notify   | `telegram`    | `{ adapter: "telegram" }`                           | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Notes:

- `openai` and `ollama` require an explicit `model` (either in the config
  or per-agent frontmatter) — no baked-in default to age badly.
- `claude-code` is the deliberate opt-in for billing runs to a **Claude
  subscription** instead of an API key: it shells out to the local `claude`
  CLI in print mode. By default no tools are enabled, so a run is a pure
  generation like every other provider; pass `allowedTools` only if you
  mean to escalate.
- `postgres` exists for fleets that outgrow one machine: several floor
  processes can share one database — job claims use `FOR UPDATE SKIP
  LOCKED` and slots are the same TTL leases as SQLite. (It mirrors the
  SQLite adapter's verified semantics; if you run it in anger before we
  publish integration coverage, we'd love the bug reports.)
- Notifiers fire on **run failures** and **budget exhaustion**, deduplicated
  (default: one identical alert per 30 minutes; tune with
  `notify: { ..., throttleSeconds: N }`).

## The interfaces

```ts
interface LLMProvider {
  readonly name: string;
  generate(req: { system: string; prompt: string; model?: string; maxTokens?: number })
    : Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; model: string }>;
}

interface Notifier {
  readonly name: string;
  notify(message: string, opts?: { severity?: "info" | "success" | "warn" | "error" }): Promise<void>;
}

// Store is larger — see packages/engine/src/types.ts. The contract that
// matters: claimDueJobs must be atomic (two dispatchers never get the same
// job), claimSlot must be an expiring lease (a crashed run frees itself),
// and consumeBudget must be atomic against its daily cap.
```

Rules that keep adapters trustworthy:

1. **Report real usage.** `usage` feeds budgets and the dashboard's cost
   view — never fabricate or zero it.
2. **Credentials come from the environment**, never from the config file
   and never persisted by the adapter.
3. **Fail loud with a helpful message.** "could not reach Ollama — is
   `ollama serve` running?" beats a bare ECONNREFUSED.

## Wiring a new adapter in

1. Create `packages/adapters/<kind>-<name>` implementing the interface
   (copy the closest existing adapter as a template).
2. Register the name in `packages/cli/src/context.ts` (`resolveStore` /
   `resolveLLM` / `resolveNotifier`).
3. Add a row to the table above and, if it takes config keys, document
   them.

That's the whole surface — adapters never import each other, and the
engine never imports adapters.
