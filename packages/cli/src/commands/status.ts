import { openFloor } from "../context.js";

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export async function status(cwd: string): Promise<void> {
  const ctx = await openFloor(cwd);
  try {
    const state = await ctx.store.floorState();

    console.log("── agents ──");
    for (const a of ctx.agents.values()) {
      const last = state.recentRuns.find((r) => r.agent === a.name);
      const active = state.activeRuns.some((r) => r.agent === a.name);
      const flag = !a.enabled ? "disabled" : active ? "RUNNING" : last ? `${last.status} ${ago(last.finishedAt ?? last.startedAt)}` : "never run";
      console.log(`  ${a.name.padEnd(16)} ${flag}`);
    }

    if (state.activeRuns.length) {
      console.log("\n── active runs ──");
      for (const r of state.activeRuns) {
        console.log(`  ${r.agent.padEnd(16)} ${r.task ?? ""}  (heartbeat ${ago(r.heartbeatAt)})`);
      }
    }

    console.log("\n── budgets (today) ──");
    if (!state.budgets.length) console.log("  none configured (unlimited)");
    for (const b of state.budgets) console.log(`  ${b.kind.padEnd(16)} ${b.usedToday}/${b.dailyCap}`);

    if (state.pendingJobs.length) {
      console.log("\n── pending jobs ──");
      for (const jb of state.pendingJobs) console.log(`  ${jb.agent.padEnd(16)} at ${jb.runAt}  (${jb.reason ?? "scheduled"})`);
    }

    if (state.unhandledDirectives.length) {
      console.log("\n── open directives ──");
      for (const d of state.unhandledDirectives) console.log(`  [${d.id.slice(0, 8)}] ${d.body}`);
    }

    console.log("\n── recent events ──");
    for (const e of state.recentEvents.slice(0, 12)) {
      const t = e.createdAt.slice(11, 19);
      console.log(`  ${t} ${e.severity.padEnd(7)} ${e.agent}/${e.kind}: ${(e.summary ?? "").split("\n")[0].slice(0, 100)}`);
    }
    if (!state.recentEvents.length) console.log("  (none yet)");
  } finally {
    await ctx.store.close();
  }
}

export async function tell(cwd: string, words: string[]): Promise<void> {
  const body = words.join(" ").trim();
  if (!body) throw new Error('usage: agentfloor tell "<directive for the fleet>"');
  const ctx = await openFloor(cwd);
  try {
    const id = await ctx.store.insertDirective(body, "cli");
    console.log(`directive recorded [${id.slice(0, 8)}] — every agent sees it in its next run's context`);
  } finally {
    await ctx.store.close();
  }
}
