/**
 * Agents are data, not code: one markdown file per agent with YAML
 * frontmatter (role config) and a body (the brief). Edit the file, and the
 * next run picks it up — no recompile, no redeploy.
 */
import { readFileSync, readdirSync, existsSync, watch } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentDef, Schedule } from "./types.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSchedule(raw: unknown): Schedule | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  let m = s.match(/^every\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0];
    const seconds = unit === "s" ? n : unit === "m" ? n * 60 : n * 3600;
    if (seconds < 5) throw new Error(`schedule "${s}": minimum interval is 5s`);
    return { kind: "every", seconds };
  }
  m = s.match(/^daily\s+at\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) throw new Error(`schedule "${s}": invalid time`);
    return { kind: "daily", hour, minute };
  }
  throw new Error(`unrecognized schedule "${s}" — use "every <N><s|m|h>" or "daily at HH:MM"`);
}

/** Compute the next fire time strictly after `after`. */
export function nextFireTime(schedule: Schedule, after: Date): Date {
  if (schedule.kind === "every") {
    return new Date(after.getTime() + schedule.seconds * 1000);
  }
  const next = new Date(after);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next <= after) next.setDate(next.getDate() + 1);
  return next;
}

export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/** Parse agent source text (frontmatter + brief) without touching disk. */
export function parseAgentSource(name: string, raw: string, file = ""): AgentDef {
  if (!isValidAgentName(name)) {
    throw new Error(`agent name "${name}" must be lowercase alphanumeric (with - or _)`);
  }
  const m = raw.match(FRONTMATTER);
  const fm: Record<string, unknown> = m ? (parseYaml(m[1]) ?? {}) : {};
  const brief = (m ? raw.slice(m[0].length) : raw).trim();
  if (!brief) throw new Error(`agent "${name}": empty brief (markdown body after frontmatter)`);
  return {
    name,
    description: fm.description != null ? String(fm.description) : undefined,
    schedule: parseSchedule(fm.schedule),
    model: fm.model != null ? String(fm.model) : undefined,
    maxTokensPerRun: fm.maxTokensPerRun != null ? Number(fm.maxTokensPerRun) : undefined,
    enabled: fm.enabled !== false,
    brief,
    file,
  };
}

export function parseAgentFile(file: string): AgentDef {
  const raw = readFileSync(file, "utf8");
  const name = basename(file).replace(/\.md$/, "");
  return parseAgentSource(name, raw, resolve(file));
}

export function loadAgents(dir: string): Map<string, AgentDef> {
  const agents = new Map<string, AgentDef>();
  if (!existsSync(dir)) return agents;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const def = parseAgentFile(join(dir, entry));
    agents.set(def.name, def);
  }
  return agents;
}

/**
 * Watch the agents directory and reload on change. Returns a disposer.
 * Errors in an edited file keep the previous good definition and surface
 * through `onError` rather than crashing the floor.
 */
export function watchAgents(
  dir: string,
  agents: Map<string, AgentDef>,
  onReload: (name: string) => void,
  onError: (err: Error) => void,
): () => void {
  if (!existsSync(dir)) return () => {};
  let timer: NodeJS.Timeout | null = null;
  const watcher = watch(dir, () => {
    // debounce bursts of fs events from a single save
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const fresh = loadAgents(dir);
        for (const name of agents.keys()) if (!fresh.has(name)) agents.delete(name);
        for (const [name, def] of fresh) {
          const prev = agents.get(name);
          agents.set(name, def);
          if (!prev || prev.brief !== def.brief || JSON.stringify(prev) !== JSON.stringify(def)) {
            onReload(name);
          }
        }
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    }, 150);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
