# Example fleet: content-research desk

A three-agent editorial desk: a **scout** proposes article angles, an
**outliner** turns the best one into a publishable outline, and an **editor**
writes a daily digest for the human running the desk.

```sh
cd examples/content-research
agentfloor up          # runs on the mock provider — no API key needed
agentfloor status      # watch runs, budgets, events accumulate
agentfloor tell "this week: focus on local-first sync engines"
agentfloor run scout   # or trigger any agent immediately
```

Switch `llm` in `agentfloor.config.ts` to `{ adapter: "claude" }` (with
`ANTHROPIC_API_KEY` set) for real output. Edit any file in `agents/` while
the floor is up — changes apply on the next run.
