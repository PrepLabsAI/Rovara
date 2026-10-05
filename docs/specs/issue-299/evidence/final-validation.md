---
type: evidence
workItem: issue-299
---

# Final validation: agent checks recognise test commands inside chains and filters

Every acceptance criterion is met. The proof is summarised from `testing-plan.md`'s Verification results, plus the three
self-review fixes, which were re-run on the final head: 322 targeted cases, then the full suite.

## Final validation evidence

| Acceptance criterion | How it was proved | Where |
|----------------------|-------------------|-------|
| R1.1, R1.2: `cd <dir>; <test>` replays as `cd <dir> && <test>`, and its run is a before | scan table: the two `cd /app; …` commands from #299, `cd pkg; npm test`; recorder keeps the exit code | [`contract.md`](contract.md), [`unit.md`](unit.md) |
| R1.3: pipefail for `cd <dir>; <test> \| tail -N` | `isPipedTestCommand` rows; scenario *the agent shell runs cd <dir>; <test> \| tail with pipefail* (real bash, failing `make test`) | [`contract.md`](contract.md), [`integration.md`](integration.md) |
| R2.1–R2.4: tests in chains, `cd` composition, no own-run before, dedupe | scan table (`go build … && go test …`, `go test …; go vet …`, `cd a && cd b`, `pytest a && pytest b && pytest a`); end-to-end scenario: a chained run is rerun and its before measured on the original code (D-16) | [`contract.md`](contract.md), [`integration.md`](integration.md) |
| R2.5, R2.6: `cd` with `\|\|`, no target, `-`, `~`, absolute or `..` refused | refusal table | [`contract.md`](contract.md) |
| R2.7: limits unchanged | `MAX_CHECKS` slice and round budget untouched; full suite green | [`regression.md`](regression.md) |
| R3.1–R3.5: filters | scan table (`grep … \| head`, `sed -n`, `sort \| uniq \| wc`, `egrep`); refusals (`tee`, `xargs`, `sed -i`/`-ni`/`--in-place`, `cat x \| pytest`) | [`contract.md`](contract.md) |
| R4.1–R4.5: refusals | refusal table: groups, `$(`, backticks, `&`, heredoc, redirections, control characters, `git stash` (also behind `env`, `timeout`, `command`, assignments), every environment changer, empty parts | [`contract.md`](contract.md) |
| R5.1–R5.3: recorder | unit tests: several runs per call, no exit code for a chain, abuse case 7 overlap in either order, `afterFirstEdit` after a bash edit | [`unit.md`](unit.md) |
| R6.1–R6.3: every `cd` mapped | `devcontainer-cd-target` unit tests; recorder test mapping `cd /app/sub; cd x` with the agent's text kept | [`unit.md`](unit.md) |
| R7.1–R7.4: replay boundary unchanged | every replay a `matchTestCommand` fixpoint; every existing row unchanged; exactly the 9 listed rows newly recognised; a 300,000-command fuzz with no violation (self-review round 2) | [`contract.md`](contract.md), [`self-review.md`](self-review.md) |
| R8.1, R8.2: spec 051 D-19, preamble version 4 | D-19 in `specs/051-agent-verification/spec.md`; the preamble test passes | [`regression.md`](regression.md) |
| Security abuse cases 1–9 | one passing negative test each; security review passed | [`security-review.md`](security-review.md) |

Gaps, stated: no critic round could run, because no critics are configured (see [`critic-review.md`](critic-review.md)).
Batch `744df9ec`'s replay count was not re-run, because its 29 commands were not supplied.
