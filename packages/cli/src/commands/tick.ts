import { floorTick } from "@agentfloor/engine";
import { openFloor } from "../context.js";

/**
 * One scheduler pass, then exit. This is how external schedulers drive a
 * floor with no resident process: cron, launchd, or a systemd timer runs
 * `agentfloor tick` every few minutes. Safe to overlap with `agentfloor up`
 * or another tick — job claims and slots are atomic.
 */
export async function tick(cwd: string): Promise<void> {
  const ctx = await openFloor(cwd);
  try {
    const result = await floorTick({
      store: ctx.store,
      llm: ctx.llm,
      notifier: ctx.notifier,
      agents: ctx.agents,
      dispatchLimit: ctx.config.dispatchLimit,
      log: (line) => console.log(line),
    });
    console.log(`tick done — ${result.enqueued} enqueued, ${result.dispatched} dispatched`);
  } finally {
    await ctx.store.close();
  }
}
