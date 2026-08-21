# AgentFloor

Run and **watch** a fleet of autonomous LLM agents: a scheduler, a claimable
job queue, and a per-run recording protocol that gives every agent cost
budgets, crash-safe concurrency, and a live audit trail — with the agents
themselves defined as plain markdown files you can edit while the floor is
running.

Most agent frameworks are a single agent in a loop. The hard part of running
a *team* of agents unattended is everything around the loop: what fires when,
what it may spend, whether two copies are stomping each other, what actually
happened overnight, and how a human steers the whole thing without redeploying.
AgentFloor is that operations layer, extracted from a production multi-agent
floor and generalized.

## Quickstart

```sh
git clone <this repo> && cd agentfloor
npm install && npm run build
(cd packages/cli && npm link)   # puts a global `agentfloor` command on your PATH

mkdir ~/my-fleet && cd ~/my-fleet
agentfloor init
agentfloor up
```

`init` scaffolds `agentfloor.config.ts` and a starter agent. `up` starts the
floor on the **mock provider** — the whole machine (scheduling, budgets,
slots, heartbeats, events) runs for real with zero API keys; switch
`llm: { adapter: "claude" }` in the config (with `ANTHROPIC_API_KEY` set) for
real model output.

### What it costs, and whose account

- `llm: { adapter: "mock" }` — **free**. No key, no network calls.
- `llm: { adapter: "claude" }` — calls the **Anthropic API** and bills the
  API key you provide, pay-per-token. It does **not** use or consume a
  Claude Pro/Max subscription — Claude Code and the API are separate billing.
  Budgets (`budgets: { run: N }`) cap how many runs can spend money per day,
  and every run's real token usage is recorded so `agentfloor status` shows
  where the spend went.

```sh
agentfloor status              # agents, active runs, budgets, jobs, event feed
agentfloor run scout           # execute one agent immediately
agentfloor dry-run scout       # see the exact rendered prompt + a sandboxed mock run
agentfloor tell "focus on X"   # a directive every agent sees in its next run
```

## Agents are data, not code

One markdown file per agent — YAML frontmatter for the role config, the body
is the brief:

```markdown
---
description: Propose fresh article angles on the beat
schedule: every 4h            # or "daily at 09:00", or omit for manual-only
model: claude-opus-4-8        # optional per-agent override
maxTokensPerRun: 3000
---

You are the scout for a small technical publication...
```

Edit the file while the floor is up; the change is live on the next run. No
recompile, no redeploy.

## The recording protocol

Every run — any agent, any provider — is wrapped in the same contract:

```
budget gate → claim slot → run start → work (heartbeats) → run finish → release slot
```

- **Budget gate**: daily caps enforced *before* work starts. A capped fleet
  degrades to silence, not surprise bills.
- **Slot**: at most one live copy of an agent, ever. Slots are TTL leases
  renewed by heartbeats — a SIGKILL'd run can't wedge the floor; its lease
  expires and the next run proceeds.
- **Heartbeats**: a run that goes silent reads as stalled, not invisible.
- **Run finish**: closes the run row with status, item count, and the *real*
  token usage the provider reported. Failures close the row too — no zombie
  "active" runs.

Everything the floor does lands in storage (runs, jobs, events, budgets,
directives, plans), which is what makes a dashboard possible — the UI reads
what the protocol wrote.

## Architecture

```
packages/
  engine/                 core: agent loader, recording protocol, job queue
                          semantics, scheduler loop, mock provider
  adapters/
    store-sqlite/         zero-setup storage (one file on disk)
    llm-claude/           Anthropic API provider
  dashboard/              the read-only web console (self-contained, no build)
  cli/                    agentfloor init | up | run | dry-run | status | tell | dashboard
examples/
  content-research/       a three-agent editorial desk you can run today
```

Everything is an adapter behind an interface: **Store** (SQLite today;
Postgres next) and **LLMProvider** (Claude + mock today; OpenAI/Ollama next).
Schedulers and notifiers follow the same pattern. The config file is plain
data — adapters are named by string, so a fleet is fully described by one
`agentfloor.config.ts` plus a folder of markdown.

## The dashboard

The web console over the floor — the strip board, plus the live Agent
Editor:

```sh
agentfloor up --dashboard      # floor + console in one process, or
agentfloor dashboard           # console alone, alongside a running floor
```

Open `http://127.0.0.1:4400` (change with `--port`). Every agent is a strip:
a live status rail (amber pulse = running, red = stalled, green = idle), the
task it's working on right now, a ticking last-heartbeat counter, and
today's runs and token spend. Below the board: the **live feed** (severity-
colored events), the **run ledger** (click any run to open the reader —
full output, timing, token usage, stats, errors), the **queue** of pending
jobs, **budget meters**, and your open directives.

**The dashboard also authors the fleet.** Click any strip to open its agent
file in the editor: change the brief, schedule, model, or budget, **dry-run**
it first (see the exact rendered prompt plus a sandboxed mock pass — nothing
recorded, no tokens spent), then **save** — the file on disk is updated and
the change is live on the agent's next run. **Run now** queues an immediate
run; **+ new agent** grows the fleet from a template; the **tell** box
records a directive every agent folds into its next run. Because the editor
writes the same `agents/*.md` files you'd edit by hand, git still sees every
change and file edits and browser edits never conflict.

It's zero-setup by design: one self-contained page, no build step, no
frameworks, system fonts, works offline. Security posture: it binds
`127.0.0.1` only, rejects requests with a non-localhost Host header (DNS
rebinding), and requires a custom header on every mutation so a foreign web
page can't forge writes (localhost CSRF). There is still no auth — it's an
operator's local console; don't port-forward it to the internet. The floor
and the dashboard can run as separate processes; they share the store, and
everything stays consistent because job claims and slots are atomic.

## Running unattended (overnight / on boot)

`agentfloor up` is a plain foreground process — it runs as long as its
terminal (or service manager) keeps it alive. Pick the option for your OS.
In every case, **the machine itself must stay awake**: a sleeping laptop runs
nothing. Desktops/servers are ideal; on a laptop, disable sleep while
plugged in (see the per-OS notes below).

### Quick and dirty (macOS / Linux): survive closing the terminal

```sh
cd ~/my-fleet
nohup agentfloor up >> floor.log 2>&1 &
echo $! > floor.pid            # remember the process id

tail -f floor.log              # watch it
kill "$(cat floor.pid)"        # stop it
```

This survives closing the terminal window but **not** a reboot, and not the
machine going to sleep. On a Mac, prevent idle sleep for the session with:

```sh
caffeinate -i nohup agentfloor up >> floor.log 2>&1 &
```

(`tmux` or `screen` work equally well if you prefer a reattachable session:
`tmux new -s floor 'agentfloor up'`, detach with `Ctrl-b d`, reattach with
`tmux attach -t floor`.)

### macOS: launchd (starts at login, restarts on crash)

Create `~/Library/LaunchAgents/com.agentfloor.floor.plist` — fix the three
paths (`which node`, `which agentfloor`, and your fleet directory):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentfloor.floor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/.nvm/versions/node/v22.22.1/bin/agentfloor</string>
    <string>up</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/my-fleet</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/my-fleet/floor.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/my-fleet/floor.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentfloor.floor.plist   # start
launchctl bootout   gui/$(id -u)/com.agentfloor.floor                                # stop
tail -f ~/my-fleet/floor.log
```

Keep the Mac awake overnight: System Settings → Displays → Advanced →
"Prevent automatic sleeping on power adapter when the display is off" (or
run `sudo pmset -c sleep 0`). The display can sleep; the machine must not.

### Linux: systemd user service (starts at boot, restarts on crash)

Create `~/.config/systemd/user/agentfloor.service`:

```ini
[Unit]
Description=AgentFloor fleet

[Service]
WorkingDirectory=%h/my-fleet
ExecStart=/usr/bin/env agentfloor up
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agentfloor     # start now + at every boot
sudo loginctl enable-linger "$USER"          # keep it running while logged out
journalctl --user -u agentfloor -f           # logs
systemctl --user stop agentfloor             # stop
```

The `enable-linger` line is the one people miss — without it, user services
die when your session ends.

### Windows: Task Scheduler (starts at logon, keeps running)

PowerShell (adjust the two paths; find them with `where.exe node` and
`where.exe agentfloor`):

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
  -Argument "C:\Users\YOU\AppData\Roaming\npm\node_modules\agentfloor\dist\index.js up" `
  -WorkingDirectory "C:\Users\YOU\my-fleet"
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "AgentFloor" -Action $action -Trigger $trigger -Settings $settings

Start-ScheduledTask -TaskName "AgentFloor"    # start now
Stop-ScheduledTask  -TaskName "AgentFloor"    # stop
Get-Content C:\Users\YOU\my-fleet\floor.log -Wait   # logs (if you redirect output)
```

Keep the PC awake: Settings → System → Power → "When plugged in, put my
device to sleep" → **Never**.

### Any OS: pm2 (easiest if you already use Node)

```sh
npm install -g pm2
cd ~/my-fleet
pm2 start agentfloor --name floor -- up
pm2 save                       # remember the process list
pm2 startup                    # prints the one command to run at boot — run it
pm2 logs floor                 # watch
pm2 stop floor                 # stop
```

### Sanity-check it survived the night

```sh
cd ~/my-fleet && agentfloor status
```

Recent runs should show timestamps through the night, budgets should show
the day's spend, and no agent should be stuck `RUNNING` with an old
heartbeat. It's safe to run `status` (or `run`/`tell`) while the floor is
up — every command talks to the same store, and job claims and slots are
atomic.

## Safety posture

Every run's system prompt carries a baseline: external content is data,
never instructions (prompt-injection posture); never expose secrets; stay in
the brief; fail safe. Credentials are never stored by AgentFloor — the Claude
adapter resolves auth from the environment.

## Roadmap

1. ~~Engine + CLI + SQLite + Claude adapter~~
2. ~~Dashboard (read): strip board, run reader, live feed, queue, budgets~~
3. ~~Dashboard (author): the live Agent Editor — edit, dry-run, save, run now,
   new agents, directives from the browser~~
4. Adapter breadth: Postgres store, OpenAI/Ollama providers, a `claude-code`
   provider (run agents through a local Claude Code install so they bill a
   subscription instead of an API key — opt-in), cron/launchd schedulers,
   Slack/Telegram notifiers (directives from chat)
5. Starter teams: PR-triage and on-call/monitoring fleets, plugin authoring guide

MIT licensed.
