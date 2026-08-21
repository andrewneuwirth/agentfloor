# The recording protocol

The per-run contract every agent execution follows, in order. It is enforced
by the engine (`executeRun`), not by agent authors — an agent cannot opt out.

```
1. budget gate      store.consumeBudget("run")        false → skip, log, exit clean
2. claim slot       store.claimSlot(agent, runId)     false → a live copy exists, yield
3. run start        store.runStart(...)               opens the run row the UI tracks
4. work             heartbeats every ~30s renew the   silence > TTL reads as stalled;
                    slot lease + stamp the run row    the lease expiring frees the slot
5. run finish       store.runFinish(runId, {...})     status, items, REAL token usage;
                                                      failures close the row too
6. release slot     store.releaseSlot(...)            always — in a finally
```

## Why each step exists

**Budget before anything.** Each run costs money. The gate runs before the
slot claim and before the run row opens, so a capped floor spends nothing —
not even bookkeeping. A `false` is a normal outcome (logged once as
`budget_exhausted`), never an error.

**Slots are leases, not locks.** The original implementation used Postgres
session advisory locks (auto-release on disconnect). The portable equivalent
is a TTL lease: claiming writes `(agent, run_id, expires_at)`; heartbeats
renew it; releasing deletes it. A crashed process simply stops renewing, the
lease expires, and the next scheduled run reclaims it. No manual unwedging.

**Exactly one start, exactly one finish.** The run row is the unit of
observability: what the agent set out to do (`task`), whether it's alive
(`heartbeat_at`), what it produced (`items`, `stats`), what it cost
(`tokens`), and how it ended (`status`, `error`). The engine closes the row
on the failure path too, so the dashboard never shows zombie "active" runs.

**Tokens are the truth, not an estimate.** The provider's reported usage
(input + output) is written into `runFinish`. This is what makes per-agent
cost tracking and daily-burn trends possible.

## Failure matrix

| What happens              | Result                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Budget cap reached        | Run never starts; one `budget_exhausted` event; clean exit   |
| Prior run still live      | Silent yield (routine — logging it would spam the feed)      |
| Provider throws           | Run closes `failed` with the error; `run_error` event; slot released |
| Process SIGKILL mid-run   | Run row stays `active` with a stale heartbeat (visibly stalled); slot lease expires on TTL; floor self-heals |

## The queue in front of the protocol

Scheduled and woken agents don't run directly — the scheduler enqueues a
**job** (`pending`, with a due time and a reason), and the dispatcher
atomically claims due jobs and executes them through the protocol. The queue
is the audit trail of *why* every run happened, and claims are transactional,
so multiple floor processes sharing one store never double-run a job.
