---
type: evidence
phase: needs-review
workItem: issue-299
---

# Self-review: agent checks recognise test commands inside chains and filters

Two rounds under the operator's policy (`the-loop critic policy`: `selfReviewCount: 3`, `stopOnNoNewFindings: true`).
Round 2 found nothing new, so the reviews stopped there. Every finding was fixed test-first, one commit per finding.

## Review cycles

| Round | Reviewer | Outcome | Findings → disposition | Link |
|-------|----------|---------|------------------------|------|
| 1 | `[claude/opus-5.5]` | new findings (3) | 1.1 a trailing `cd` after the test let the run count as a before → will-fix, `234766dc`. 1.2 leading `NAME=value` words hid `cd`, environment changers and `git stash`, and `X="a b"` hid a bare assignment → will-fix, `c58b8404`. 1.3 `sed`/`sort`/`uniq` can write files but did not count for the overlap rule → will-fix, `f74774de`. D-19 updated in `6075a077`. | [PR #300 comment](https://github.com/PrepLabsAI/AgentX/pull/300#issuecomment-5983567199) |
| 2 | `[claude/opus-5.5]` | zero (converged) | Code re-read, plus a 300,000-command random fuzz: no throw, every replay a `matchTestCommand` fixpoint, an own-run before only for a lone test | PR #300 conversation |
