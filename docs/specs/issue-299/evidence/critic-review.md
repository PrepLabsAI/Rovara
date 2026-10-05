---
type: evidence
phase: needs-review
workItem: issue-299
---

# Critic review: agent checks recognise test commands inside chains and filters

No critic round could run. `the-loop critic list` on the machine running this loop reports "No critics configured":
the operator's `cli-config.yaml` has no `critics[]`. Per `reference/reviewing.md`, each round is recorded as
**unavailable**. That is a stated gap, not a pass, and the PR briefing says so.

## Review cycles

| Round | Critic | Outcome | Findings → disposition | Duration / usage |
|-------|--------|---------|------------------------|------------------|
| 1 | none configured | unavailable: no `critics[]` in the operator's CLI config | — | — |
