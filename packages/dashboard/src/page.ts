/**
 * The dashboard page: one self-contained HTML document. No frameworks, no
 * font downloads, no build step — it must render on a machine with no
 * network, straight from the CLI.
 *
 * Design: a control-room "strip board". Each agent is a flight strip — a
 * wide row with a status rail, its live task, a ticking heartbeat, and
 * today's cost. Deep blue-ink surfaces, phosphor-amber for anything live,
 * system monospace for all data. The strips are the signature; everything
 * below them (feed, ledger, queue, budgets) stays quiet.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%230D141C'/%3E%3Crect x='2' y='3' width='3' height='10' fill='%23FFB000'/%3E%3Crect x='7' y='3' width='7' height='4' fill='%2322303F'/%3E%3Crect x='7' y='9' width='7' height='4' fill='%2322303F'/%3E%3C/svg%3E">
<title>AgentFloor</title>
<style>
  :root {
    --ink: #0D141C;
    --bay: #121C27;
    --steel: #22303F;
    --paper: #D9E3ED;
    --dim: #7E8FA3;
    --faint: #4A5A6C;
    --phosphor: #FFB000;
    --ok: #43C98A;
    --err: #F05B4D;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; margin: 0; }
  html { color-scheme: dark; }
  body {
    background: var(--ink);
    color: var(--paper);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.45;
    padding: 0 20px 48px;
  }
  a { color: inherit; }

  /* header */
  header {
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 18px 0 14px;
    border-bottom: 1px solid var(--steel);
  }
  .wordmark { font-family: var(--mono); font-size: 15px; letter-spacing: .32em; font-weight: 600; }
  .wordmark em { font-style: normal; color: var(--phosphor); }
  .floorname { font-family: var(--mono); color: var(--dim); font-size: 12px; letter-spacing: .08em; }
  .headstats { margin-left: auto; display: flex; gap: 18px; align-items: baseline; font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .headstats b { color: var(--paper); font-weight: 600; }
  .headstats .live b { color: var(--phosphor); }
  #clock { color: var(--paper); font-size: 13px; }

  /* section labels */
  .label {
    font-family: var(--mono); font-size: 10px; letter-spacing: .28em;
    color: var(--faint); text-transform: uppercase;
    margin: 26px 0 10px;
  }

  /* strip board */
  .strip {
    display: grid;
    grid-template-columns: 5px minmax(140px, 190px) 1fr minmax(96px, 120px) minmax(120px, 150px) minmax(96px, 130px);
    gap: 0 14px; align-items: center;
    background: var(--bay);
    border: 1px solid var(--steel);
    border-left: none;
    margin-bottom: 6px;
    min-height: 54px;
    padding-right: 14px;
  }
  .rail { align-self: stretch; background: var(--faint); }
  .strip.running .rail { background: var(--phosphor); animation: railpulse 1.6s ease-in-out infinite; }
  .strip.stalled .rail { background: var(--err); animation: railpulse 0.8s steps(2) infinite; }
  .strip.failed  .rail { background: var(--err); }
  .strip.idle    .rail { background: var(--ok); opacity: .55; }
  .strip.disabled { opacity: .45; }
  @keyframes railpulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .rail { animation: none !important; } }

  .strip .who { padding: 8px 0; }
  .strip .who .name { font-family: var(--mono); font-weight: 700; font-size: 14px; letter-spacing: .04em; }
  .strip .who .sched { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  .strip .now { font-family: var(--mono); font-size: 12.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip.running .now { color: var(--phosphor); }
  .strip.stalled .now { color: var(--err); }
  .cell { font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .cell b { color: var(--paper); font-weight: 600; }
  .cell .u { color: var(--faint); font-size: 10px; letter-spacing: .12em; display: block; }
  .strip .hb.fresh b { color: var(--phosphor); }
  .strip .hb.stale b { color: var(--err); }

  /* columns */
  .cols { display: grid; grid-template-columns: 1.2fr 1.2fr .8fr; gap: 22px; }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } .strip { grid-template-columns: 5px minmax(110px,150px) 1fr minmax(90px,110px); } .strip .today, .strip .lastrun { display: none; } }

  .panel { background: var(--bay); border: 1px solid var(--steel); }
  .rows { max-height: 460px; overflow-y: auto; }
  .row {
    display: flex; gap: 10px; align-items: baseline;
    padding: 7px 12px; border-bottom: 1px solid rgba(34,48,63,.55);
    font-family: var(--mono); font-size: 12px;
  }
  .row:last-child { border-bottom: none; }
  .row .t { color: var(--faint); flex: 0 0 58px; }
  .row .agent { color: var(--paper); font-weight: 600; flex: 0 0 auto; }
  .row .msg { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .row.sev-success .msg { color: var(--ok); }
  .row.sev-warn .msg { color: var(--phosphor); }
  .row.sev-error .msg { color: var(--err); }

  .row.run { cursor: pointer; }
  .row.run:hover { background: rgba(255,176,0,.06); }
  .pill {
    font-size: 10px; letter-spacing: .1em; padding: 1px 7px;
    border: 1px solid var(--steel); color: var(--dim); flex: 0 0 auto;
  }
  .pill.done { color: var(--ok); border-color: rgba(67,201,138,.4); }
  .pill.failed, .pill.blocked { color: var(--err); border-color: rgba(240,91,77,.4); }
  .pill.active { color: var(--phosphor); border-color: rgba(255,176,0,.4); }
  .tok { color: var(--dim); flex: 0 0 76px; text-align: right; }

  /* budgets */
  .budget { padding: 10px 12px; border-bottom: 1px solid rgba(34,48,63,.55); font-family: var(--mono); font-size: 12px; }
  .budget:last-child { border-bottom: none; }
  .budget .line { display: flex; justify-content: space-between; color: var(--dim); margin-bottom: 6px; }
  .budget .line b { color: var(--paper); }
  .meter { height: 4px; background: var(--steel); }
  .meter i { display: block; height: 100%; background: var(--ok); }
  .meter.hot i { background: var(--phosphor); }
  .meter.full i { background: var(--err); }

  .empty { padding: 18px 14px; color: var(--faint); font-family: var(--mono); font-size: 12px; }

  /* run reader drawer */
  #drawer {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(680px, 94vw);
    background: var(--ink); border-left: 1px solid var(--steel);
    transform: translateX(102%); transition: transform .18s ease-out;
    overflow-y: auto; padding: 20px 22px; z-index: 20;
  }
  @media (prefers-reduced-motion: reduce) { #drawer { transition: none; } }
  #drawer.open { transform: none; box-shadow: -30px 0 60px rgba(0,0,0,.5); }
  #drawer .close { float: right; background: none; border: 1px solid var(--steel); color: var(--dim); font-family: var(--mono); padding: 4px 10px; cursor: pointer; }
  #drawer .close:hover { color: var(--paper); }
  #drawer h2 { font-family: var(--mono); font-size: 15px; letter-spacing: .06em; margin-bottom: 4px; }
  #drawer .meta { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-bottom: 14px; }
  #drawer pre {
    background: var(--bay); border: 1px solid var(--steel);
    padding: 12px; font-family: var(--mono); font-size: 12px;
    white-space: pre-wrap; word-break: break-word; color: var(--paper);
    margin: 8px 0 16px;
  }
  #drawer .err { color: var(--err); }

  footer { margin-top: 34px; font-family: var(--mono); font-size: 11px; color: var(--faint); letter-spacing: .08em; }
  button:focus-visible, .row.run:focus-visible { outline: 2px solid var(--phosphor); outline-offset: 1px; }
</style>
</head>
<body>
<header>
  <span class="wordmark">AGENT<em>FLOOR</em></span>
  <span class="floorname" id="floorname"></span>
  <div class="headstats">
    <span class="live">running <b id="h-running">0</b></span>
    <span>stalled <b id="h-stalled">0</b></span>
    <span>runs today <b id="h-runs">0</b></span>
    <span>tokens today <b id="h-tokens">0</b></span>
    <span id="clock">--:--:--</span>
  </div>
</header>

<div class="label">Strip board</div>
<div id="board"></div>

<div class="cols">
  <section>
    <div class="label">Live feed</div>
    <div class="panel rows" id="feed"></div>
  </section>
  <section>
    <div class="label">Run ledger</div>
    <div class="panel rows" id="runs"></div>
  </section>
  <section>
    <div class="label">Queue</div>
    <div class="panel" id="jobs"></div>
    <div class="label">Budgets</div>
    <div class="panel" id="budgets"></div>
    <div class="label">Open directives</div>
    <div class="panel" id="directives"></div>
  </section>
</div>

<aside id="drawer" aria-label="Run detail"></aside>

<footer>read-only console &middot; state refreshes every 2s &middot; steer the fleet with <b>agentfloor tell</b></footer>

<script>
(function () {
  "use strict";
  var state = null;

  // XSS rule for this page: EVERY dynamic value — including server-derived
  // enums and agent/LLM-produced text — passes through esc() before being
  // interpolated into markup. No raw HTML is ever rendered.
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function ago(iso) {
    if (!iso) return "\\u2014";
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function hhmmss(iso) { return iso ? new Date(iso).toTimeString().slice(0, 8) : ""; }

  function renderBoard() {
    var el = document.getElementById("board");
    if (!state.agents.length) {
      el.innerHTML = '<div class="panel empty">No agents on the board. Add a markdown file to agents/ \\u2014 the floor picks it up live.</div>';
      return;
    }
    el.innerHTML = state.agents.map(function (a) {
      var nowLine;
      if (a.phase === "running") nowLine = a.task || "working";
      else if (a.phase === "stalled") nowLine = "STALLED \\u2014 no heartbeat: " + (a.task || "unknown task");
      else if (a.phase === "disabled") nowLine = "disabled";
      else if (a.phase === "never") nowLine = "never run";
      else if (a.phase === "failed") nowLine = "last run failed";
      else nowLine = "idle";
      var hbFresh = a.heartbeatAt && (Date.now() - new Date(a.heartbeatAt).getTime()) < 90000;
      return '<div class="strip ' + esc(a.phase) + '">'
        + '<div class="rail"></div>'
        + '<div class="who"><div class="name">' + esc(a.name) + '</div><div class="sched">' + esc(a.schedule) + (a.model ? ' \\u00b7 ' + esc(a.model) : '') + '</div></div>'
        + '<div class="now" title="' + esc(nowLine) + '">' + esc(nowLine) + '</div>'
        + '<div class="cell hb ' + (a.heartbeatAt ? (hbFresh ? "fresh" : "stale") : "") + '"><span class="u">heartbeat</span><b>' + (a.heartbeatAt ? esc(ago(a.heartbeatAt)) : "\\u2014") + '</b></div>'
        + '<div class="cell today"><span class="u">today</span><b>' + num(a.runsToday) + '</b> runs \\u00b7 <b>' + num(a.tokensToday) + '</b> tok' + (a.failedToday ? ' \\u00b7 <b style="color:var(--err)">' + num(a.failedToday) + ' failed</b>' : '') + '</div>'
        + '<div class="cell lastrun"><span class="u">last run</span><b>' + esc(ago(a.lastRunAt)) + '</b></div>'
        + '</div>';
    }).join("");
  }

  function renderFeed() {
    var el = document.getElementById("feed");
    if (!state.events.length) { el.innerHTML = '<div class="empty">Nothing logged yet. Events appear here as agents work.</div>'; return; }
    el.innerHTML = state.events.map(function (e) {
      return '<div class="row sev-' + esc(e.severity) + '">'
        + '<span class="t">' + hhmmss(e.createdAt) + '</span>'
        + '<span class="agent">' + esc(e.agent) + '</span>'
        + '<span class="msg" title="' + esc(e.kind) + '">' + esc((e.summary || e.kind).split("\\n")[0]) + '</span>'
        + '</div>';
    }).join("");
  }

  function renderRuns() {
    var el = document.getElementById("runs");
    if (!state.runs.length) { el.innerHTML = '<div class="empty">No runs yet. Start the floor with agentfloor up, or run an agent with agentfloor run.</div>'; return; }
    el.innerHTML = state.runs.map(function (r) {
      return '<div class="row run" tabindex="0" role="button" data-id="' + esc(r.id) + '">'
        + '<span class="t">' + hhmmss(r.startedAt) + '</span>'
        + '<span class="agent">' + esc(r.agent) + '</span>'
        + '<span class="pill ' + esc(r.status) + '">' + esc(r.status) + '</span>'
        + '<span class="msg">' + esc(r.task || "") + '</span>'
        + '<span class="tok">' + (r.tokens != null ? num(r.tokens) + " tok" : "") + '</span>'
        + '</div>';
    }).join("");
  }

  function renderJobs() {
    var el = document.getElementById("jobs");
    var pending = state.jobs.pending;
    if (!pending.length) { el.innerHTML = '<div class="empty">Queue is clear.</div>'; return; }
    el.innerHTML = pending.map(function (j) {
      return '<div class="row"><span class="t">' + hhmmss(j.runAt) + '</span>'
        + '<span class="agent">' + esc(j.agent) + '</span>'
        + '<span class="msg">' + esc(j.reason || j.createdBy) + '</span></div>';
    }).join("");
  }

  function renderBudgets() {
    var el = document.getElementById("budgets");
    if (!state.budgets.length) { el.innerHTML = '<div class="empty">No caps configured \\u2014 spending is unlimited.</div>'; return; }
    el.innerHTML = state.budgets.map(function (b) {
      var pct = b.dailyCap ? Math.min(100, Math.round(100 * b.usedToday / b.dailyCap)) : 0;
      var cls = pct >= 100 ? "full" : pct >= 75 ? "hot" : "";
      return '<div class="budget"><div class="line"><span>' + esc(b.kind) + '</span><b>' + num(b.usedToday) + ' / ' + num(b.dailyCap) + '</b></div>'
        + '<div class="meter ' + cls + '"><i style="width:' + pct + '%"></i></div></div>';
    }).join("");
  }

  function renderDirectives() {
    var el = document.getElementById("directives");
    if (!state.directives.length) { el.innerHTML = '<div class="empty">None. Record one with agentfloor tell "..."</div>'; return; }
    el.innerHTML = state.directives.map(function (d) {
      return '<div class="row"><span class="t">' + esc(ago(d.createdAt)) + '</span><span class="msg" style="white-space:normal">' + esc(d.body) + '</span></div>';
    }).join("");
  }

  function render() {
    if (!state) return;
    document.getElementById("floorname").textContent = "/ " + state.floor;
    document.getElementById("h-running").textContent = state.totals.running;
    document.getElementById("h-stalled").textContent = state.totals.stalled;
    document.getElementById("h-runs").textContent = num(state.totals.runsToday);
    document.getElementById("h-tokens").textContent = num(state.totals.tokensToday);
    renderBoard(); renderFeed(); renderRuns(); renderJobs(); renderBudgets(); renderDirectives();
  }

  // run reader drawer
  var drawer = document.getElementById("drawer");
  function closeDrawer() { drawer.classList.remove("open"); drawer.innerHTML = ""; }
  function openRun(id) {
    fetch("/api/run/" + id).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.run) return;
      var r = d.run;
      var dur = r.finishedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) + "s" : "in flight";
      var html = '<button class="close" aria-label="Close">esc</button>'
        + '<h2>' + esc(r.agent) + ' <span class="pill ' + esc(r.status) + '">' + esc(r.status) + '</span></h2>'
        + '<div class="meta">' + esc(r.task || "") + '<br>'
        + 'started ' + esc(new Date(r.startedAt).toLocaleString()) + ' \\u00b7 ' + dur
        + (r.tokens != null ? ' \\u00b7 ' + num(r.tokens) + ' tokens' : '') + '</div>';
      if (r.error) html += '<div class="label">Error</div><pre class="err">' + esc(r.error) + '</pre>';
      var outputs = d.events.filter(function (e) { return e.data && e.data.text; });
      outputs.forEach(function (e) {
        html += '<div class="label">Output \\u00b7 ' + esc(e.kind) + '</div><pre>' + esc(e.data.text) + '</pre>';
      });
      var rest = d.events.filter(function (e) { return !(e.data && e.data.text); });
      if (rest.length) {
        html += '<div class="label">Events</div>';
        html += rest.map(function (e) {
          return '<div class="row sev-' + esc(e.severity) + '"><span class="t">' + hhmmss(e.createdAt) + '</span><span class="msg" style="white-space:normal">' + esc(e.kind) + ': ' + esc(e.summary || "") + '</span></div>';
        }).join("");
      }
      if (r.stats) html += '<div class="label">Stats</div><pre>' + esc(JSON.stringify(r.stats, null, 2)) + '</pre>';
      drawer.innerHTML = html;
      drawer.classList.add("open");
      drawer.querySelector(".close").addEventListener("click", closeDrawer);
      drawer.querySelector(".close").focus();
    });
  }
  document.getElementById("runs").addEventListener("click", function (ev) {
    var row = ev.target.closest(".row.run");
    if (row) openRun(row.getAttribute("data-id"));
  });
  document.getElementById("runs").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      var row = ev.target.closest(".row.run");
      if (row) openRun(row.getAttribute("data-id"));
    }
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeDrawer(); });

  // clock ticks every second; relative times re-render with it
  setInterval(function () {
    document.getElementById("clock").textContent = new Date().toTimeString().slice(0, 8);
    if (state) renderBoard();
  }, 1000);

  function poll() {
    fetch("/api/state").then(function (r) { return r.json(); }).then(function (s) {
      state = s; render();
    }).catch(function () { /* floor unreachable; keep last picture */ });
  }
  poll();
  setInterval(poll, 2000);
})();
</script>
</body>
</html>
`;
