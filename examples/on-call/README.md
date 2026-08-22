# Example fleet: on-call desk

Three agents that keep an on-call rotation sane: a **signal-reader** turns
pasted alerts into a ranked situation summary every half hour, a **scribe**
maintains the incident timeline, and a **handoff** writer produces the
brief the next shift actually reads.

```sh
cd examples/on-call
agentfloor up --dashboard
agentfloor tell "alert: p95 latency on /checkout doubled since 14:10; deploy 6f3a went out 14:05"
```

Signals flow in as directives (`agentfloor tell`, or the tell box in the
dashboard). Turn on `notify: { adapter: "slack" }` in the config to get
pinged when a run fails or the budget caps out. The agents are written to
report "quiet board" honestly rather than manufacture urgency.
