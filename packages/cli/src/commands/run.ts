import { buildPrompt, executeRun, MockProvider } from "@agentfloor/engine";
import { openFloor } from "../context.js";

export async function run(cwd: string, agentName: string | undefined): Promise<void> {
  if (!agentName) throw new Error("usage: agentfloor run <agent>");
  const ctx = await openFloor(cwd);
  try {
    const agent = ctx.agents.get(agentName);
    if (!agent) throw new Error(`unknown agent "${agentName}" (have: ${[...ctx.agents.keys()].join(", ") || "none"})`);
    if (!agent.enabled) throw new Error(`agent "${agentName}" is disabled (enabled: false)`);

    console.log(`running ${agent.name} once (llm: ${ctx.llm.name})…\n`);
    const outcome = await executeRun({ store: ctx.store, llm: ctx.llm, log: (l) => console.log(`  ${l}`) }, agent, {
      reason: "manual run",
    });

    switch (outcome.status) {
      case "done":
        console.log(`\n─── output ───\n${outcome.text}\n──────────────`);
        console.log(`run ${outcome.runId} done — ${outcome.tokens} tokens`);
        break;
      case "failed":
        console.error(`run failed: ${outcome.error}`);
        process.exitCode = 1;
        break;
      case "skipped_budget":
        console.log("skipped: daily run budget exhausted (raise budgets.run in config)");
        break;
      case "skipped_slot":
        console.log("skipped: a prior run of this agent is still active (slot held)");
        break;
    }
  } finally {
    await ctx.store.close();
  }
}

export async function dryRun(cwd: string, agentName: string | undefined): Promise<void> {
  if (!agentName) throw new Error("usage: agentfloor dry-run <agent>");
  const ctx = await openFloor(cwd);
  try {
    const agent = ctx.agents.get(agentName);
    if (!agent) throw new Error(`unknown agent "${agentName}" (have: ${[...ctx.agents.keys()].join(", ") || "none"})`);

    // Render exactly what a real run would send (live plan + directives
    // included), then do one sandboxed mock generation. No store writes.
    const { system, prompt } = await buildPrompt(ctx.store, agent);
    console.log("─── system prompt ───");
    console.log(system);
    console.log("\n─── prompt ───");
    console.log(prompt);
    const mock = new MockProvider();
    const result = await mock.generate({ system, prompt, model: agent.model, maxTokens: agent.maxTokensPerRun });
    console.log("\n─── sandboxed mock run (no store writes, no LLM cost) ───");
    console.log(result.text);
  } finally {
    await ctx.store.close();
  }
}
