import { basename } from "node:path";
import { startFloor } from "@agentfloor/engine";
import { startDashboard, type DashboardHandle } from "@agentfloor/dashboard";
import { openFloor } from "../context.js";
import { parsePort } from "./dashboard.js";

export async function up(cwd: string, args: string[] = []): Promise<void> {
  const ctx = await openFloor(cwd);
  const scheduled = [...ctx.agents.values()].filter((a) => a.enabled && a.schedule);
  console.log(`agentfloor up — ${ctx.agents.size} agent(s) loaded, ${scheduled.length} scheduled, llm: ${ctx.llm.name}`);
  for (const a of ctx.agents.values()) {
    const sched = a.schedule
      ? a.schedule.kind === "every"
        ? `every ${a.schedule.seconds}s`
        : `daily at ${String(a.schedule.hour).padStart(2, "0")}:${String(a.schedule.minute).padStart(2, "0")}`
      : "manual";
    console.log(`  ${a.enabled ? "•" : "◦"} ${a.name}  [${sched}]  ${a.description ?? ""}`);
  }
  console.log("watching agents/ for edits — Ctrl-C to stop\n");

  let dash: DashboardHandle | null = null;
  if (args.includes("--dashboard")) {
    dash = await startDashboard({
      store: ctx.store,
      agents: ctx.agents,
      floorName: basename(ctx.configDir),
      port: parsePort(args),
    });
    console.log(`dashboard on ${dash.url}\n`);
  }

  const floor = startFloor({
    store: ctx.store,
    llm: ctx.llm,
    agents: ctx.agents,
    agentsDir: ctx.agentsDir,
    tickSeconds: ctx.config.tickSeconds,
    dispatchLimit: ctx.config.dispatchLimit,
    log: (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
  });

  const shutdown = async () => {
    console.log("\nstopping floor…");
    await floor.stop();
    if (dash) await dash.close();
    await ctx.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // keep the process alive
  await new Promise(() => {});
}
