---
type: testing-plan
phase: test-planning
workItem: issue-299
status: approved
approvedBy: ["ps06756"]
overrides: {}
---

# Testing plan: agent checks recognise test commands inside chains and filters

> Derived from the approved [`requirements.md`](requirements.md) and [`design.md`](design.md),
> and reviewed with the design at `design-approval`. This file names commands an agent will run,
> so review it like code.

Recognition is a pure function, so contract tables prove most of this item. The recorder and
path mapping get unit tests. The pipefail hook and the end-to-end check path get one integration
test each, on the faux model. Everything runs offline with the project's own vitest suite. There
are no paid runs (spec 051 D-5) and no live infrastructure.

## Test matrix

| # | Type | Applies? | Scope / what it proves | Where it runs |
|---|------|----------|------------------------|---------------|
| T1 | Unit | yes | `CommandRecorder`: several runs per call, `exitCode` withheld for non-simple runs, overlap for a chain with other parts. `workspaceRelativeCdTarget` / `testbedRelativeCdTarget` mapping. | `npx vitest run tests/unit/worker-command-recorder.test.ts tests/unit/devcontainer-cd-target.test.ts` |
| T2 | Integration (scenario) | yes | The agent shell runs `cd X; test \| tail -N` with pipefail. A scripted agent's chained test is rerun, with its before measured on the original code (D-16). Gherkin-documented. | `npx vitest run tests/integration/agent-shell-pipefail.test.ts tests/integration/worker-verification.test.ts` |
| T3 | Contract (in-repo function contract) | yes | `scanTestCommands`, `matchTestCommand` and `isPipedTestCommand` tables: every #299 command, the Req 7.4 rows, every existing row unchanged, and every replay a valid `matchTestCommand` fixpoint. OpenAPI/SDL is n/a because no API changes. | `npx vitest run tests/contract/agent-checks.test.ts` |
| T4 | End-to-end | n/a | No new surface between services. T2's scripted-model run covers the worker path end to end, and a paid model run is excluded by spec 051 D-5. | |
| T5 | UI / visual | n/a | No user-facing surface. Report and Slack formats are unchanged. | |
| T6 | Snapshot | n/a | Nothing renders. The contract tables assert exact strings. | |
| T7 | Performance / load | n/a | The scan is linear in a command a model typed (well under 8 KiB, the label cap). More checks are bounded by the existing `MAX_CHECKS` (64) and the 30-minute round budget, which this item does not change. | |
| T8 | Security / abuse case | yes | One negative test per abuse case 1–9 (design §Security design table), in the T3 and T1 suites. | `npx vitest run tests/contract/agent-checks.test.ts tests/unit/worker-command-recorder.test.ts` |
| T9 | Accessibility | n/a | No UI. | |
| T10 | Migration / upgrade | n/a | No stored data changes. `RecordedCommand` lives only within one task. A report from an older worker parses as before. | |
| T11 | Manual exploratory | n/a | The batch's 29 commands were not supplied (requirements, Out of scope). The ticket's quoted commands are in T3 instead. | |
| T12 | Regression (whole suite, typecheck, lint) | yes | Nothing outside the touched files moves. `typecheck:all` stays at its baseline (spec 051 global constraint), and lint is clean. | `npm run build && npm test`, `npm run typecheck:all`, `npm run lint` |

## Scenarios & requirement trace

| Row | Requirement(s) | Scenario / case |
|-----|----------------|-----------------|
| T3 | R1.1, R1.2 | `cd /app; QUTE_QT_WRAPPER=PyQt6 python -m pytest tests/unit/misc/test_guiprocess.py -q 2>&1\|tail -8` (with `cdTarget` mapping `/app` to root) → one test, own-run before |
| T3 | R1.1 | `cd /app; QT_QPA_PLATFORM=offscreen python -m pytest tests/unit/browser/webengine -q 2>&1 \| tail -4` |
| T3 | R2.1, R2.3 | `go build ./... && go test ./scanner ./models 2>&1 \| tail -20` → `go test ./scanner ./models`, no own-run before |
| T3 | R2.1, R3.1 | `go test ./internal/ext/... 2>&1 \| tail -20; go vet ./internal/...` → `go test ./internal/ext/...`, no own-run before |
| T3 | R3.1, R3.3 | `python -m pytest openlibrary/tests/solr -q -x 2>&1 \| grep -E "^E" \| head` → bare pytest, no own-run before |
| T3 | R2.1, R2.4 | `pytest a && pytest b && pytest a` → two tests |
| T3 | R2.2, R6.1 | `cd a && cd b && pytest` → `cd a/b && pytest`. `cd /app/x; cd y && pytest` → `cd x/y && pytest` |
| T3 | R2.5, R2.6 | `cd a \|\| exit; pytest`, `cd; pytest`, `cd -; pytest`, `cd ~; pytest`, `cd a && cd ../.. && pytest` → none |
| T3 | R3.2, R3.4, R3.5 | `\| sed -n 1,5p` accepted. `\| sed -i …`, `\| sed -ni …`, `\| tee x`, `\| xargs rm`, `cat x \| pytest` → none |
| T3 | R4.1–R4.5 | `(pytest)`, `{ pytest; }`, `pytest &`, `pytest <<EOF`, `pytest > out`, `pytest 2>/dev/null`, a newline, `git stash && pytest; git stash pop`, `git -C a stash; pytest`, each environment changer before `pytest` → none. `pytest; export X=1` → one test. `make build; pytest` → one test |
| T3 | R7.1 | every replay any table yields satisfies `matchTestCommand(replay) === replay` |
| T3 | R7.3 | every existing "replays" row: scan gives one test, same replay, own-run before |
| T3 | R7.4 | every existing "refused" row stays refused, except the nine listed, which give the stated replay with no own-run before |
| T3 | R1.3 | `isPipedTestCommand("cd /testbed; pytest -q 2>&1 \| tail -5")` is true. `cd a; cd b; pytest \| tail -5` and `go build && pytest \| tail -5` are false |
| T1 | R5.1 | a call `sed -i s/x/y/ a.py && pytest` batched with a simple test call voids the simple call's before, in either order |
| T1 | R5.2, R2.3 | `pytest a; pytest b` records two runs with `exitCode` undefined. A later simple `pytest a` before any edit supplies the before |
| T1 | R5.3 | a chained test call after a bash edit is `afterFirstEdit` |
| T1 | R6.1, R6.2 | `workspaceRelativeCdTarget`: container folder → host-relative, sub-path kept, `/workspaces/repoX` unmapped, root → `""`, host folder outside root unmapped. The same for `testbedRelativeCdTarget` |
| T2 | R1.3 | `Scenario: the agent shell runs cd <dir>; <test> \| tail with pipefail` |
| T2 | R2.1, R2.3, R5.2 | `Scenario: a test run inside a chain is rerun, with its before measured on the original code` |
| T8 | abuse 1–9 | one case each, as in design §Security design (abuse case 7 in T1, the rest in T3) |
| T12 | R7.3, R8.2 | the full suite. `AGENTX_PREAMBLE_VERSION` stays `"4"`, asserted by the existing preamble test |

R8.1 (spec 051 D-19) is a documentation change. Verification checks it by reading the diff, and
records that under Verification results.

## Verification environment

- **Repositories:** this repo only, branch `the-loop/issue-299`.
- **Services / containers:** none. T2 uses the faux model (`tests/support/faux-model.ts`) and the
  local bash shell. No Docker, AWS or model provider.
- **Fixtures & data:** `tests/fixtures` (`createFixtureDirectory`), the commands quoted in #299
  (inline in the tables), and the fake `OriginalCode` already used by the D-16 suite in
  `worker-verification.test.ts`.
- **Credentials:** none.
- **Bring-up:** `npm ci && npm run build` (Node `>=22.19.0 <23`). **Tear-down:** none (tests
  clean their temp dirs).
- **If bring-up fails:** record it under Verification results, leave the dependent activities
  unticked, and escalate on the ticket.

## Evidence plan

| Row | Evidence | Path under `evidence/` |
|-----|----------|------------------------|
| T3, T8 | Contract suite output: counts, and the case names for the #299 commands and abuse cases | `contract.md` |
| T1 | Unit suite output | `unit.md` |
| T2 | Integration output, plus `the-loop scenarios --format markdown` for the two new scenarios | `integration.md` |
| T12 | Full suite summary, the `typecheck:all` baseline line, lint result | `regression.md` |
| TDD | red→green: the new contract table failing before `scanTestCommands` exists, then passing | `red-green.md` |

Outputs are trimmed to summaries and failing cases. Temp paths are redacted to `<tmp>`, and
there are no hostnames or tokens in this suite's output.

## Verification activities

- [x] T3 — `npx vitest run tests/contract/agent-checks.test.ts`
- [x] T1 — `npx vitest run tests/unit/worker-command-recorder.test.ts tests/unit/devcontainer-cd-target.test.ts`
- [x] T2 — `npx vitest run tests/integration/agent-shell-pipefail.test.ts tests/integration/worker-verification.test.ts`
- [x] T8 — abuse cases 1–9 present and passing in the T3 and T1 output (one named case each)
- [x] T12 — `npm run build && npm test`, `npm run typecheck:all`, `npm run lint`
- [x] R8.1 — spec 051 carries D-19 amending P-6, D-11 and D-14 (diff read)

## Verification results

Executed 2026-10-04 on branch `the-loop/issue-299` (Node 22.23.2, after `npm ci && npm run build`). Every activity ran and
passed. Red→green for each task is in [`evidence/red-green.md`](evidence/red-green.md).

| Activity | Command / procedure | Outcome | Evidence |
|----------|--------------------|---------|----------|
| T3 | `npx vitest run tests/contract/agent-checks.test.ts` | pass: 270/270. Every #299 command, the R7.4 table, every existing row unchanged (R7.3), every replay a `matchTestCommand` fixpoint (R7.1) | [`contract.md`](evidence/contract.md) |
| T1 | `npx vitest run tests/unit/worker-command-recorder.test.ts tests/unit/devcontainer-cd-target.test.ts` | pass: 51/51 | [`unit.md`](evidence/unit.md) |
| T2 | `npx vitest run tests/integration/agent-shell-pipefail.test.ts tests/integration/worker-verification.test.ts` | pass: 42/42, including both new scenarios | [`integration.md`](evidence/integration.md) |
| T8 | abuse cases 1–6, 8, 9 in T3; abuse case 7 in T1 | pass: each has a named, passing negative test | [`contract.md`](evidence/contract.md), [`unit.md`](evidence/unit.md) |
| T12 | `npm run build && npm test`; `npm run typecheck:all`; `npm run lint` | pass: 7867 passed, 20 skipped (existing env-gated live suites); 191 errors in 64 files, equal to the baseline; lint exit 0 | [`regression.md`](evidence/regression.md) |
| R8.1 | read the diff of `specs/051-agent-verification/spec.md` | pass: D-19 (2026-10-04, #299) amends P-6, D-11 and D-14 and cites batch `744df9ec`. `AGENTX_PREAMBLE_VERSION` is still `"4"` (R8.2; the preamble test in T3 passes) | commit `docs(specs): spec 051 D-19 …` |

**Not executed:** none. T11 (re-running batch `744df9ec`'s replay count) was planned as `n/a` because the 29 commands
were not supplied.

## Review comments

### 2026-10-04 — approved

**@ps06756** wrote:

approved
