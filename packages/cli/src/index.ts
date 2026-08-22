#!/usr/bin/env node
/**
 * agentfloor — run and watch a fleet of autonomous LLM agents.
 *
 *   agentfloor init            scaffold config + a starter agent
 *   agentfloor up              start the floor (scheduler + dispatcher)
 *   agentfloor run <agent>     execute one agent run now
 *   agentfloor dry-run <agent> render the prompt + one sandboxed mock run
 *   agentfloor status          agents, runs, budgets, jobs, events
 *   agentfloor tell "<text>"   record an operator directive for the fleet
 */
import { init } from "./commands/init.js";
import { up } from "./commands/up.js";
import { run, dryRun } from "./commands/run.js";
import { status, tell } from "./commands/status.js";
import { dashboard } from "./commands/dashboard.js";
import { tick } from "./commands/tick.js";

const HELP = `agentfloor — run and watch a fleet of autonomous LLM agents

usage:
  agentfloor init             scaffold agentfloor.config.ts + agents/
  agentfloor up               start the floor (Ctrl-C to stop)
      --dashboard [--port N]  also serve the web console
  agentfloor dashboard        serve the web console alone [--port N, default 4400]
  agentfloor tick             one scheduler pass, then exit (for cron/launchd/systemd)
  agentfloor run <agent>      execute one agent run now
  agentfloor dry-run <agent>  render the prompt + one sandboxed mock run
  agentfloor status           show agents, runs, budgets, jobs, events
  agentfloor tell "<text>"    record an operator directive for the fleet
`;

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  const cwd = process.cwd();
  switch (cmd) {
    case "init":
      return init(cwd);
    case "up":
      return up(cwd, args);
    case "dashboard":
      return dashboard(cwd, args);
    case "tick":
      return tick(cwd);
    case "run":
      return run(cwd, args[0]);
    case "dry-run":
    case "dryrun":
      return dryRun(cwd, args[0]);
    case "status":
      return status(cwd);
    case "tell":
      return tell(cwd, args);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
