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
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrompt,
  isValidAgentName,
  MockProvider,
  parseAgentSource,
  type AgentDef,
  type RunRow,
  type Store,
} from "@agentfloor/engine";
import { PAGE_HTML } from "./page.js";

export interface DashboardOptions {
  store: Store;
  agents: Map<string, AgentDef>;
  /** Fleet display name (usually the fleet directory basename). */
  floorName: string;
  /**
   * Directory of agent files. Enables the Agent Editor (saving writes
   * `<agentsDir>/<name>.md`; the floor's hot-reload makes it live). Omit for
   * a strictly read-only console.
   */
  agentsDir?: string;
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

async function buildState(store: Store, agents: Map<string, AgentDef>, floorName: string, editable: boolean) {
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
    editable,
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4400;
  const dryRunner = new MockProvider();

  const server: Server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: this console only ever answers as localhost.
      const hostHeader = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHeader)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden host");
        return;
      }
      // Localhost-CSRF guard: mutations require a custom header. Browsers
      // won't send it cross-origin without a CORS preflight, and we never
      // answer preflights permissively — so foreign pages can't write here.
      if (req.method !== "GET" && req.headers["x-agentfloor-edit"] !== "1") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing edit header" }));
        return;
      }
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);
      if (url.pathname === "/") {
        // no-store: the page ships inside the server binary, so a stale
        // cached copy after an upgrade is pure confusion
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE_HTML);
        return;
      }
      if (url.pathname === "/api/state") {
        const state = await buildState(opts.store, opts.agents, opts.floorName, !!opts.agentsDir);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state));
        return;
      }
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // ── Agent Editor API ────────────────────────────────────────────────
      const agentMatch = url.pathname.match(/^\/api\/agent\/([a-z0-9_-]+)(\/(dry-run|run))?$/);
      if (agentMatch) {
        const name = agentMatch[1];
        const action = agentMatch[3];
        if (!isValidAgentName(name)) return json(400, { error: "invalid agent name" });

        if (req.method === "GET" && !action) {
          const def = opts.agents.get(name);
          if (!def || !def.file) return json(404, { error: "unknown agent" });
          return json(200, { name, file: def.file, source: readFileSync(def.file, "utf8") });
        }

        if (req.method === "POST" && action === "run") {
          const jobId = await opts.store.scheduleJob({
            agent: name,
            runAt: new Date().toISOString(),
            reason: "run now (dashboard)",
            createdBy: "dashboard",
          });
          return json(200, { ok: true, jobId, note: "queued — the floor dispatches it on its next tick" });
        }

        if (req.method === "POST" && action === "dry-run") {
          const body = await readJson(req);
          const source =
            typeof body.source === "string"
              ? body.source
              : opts.agents.get(name)?.file
                ? readFileSync(opts.agents.get(name)!.file, "utf8")
                : null;
          if (source == null) return json(404, { error: "unknown agent and no draft source given" });
          let def: AgentDef;
          try {
            def = parseAgentSource(name, source);
          } catch (err) {
            return json(422, { error: err instanceof Error ? err.message : String(err) });
          }
          const { system, prompt } = await buildPrompt(opts.store, def);
          const result = await dryRunner.generate({ system, prompt, model: def.model, maxTokens: def.maxTokensPerRun });
          return json(200, { system, prompt, output: result.text });
        }

        if (req.method === "POST" && !action) {
          if (!opts.agentsDir) return json(403, { error: "editor disabled — dashboard was started without an agents directory" });
          const body = await readJson(req);
          if (typeof body.source !== "string") return json(400, { error: "body must be { source: string }" });
          const file = join(opts.agentsDir, `${name}.md`);
          let def: AgentDef;
          try {
            def = parseAgentSource(name, body.source, file);
          } catch (err) {
            return json(422, { error: err instanceof Error ? err.message : String(err) });
          }
          writeFileSync(file, body.source);
          opts.agents.set(name, def); // immediate; file watchers catch it too
          return json(200, { ok: true, file, note: "saved — effective on the agent's next run" });
        }
      }

      if (url.pathname === "/api/tell" && req.method === "POST") {
        const body = await readJson(req);
        const text = typeof body.body === "string" ? body.body.trim() : "";
        if (!text) return json(400, { error: "body must be { body: string }" });
        const id = await opts.store.insertDirective(text, "dashboard");
        return json(200, { ok: true, id });
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
