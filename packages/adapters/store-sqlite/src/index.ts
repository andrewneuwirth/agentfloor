/**
 * SQLite storage adapter — the zero-setup default. One file on disk holds
 * the whole floor: runs, jobs, events, budgets, slots, directives, plans.
 *
 * Concurrency notes:
 * - Job claims run in an IMMEDIATE transaction (UPDATE … WHERE status =
 *   'pending' guarded by the select), so two floor processes sharing one db
 *   file cannot claim the same job.
 * - Slots are TTL leases, not locks: a claim inserts (agent, run_id,
 *   expires_at); heartbeats renew; a crashed run's lease simply expires.
 *   This replaces the Postgres session-advisory-lock trick portably.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
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
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  task TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  items INTEGER,
  tokens INTEGER,
  error TEXT,
  stats TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent_started ON runs (agent, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);

CREATE TABLE IF NOT EXISTS slots (
  agent TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  kind TEXT PRIMARY KEY,
  daily_cap INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_ledger (
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, day)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  data TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events (created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  created_by TEXT NOT NULL DEFAULT 'scheduler',
  result TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, run_at);

CREATE TABLE IF NOT EXISTS agent_state (
  agent TEXT PRIMARY KEY,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS directives (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cli',
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  horizon TEXT NOT NULL,
  title TEXT,
  body TEXT,
  data TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  reason TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wakes_pending ON wakes (agent, claimed_at);
`;

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const j = (v: unknown) => (v == null ? null : JSON.stringify(v));
const pj = <T>(s: string | null): T | null => (s == null ? null : (JSON.parse(s) as T));

interface RunDb {
  id: string; agent: string; task: string | null; status: string; items: number | null;
  tokens: number | null; error: string | null; stats: string | null;
  started_at: string; finished_at: string | null; heartbeat_at: string | null;
}
interface JobDb {
  id: string; agent: string; run_at: string; status: string; reason: string | null;
  created_by: string; result: string | null; created_at: string;
  started_at: string | null; finished_at: string | null;
}
interface EventDb {
  id: string; agent: string; kind: string; summary: string | null; severity: string;
  data: string | null; run_id: string | null; created_at: string;
}

const runFromDb = (r: RunDb): RunRow => ({
  id: r.id, agent: r.agent, task: r.task, status: r.status as RunRow["status"],
  items: r.items, tokens: r.tokens, error: r.error, stats: pj(r.stats),
  startedAt: r.started_at, finishedAt: r.finished_at, heartbeatAt: r.heartbeat_at,
});
const jobFromDb = (r: JobDb): JobRow => ({
  id: r.id, agent: r.agent, runAt: r.run_at, status: r.status as JobStatus,
  reason: r.reason, createdBy: r.created_by, result: pj(r.result),
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});
const eventFromDb = (r: EventDb): EventRow => ({
  id: r.id, agent: r.agent, kind: r.kind, summary: r.summary,
  severity: r.severity as EventRow["severity"], data: pj(r.data),
  runId: r.run_id, createdAt: r.created_at,
});

export interface SqliteStoreOptions {
  /** Database file path, or ":memory:" for tests/dry-runs. */
  path: string;
}

export class SqliteStore implements Store {
  private db!: Database.Database;

  constructor(private readonly opts: SqliteStoreOptions) {}

  async init(): Promise<void> {
    this.db = new Database(this.opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async runStart(agent: string, task: string | null): Promise<string> {
    return this.runStartWithId(randomUUID(), agent, task);
  }

  async runStartWithId(id: string, agent: string, task: string | null): Promise<string> {
    const t = now();
    this.db
      .prepare("INSERT INTO runs (id, agent, task, status, started_at, heartbeat_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run(id, agent, task, t, t);
    return id;
  }

  async heartbeat(runId: string, task?: string | null, items?: number | null): Promise<void> {
    this.db
      .prepare(
        `UPDATE runs SET heartbeat_at = ?,
           task = COALESCE(?, task),
           items = COALESCE(?, items)
         WHERE id = ?`,
      )
      .run(now(), task ?? null, items ?? null, runId);
  }

  async runFinish(runId: string, opts: RunFinishOpts): Promise<void> {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, items = COALESCE(?, items), tokens = ?,
           error = ?, stats = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(opts.status ?? "done", opts.items ?? null, opts.tokens ?? null, opts.error ?? null, j(opts.stats), now(), runId);
  }

  async activeRuns(): Promise<RunRow[]> {
    return (this.db.prepare("SELECT * FROM runs WHERE status = 'active' ORDER BY started_at").all() as RunDb[]).map(runFromDb);
  }

  async recentRuns(limit = 20): Promise<RunRow[]> {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunDb[]).map(runFromDb);
  }

  // ── slots (TTL leases) ────────────────────────────────────────────────────

  async claimSlot(agent: string, runId: string, ttlSeconds = 600): Promise<boolean> {
    const claim = this.db.transaction((): boolean => {
      this.db.prepare("DELETE FROM slots WHERE agent = ? AND expires_at < ?").run(agent, now());
      const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      try {
        this.db.prepare("INSERT INTO slots (agent, run_id, expires_at) VALUES (?, ?, ?)").run(agent, runId, expires);
        return true;
      } catch {
        return false; // primary-key conflict → a live run holds the slot
      }
    });
    return claim.immediate();
  }

  async renewSlot(agent: string, runId: string): Promise<void> {
    this.db
      .prepare("UPDATE slots SET expires_at = ? WHERE agent = ? AND run_id = ?")
      .run(new Date(Date.now() + 600 * 1000).toISOString(), agent, runId);
  }

  async releaseSlot(agent: string, runId: string): Promise<void> {
    this.db.prepare("DELETE FROM slots WHERE agent = ? AND run_id = ?").run(agent, runId);
  }

  // ── budgets ───────────────────────────────────────────────────────────────

  async setBudgetCap(kind: string, dailyCap: number): Promise<void> {
    this.db
      .prepare("INSERT INTO budgets (kind, daily_cap) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET daily_cap = excluded.daily_cap")
      .run(kind, dailyCap);
  }

  async consumeBudget(kind: string, n = 1): Promise<boolean> {
    const consume = this.db.transaction((): boolean => {
      const cap = this.db.prepare("SELECT daily_cap FROM budgets WHERE kind = ?").get(kind) as { daily_cap: number } | undefined;
      if (!cap) return true; // no cap configured for this kind → unlimited
      const day = today();
      const row = this.db.prepare("SELECT used FROM budget_ledger WHERE kind = ? AND day = ?").get(kind, day) as
        | { used: number }
        | undefined;
      const used = row?.used ?? 0;
      if (used + n > cap.daily_cap) return false;
      this.db
        .prepare(
          "INSERT INTO budget_ledger (kind, day, used) VALUES (?, ?, ?) ON CONFLICT (kind, day) DO UPDATE SET used = used + ?",
        )
        .run(kind, day, n, n);
      return true;
    });
    return consume.immediate();
  }

  async budgetStatus(): Promise<BudgetRow[]> {
    const day = today();
    const rows = this.db
      .prepare(
        `SELECT b.kind, b.daily_cap, COALESCE(l.used, 0) AS used
         FROM budgets b LEFT JOIN budget_ledger l ON l.kind = b.kind AND l.day = ?
         ORDER BY b.kind`,
      )
      .all(day) as { kind: string; daily_cap: number; used: number }[];
    return rows.map((r) => ({ kind: r.kind, dailyCap: r.daily_cap, usedToday: r.used }));
  }

  // ── events ────────────────────────────────────────────────────────────────

  async logEvent(agent: string, kind: string, summary: string | null, opts: EventOpts = {}): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO events (id, agent, kind, summary, severity, data, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, agent, kind, summary, opts.severity ?? "info", j(opts.data), opts.runId ?? null, now());
    return id;
  }

  async recentEvents(limit = 50): Promise<EventRow[]> {
    return (this.db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(limit) as EventDb[]).map(eventFromDb);
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  async scheduleJob(job: { agent: string; runAt: string; reason?: string | null; createdBy?: string }): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO jobs (id, agent, run_at, status, reason, created_by, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
      .run(id, job.agent, job.runAt, job.reason ?? null, job.createdBy ?? "scheduler", now());
    return id;
  }

  async claimDueJobs(limit = 5): Promise<JobRow[]> {
    const claim = this.db.transaction((): JobDb[] => {
      const due = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?")
        .all(now(), limit) as JobDb[];
      const t = now();
      const mark = this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'");
      return due.filter((jb) => mark.run(t, jb.id).changes === 1);
    });
    return claim.immediate().map(jobFromDb);
  }

  async finishJob(id: string, status: "done" | "failed", result?: Record<string, unknown> | null): Promise<void> {
    this.db.prepare("UPDATE jobs SET status = ?, finished_at = ?, result = ? WHERE id = ?").run(status, now(), j(result), id);
  }

  async listJobs(opts: { status?: JobStatus; limit?: number } = {}): Promise<JobRow[]> {
    const limit = opts.limit ?? 50;
    const rows = opts.status
      ? (this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY run_at DESC LIMIT ?").all(opts.status, limit) as JobDb[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY run_at DESC LIMIT ?").all(limit) as JobDb[]);
    return rows.map(jobFromDb);
  }

  // ── scheduler bookkeeping ─────────────────────────────────────────────────

  async getNextRunAt(agent: string): Promise<string | null> {
    const row = this.db.prepare("SELECT next_run_at FROM agent_state WHERE agent = ?").get(agent) as
      | { next_run_at: string | null }
      | undefined;
    return row?.next_run_at ?? null;
  }

  async setNextRunAt(agent: string, iso: string): Promise<void> {
    this.db
      .prepare("INSERT INTO agent_state (agent, next_run_at) VALUES (?, ?) ON CONFLICT (agent) DO UPDATE SET next_run_at = excluded.next_run_at")
      .run(agent, iso);
  }

  // ── directives ────────────────────────────────────────────────────────────

  async insertDirective(body: string, source = "cli"): Promise<string> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO directives (id, body, source, created_at) VALUES (?, ?, ?, ?)").run(id, body, source, now());
    return id;
  }

  async unhandledDirectives(): Promise<DirectiveRow[]> {
    const rows = this.db.prepare("SELECT * FROM directives WHERE handled = 0 ORDER BY created_at").all() as {
      id: string; body: string; source: string; handled: number; created_at: string;
    }[];
    return rows.map((r) => ({ id: r.id, body: r.body, source: r.source, handled: !!r.handled, createdAt: r.created_at }));
  }

  async handleDirective(id: string): Promise<void> {
    this.db.prepare("UPDATE directives SET handled = 1 WHERE id = ?").run(id);
  }

  // ── plans ─────────────────────────────────────────────────────────────────

  async writePlan(plan: { horizon: string; title?: string | null; body?: string | null; data?: Record<string, unknown> | null }): Promise<string> {
    const id = randomUUID();
    const write = this.db.transaction(() => {
      this.db.prepare("UPDATE plans SET status = 'superseded' WHERE horizon = ? AND status = 'active'").run(plan.horizon);
      this.db
        .prepare("INSERT INTO plans (id, horizon, title, body, data, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
        .run(id, plan.horizon, plan.title ?? null, plan.body ?? null, j(plan.data), now());
    });
    write.immediate();
    return id;
  }

  async latestPlan(horizon = "day"): Promise<PlanRow | null> {
    const r = this.db.prepare("SELECT * FROM plans WHERE horizon = ? ORDER BY created_at DESC LIMIT 1").get(horizon) as
      | { id: string; horizon: string; title: string | null; body: string | null; data: string | null; status: string; created_at: string }
      | undefined;
    if (!r) return null;
    return { id: r.id, horizon: r.horizon, title: r.title, body: r.body, data: pj(r.data), status: r.status, createdAt: r.created_at };
  }

  // ── wakes ─────────────────────────────────────────────────────────────────

  async raiseWake(agent: string, reason?: string | null): Promise<void> {
    this.db.prepare("INSERT INTO wakes (id, agent, reason, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), agent, reason ?? null, now());
  }

  async claimWakes(agent: string): Promise<WakeRow[]> {
    const claim = this.db.transaction((): WakeRow[] => {
      const rows = this.db
        .prepare("SELECT id, agent, reason, created_at FROM wakes WHERE agent = ? AND claimed_at IS NULL")
        .all(agent) as { id: string; agent: string; reason: string | null; created_at: string }[];
      if (rows.length) {
        this.db.prepare("UPDATE wakes SET claimed_at = ? WHERE agent = ? AND claimed_at IS NULL").run(now(), agent);
      }
      return rows.map((r) => ({ id: r.id, agent: r.agent, reason: r.reason, createdAt: r.created_at }));
    });
    return claim.immediate();
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
