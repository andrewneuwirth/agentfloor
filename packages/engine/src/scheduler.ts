/**
 * The floor loop: a scheduler that enqueues jobs when agents come due (or
 * are woken), and a dispatcher that claims due jobs and executes them
 * through the recording protocol.
 *
 * Two-layer design (schedule → queue → claim → run) is deliberate: the
 * queue is the audit trail of *why* every run happened, wakes and operator
 * pushes go through the same door as timed runs, and a second floor process
 * pointed at the same store won't double-run anything — claims are atomic
 * and slots are exclusive.
 *
 * Two ways to drive it:
 * - `startFloor()` — a resident node-loop that ticks every N seconds
 *   (`agentfloor up`).
 * - `floorTick()` — exactly one pass, for external schedulers: cron,
 *   launchd, or a systemd timer invoking `agentfloor tick`.
 */
import type { AgentDef, LLMProvider, Notifier, Store } from "./types.js";
import { nextFireTime, watchAgents } from "./agents.js";
import { executeRun } from "./protocol.js";

export interface TickOptions {
  store: Store;
  llm: LLMProvider;
  notifier?: Notifier;
  agents: Map<string, AgentDef>;
  dispatchLimit?: number;
  log?: (line: string) => void;
}

export interface TickResult {
  enqueued: number;
  dispatched: number;
}

/** One scheduler pass: enqueue due/woken agents, then dispatch due jobs. */
export async function floorTick(opts: TickOptions): Promise<TickResult> {
  const { store, agents } = opts;
  const log = opts.log ?? (() => {});
  const now = new Date();
  let enqueued = 0;

  for (const agent of agents.values()) {
    if (!agent.enabled) continue;

    // wakes pull the next run forward regardless of schedule
    const wakes = await store.claimWakes(agent.name);
    if (wakes.length) {
      const reason = wakes[0].reason ?? "woken";
      await store.scheduleJob({ agent: agent.name, runAt: now.toISOString(), reason, createdBy: "wake" });
      log(`${agent.name}: wake → job enqueued (${reason})`);
      enqueued++;
      continue;
    }

    if (!agent.schedule) continue;
    const nextIso = await store.getNextRunAt(agent.name);
    if (!nextIso) {
      // first sighting: schedule from now so a fresh floor doesn't backfill
      await store.setNextRunAt(agent.name, nextFireTime(agent.schedule, now).toISOString());
      continue;
    }
    if (new Date(nextIso) <= now) {
      await store.scheduleJob({ agent: agent.name, runAt: nextIso, reason: "scheduled", createdBy: "scheduler" });
      await store.setNextRunAt(agent.name, nextFireTime(agent.schedule, now).toISOString());
      log(`${agent.name}: due → job enqueued`);
      enqueued++;
    }
  }

  const jobs = await store.claimDueJobs(opts.dispatchLimit ?? 3);
  for (const job of jobs) {
    const agent = agents.get(job.agent);
    if (!agent || !agent.enabled) {
      await store.finishJob(job.id, "failed", { error: `unknown or disabled agent "${job.agent}"` });
      log(`job ${job.id}: no agent "${job.agent}", marked failed`);
      continue;
    }
    log(`dispatch ${agent.name} (${job.reason ?? "scheduled"})`);
    const outcome = await executeRun(
      { store, llm: opts.llm, notifier: opts.notifier, log },
      agent,
      { reason: job.reason ?? undefined },
    );
    const jobStatus = outcome.status === "failed" ? "failed" : "done";
    await store.finishJob(job.id, jobStatus, {
      outcome: outcome.status,
      runId: outcome.runId ?? null,
      tokens: outcome.tokens ?? null,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  return { enqueued, dispatched: jobs.length };
}

export interface FloorOptions extends TickOptions {
  /** Directory to hot-reload agent files from (optional). */
  agentsDir?: string;
  tickSeconds?: number;
}

export interface FloorHandle {
  stop(): Promise<void>;
}

export function startFloor(opts: FloorOptions): FloorHandle {
  const log = opts.log ?? (() => {});
  const tickMs = (opts.tickSeconds ?? 15) * 1000;

  let stopped = false;
  let ticking = false;

  const unwatch = opts.agentsDir
    ? watchAgents(
        opts.agentsDir,
        opts.agents,
        (name) => log(`agent "${name}" reloaded — effective next run`),
        (err) => log(`agent reload error (keeping previous definitions): ${err.message}`),
      )
    : () => {};

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await floorTick(opts);
    } catch (err) {
      log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick(), tickMs);
  void tick(); // fire immediately on start

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      unwatch();
      // let an in-flight tick settle
      while (ticking) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
