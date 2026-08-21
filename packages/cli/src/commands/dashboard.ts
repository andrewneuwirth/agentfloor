import { basename } from "node:path";
import { startDashboard } from "@agentfloor/dashboard";
import { openFloor } from "../context.js";

export function parsePort(args: string[]): number | undefined {
  const i = args.indexOf("--port");
  if (i === -1) return undefined;
  const n = parseInt(args[i + 1] ?? "", 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("--port needs a number between 1 and 65535");
  return n;
}

export async function dashboard(cwd: string, args: string[]): Promise<void> {
  const ctx = await openFloor(cwd);
  const handle = await startDashboard({
    store: ctx.store,
    agents: ctx.agents,
    floorName: basename(ctx.configDir),
    port: parsePort(args),
  });
  console.log(`dashboard on ${handle.url} — read-only console over this fleet's store`);
  console.log("run it alongside `agentfloor up` (separate terminal or service); Ctrl-C to stop");

  const shutdown = async () => {
    await handle.close();
    await ctx.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}
