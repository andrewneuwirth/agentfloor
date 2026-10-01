# AGENTS.md — agentfloor

## Purpose
Run and watch a fleet of autonomous LLM agents: scheduler, job queue, per-day cost
budgets, heartbeats, and per-run observability, with a local web console.

## Stack
TypeScript (ES modules), Node >= 20, npm workspaces monorepo, built with `tsc -b`.
- `packages/engine` — scheduler, protocol, agents, mock provider.
- `packages/dashboard` — local console (http://127.0.0.1:4400, `--port` to change).
- `packages/cli` — the `agentfloor` binary (init | up | tick | run | dry-run | status | tell | dashboard).
- `packages/adapters/*` — store-sqlite, store-postgres, llm-claude, llm-openai,
  llm-ollama, llm-claude-code, notify.

## Install / run / test
```bash
npm install && npm run build            # builds every workspace into dist/
(cd packages/cli && npm link)           # global `agentfloor` command
mkdir ~/my-fleet && cd ~/my-fleet && agentfloor init && agentfloor up
agentfloor up --dashboard               # floor + console in one process
npm run clean                           # remove build output
```
Tests: there is no test suite yet — `npm test` targets `packages/engine/dist/test`,
which does not exist, and is a no-op by design (`|| true`).

## Where outputs / data go
- Build output: `packages/**/dist/` and `*.tsbuildinfo` (gitignored).
- Runtime state lives in the user's fleet directory, not this repo:
  `agentfloor.db` (SQLite, next to `agentfloor.config.ts`) unless the config sets
  `store.path` or uses Postgres.
- Default LLM adapter is `mock` (no network, no cost). `claude` bills
  `ANTHROPIC_API_KEY`; `claude-code` bills the local Claude subscription — opt-in only.

## Do not move
- `packages/*` paths — hard-coded in root `package.json` workspaces and the
  `build`/`clean` scripts, and in each `tsconfig.json` project reference.
- `tsconfig.base.json` — extended by every package tsconfig.
- `examples/*` — listed in README; `agentfloor.config.example.ts` is the reference config shape.
- `docs/assets/*` — images embedded in README.

## Rules
- Docs go in `docs/`, never the repo root.
- Never commit `.env*`, `*.db*`, `dist/`, or `node_modules/`.
