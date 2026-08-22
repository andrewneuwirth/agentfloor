# Driving the floor with an external scheduler

`agentfloor up` is a resident process that ticks on its own. If you'd
rather have **no resident process**, let your OS scheduler drive the floor:

```sh
agentfloor tick
```

runs exactly one pass — enqueue whichever agents are due (or woken),
dispatch due jobs through the recording protocol, exit. All state lives in
the store, so ticks are stateless and safe to overlap with each other or
with a running `up` (claims are atomic, slots are exclusive).

The trade-off: your fleet's reaction time is your tick cadence, and
hot-reload/wake latency stretches to match. For most scheduled fleets a
5-minute cadence is plenty.

## cron (Linux/macOS)

```cron
*/5 * * * * cd /home/you/my-fleet && /usr/local/bin/agentfloor tick >> floor.log 2>&1
```

`crontab -e` to install. Use absolute paths — cron's PATH is minimal.

## systemd timer (Linux)

`~/.config/systemd/user/agentfloor-tick.service`:

```ini
[Unit]
Description=AgentFloor tick

[Service]
Type=oneshot
WorkingDirectory=%h/my-fleet
ExecStart=/usr/bin/env agentfloor tick
```

`~/.config/systemd/user/agentfloor-tick.timer`:

```ini
[Unit]
Description=AgentFloor tick every 5 minutes

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agentfloor-tick.timer
sudo loginctl enable-linger "$USER"     # keep firing while logged out
```

## launchd (macOS)

`~/Library/LaunchAgents/com.agentfloor.tick.plist` — fix the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentfloor.tick</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/.nvm/versions/node/v22.22.1/bin/agentfloor</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/my-fleet</string>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/Users/YOU/my-fleet/floor.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/my-fleet/floor.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentfloor.tick.plist
launchctl bootout   gui/$(id -u)/com.agentfloor.tick    # to remove
```

## Windows (Task Scheduler)

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
  -Argument "C:\Users\YOU\AppData\Roaming\npm\node_modules\agentfloor\dist\index.js tick" `
  -WorkingDirectory "C:\Users\YOU\my-fleet"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "AgentFloor tick" -Action $action -Trigger $trigger
```

## Which mode should I use?

| You want…                                   | Use                          |
| ------------------------------------------- | ---------------------------- |
| Sub-minute reactions, hot reload, wakes now | `agentfloor up` (resident)   |
| No resident process, OS-managed cadence     | `agentfloor tick` on a timer |
| The dashboard alongside either              | `agentfloor dashboard`       |
