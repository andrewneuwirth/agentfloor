/**
 * The AgentFloor dashboard — a read-only web view of the floor.
 *
 * One node:http server, zero frontend dependencies: the page is a single
 * self-contained HTML document (inline CSS + JS, system fonts) that polls
 * /api/state. It reads the same store the floor writes, so it can run in
 * the same process as `up` or as a separate process against the same file.
 *
 * Binds 127.0.0.1 only — there is no auth; this is an operator's local
 * console, not a hosted service.
 */
import { createServer, type Server } from "node:http";
import type { AgentDef, RunRow, Store } from "@agentfloor/engine";
import { PAGE_HTML } from "./page.js";

export interface DashboardOptions {
  store: Store;
  agents: Map<string, AgentDef>;
  /** Fleet display name (usually the fleet directory basename). */
  floorName: string;
  port?: number;
  host?: string;
}

export interface DashboardHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Heartbeats older than this on an active run read as stalled. */
const STALL_AFTER_MS = 90_000;

type AgentPhase = "running" | "stalled" | "idle" | "failed" | "never" | "disabled";

function agentPhase(def: AgentDef, active: RunRow | undefined, last: RunRow | undefined, now: number): AgentPhase {
  if (!def.enabled) return "disabled";
  if (active) {
    const hb = active.heartbeatAt ? new Date(active.heartbeatAt).getTime() : new Date(active.startedAt).getTime();
    return now - hb > STALL_AFTER_MS ? "stalled" : "running";
  }
  if (!last) return "never";
  return last.status === "failed" ? "failed" : "idle";
}

function scheduleLabel(def: AgentDef): string {
  if (!def.schedule) return "manual";
  if (def.schedule.kind === "every") {
    const s = def.schedule.seconds;
    return s % 3600 === 0 ? `every ${s / 3600}h` : s % 60 === 0 ? `every ${s / 60}m` : `every ${s}s`;
  }
  return `daily ${String(def.schedule.hour).padStart(2, "0")}:${String(def.schedule.minute).padStart(2, "0")}`;
}

async function buildState(store: Store, agents: Map<string, AgentDef>, floorName: string) {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [active, recent, events, pendingJobs, recentJobs, budgets, directives, stats, plan] = await Promise.all([
    store.activeRuns(),
    store.recentRuns(60),
    store.recentEvents(120),
    store.listJobs({ status: "pending", limit: 30 }),
    store.listJobs({ limit: 30 }),
    store.budgetStatus(),
    store.unhandledDirectives(),
    store.runStatsSince(startOfDay.toISOString()),
    store.latestPlan("day"),
  ]);

  const statByAgent = new Map(stats.map((s) => [s.agent, s]));
  const agentRows = [...agents.values()].map((def) => {
    const activeRun = active.find((r) => r.agent === def.name);
    const lastRun = recent.find((r) => r.agent === def.name && r.status !== "active");
    const st = statByAgent.get(def.name);
    return {
      name: def.name,
      description: def.description ?? null,
      schedule: scheduleLabel(def),
      model: def.model ?? null,
      phase: agentPhase(def, activeRun, lastRun, now),
      task: activeRun?.task ?? null,
      heartbeatAt: activeRun?.heartbeatAt ?? null,
      lastRunAt: lastRun ? (lastRun.finishedAt ?? lastRun.startedAt) : null,
      lastStatus: lastRun?.status ?? null,
      runsToday: st?.runs ?? 0,
      failedToday: st?.failed ?? 0,
      tokensToday: st?.tokens ?? 0,
    };
  });

  return {
    now: new Date(now).toISOString(),
    floor: floorName,
    agents: agentRows,
    totals: {
      runsToday: stats.reduce((n, s) => n + s.runs, 0),
      tokensToday: stats.reduce((n, s) => n + s.tokens, 0),
      running: agentRows.filter((a) => a.phase === "running").length,
      stalled: agentRows.filter((a) => a.phase === "stalled").length,
    },
    runs: recent,
    events,
    jobs: { pending: pendingJobs, recent: recentJobs },
    budgets,
    directives,
    plan: plan ? { title: plan.title, body: plan.body } : null,
  };
}

export function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4400;

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      }
      if (url.pathname === "/api/state") {
        const state = await buildState(opts.store, opts.agents, opts.floorName);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/run\/([0-9a-f-]{8,})$/);
      if (runMatch) {
        const run = await opts.store.getRun(runMatch[1]);
        if (!run) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "run not found" }));
          return;
        }
        const events = await opts.store.eventsForRun(run.id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ run, events }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
