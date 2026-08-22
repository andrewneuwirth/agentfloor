/**
 * Core AgentFloor abstractions. Everything else — storage backends, LLM
 * providers, schedulers, notifiers — plugs into these interfaces.
 */

// ── Agents (data, not code) ──────────────────────────────────────────────────

/** Parsed from an `agents/<name>.md` file: YAML frontmatter + markdown body. */
export interface AgentDef {
  /** Lowercase key; the filename stem. Every store row joins on this. */
  name: string;
  /** One-line human description (shown in status output). */
  description?: string;
  /**
   * When the scheduler enqueues runs for this agent.
   * `"every 10m"` / `"every 2h"` / `"daily at 09:00"` / absent = manual only.
   */
  schedule?: Schedule;
  /** LLM model override; absent = provider default. */
  model?: string;
  /** Per-run output-token ceiling passed to the provider. */
  maxTokensPerRun?: number;
  /** Disabled agents load but are never scheduled or runnable. */
  enabled: boolean;
  /** The brief: the markdown body handed to the LLM as the agent's task. */
  brief: string;
  /** Absolute path of the source file (for hot-reload + editing). */
  file: string;
}

export type Schedule =
  | { kind: "every"; seconds: number }
  | { kind: "daily"; hour: number; minute: number };

// ── Runs & the recording protocol ────────────────────────────────────────────

export type RunStatus = "active" | "done" | "failed" | "blocked";

export interface RunRow {
  id: string;
  agent: string;
  task: string | null;
  status: RunStatus;
  items: number | null;
  tokens: number | null;
  error: string | null;
  stats: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
}

export interface RunFinishOpts {
  status?: Exclude<RunStatus, "active">;
  items?: number | null;
  tokens?: number | null;
  error?: string | null;
  stats?: Record<string, unknown> | null;
}

// ── Events (the live activity feed) ──────────────────────────────────────────

export type EventSeverity = "info" | "success" | "warn" | "error";

export interface EventOpts {
  severity?: EventSeverity;
  data?: Record<string, unknown>;
  runId?: string;
}

export interface EventRow {
  id: string;
  agent: string;
  kind: string;
  summary: string | null;
  severity: EventSeverity;
  data: Record<string, unknown> | null;
  runId: string | null;
  createdAt: string;
}

// ── Jobs (the claimable queue) ───────────────────────────────────────────────

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  agent: string;
  runAt: string;
  status: JobStatus;
  reason: string | null;
  createdBy: string;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ── Directives / plans / wakes ───────────────────────────────────────────────

export interface DirectiveRow {
  id: string;
  body: string;
  source: string;
  handled: boolean;
  createdAt: string;
}

export interface PlanRow {
  id: string;
  horizon: string;
  title: string | null;
  body: string | null;
  data: Record<string, unknown> | null;
  status: string;
  createdAt: string;
}

export interface WakeRow {
  id: string;
  agent: string;
  reason: string | null;
  createdAt: string;
}

export interface AgentRunStats {
  agent: string;
  runs: number;
  failed: number;
  tokens: number;
}

// ── Budgets ──────────────────────────────────────────────────────────────────

export interface BudgetRow {
  kind: string;
  dailyCap: number;
  usedToday: number;
}

// ── Aggregate floor state (powers `status` + future dashboard) ───────────────

export interface FloorState {
  activeRuns: RunRow[];
  recentRuns: RunRow[];
  recentEvents: EventRow[];
  pendingJobs: JobRow[];
  budgets: BudgetRow[];
  unhandledDirectives: DirectiveRow[];
}

// ── Store adapter ────────────────────────────────────────────────────────────

/**
 * The storage backend. Every method is async so implementations can be SQLite
 * (sync under the hood), Postgres, or anything else. The engine only ever
 * talks to storage through this interface.
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  // runs
  runStart(agent: string, task: string | null): Promise<string>;
  heartbeat(runId: string, task?: string | null, items?: number | null): Promise<void>;
  runFinish(runId: string, opts: RunFinishOpts): Promise<void>;
  activeRuns(): Promise<RunRow[]>;
  recentRuns(limit?: number): Promise<RunRow[]>;
  getRun(id: string): Promise<RunRow | null>;
  eventsForRun(runId: string, limit?: number): Promise<EventRow[]>;
  /** Per-agent run/token totals since an ISO timestamp (dashboards, cost views). */
  runStatsSince(sinceIso: string): Promise<AgentRunStats[]>;

  // concurrency slots — crash-safe leases. A claim holds until released or
  // until `ttlSeconds` passes without a renewal (heartbeats renew).
  claimSlot(agent: string, runId: string, ttlSeconds?: number): Promise<boolean>;
  renewSlot(agent: string, runId: string): Promise<void>;
  releaseSlot(agent: string, runId: string): Promise<void>;

  // budgets — daily caps, consumed atomically
  setBudgetCap(kind: string, dailyCap: number): Promise<void>;
  consumeBudget(kind: string, n?: number): Promise<boolean>;
  budgetStatus(): Promise<BudgetRow[]>;

  // events
  logEvent(agent: string, kind: string, summary: string | null, opts?: EventOpts): Promise<string>;
  recentEvents(limit?: number): Promise<EventRow[]>;

  // jobs
  scheduleJob(job: { agent: string; runAt: string; reason?: string | null; createdBy?: string }): Promise<string>;
  /** Atomically flip due pending jobs to running and return them. */
  claimDueJobs(limit?: number): Promise<JobRow[]>;
  finishJob(id: string, status: "done" | "failed", result?: Record<string, unknown> | null): Promise<void>;
  listJobs(opts?: { status?: JobStatus; limit?: number }): Promise<JobRow[]>;

  // scheduler bookkeeping (per-agent next fire time)
  getNextRunAt(agent: string): Promise<string | null>;
  setNextRunAt(agent: string, iso: string): Promise<void>;

  // directives (human steering)
  insertDirective(body: string, source?: string): Promise<string>;
  unhandledDirectives(): Promise<DirectiveRow[]>;
  handleDirective(id: string): Promise<void>;

  // plans
  writePlan(plan: { horizon: string; title?: string | null; body?: string | null; data?: Record<string, unknown> | null }): Promise<string>;
  latestPlan(horizon?: string): Promise<PlanRow | null>;

  // wakes (pull an agent's next run forward)
  raiseWake(agent: string, reason?: string | null): Promise<void>;
  /** Claim (and clear) pending wakes for an agent. */
  claimWakes(agent: string): Promise<WakeRow[]>;

  // aggregate
  floorState(): Promise<FloorState>;
}

// ── LLM provider adapter ─────────────────────────────────────────────────────

export interface GenerateRequest {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

// ── Notifier adapter ─────────────────────────────────────────────────────────

/** Outbound human alerts (run failures, exhausted budgets, stalls). */
export interface Notifier {
  readonly name: string;
  notify(message: string, opts?: { severity?: EventSeverity }): Promise<void>;
}

// ── Config (plain data — resolved by the CLI's adapter registry) ─────────────

export interface AgentFloorConfig {
  /** Directory of `*.md` agent definitions, relative to the config file. */
  agentsDir?: string;
  store?: { adapter: string; [key: string]: unknown };
  llm?: { adapter: string; [key: string]: unknown };
  /** Optional outbound alerts (run failures, budget exhaustion). */
  notify?: { adapter: string; [key: string]: unknown };
  /** Daily caps by budget kind. `run` gates every agent run. */
  budgets?: Record<string, number>;
  /** Scheduler tick interval in seconds (default 15). */
  tickSeconds?: number;
  /** Max jobs dispatched per tick (default 3). */
  dispatchLimit?: number;
}

/** Identity helper so configs get type-checking + completion. */
export function defineConfig(config: AgentFloorConfig): AgentFloorConfig {
  return config;
}
