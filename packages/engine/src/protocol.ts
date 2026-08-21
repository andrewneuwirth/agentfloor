/**
 * The recording protocol — AgentFloor's per-run contract.
 *
 * Every run, regardless of agent or provider, is wrapped in the same
 * lifecycle:
 *
 *   budget gate → claim slot → run start → work (heartbeats) → run finish
 *   (with real token usage) → release slot
 *
 * This is what makes a fleet observable and safe to leave unattended: cost
 * caps are enforced before work starts, no agent ever runs two copies at
 * once, a silent run reads as stalled, and a crashed run still closes its
 * row and frees its slot (the slot is a TTL lease renewed by heartbeats, so
 * even a SIGKILL can't wedge the floor).
 */
import type { AgentDef, LLMProvider, Store } from "./types.js";
import { GLOBAL_GUIDELINES } from "./guidelines.js";

export interface RunOutcome {
  status: "done" | "failed" | "skipped_budget" | "skipped_slot";
  runId?: string;
  text?: string;
  tokens?: number;
  error?: string;
}

export interface RunDeps {
  store: Store;
  llm: LLMProvider;
  /** Slot lease TTL. Heartbeats renew it; default 10 minutes. */
  slotTtlSeconds?: number;
  /** Heartbeat cadence while the provider call is in flight. Default 30s. */
  heartbeatSeconds?: number;
  log?: (line: string) => void;
}

/** Build the prompt for one run: brief + live floor context. */
export async function buildPrompt(store: Store, agent: AgentDef): Promise<{ system: string; prompt: string }> {
  const parts: string[] = [`# Your brief (agent: ${agent.name})`, "", agent.brief];

  const plan = await store.latestPlan("day");
  if (plan?.body) {
    parts.push("", "# Current plan (context — the fleet's standing intent)", "", plan.body);
  }
  const directives = await store.unhandledDirectives();
  if (directives.length) {
    parts.push(
      "",
      "# Operator directives (steering from the human — fold these into your work)",
      "",
      ...directives.map((d) => `- ${d.body}`),
    );
  }
  parts.push(
    "",
    "# Output",
    "",
    "Execute exactly one run of your brief now and reply with your result.",
    "Be concrete; never fabricate data or claim work you did not do.",
  );
  return { system: GLOBAL_GUIDELINES, prompt: parts.join("\n") };
}

/**
 * Execute exactly one run of an agent under the recording protocol.
 * Never throws for run-level failures — the outcome is always recorded in
 * the store and returned.
 */
export async function executeRun(deps: RunDeps, agent: AgentDef, opts: { reason?: string } = {}): Promise<RunOutcome> {
  const { store, llm } = deps;
  const log = deps.log ?? (() => {});
  const slotTtl = deps.slotTtlSeconds ?? 600;

  // 1. budget gate — before anything else
  if (!(await store.consumeBudget("run"))) {
    await store.logEvent(agent.name, "budget_exhausted", "Daily run budget hit; skipping run", {
      severity: "warn",
    });
    log(`${agent.name}: run budget exhausted, skipping`);
    return { status: "skipped_budget" };
  }

  // 2. overlap gate — one live copy per agent, ever
  const runId = crypto.randomUUID();
  if (!(await store.claimSlot(agent.name, runId, slotTtl))) {
    log(`${agent.name}: prior run still holds the slot, yielding`);
    return { status: "skipped_slot" };
  }

  // 3. open the run row (sharing the slot's id when the store supports it)
  const what = agent.description ?? `run ${agent.name}`;
  const task = opts.reason && opts.reason !== "scheduled" ? `${what} (${opts.reason})` : what;
  const rid =
    typeof (store as Partial<StoreWithRunStartId>).runStartWithId === "function"
      ? await (store as StoreWithRunStartId).runStartWithId(runId, agent.name, task)
      : await store.runStart(agent.name, task);

  let heartbeatTimer: NodeJS.Timeout | null = null;
  try {
    // 4. the work — heartbeat while the provider call is in flight
    const { system, prompt } = await buildPrompt(store, agent);
    const hbSeconds = deps.heartbeatSeconds ?? 30;
    // heartbeats stamp liveness only (null task keeps the run's task label)
    heartbeatTimer = setInterval(() => {
      store.heartbeat(rid, null, null).catch(() => {});
      store.renewSlot(agent.name, runId).catch(() => {});
    }, hbSeconds * 1000);
    heartbeatTimer.unref?.();

    await store.heartbeat(rid, null, 0);
    const result = await llm.generate({
      system,
      prompt,
      model: agent.model,
      maxTokens: agent.maxTokensPerRun,
    });
    const tokens = result.usage.inputTokens + result.usage.outputTokens;

    await store.logEvent(agent.name, "run_output", truncate(result.text, 400), {
      severity: "info",
      runId: rid,
      data: { model: result.model, text: result.text, usage: result.usage },
    });

    // 5. close the run with the truth
    await store.runFinish(rid, {
      status: "done",
      items: 1,
      tokens,
      stats: { model: result.model, ...result.usage },
    });
    log(`${agent.name}: run done — ${tokens} tokens`);
    return { status: "done", runId: rid, text: result.text, tokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 5b. a failure still closes the row — no zombie "active" runs
    await store.runFinish(rid, { status: "failed", error: message }).catch(() => {});
    await store
      .logEvent(agent.name, "run_error", `Run failed: ${message}`, { severity: "error", runId: rid })
      .catch(() => {});
    log(`${agent.name}: run failed — ${message}`);
    return { status: "failed", runId: rid, error: message };
  } finally {
    // 6. ALWAYS release the slot
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await store.releaseSlot(agent.name, runId).catch(() => {});
  }
}

/**
 * Optional store extension: open a run under a caller-chosen id so the slot
 * lease and the run row share one identity. SQLite adapter implements it.
 */
interface StoreWithRunStartId extends Store {
  runStartWithId(id: string, agent: string, task: string | null): Promise<string>;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
