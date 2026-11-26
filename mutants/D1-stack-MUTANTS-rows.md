# D1 stack: the MUTANTS.md rows taken out at the rebase onto code/next 5c44e8fca

MUTANTS.md is code/next's at the rebase (owner rule); the stack's own rows, byte for byte as they stood on the old heads (D1-2 f9e258bdc, D1-3 a2ff0bd91, E2E 863917aa1), are kept here. Per-lane evidence also stays in D1-2.md and D1-3.md.

## D1-2-OLD-ENGINE-REMOVAL (mutants run on the D1-2 working tree before its commits; code head named in the commit that carries this section)

Each mutant is one edit to the named source, run against the tests named, then reverted.

| Mutant | Tests | Result |
| --- | --- | --- |
| M1 `requireWorkspace` no longer refuses a core task's workspace (`aws/broker.ts`) | `d1-retired-doors.test.ts` | killed ("a task posted to a workspace the core holds is refused ... writes nothing at all") |
| M2 `isCoreTask` answers true for every well-formed id (`aws/engine-boundary.ts`) | `aws-engine-boundary.test.ts` | killed (the mark rule case and the list case) |
| M3 `listTasks` lists a row whose task has no core mark (`aws/developer-tasks.ts`) | `aws-engine-boundary.test.ts` | killed ("lists only tasks that carry the core's mark") |
| M4 the Stop button of a core task refuses nobody (`aws/slack-core-stop.ts`) | `core-stop-slack-admin.test.ts` | killed |
| M5 a retired Slack press writes no private note (`aws/broker.ts`) | `d1-retired-doors.test.ts` | killed |
| M6 a retired worker callback (`candidate-export`) is routed again (`aws/broker.ts` callback regex) | `cloud-handlers.test.ts` | killed (the retired-callback parity check) |
| M7 the single-workspace Slack start is refused (fallback removed) (`aws/broker.ts`) | `slack-company-layout-start.test.ts` | killed |
| M8 the webhook mapper no longer ignores a task with no core mark (`aws/github-core-webhooks.ts`) | `github-webhook-core-branch.test.ts`, `github-webhook-hosted-wiring.test.ts` | killed (first attempt replaced every use of the identifier and broke the file, reported survived by my runner; redone with the single condition: killed) |
| M9 the pinned-tests history accepts a reviewed lowering whose `from` is below the held floor (`tests/support/pinned-tests.ts`) | `pinned-tests-guard.test.ts` | killed ("allows a floor to be lowered, or a pin retired, only with a reviewed entry that names the floor it replaced") |

## D1-2-REVIEW-FIXES (the Sonnet pre-review's must-fixes, on the D1-2 branch; each mutant one edit, run, reverted)

| Mutant | Tests | Result |
| --- | --- | --- |
| M1 the merge sweep's `loadTask` no longer reads the mark (`services/merge-tracking.ts`) | `merge-tracking-sweep-budget.test.ts` | killed ("leaves an old task's row alone ...") |
| M2 a legacy-event press of a core-marked task is no longer answered by `answerCoreTaskLegacyPress` (`aws/broker.ts`) | `d1-retired-doors.test.ts`, `core-stop-slack-admin.test.ts` | killed (Keep not served; the owner-only refusals; the Stop button, 4 tests) |
| M3 the People confirmation POST skips the origin check (`aws/people-confirm-web.ts`) | `people-confirm-web.test.ts` | killed ("refuses another origin") |
| M5a the pinned-tests history accepts a lowering whose `from` is at or above the held floor, not exactly it | `pinned-tests-guard.test.ts` | killed |
| M5b a retired pin is accepted though its test file still exists | `pinned-tests-guard.test.ts` | killed |
| S1 old rows count against the page again (`aws/developer-tasks.ts` listTasks, company mode) | `list-old-tasks-company-mode.test.ts` | killed (2 tests) |

## D1-2-TEST-REVIEW-FIXES (the Opus review's test fixes and the rebase onto e4b80f981; each mutant one edit, run, reverted)

| Mutant | Tests | Result |
| --- | --- | --- |
| E2 the core comment route is not called (`addComment` sends a GET instead of a POST) | `core-plan-comments.test.ts` | killed (the 4 restored cases that need a comment fail) |
| E4 `testProofPullRequestLines` stops stripping angle brackets and backticks from a proving label (`developer/test-proof-lines.ts`) | `broker-test-proof-lines.test.ts` | killed |
| S1 the confirming POST skips the origin check (`aws/people-confirm-web.ts`) | `people-confirm-web.test.ts` | killed |
| S2 the list page turns budget overflow back into an error (`aws/developer-tasks.ts`) | `list-old-tasks-company-mode.test.ts` | killed |
| S2 old rows count against the page again (company mode) | `list-old-tasks-company-mode.test.ts` | killed (2 tests) |
| D1-2 `APPROVED_FLOOR_DROPS` widened (`to: 34` becomes `33` for task-people, `pinned-tests.ts`) | `pinned-tests-guard.test.ts` | killed (the list deep-equal fails) |

## D1-3-SWITCH-COLLAPSE (mutants run on commit e08884b09, the switch collapse; each mutant one edit to the named source, run against the tests named, reverted by `git checkout`)

| Mutant | Tests | Result |
| --- | --- | --- |
| M1 the fixed settings text of the core mark becomes `cc=off` (`core-host/core-task-mark.ts`) | `core-host-app.test.ts` | killed (2: the byte-for-byte mark golden and "a core start writes the mark with the task") |
| M2 the mark's `flow` area is written as `workflow` (`core-host/core-task-mark.ts`) | `core-host-app.test.ts` | killed (the byte-for-byte golden) |
| M3 `coreWiringGaps` stops asking for the `merge-tracking` service (`core-host/core-wiring-guard.ts`) | `core-host-wiring-guard.test.ts`, `core-host-app.test.ts` | killed (3) |
| M4 `coreWiringGaps` never names `honest-ci` (`core-host/core-wiring-guard.ts`) | `core-host-wiring-guard.test.ts` | killed (8) |
| M5 the root no longer throws `CoreWiringIncompleteError` for a standing check (`core-host/app.ts`) | `core-host-wiring-guard.test.ts` | killed (6) |
| M6 the core's start no longer writes the mark item with the task (`core-host/core-runtime.ts`) | `core-host-app.test.ts`, `aws-engine-boundary.test.ts` | killed (21) |
| M7 the setup-run start no longer refuses an install with no model gateway (`core-host/setup-run-routes.ts`) | `core-host-setup-run-routes.test.ts` | killed ("refuses a start before writing anything when the install has no model gateway") |
| M8 `projectArchiveTakesEffect` answers false (`aws/core-engine-root.ts`) | `core-engine-root.test.ts` | killed ("gives the developer API its core entries") |
| M9 the scheduled jobs forget the companies a lessons or system-runs flag names (`core-host/app.ts`) | `core-host-app.test.ts` | killed ("L4-JA56 B5 ...") |

Also, not a mutant but the proof that the collapsed mark write is the old one: the OLD writer (`stampItem(stampForNewTask(CORE_ENGINE_ON, ...))` at 0ffb6a3ac) and the new `coreTaskMarkItem(coreTaskMarkFor(...))` produced the same item byte for byte (JSON of the whole put, key order included) for one fixed task id, company and time; run once with `tsx` on a scratch copy of the two old files, scratch removed.

## E2E-UNCONNECTED-DELETE (run on 35f261161, before the lane was folded for typecheck fixes; the product files of entries 14 and 6 were identical at 781fea189, see the pre-review re-stamp below; the M2 test was tightened after its first run)

Each mutant applied to the sha above, the named test run under Node 22.23.2, then reverted.

| Mutant | Test | Result |
| --- | --- | --- |
| C1 the admission read no longer refuses a `replay` round (`core/e2e/callbacks.ts`) | `e2e-core-callbacks.test.ts` | killed (1) |
| C2 the same for a `grounding` round | `e2e-core-callbacks.test.ts` | killed (1) |
| C3 the grounding refusal uses the replay words | `e2e-core-callbacks.test.ts` | killed (1) |
| C4 the retired-round refusal moves after the task read | `e2e-core-callbacks.test.ts` | killed (2: the readers throw if called) |
| V1 `settleNonCandidateRound` answers false for a retired round (`core/e2e/verification.ts`) | `e2e-core-verification.test.ts` | killed (2) |
| V2 the candidate guard for a `grounding` admission is removed | `e2e-core-verification.test.ts` | killed (1) |
| V3 the candidate guard for a `replay` admission is removed | `e2e-core-verification.test.ts` | killed (1) |
| V4 `isNonCandidateRound` is true only for a baseline | `e2e-core-verification.test.ts` | killed (2) |
| M1 `releaseMergeClaim` releases nothing (`core/merge/merge.ts`) | `core-merge-flow.test.ts` | killed (1) |
| M2 a claim transaction that failed on its audit step is answered "already merging" | `core-merge-press-hardening.test.ts` | SURVIVED the first test (it checked the code only, both are RUNTIME_UNAVAILABLE); the case now asserts the message "The merge could not be recorded."; killed (1) after that |
| M3 the audit fact's `approvedBy` is not the press method | `core-merge-flow.test.ts` | killed (1) |

### E2E-UNCONNECTED-DELETE pre-review round (Sonnet pre-review MUST-1 and SHOULD-3)

Product files of this table are the ones of the head that carries the commits "pre-review MUST-1" and "pre-review SHOULD-3"; the rows of the table above hold for them too (`git diff 781fea189 HEAD -- packages` is the one `callbacks.ts` refactor into `refuseRetiredRound`, which the C1 to C4 mutants still cover).

| Mutant | Test | Result |
| --- | --- | --- |
| M4 the press's own second-review wait ask is dropped (`core/merge/merge.ts`, `mergeableNow`: `const wait = undefined`) | `core-merge-press-hardening.test.ts` (the late-ask case) | SURVIVED the 11 merge files before the case was ported (the gate's only test had been deleted with the proof file); killed (1) after |
| C5 the evidence upload no longer refuses a retired round (`callbacks.ts`, `refuseRetiredRound` call in `evidenceUploadStep` removed) | `e2e-core-callbacks.test.ts` (retired-round upload, 2 kinds) | killed (2) |

