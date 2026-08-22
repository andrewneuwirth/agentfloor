/**
 * Postgres storage adapter — same core schema and semantics as SQLite, for
 * fleets that outgrow one machine or want several floor processes on
 * shared storage.
 *
 * - Job claims use FOR UPDATE SKIP LOCKED, so concurrent dispatchers never
 *   double-claim.
 * - Slots are the same TTL leases as SQLite (portable and crash-safe;
 *   session advisory locks would tie a lease to one connection, which
 *   fights pooled connections).
 * - Everything lives in a dedicated `agentfloor` schema, created on init.
 *
 * Connection string comes from options.url or the AGENTFLOOR_DB_URL env
 * var — keep credentials in the environment, not the config file.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import type {
  AgentRunStats,
  BudgetRow,
  DirectiveRow,
  EventOpts,
  EventRow,
  FloorState,
  JobRow,
  JobStatus,
  PlanRow,
  RunFinishOpts,
  RunRow,
  Store,
  WakeRow,
} from "@agentfloor/engine";

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS agentfloor;
CREATE TABLE IF NOT EXISTS agentfloor.runs (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  task text,
  status text NOT NULL DEFAULT 'active',
  items integer,
  tokens bigint,
  error text,
  stats jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  heartbeat_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_agent_started ON agentfloor.runs (agent, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON agentfloor.runs (status);

CREATE TABLE IF NOT EXISTS agentfloor.slots (
  agent text PRIMARY KEY,
  run_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS agentfloor.budgets (
  kind text PRIMARY KEY,
  daily_cap integer NOT NULL
);
CREATE TABLE IF NOT EXISTS agentfloor.budget_ledger (
  kind text NOT NULL,
  day date NOT NULL,
  used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, day)
);

CREATE TABLE IF NOT EXISTS agentfloor.events (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  kind text NOT NULL,
  summary text,
  severity text NOT NULL DEFAULT 'info',
  data jsonb,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_created ON agentfloor.events (created_at DESC);

CREATE TABLE IF NOT EXISTS agentfloor.jobs (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  created_by text NOT NULL DEFAULT 'scheduler',
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_due ON agentfloor.jobs (status, run_at);

CREATE TABLE IF NOT EXISTS agentfloor.agent_state (
  agent text PRIMARY KEY,
  next_run_at timestamptz
);

CREATE TABLE IF NOT EXISTS agentfloor.directives (
  id uuid PRIMARY KEY,
  body text NOT NULL,
  source text NOT NULL DEFAULT 'cli',
  handled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agentfloor.plans (
  id uuid PRIMARY KEY,
  horizon text NOT NULL,
  title text,
  body text,
  data jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agentfloor.wakes (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  reason text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wakes_pending ON agentfloor.wakes (agent, claimed_at);
`;

interface RunDb {
  id: string; agent: string; task: string | null; status: string; items: number | null;
  tokens: string | number | null; error: string | null; stats: Record<string, unknown> | null;
  started_at: Date; finished_at: Date | null; heartbeat_at: Date | null;
}
interface JobDb {
  id: string; agent: string; run_at: Date; status: string; reason: string | null;
  created_by: string; result: Record<string, unknown> | null; created_at: Date;
  started_at: Date | null; finished_at: Date | null;
}
interface EventDb {
  id: string; agent: string; kind: string; summary: string | null; severity: string;
  data: Record<string, unknown> | null; run_id: string | null; created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const runFromDb = (r: RunDb): RunRow => ({
  id: r.id, agent: r.agent, task: r.task, status: r.status as RunRow["status"],
  items: r.items, tokens: r.tokens == null ? null : Number(r.tokens), error: r.error, stats: r.stats,
  startedAt: r.started_at.toISOString(), finishedAt: iso(r.finished_at), heartbeatAt: iso(r.heartbeat_at),
});
const jobFromDb = (r: JobDb): JobRow => ({
  id: r.id, agent: r.agent, runAt: r.run_at.toISOString(), status: r.status as JobStatus,
  reason: r.reason, createdBy: r.created_by, result: r.result,
  createdAt: r.created_at.toISOString(), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
});
const eventFromDb = (r: EventDb): EventRow => ({
  id: r.id, agent: r.agent, kind: r.kind, summary: r.summary,
  severity: r.severity as EventRow["severity"], data: r.data, runId: r.run_id,
  createdAt: r.created_at.toISOString(),
});

export interface PostgresStoreOptions {
  /** Connection string; falls back to AGENTFLOOR_DB_URL. */
  url?: string;
}

export class PostgresStore implements Store {
  private pool!: pg.Pool;

  constructor(private readonly opts: PostgresStoreOptions = {}) {}

  async init(): Promise<void> {
    const url = this.opts.url ?? process.env.AGENTFLOOR_DB_URL;
    if (!url) {
      throw new Error("postgres store needs a connection string — set AGENTFLOOR_DB_URL (keep credentials out of the config file)");
    }
    this.pool = new pg.Pool({ connectionString: url, max: 5 });
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params);
    return res.rows as T[];
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async runStart(agent: string, task: string | null): Promise<string> {
    return this.runStartWithId(randomUUID(), agent, task);
  }

  async runStartWithId(id: string, agent: string, task: string | null): Promise<string> {
    await this.q("INSERT INTO agentfloor.runs (id, agent, task, status, heartbeat_at) VALUES ($1, $2, $3, 'active', now())", [id, agent, task]);
    return id;
  }

  async heartbeat(runId: string, task?: string | null, items?: number | null): Promise<void> {
    await this.q(
      "UPDATE agentfloor.runs SET heartbeat_at = now(), task = COALESCE($2, task), items = COALESCE($3, items) WHERE id = $1",
      [runId, task ?? null, items ?? null],
    );
  }

  async runFinish(runId: string, opts: RunFinishOpts): Promise<void> {
    await this.q(
      `UPDATE agentfloor.runs SET status = $2, items = COALESCE($3, items), tokens = $4, error = $5, stats = $6, finished_at = now() WHERE id = $1`,
      [runId, opts.status ?? "done", opts.items ?? null, opts.tokens ?? null, opts.error ?? null, opts.stats ?? null],
    );
  }

  async activeRuns(): Promise<RunRow[]> {
    return (await this.q<RunDb>("SELECT * FROM agentfloor.runs WHERE status = 'active' ORDER BY started_at")).map(runFromDb);
  }

  async recentRuns(limit = 20): Promise<RunRow[]> {
    return (await this.q<RunDb>("SELECT * FROM agentfloor.runs ORDER BY started_at DESC LIMIT $1", [limit])).map(runFromDb);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const rows = await this.q<RunDb>("SELECT * FROM agentfloor.runs WHERE id = $1", [id]);
    return rows[0] ? runFromDb(rows[0]) : null;
  }

  async eventsForRun(runId: string, limit = 100): Promise<EventRow[]> {
    return (await this.q<EventDb>("SELECT * FROM agentfloor.events WHERE run_id = $1 ORDER BY created_at LIMIT $2", [runId, limit])).map(eventFromDb);
  }

  async runStatsSince(sinceIso: string): Promise<AgentRunStats[]> {
    const rows = await this.q<{ agent: string; runs: string; failed: string; tokens: string }>(
      `SELECT agent, COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(tokens), 0) AS tokens
       FROM agentfloor.runs WHERE started_at >= $1 GROUP BY agent ORDER BY tokens DESC`,
      [sinceIso],
    );
    return rows.map((r) => ({ agent: r.agent, runs: Number(r.runs), failed: Number(r.failed), tokens: Number(r.tokens) }));
  }

  // ── slots (TTL leases) ────────────────────────────────────────────────────

  async claimSlot(agent: string, runId: string, ttlSeconds = 600): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM agentfloor.slots WHERE agent = $1 AND expires_at < now()", [agent]);
      const res = await client.query(
        "INSERT INTO agentfloor.slots (agent, run_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) ON CONFLICT (agent) DO NOTHING",
        [agent, runId, ttlSeconds],
      );
      await client.query("COMMIT");
      return res.rowCount === 1;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async renewSlot(agent: string, runId: string): Promise<void> {
    await this.q("UPDATE agentfloor.slots SET expires_at = now() + interval '600 seconds' WHERE agent = $1 AND run_id = $2", [agent, runId]);
  }

  async releaseSlot(agent: string, runId: string): Promise<void> {
    await this.q("DELETE FROM agentfloor.slots WHERE agent = $1 AND run_id = $2", [agent, runId]);
  }

  // ── budgets ───────────────────────────────────────────────────────────────

  async setBudgetCap(kind: string, dailyCap: number): Promise<void> {
    await this.q("INSERT INTO agentfloor.budgets (kind, daily_cap) VALUES ($1, $2) ON CONFLICT (kind) DO UPDATE SET daily_cap = EXCLUDED.daily_cap", [kind, dailyCap]);
  }

  async consumeBudget(kind: string, n = 1): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cap = await client.query("SELECT daily_cap FROM agentfloor.budgets WHERE kind = $1", [kind]);
      if (cap.rowCount === 0) {
        await client.query("COMMIT");
        return true; // no cap configured → unlimited
      }
      await client.query(
        "INSERT INTO agentfloor.budget_ledger (kind, day, used) VALUES ($1, CURRENT_DATE, 0) ON CONFLICT (kind, day) DO NOTHING",
        [kind],
      );
      const upd = await client.query(
        "UPDATE agentfloor.budget_ledger SET used = used + $2 WHERE kind = $1 AND day = CURRENT_DATE AND used + $2 <= $3",
        [kind, n, cap.rows[0].daily_cap],
      );
      await client.query("COMMIT");
      return upd.rowCount === 1;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async budgetStatus(): Promise<BudgetRow[]> {
    const rows = await this.q<{ kind: string; daily_cap: number; used: number | string }>(
      `SELECT b.kind, b.daily_cap, COALESCE(l.used, 0) AS used
       FROM agentfloor.budgets b LEFT JOIN agentfloor.budget_ledger l ON l.kind = b.kind AND l.day = CURRENT_DATE
       ORDER BY b.kind`,
    );
    return rows.map((r) => ({ kind: r.kind, dailyCap: r.daily_cap, usedToday: Number(r.used) }));
  }

  // ── events ────────────────────────────────────────────────────────────────

  async logEvent(agent: string, kind: string, summary: string | null, opts: EventOpts = {}): Promise<string> {
    const id = randomUUID();
    await this.q(
      "INSERT INTO agentfloor.events (id, agent, kind, summary, severity, data, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, agent, kind, summary, opts.severity ?? "info", opts.data ?? null, opts.runId ?? null],
    );
    return id;
  }

  async recentEvents(limit = 50): Promise<EventRow[]> {
    return (await this.q<EventDb>("SELECT * FROM agentfloor.events ORDER BY created_at DESC LIMIT $1", [limit])).map(eventFromDb);
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  async scheduleJob(job: { agent: string; runAt: string; reason?: string | null; createdBy?: string }): Promise<string> {
    const id = randomUUID();
    await this.q(
      "INSERT INTO agentfloor.jobs (id, agent, run_at, status, reason, created_by) VALUES ($1, $2, $3, 'pending', $4, $5)",
      [id, job.agent, job.runAt, job.reason ?? null, job.createdBy ?? "scheduler"],
    );
    return id;
  }

  async claimDueJobs(limit = 5): Promise<JobRow[]> {
    const rows = await this.q<JobDb>(
      `UPDATE agentfloor.jobs SET status = 'running', started_at = now()
       WHERE id IN (
         SELECT id FROM agentfloor.jobs
         WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return rows.map(jobFromDb);
  }

  async finishJob(id: string, status: "done" | "failed", result?: Record<string, unknown> | null): Promise<void> {
    await this.q("UPDATE agentfloor.jobs SET status = $2, finished_at = now(), result = $3 WHERE id = $1", [id, status, result ?? null]);
  }

  async listJobs(opts: { status?: JobStatus; limit?: number } = {}): Promise<JobRow[]> {
    const limit = opts.limit ?? 50;
    const rows = opts.status
      ? await this.q<JobDb>("SELECT * FROM agentfloor.jobs WHERE status = $1 ORDER BY run_at DESC LIMIT $2", [opts.status, limit])
      : await this.q<JobDb>("SELECT * FROM agentfloor.jobs ORDER BY run_at DESC LIMIT $1", [limit]);
    return rows.map(jobFromDb);
  }

  // ── scheduler bookkeeping ─────────────────────────────────────────────────

  async getNextRunAt(agent: string): Promise<string | null> {
    const rows = await this.q<{ next_run_at: Date | null }>("SELECT next_run_at FROM agentfloor.agent_state WHERE agent = $1", [agent]);
    return rows[0]?.next_run_at ? rows[0].next_run_at.toISOString() : null;
  }

  async setNextRunAt(agent: string, isoTs: string): Promise<void> {
    await this.q(
      "INSERT INTO agentfloor.agent_state (agent, next_run_at) VALUES ($1, $2) ON CONFLICT (agent) DO UPDATE SET next_run_at = EXCLUDED.next_run_at",
      [agent, isoTs],
    );
  }

  // ── directives ────────────────────────────────────────────────────────────

  async insertDirective(body: string, source = "cli"): Promise<string> {
    const id = randomUUID();
    await this.q("INSERT INTO agentfloor.directives (id, body, source) VALUES ($1, $2, $3)", [id, body, source]);
    return id;
  }

  async unhandledDirectives(): Promise<DirectiveRow[]> {
    const rows = await this.q<{ id: string; body: string; source: string; handled: boolean; created_at: Date }>(
      "SELECT * FROM agentfloor.directives WHERE handled = false ORDER BY created_at",
    );
    return rows.map((r) => ({ id: r.id, body: r.body, source: r.source, handled: r.handled, createdAt: r.created_at.toISOString() }));
  }

  async handleDirective(id: string): Promise<void> {
    await this.q("UPDATE agentfloor.directives SET handled = true WHERE id = $1", [id]);
  }

  // ── plans ─────────────────────────────────────────────────────────────────

  async writePlan(plan: { horizon: string; title?: string | null; body?: string | null; data?: Record<string, unknown> | null }): Promise<string> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE agentfloor.plans SET status = 'superseded' WHERE horizon = $1 AND status = 'active'", [plan.horizon]);
      await client.query(
        "INSERT INTO agentfloor.plans (id, horizon, title, body, data, status) VALUES ($1, $2, $3, $4, $5, 'active')",
        [id, plan.horizon, plan.title ?? null, plan.body ?? null, plan.data ?? null],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return id;
  }

  async latestPlan(horizon = "day"): Promise<PlanRow | null> {
    const rows = await this.q<{ id: string; horizon: string; title: string | null; body: string | null; data: Record<string, unknown> | null; status: string; created_at: Date }>(
      "SELECT * FROM agentfloor.plans WHERE horizon = $1 ORDER BY created_at DESC LIMIT 1",
      [horizon],
    );
    const r = rows[0];
    return r ? { id: r.id, horizon: r.horizon, title: r.title, body: r.body, data: r.data, status: r.status, createdAt: r.created_at.toISOString() } : null;
  }

  // ── wakes ─────────────────────────────────────────────────────────────────

  async raiseWake(agent: string, reason?: string | null): Promise<void> {
    await this.q("INSERT INTO agentfloor.wakes (id, agent, reason) VALUES ($1, $2, $3)", [randomUUID(), agent, reason ?? null]);
  }

  async claimWakes(agent: string): Promise<WakeRow[]> {
    const rows = await this.q<{ id: string; agent: string; reason: string | null; created_at: Date }>(
      "UPDATE agentfloor.wakes SET claimed_at = now() WHERE agent = $1 AND claimed_at IS NULL RETURNING id, agent, reason, created_at",
      [agent],
    );
    return rows.map((r) => ({ id: r.id, agent: r.agent, reason: r.reason, createdAt: r.created_at.toISOString() }));
  }

  // ── aggregate ─────────────────────────────────────────────────────────────

  async floorState(): Promise<FloorState> {
    return {
      activeRuns: await this.activeRuns(),
      recentRuns: await this.recentRuns(15),
      recentEvents: await this.recentEvents(25),
      pendingJobs: await this.listJobs({ status: "pending", limit: 25 }),
      budgets: await this.budgetStatus(),
      unhandledDirectives: await this.unhandledDirectives(),
    };
  }
}
