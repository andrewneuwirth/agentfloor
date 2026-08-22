# Example fleet: PR triage desk

Three agents that keep a review queue moving: a **triager** orders the open
pull requests, a **review-prepper** writes a briefing for whatever is at
the top, and a **nudger** drafts friendly pokes for stalled reviews once a
day.

```sh
cd examples/pr-triage
agentfloor up --dashboard
agentfloor tell "PRs open today: #412 fix flaky auth test (small), #408 new billing webhooks (risky), #415 docs typo"
```

The agents work from directives and their own prior outputs — feed them the
day's PR list with `agentfloor tell` (or wire up a real source when tool
support lands). They are written to say "nothing to do" rather than invent
pull requests.
