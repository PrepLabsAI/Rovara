# Server-read regression mutant evidence

## Item 3 — OPUS-F1F2 tests-only follow-up (0410a0dfd + local tests)

Production code is unchanged. This delta adds/touches no production guard, refusal, money or authority line, so no new per-line remove/loosen/invert matrix applies. The two named reviewer guard removals were applied singly in one isolated scratch copy, never in the production worktree. No per-job mutant cap is asserted.

| Mutant / production location | Mutation | New failing test in tests/unit/task-start-request-read.test.ts | Restored result |
|---|---|---|---|
| M2 — packages/broker/src/core/task-flow/start-request-read.ts:62 | Remove the final `if (await deps.company() !== companyId) throw startReadNotFound();` after the last People proof. | masks a membership moved during the final authority pass | 1 failed (expected 404, received 200); restore: 1 passed |
| M7 — packages/broker/src/aws/developer-routes.ts:2846 | Replace `if (fresh.companyId !== live.companyId) throw agentXError("TASK_NOT_FOUND", "That task is unavailable.");` with `void fresh;`. | masks a membership moved between the final live read and standing recheck | 1 failed (expected 404, received 200); restore: 1 passed |

Each mutant and restoration passed `tsc -b` before the one selected test ran, via `ci-like-test.sh <scratch> tests/unit/task-start-request-read.test.ts -t <case> --maxWorkers=1`. Only assertion failures showing 200 instead of 404 count as kills. There were no collection/type/timeout failures. Runner and exact outputs are in the lane brief folder: opus-f1f2-mutants.py, opus-f1f2-mutant-results.json, opus-f1f2-mutant-M2.log, opus-f1f2-mutant-M2-restored.log, opus-f1f2-mutant-M7.log and opus-f1f2-mutant-M7-restored.log. Final source and tests in the single scratch copy matched the worktree byte-for-byte before deletion.

The four optional P3 cases are also added: cross-company catalog continuation (M8), impact query selectors (M9), a header naming a second person with a persisted mark for the same request (M12), and valid core stamp flags/stampedAt drift (M13). These are passing regression cases; no additional mutant kill is claimed. Existing real-broker tests still accept the documented UUID and strict github/disconnect/installationId inputs, and both route registration files pass.

Final focused verification: 22 files / 773 tests pass, including all restored item-3 tests, their explicit importers, complexity and both inventory ratchets. Pinned Node 22.23.2; `tsc -b`, strict-changed on the three changed TS files, ESLint on those files and `git diff --check` pass. The start-read file has 19 test declarations (32 expanded cases), up from 15 (28).

Final changed-test fingerprints:

```text
d06ffc50cb2850f327d3eb47e274e7a258732dc4513be9889567636bba2a3421  tests/support/server-read-world.ts
2f03b2d127d2ed0047af4a9f55f6c2c1e91b078d79fd5f12eeeb4d1389e3f47c  tests/unit/task-start-request-read.test.ts
6f42e860ed2409cece332415759e92bf541516998d013ba4c50595a6c6e69887  tests/unit/connection-impact.test.ts
```

Evidence applies to this uncommitted tests-only delta on the head above. L6/9d owns the commit, final-head lane gate, lead 4 Opus delta review and staging proof. No current gate stamp or review verdict is claimed.

## RD-2.0 - contract rows for the task page reads (commit 567630b57 plus the S2/S3 follow-up)

Production guards this lane adds: the `owns()` clause and the mount hunk in `core-host/dev-routes.ts`, GET-only and the anchored path regex in `core-host/task-screen-routes.ts`, the stub's fixed `ROUTE_NOT_SERVED` refusal (`task-spec-routes.ts`, the other three stubs are the same line), the code's 404 status (`packages/code-api/src/errors.ts`), and the existing script-token line that keeps a token off the four paths. Each mutant was applied singly to the working tree, one targeted run, then the file was restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Failing test (all in tests/unit/core-host-dev-routes.test.ts, "the task page's new reads (RD-2.0)", unless noted) |
|---|---|---|
| M1 dev-routes.ts `owns()` | drop `\|\| taskScreenRoute(path, method) !== undefined` | both tests: no answer (undefined) instead of 404 / 403 |
| M2 task-screen-routes.ts `taskScreenRoute` | GET-only check removed | "serves GET only": POST/PUT answered instead of left to the old broker |
| M3 task-screen-routes.ts `PATH` | drop the `$` anchor | "serves GET only": `/specs` and `/spec/x` answered |
| M4 task-spec-routes.ts | stub resolves 200 `{}` instead of refusing | "answers ROUTE_NOT_SERVED ...": 200 instead of 404 |
| M5 code-api errors.ts | remove `ROUTE_NOT_SERVED` from the 404 group | code-api-errors "lists every code in its order", code-api-version digest, and the dev-routes test (409 instead of 404) |
| M6 dev-routes.ts script-token line | let the four paths past the token refusal | "serves GET only ... keeps a script token out": 404 instead of 403 |
| M7 dev-routes.ts `taskSurfaceAnswer` | remove the `routeTaskScreen` line | "answers ROUTE_NOT_SERVED ...": undefined instead of 404 |
| M8 task-spec-routes.ts | code `NOT_FOUND` instead of `ROUTE_NOT_SERVED` | "answers ROUTE_NOT_SERVED ...": body differs from the row's example refusal |

All 8 killed; the restored tree passes (17 files, 539 tests, `tsc -b` clean). Evidence applies to this lane's commits; the final-head gate and review belong to 9d.

## RD-2.0-READ-RULE - the one read rule (commit 1 9f1dbfedc, commit 2 1c14abfdc; all 14 mutants re-applied on 3c53c33eb, the head after the gate fixes)

Production guards this lane adds: the company check first and every basis in `core/task-flow/read-rule.ts` (`ADMITTED_BY`, `SHARED_PARTS`, `SHARED_ROLES`, `maySeeTaskMoney`, `mayReadSourceCode`, `mayReadCodeDetails`), the stored share's live project check (`aws/task-readers.ts` `readerShare`), and the events route's call of the rule (`aws/core-task-rule-routes.ts`). Each mutant was applied singly to the working tree, one targeted run (`tests/unit/task-read-rule.test.ts`, `tests/contract/rd-2-0-read-rule-golden.test.ts`, `tests/unit/core-host-task-web-routes.test.ts`), then the file was restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Killed by |
|---|---|---|
| M1 read-rule.ts company check | dropped (a task of another company is judged by the seams) | core-host-task-web-routes (5 tests: taskReadable, task read, merge standing...), the table |
| M2 task-readers.ts `readerShare` | a share is admitted without the live project membership | the real-routes table and the golden ("left the project") |
| M3 read-rule.ts `storedShare` | an unknown stored role is treated as viewer | the table ("unknown role"), the real routes, the golden |
| M4 read-rule.ts `maySeeTaskMoney` | money for every member (the stored-owner test dropped) | the decision's money table and the golden (task view shapes) |
| M5 read-rule.ts | a withheld part answers the missing task's 404 instead of TASK_PART_NOT_SHOWN | the table ("shared reader", "admin and shared") and the golden |
| M6 core-task-rule-routes.ts | the events route skips the read rule | the real-routes table and the golden (a stranger reads the events) |
| M7 read-rule.ts `ADMITTED_BY.task` | the stored share is asked before the core's own rule | core-host-task-web-routes ("never asks for the owner...") and the table |
| M8 read-rule.ts `reads` | any canRead failure becomes "no" (so the share is asked) | core-host-task-web-routes ("a core read that fails for another reason stays a failure") and the table |
| M9 read-rule.ts `mayReadSourceCode` | the old page rule carries source code | the decision's source-code flags |
| M10 read-rule.ts `ADMITTED_BY.diff` | the diff admits a share (survived the first run: the page seam throws its refusal first; killed by the new test that binds no page seam) | "the diff and the plan and proof never admit a stored share" |
| M11 read-rule.ts `ADMITTED_BY.share` | the readers routes admit the core read rule (a co-owner told "only the owner can share") | the table ("share" column) |
| M12 read-rule.ts `ADMITTED_BY.events` | the events drop the core read rule | the table and the golden's named widening cells |
| M13 read-rule.ts `mayReadCodeDetails` | code details for every reader | the decision's flags (`codeDetails` equals `sourceCode`) |
| M14 read-rule.ts `ADMITTED_BY.plan` | the plan admits a share | the table ("shared reader", "admin and shared") |

All 14 killed on 3c53c33eb (M10 survived on the first run, before its test existed); the restored tree passes. Evidence applies to this lane's commits; the final-head gate and review belong to 9d.

## RD-2.0-READ-RULE pre-review fixes (head cdd50103e: the plan GET, the live grant re-read, the answers frame, plan comments, the actions standing)

New production guards: the plan GET's call of the rule (`core-host/parity-task-routes.ts`), the live company membership and project grant re-read for every way in (`core/task-flow/read-rule.ts` `liveGrantOf`), the answers frame's withheld documents (`core/answers/task-context.ts`), the plan comments' gate (`aws/core-task-rule-routes.ts`), the actions standing's reader check (`core/task-actions/standing.ts`), the merge standing's grant re-read for the task's owner (`core-host/hosted-merge-routes.ts`), the stored person's mode and the share-lookup log. Each mutant applied singly on cdd50103e, one targeted run (the table, the golden, core-host-task-web-routes), restored with `git checkout -- <file>`. M9 (source code without the grant proof) was re-expressed for the new `grantProved` flag and killed again.

| Mutant / location | Mutation | Killed by |
|---|---|---|
| M15 parity-task-routes.ts | the plan GET reads the task and asks no rule | the real-routes table (a stranger, a share and the starters read the plan route) |
| M16 read-rule.ts `grant === "no"` | no live grant re-read for any way in | the table's two starters on every read (function and routes), the starters test |
| M17 task-context.ts | the answers frame hands a share the plan text | the table's answers cell for a share, the golden's named cells, the answers test |
| M18 core-task-rule-routes.ts | the plan comments skip the rule | the real-routes table (comments for a stranger and a share) |
| M19 standing.ts | a refusal of the rule counts as a reader | the actions standing test |
| M20 hosted-merge-routes.ts | the task's owner is not re-checked for the grant at the merge standing | the starters on the real merge route |
| M21 read-rule.ts | the task's own person reads as "reader" | the table (every "o" cell) |
| M22 read-rule.ts | a failing share lookup is not logged | the log test |
| M9 read-rule.ts `mayReadSourceCode` | source code without the grant proof | the decision's source-code flags |

All killed; the restored tree passes.
## MERGE-APPROVAL-NOT-SPENT-ON-REFUSAL (lane commit 0ba8a3b9c, round 2 on top of it)

Tests: `tests/unit/core-merge-approval-not-spent.test.ts` and `tests/unit/core-merge-press-hardening.test.ts`, run together (22 tests) after each mutant of `packages/broker/src/core/merge/merge.ts` (each restored from a copy; `tsc -b` not re-run per mutant).

| Mutant | Result |
| --- | --- |
| M1 `proofUseKeys` leaves out the `MERGE_PROOF_TOKEN` row (a comment used for request A is read as unused for request B) | killed (2 tests) |
| M2 a host refusal never gives the approval back | killed (2 tests) |
| M3 the approval is given back by any claim, not only the one that wrote its use | killed (2 tests, the half merge) |
| M4 `pressMerge` does not set `useRecordedByCaller` | killed (3 tests) |
| M5 `refuseUsedProof` is not called | killed (8 tests) |
| M6 the use rows are deleted without the `usedAt` condition | SURVIVES, on purpose not killed: the same transaction also requires this run's own claim (`by`, `at`), so rows of another run's claim cannot be reached; the condition is a second guard. |
## PH-S3-PREFIXES: release build roles write only their own pipeline output (2026-11-25)

Measured on Code lane commit 47fb34900 (the lane rebased onto L1/L9b-code 6336ff3b0) plus the uncommitted follow-up delta (own-prefix `s3:AbortMultipartUpload`, cross-repo contract digest, runbook), and on Cloud lane commit 38b45c442 plus its follow-up delta. Each mutant was applied alone, the one named test file ran, and the file was restored (diffed against a backup copy) before the next. Only assertion failures count.

| Mutant / location | Mutation | Failing tests (of the file) | Restored |
|---|---|---|---|
| Code M1, infra/lib/release-pipeline.ts `ReleaseArtifactBucket.scopeWrites` | the project is not registered (CDK's whole-bucket read-write returns) | 4 of 14 in tests/contract/release-pipeline-s3-prefixes.test.ts | green |
| Code M2, `artifactKeyPattern` | an artifact name cut to 4 characters (a bare `Beta*` that also matches the Cloud-side names) | 5 of 14 | green |
| Code M3, the `DenyArtifactWritesOutsideOwnOutput` statement | removed | 2 of 14 | green |
| Code M4, `grantReadWrite` | the own-prefix grant also holds `s3:DeleteObject` | 4 of 14 | green |
| Code M5, `grantReadWrite` | the grant's resource is the whole bucket (`bucket/*`) | 2 of 14 | green |
| Code M6, `cloudStateArtifactName` | the old names `Beta<Action>State` / `Production<Action>State` | 2 of 14 | green |
| Cloud C1, infra/lib/cloud-release-actions.ts `PipelineStateWrites` | the Allow's resource is `bucket/*` | 6 of 40 in tests/contract/cloud-release-actions.test.ts | green |
| Cloud C2, `DenyArtifactWritesOutsideOwnState` | removed | 2 of 40 | green |
| Cloud C3, infra/lib/cloud-boundary.ts `PipelineStateWrites` | the boundary cap is `bucket/*` | 3 of 40 | green |
| Cloud C4 | the beta role is given the production prefix | 3 of 40 | green |
| Cloud C5 | the role's Allow also holds `s3:DeleteObject` | 8 of 40 | green |

No new money or authority line other than the IAM grants above; the template pin (environment-release-pipeline*.test.ts) and the `AgentXReleasePipeline` snapshot hold the synthesized result, and the pin was recomputed against the rebased base (the base's own template still matches the pin recorded before this lane, `291ca547...`).


## GRANT-EXCHANGE-G1 (Git exchange: liveness, count, audit, log; two commits on base 97fdae1c0, mutants re-measured on the second)

Tests: core `tests/unit/core-e2e-publication-callback.test.ts` with `tests/unit/core-close-recovery.test.ts` (the core's exchange, `packages/broker/src/services/repository-exchange.ts`), legacy `tests/contract/legacy-git-exchange.test.ts` (`packages/broker/src/aws/legacy-repository-exchange.ts` and `assertLegacyPushAuthority` in `packages/broker/src/aws/broker.ts`). Each mutant was applied alone to a scratch edit of the file, the named tests were run (`--maxWorkers=2`), and the file was restored from a copy. `tsc -b` was not re-run per mutant. Earlier rounds of this lane found survivors and fake-rejected mutants (a stale workspace object in the first tests; a mutated DynamoDB expression the fake rejects; after the Sonnet pre-review's fixes, a workspace check that was done twice, so removing either copy went unseen, and a legacy publish case that the new clone fence now hid): each was fixed by a test, by dropping the duplicate check (the workspace is now checked only in the transaction that takes the slot) or by a corrected mutant, and the whole list was re-run. The rows below are the final results.

| Mutant | Result |
| --- | --- |
| core: CANCEL_REQUESTED refusal removed | killed (3 tests) |
| core: not-live (ended) refusal removed | killed (4 tests) |
| core: closing run refusal removed | killed (3 tests) |
| core: push authority call removed | killed (12 tests) |
| core: cap condition removed from the count | killed (2 tests) |
| core: status condition removed from the count | killed (1 test) |
| core: cap per repository (x repositories) made x1 | killed (3 tests) |
| core: push audit failure swallowed (fail open) | killed (1 test) |
| core: clone audit failure refused (fail closed) | killed (1 test) |
| core: push not audited at all | killed (3 tests) |
| core: coverage check removed before the count | killed (2 tests) |
| core: log carries the nonce, not its hash (grant id) | killed (7 tests) |
| access: grant id is not a hash of the nonce | killed (2 tests) |
| legacy: CANCEL_REQUESTED refusal removed | killed (2 tests) |
| legacy: not-live (ended) refusal removed | killed (4 tests) |
| legacy: closing workspace refusal removed | killed (2 tests) |
| legacy: authority call removed | killed (9 tests) |
| legacy: cap condition removed | killed (2 tests) |
| legacy: status condition removed from the count | killed (1 test) |
| legacy: coverage check removed | killed (2 tests) |
| legacy authority: fence compare removed | killed (2 tests) |
| legacy authority: active operation compare removed | killed (3 tests) |
| legacy authority: closed task refusal removed | killed (2 tests) |
| legacy authority: pull request head compare removed | killed (1 test) |
| legacy authority: workflow candidate compare removed | killed (1 test) |
| legacy authority: publish without candidate not checked | killed (1 test) |
| legacy authority: maintain not checked | killed (2 tests) |
| core: the request's repository address is logged before the grant verifies | killed (1 test) |
| core: the count's transaction does not check the workspace fence | killed (3 tests) |
| core: the count's transaction does not check the active operation | killed (3 tests) |
| core: the count's transaction does not check a closing workspace | killed (4 tests) |
| core: a slot is never given back | killed (2 tests) |
| core: a slot is not given back after a failed mint | killed (1 test) |
| core: a slot is not given back after a failed audit | killed (1 test) |
| core: the issued row is not written | killed (2 tests) |
| core: a failed mint is not told apart (the host error passes through) | killed (1 test) |
| legacy: a slot is never given back | killed (1 test) |
| legacy: the request's repository address is logged before the grant verifies | killed (1 test) |
| legacy: the cap is one repository's, not the grant's | killed (1 test) |
| legacy authority: a clone is not held to the workspace fence | killed (2 tests) |

The journeys (`tests/journeys/web-task.test.ts`, the two "Git exchange" cases) hold the same property end to end on the real core and are not mutated here; they run in every pull request run.
# TIER-GROWTH-MERGE (lane pr/tier-growth-merge-20261125): a grown change merges only after the higher tier's reviews ran on the current head

Shape (a): the tier pass (`tier-checks.ts`) runs the higher tier's code and security reviews for every grown task (not only the lighter flow), records `recordTierReview` for the head, and the merge view, the press, the standing and the session summary read ONE reader (`core/merge/grown-owed.ts`). Each mutant below was applied singly to a clean tree, the named tests were run (Node 22.23.2, `--maxWorkers=1`), and the line was restored.

| Mutant / production location | Mutation | Killed by |
|---|---|---|
| M1 core/merge/merge.ts `readinessFromItems` | `base.ready && owed !== undefined ? notReady(owed.words) : base` becomes `base` (the view says ready while owed) | tests/unit/change-tier-merge-gate.test.ts: 4 fail (BAR, risky, lower tier/older head, skipped at small) |
| M2 core/merge/grown-owed.ts `growthOwedOf` | a review record for ANY head clears the debt | the same file: BAR (stale review after a push), lower tier/older head, risky |
| M3 core/merge/grown-owed.ts `growthOwedOf` | a record at level small clears a debt of standard/risky | "grown to risky: a standard review is not enough", lower tier/older head |
| M4 core/merge/merge.ts `tierGate` | `owed` forced false (the final gate ignores the debt) | "the gate itself ... never merges it without the review" |
| M5 services/merge-tracking.ts `trackRow` | a grown task is never scheduled for the tier pass | tests/journeys/tier-growth.test.ts: 6 of 7 fail |
| M6 build-step/tier-review-calls.ts `oneReview` | the spending-limit refusal reads as an outage (no cap words, no Needs you) | tier-growth journey CAP case |
| M7 build-step/tier-checks.ts `runTierChecks` | a grown normal-flow task is "not owed" whatever the record says (no reviews run) | tier-growth journey: 6 of 7 fail |

The bar tests: `tests/unit/change-tier-merge-gate.test.ts` "a grown change on the normal flow" (BAR; grown to risky; the gate itself; the reader's states) and the journey `tests/journeys/tier-growth.test.ts` (seven cases on the real core and worker).

## TIER-GROWTH-MERGE, hosted wiring (core-host/hosted-tier-review.ts, wired in aws/core-engine-root.ts)

The grown tier's reviews run on the hosted root as the task's own paid call over the gateway's agent route (a task token for the review step with the task's payer, one model, the gateway's current price), under `tierReviewMeter` (admission, task cap room, worst-case price). Tests: tests/journeys/tier-growth.test.ts through the hosted root (only the network is faked; no reviewer is put in the core's deps) and tests/unit/hosted-tier-review.test.ts. Each mutant applied singly, the named test run, the line restored.

| Mutant / production location | Mutation | Killed by |
|---|---|---|
| M8 hosted-tier-review.ts `meter` | `worst <= room` becomes `true` (the call's worst-case price is not held against the task's room) | journey CAP case |
| M9 hosted-tier-review.ts `call` | the usage booking is skipped | journey "rates standard" case (the two bookings on the task's ledger) |
| M10 hosted-tier-review.ts | the token's step is not `review` | journey "rates standard" case (step, payer and one model asserted on every call) |

## TIER-GROWTH-MERGE, pre-review fixes (money lines of core-host/hosted-tier-review.ts and the typed refusals)

The meter prices the request body as sent (or, without the prompt, the patch's characters at their widest plus framing) and answers by reason; `call` re-checks its own worst case against the room before sending; a 2xx is booked whether or not it reads; nothing is repeated after a request may have reached the model; a booking that failed refuses the task's next call. Each mutant applied singly, the named test run, restored.

| Mutant / production location | Mutation | Killed by |
|---|---|---|
| M11 hosted-tier-review.ts `call` | the worst-case-against-room check before sending is removed | tests/unit/hosted-tier-review-call.test.ts "sends nothing when its own worst case ... does not fit" |
| M12 hosted-tier-review.ts `call` | an answer that cannot be read is not booked | the same file, "books a 2xx whose answer cannot be read" |
| M13 tier-review-calls.ts `callWithDeadline` | a failure after the request was sent is retried (a second paid call) | the same test (one request only) |
| M15 hosted-tier-review.ts `FALLBACK_BYTES_PER_CHAR` | the meter without the prompt prices a character as one byte | tests/unit/hosted-tier-review-meter.test.ts (the pre-review's probe) |
| M16 hosted-tier-review.ts `meter` | an unbooked usage no longer refuses the task's next call | hosted-tier-review-call.test.ts "keeps a booking that failed" |

## TIER-GROWTH-MERGE, the tier_review reviewer kind (core-host/hosted-tier-review.ts)

The hosted call mints a reviewer grant of the Cloud gateway's `tier_review` kind: step = kind, exactly kind/slot/ceilingUsd, the call's priced worst case as the ceiling, one model, 120 s, a fresh jti, the task's own workspace and latest operation, the signed price. Applied singly, run, restored.

| Mutant | Mutation | Killed by |
|---|---|---|
| M17 hosted-tier-review.ts | the ceiling is twice the priced worst case | tests/unit/hosted-tier-review-call.test.ts "mints a tier_review reviewer grant" |
| M18 hosted-tier-review.ts | the step is `review`, not the kind | the same test |

## TIER-GROWTH-MERGE, after the Opus review (a request that may have reached the model is never repeated; a 422 is read by its code)

| Mutant | Mutation | Killed by |
|---|---|---|
| M19 hosted-tier-review.ts `provablyNotSent` | any non-abort fetch failure counts as "never sent" (retried, unbooked) | hosted-tier-review-call.test.ts "a socket cut after the request was written" |
| M20 hosted-tier-review.ts `GATEWAY_REFUSALS` | a 502 counts as a gateway refusal before the model (unbooked) | the same file, "a 502 may come after the model was called" |
| M21 hosted-tier-review.ts `refuseBeforeSend` | every 422 reads as the spending limit | the same file, "a 422 is the spending limit only by its code" |
## REDACT-BLOCK-REASON (security stopgap): guard mutants, round 2

Each mutant was applied singly to the production file in the lane worktree (the file restored from its saved text after each run; `git diff` shows no mutant left behind), then the named test file was run once with `vitest run <file> --maxWorkers=1`. "Killed" = the run failed on the named assertion; the restored file passed. Two mutants survived their first test and led to a new test (M3, M9); the table shows the final kill. The `redactText` patterns themselves (packages/contracts, consumed built) are covered by positive and negative cases in tests/unit/redact-text-gaps.test.ts, not by this table.

| Mutant | Production location | Mutation | Killed by |
|---|---|---|---|
| M1 | packages/broker/src/local/app/task-view.ts (workflow in the task GET) | drop `withRedactedBlockReason(...)` around the spread workflow | tests/unit/block-reason-task-view.test.ts and block-reason-read-sites.test.ts "the local and hosted task GET" |
| M2 | packages/broker/src/aws/developer-tasks.ts (taskView, about 25 routes) | `workflow: withoutDesignReviewMoney(...)` without the redaction | block-reason-read-sites.test.ts "taskView (about 25 routes) redacts the stored reason" |
| M3 | packages/broker/src/aws/developer-tasks.ts (list detail, workflow of a core task) | `blockReason: workflow.blockReason` raw | tests/contract/aws-engine-boundary.test.ts "?detail=1 shows a core task's block reason stored raw redacted" (first survived block-reason-read-sites: that list takes the redacted taskView for a workflow task; only a core task falls back to the stored workflow) |
| M4 | packages/broker/src/local/app/facts.ts | `blockReason` raw | block-reason-read-sites.test.ts "the local app's task facts" |
| M5 | packages/broker/src/core-host/pr-feedback-view.ts | `blockReason` raw | block-reason-read-sites.test.ts "the PR feedback view" |
| M6 | packages/mcp/src/tools.ts (`block_reason`) | raw `task.workflow.blockReason` | block-reason-read-sites.test.ts "agentx_get_task shows block_reason redacted" |
| M7 | packages/mcp/src/tools.ts (`blockedBecause`) | `blockReasonSentence(reason ?? fallback)` without redaction | block-reason-read-sites.test.ts (2 failures: get_task text and next step) |
| M8 | packages/mcp/src/tools.ts (branch conflict ask / give-up next step) | `blockReasonSentence(task.workflow.blockReason!)` | block-reason-read-sites.test.ts "the next-step text for a blocked workflow" |
| M9 | packages/mcp/src/tools.ts (branch conflict stop next step) | same, in the second branch | same test, after adding `BRANCH_CONFLICT_STOP_PREFIX` to its prefixes (first survived) |
| M10 | packages/broker/src/core/task-flow/reads.ts | `blockReason` raw | tests/unit/block-reason-redaction.test.ts "the task view shows a reason stored raw redacted" |
| M11 | packages/broker/src/core/task-flow/stage-machine.ts | planning stop written with `.slice(0, 500)` only | block-reason-redaction.test.ts (3 failures: planning stop, reading stop, straddling cut) |
| M12 | packages/broker/src/core/design-review/resolve-run.ts | same, resolve run | block-reason-redaction.test.ts "the design review's planning stop" |
| M13 | packages/broker/src/core/task-flow/results.ts | ingest stores `error.slice(0, 16_384)` unredacted | block-reason-redaction.test.ts "a worker's recorded end stores its error redacted at ingest" |
| M14 | packages/broker/src/aws/dispatcher.ts (`terminalDispatchError`) | store the error's own message instead of the fixed words | tests/contract/dispatcher-given-up-words.test.ts (5 failures) |
| M15 | packages/broker/src/aws/dispatcher.ts | remove the `logStaleAddress` call | dispatcher-given-up-words.test.ts (the stale-address log lines, 2 failures) |
| M16 | packages/broker/src/aws/sessions.ts (`markFailed` message) | unredacted `.slice(0, 16_384)` | tests/contract/session-manager.test.ts "stores the provisioner's error text redacted" |
| M17 | packages/worker/src/server.ts (`unauthorized`) | never add the worker's own workspace and generation to the wrong_workspace / wrong_generation answer | tests/contract/worker-invoke-auth.test.ts (2 failures) |
| M18 | packages/broker/src/aws/ec2-delivery.ts (`DeliveryFailure`) | cut to 512 before redacting | dispatcher-given-up-words.test.ts "redacts the worker's text before it cuts it" |
| M19 | packages/worker/src/run-task.ts (failure event) | `emit("error", { message: taskFailure.message })` | tests/contract/worker-planning-deadline.test.ts "the task's failure event" |
| M20 | packages/worker/src/nightly-invocation.ts (failure event) | `error.message.slice(0, 300)` without redaction | tests/unit/worker-nightly-invocation.test.ts "the failure event" |
| M21 | packages/broker/src/aws/developer-tasks.ts (`getWorkflowFeedbackReview`, the legacy hosted feedback review view) | `blockReason: workflow.blockReason` raw | tests/unit/feedback-review-block-reason.test.ts "shows a block reason stored raw redacted" (review F1) |
| M22 | packages/broker/src/developer/workflow-messages.ts (`visibleBlockReason`, the Slack words) | return the E2E plan-correction reason as it is, without `redactText` | tests/unit/slack-block-reason-redaction.test.ts "redacts the ApplicationPlanDefect message" (review F2) |
## REGISTRY-TOLERANT-READ — kept-at-use rules, rule 9 and the per-project list guards (c6dd21ac1 + the pre-review delta, uncommitted)

Each guard below was removed or loosened singly, in this worktree, with the touched contracts rebuilt (`tsc -b`) before the test ran and again after the file was restored (`@agentx/contracts` is read from its build). `node vitest run <file> --maxWorkers=1`, pinned Node 22.23.2. A kill is an assertion failure in the named test, never a collection or type error. One more mutant (the revision-unreadable decision by message text) was dropped: the helper that made it was dead code after the catch sites moved to a class check (`ProjectRevisionUnreadableError`, `core/project-left-out.ts`), and it was deleted.

| Mutant | Mutation | Killed by (test file: test) |
|---|---|---|
| A, `core/task-flow/start.ts` | drop `if (barred !== undefined) return refused(barred);` (the use check at task start) | tests/unit/registry-tolerant-read.test.ts: a task start refuses each, once, before any workspace, and records the refusal |
| B, `core/task-flow/dispatch.ts` `toWorker` | drop the use check shared by prepare, publish and maintain | same file: the dispatcher's prepare fails the operation ...; a publication on a revision pinned before the rule applied fails the operation ... |
| C, `core/e2e/application-readiness.ts` | drop `if (barred !== undefined) throw barred;` in the selection reader | same file: the application readiness reader reads the pinned revision (and is refused only by a rule kept at use) |
| D, `core/task-flow/project-source.ts` `latest()` | a catalogue pointer whose revision does not read returns undefined instead of refusing | same file: task start: the catalogue names a revision that does not read ... never runs revision 1 |
| E, `aws/company-revision-row.ts` | the named revision that does not read is absent instead of refused | same file: the dispatcher's company read: the catalogue's revision is THE revision ... |
| F, `contracts/src/project-node.ts` `projectUseProblems` | drop the command env rule | same file: each kept rule ...; the application readiness reader ... |
| G, `contracts/src/project-registries.ts` | the stored read keeps generic registry entries (identity preprocess) | same file: reads in every shape a released version wrote ...; drops the generic entries and keeps the CodeArtifact one ... |
| H, `aws/core-code-host.ts` | one unreadable project fails the whole company's repository list | tests/unit/core-code-host.test.ts: one project whose current revision cannot be read names no repository and is logged ... |
| I, `aws/github-lifecycle.ts` | the unreadable revision is no longer counted as using the installation | tests/contract/github-lifecycle-routes.test.ts: an unreadable project counts as using it ... |
| J, `aws/developer-routes.ts` `namedCompanyDefinition` | the project list fails on one unreadable project | tests/contract/company-layout-revisions.test.ts: the latest revision in the core's order ...; one project whose current revision cannot be read marks nothing ... |
| K, `aws/client-project-create.ts` | the repository picker fails on one unreadable project | same file: one project whose current revision cannot be read marks nothing and is logged ... |
| L, `aws/company-member-handover.ts` | one unreadable project blocks the leaver's hand-over | tests/contract/company-member-handover.test.ts: a project whose current revision cannot be read ... does not block the hand-over ... |
| M, `local/registered-repositories.ts` | one unreadable project fails the laptop's repository list (skip and log removed) | tests/unit/registry-tolerant-read.test.ts: the laptop's registered repositories leave one unreadable project out ... |

Runner and exact output are in the builder's scratchpad (`rtr-mut/run.py`, `results.json`, `results-FG.json`), not in the repository. All twelve restored: `git diff` shows only the lane's delta.
## G1 CORE-RUN-STOP-RELAY (2026-11-25, rebased onto origin/code/next d57dda450)

Money (caps). The change sets `ROVARA_CORE_OUTBOX_STREAM_RELAY=on` (packed `rl`) on the broker and the dispatcher, so the hosted admission declares `enforcesCost: true`. Evidence tree: origin/code/next d57dda450 plus this lane's one commit (its sha is the commit that carries this entry). Each mutant was applied singly to infra or contracts source, `tsc -b` then `ci-like-test.sh <worktree> tests/contract/core-engine-infrastructure.test.ts -t "outbox stream relay setting"` (pinned Node 22.23.2), then the file was restored from a byte copy. Each mutant fails the new describe twice (the named and the legacy template).

| Mutant / production location | Mutation | Failing test (new describe "the outbox stream relay setting") | Restored result |
|---|---|---|---|
| M1 packages/contracts/src/core-engine-infra.ts (CORE_JOB_SCHEDULES) | delete the `run-watch` schedule (carries `spendStopOverdue` for a silent worker) | "is declared only with the fallback and the delivery: ..." (x2) | 7 passed |
| M2 same | delete the `dispatch-sweep` schedule | same test (x2) | 7 passed |
| M3 same | delete the `outbox-relay-backstop` schedule | same test (x2) | 7 passed |
| M4 infra/lib/developer-task-notifier.ts (State stream filter) | entityType `OUTBOX` becomes `OUTBOX_X` | "is declared only with the relay it stands for: the State stream filter ..." (x2) | 7 passed |
| M5 infra/lib/developer-task-notifier.ts (RelayCoreOutboxToBroker) | action `lambda:InvokeFunction` becomes `lambda:InvokeAsync` | same test (x2) | 7 passed |
| M6 infra/lib/core-engine.ts | drop the dispatcher's `rl` setting | "is exactly `on` for the broker and the dispatcher, packed ..." (x2) | 7 passed |
| M7 infra/lib/core-engine.ts | broker's `rl` value `on` becomes `off` | same test (x2) | 7 passed |
| M8 infra/lib/core-engine.ts (DispatcherMapping) | `enabled: true` becomes `false` | "is declared only with the fallback and the delivery: ..." (x2) | 7 passed |
| M9 infra/lib/core-engine.ts (BrokerUsesCoreDispatchQueue) | remove `sqs:SendMessage` from the broker's queue actions | same test (x2) | 7 passed |

Rule D re-pins (no `-u`, no snapshot file changed): with `withoutCoreOutboxStreamRelay` taken out the pins recorded before this lane hold in core-engine-infrastructure (6694babb... and all older), legacy-templates (0289bd3b... then 169c6df1... and all older), named-templates (830e2fa7... then 74e8f0a3... and all older) and developer-signin-infrastructure (c1552880... unchanged). Cloud (the Cloud trunk 64af14112) has no packed settings table or reader and no `rl` code (Code's table is the only one; Cloud's own packed codes are live-interaction `rd`, `ak`, `fd`).
## LESSONS-READINESS: hosted lease fence and load record (money lane)

Each mutant was applied singly to the production file in the lane worktree, the three test files run, and the file restored (checked byte for byte). All 11 are killed by an assertion failure (never a collection or type error). Tests: `tests/unit/lessons/gateway-learning.test.ts`, `tests/unit/lessons/reflect-lease-lapse.test.ts`, `tests/unit/hosted-lessons-load-record.test.ts`.

| Mutant / production location | Mutation | Result with the mutant |
|---|---|---|
| M1 - lessons/gateway-learning.ts `startCall` | The lease mark (`callStarting`) is not written before the request. | 8 failed (every lapsed-lease scenario makes a second gateway call) |
| M2 - gateway-learning.ts fetch-reject path | `failedAfterSend()` replaced by a plain error (no final fault). | 2 failed |
| M3 - gateway-learning.ts 3xx path | Same, redirect. | 1 failed |
| M4 - gateway-learning.ts malformed-body path | Same, body with a non-object block. | 1 failed |
| M5 - gateway-learning.ts `refuseInstallPause` | The gateway's own refusal does not take the mark back. | 2 failed |
| M6 - gateway-learning.ts `waitFor` | The wait is not clamped to the attempt's deadline. | 1 failed |
| M7 - gateway-learning.ts `waitFor` | The attempt's abort signal is not listened to. | 1 failed |
| M8 - gateway-learning.ts `startCall` | The "cannot finish before the deadline" refusal is removed. | 1 failed |
| M9 - gateway-learning.ts `startCall` | A mark that cannot be written is not noted retryable. | 1 failed |
| M10 - lessons/load-record.ts `recordLessonLoad` | The operation reference row is not written. | 5 failed |
| M11 - lessons/load-record.ts `recordLessonLoad` | The use rows are not written. | 2 failed |

Also checked: the lease test's worker clock is passed to the gateway model (`now`). With the test clock placed before the real date, removing that option fails 5 of 6 tests, with it all pass (the same condition as a real clock moving past the fixed test epoch).


## PROJECT-GRANT-RECHECK: the stored person holds a task only with the live project grant (2026-11-25)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M1, `hostedTaskAccess.resolve` | the stored-person branches skip `inputs.projectGrant` | tests/journeys/project-grant-recheck.test.ts | red (3 of 6) |
| M2, `taskAccessOfRecord` | the legacy owner skips `holdsOwnTask` | same file (Code's task page rows) | red (1 of 6) |
| M3, `core-task-rule-routes` | events and readers: `owner = task.developerId === caller` | same file (events, readers) | red (1 of 6) |
| M4, `sessions/access.ts` | the owner of a task session needs no grant | same file (session stop, tell, close) | red (1 of 6) |
| M5, `lessons-api.ts` | the off-roster own-task exception is back | tests/unit/core-host-lessons-api.test.ts | red (1 of 57) |
| M6, `developer-tasks.ts listTasks` | the own list ignores the grant | same file as M1 (task list) | red (1 of 6) |
| M7, `script-tokens/authenticate.ts` | the token's project is not re-checked live | tests/unit/script-token-project-grant.test.ts | red (3 of 3) |

## RD-2.0-READ-RULE rebased onto PROJECT-GRANT-RECHECK (merge of 84d7b51fe)

The hotfix's live grant re-check (`hostedTaskAccess.resolve`: the stored person holds a task only while the project grant is held, as a People entry does) is the base truth for the company's own rule. The read rule takes the grant as proved for `reads` and `acts` where the rule says so (`TaskAccess.provesProjectGrant`, set by `hostedTaskAccess`) and asks its live-grant seam once for every other way in (the old page rule, the stored person on the events and the readers routes), so no person's grant is read twice. The hotfix's `holdsOwnTask` call on the events route is replaced by the same seam (one implementation); its page-rule and session-rule re-checks stay for the old page routes and sessions. Each mutant applied singly on the merge, one targeted run, restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Killed by |
|---|---|---|
| M23 read-rule.ts `grantFor` | every way in counts as grant-proved | the two starters on every read (8 tests) |
| M24 core-engine-root.ts | the hosted rule no longer says it proves the grant | the "one grant check, not two" test |

Both killed; the restored tree passes.

## RD-2.0-READ-RULE round 3 pre-review fixes (head f034f9123: the live grant in the task's company, fail closed without a seam, the table in the production configuration)

The hotfix's own mutant (the stored person on the events and the readers routes trusted) at its new place, the host not binding the live-grant seam, and the guards added in this round. Each mutant applied singly on f034f9123, one targeted run (the table in both configurations, the golden, core-host-task-web-routes), restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Killed by |
|---|---|---|
| M25 read-rule.ts `grantFor` | the stored person (`developer` basis: events, readers routes) counted as grant-proved (the hotfix's M3 at its new place) | 11 tests: the table on both configurations, the starters, the journeys' source-code and re-read tests |
| M26 dev-routes.ts `decideRead` | the host no longer binds the live-grant seam | the real-routes table (starters on events, diff, comments), the diff route test |
| M27 read-rule.ts `grantFor` | the old page rule (`page` basis: the diff, the comments) counted as grant-proved | 10 tests: the table, the starters, the diff route test |
| M28 dev-routes.ts | the seam does not pass the task's company | "the live grant is read in the TASK'S company" (a person moved to another company between two reads) |
| M29 read-rule.ts `liveGrantOf` | a missing seam on a rule that proves the grant admits | "a host that proves the grant but binds no live-grant seam admits nobody ..." |

All killed; the restored tree passes.
## PROJECT-GRANT-RECHECK, channel-access starters (2026-11-25)

All killed by tests/contract/task-owner-channel-access.test.ts (9 tests).

| Mutant | Change | Result |
| --- | --- | --- |
| C1, `taskReaderPerson` own-task answer | a person with no grant is `mayStart` with no `checkProjectAccess` call | red (6 of 9: leave, channel use off, Slack down, no Slack link, grant-removed-then-leaves, neither) |
| C2, `taskReaderPerson` own-task answer | a failed or refused start check answers `mayStart: true` (fail open) | red (6 of 9) |
| C3, `taskReaderPerson` own-task answer | the start check is asked as a fixed Slack user, not the person's own link | red (1 of 9: no Slack link) |
| C4, `holdsOwnTask` | reads `projectMember` only (the first hotfix) | red (3 of 9: the red commit) |

## RD-2.0-READ-RULE merged with the FINAL project-grant hotfix (d8c5b04a1): the channel branch routed once

The hotfix's own-task test (`holdsOwnTask`: the grant, or the access that let the person start the task, a bound-channel member where the project lets channel members use it) is the ONE test for the task's own person. The read rule's live-grant seam asks it for the stored person (`taskRules.holdsOwnTask`) and asks the project grant, in the task's company, for everyone else; the page rule's own re-check of the stored person (a task with no People list) is reported by the page seam and not read a second time. Each mutant applied singly on b3f6ce1c5, one targeted run, restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Killed by |
|---|---|---|
| M30 dev-routes.ts `liveGrantOf` | the channel branch is undone: the stored person is asked by the grant alone | "the hotfix's channel branch is kept, and read once" (a channel starter is refused on events, diff, comments) |
| M31 read-rule.ts `firstAdmission` | the page rule's own re-check of the stored person is not trusted, so the hold is read twice | the same test (the hold on their task must be read once per way in) |

Both killed; the restored tree passes.

### Correction (RD-2.0-READ-RULE, after the combined Opus review of 152cbb7db): M28 above

The row for M28 said the "moved to another company" test killed it. On 152cbb7db it did NOT: since round 5 the task's own person goes to the hotfix's own-task test (which passes the task's company itself), and that test moved only the owner, so it never reached the line M28 changes (`dev-routes.ts liveGrantOf`: `grant(person.personId, task.project, target.runtime.companyId)` for everyone who is not the task's own person). Fix: a second test moves a People COMMENTER (let in by the page rule and the read rule, asked for the grant by that line) to the other company, which holds a same-named grant, and expects TASK_NOT_FOUND on the diff, the comments, the task and the events. Run on the head after the fix: with `grant(person.personId, task.project)` (the company dropped) exactly that test goes red and the owner test stays green; restored, both pass. The M28 row stands corrected: killed by "the same for a person the grant is asked of by the PROJECT GRANT".
## RD-2.0 - contract rows for the task page reads (commit 567630b57 plus the S2/S3 follow-up)

Production guards this lane adds: the `owns()` clause and the mount hunk in `core-host/dev-routes.ts`, GET-only and the anchored path regex in `core-host/task-screen-routes.ts`, the stub's fixed `ROUTE_NOT_SERVED` refusal (`task-spec-routes.ts`, the other three stubs are the same line), the code's 404 status (`packages/code-api/src/errors.ts`), and the existing script-token line that keeps a token off the four paths. Each mutant was applied singly to the working tree, one targeted run, then the file was restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Failing test (all in tests/unit/core-host-dev-routes.test.ts, "the task page's new reads (RD-2.0)", unless noted) |
|---|---|---|
| M1 dev-routes.ts `owns()` | drop `\|\| taskScreenRoute(path, method) !== undefined` | both tests: no answer (undefined) instead of 404 / 403 |
| M2 task-screen-routes.ts `taskScreenRoute` | GET-only check removed | "serves GET only": POST/PUT answered instead of left to the old broker |
| M3 task-screen-routes.ts `PATH` | drop the `$` anchor | "serves GET only": `/specs` and `/spec/x` answered |
| M4 task-spec-routes.ts | stub resolves 200 `{}` instead of refusing | "answers ROUTE_NOT_SERVED ...": 200 instead of 404 |
| M5 code-api errors.ts | remove `ROUTE_NOT_SERVED` from the 404 group | code-api-errors "lists every code in its order", code-api-version digest, and the dev-routes test (409 instead of 404) |
| M6 dev-routes.ts script-token line | let the four paths past the token refusal | "serves GET only ... keeps a script token out": 404 instead of 403 |
| M7 dev-routes.ts `taskSurfaceAnswer` | remove the `routeTaskScreen` line | "answers ROUTE_NOT_SERVED ...": undefined instead of 404 |
| M8 task-spec-routes.ts | code `NOT_FOUND` instead of `ROUTE_NOT_SERVED` | "answers ROUTE_NOT_SERVED ...": body differs from the row's example refusal |

All 8 killed; the restored tree passes (17 files, 539 tests, `tsc -b` clean). Evidence applies to this lane's commits; the final-head gate and review belong to 9d.

## SI-1: saved images, kind and constants (branch pr/si-1-20261125)

Two mutants, applied singly to the tracked source, the touched suites run, then restored with `git checkout`. Suites: `saved-env-rebuild-constants`, `system-starter`, `saved-env-registry`, `system-owner-access`, `saved-env-images-infrastructure`, `named-templates` (after `tsc -b`).

| Mutant | Location | Mutation | Expected kill |
|---|---|---|---|
| M1 | `packages/broker/src/core/system-runs/starter.ts` `startable` | also accept `saved_env_rebuild` | `system-starter.test.ts` "refuses saved_env_rebuild before anything is read or written" |
| M2 | `packages/contracts/src/saved-env.ts` | `SAVED_ENV_KEEP = 3` | `saved-env-rebuild-constants.test.ts` (value) and the keep-two cases in `saved-env-registry.test.ts` |

Results (6 files, 153 tests green before and after): M1 killed, 1 failed (`system-starter.test.ts` refuses "saved_env_rebuild" before anything is read or written). M2 killed, 4 failed (`saved-env-rebuild-constants.test.ts` numbers; `saved-env-registry.test.ts` "keeps the newest two images", "row keeps at most two images", and the manage walk test). Both restored with `git checkout`; the tree matches the committed source.

## MAINTAIN-TOKEN-CLEANUP (a plain maintenance takes the push token only after the cleanup)

Tests: `tests/contract/worker-credential-fetch-cleanup.test.ts` and `tests/integration/pull-request-maintenance.test.ts` (37 tests together; the maintenance file is a post-deploy file, so it was run with a scratch vitest config that drops it from the exclude list). Each mutant applied to `packages/worker/src/` from a copy and restored from it (restored files compared byte-for-byte); `tsc -b` not re-run per mutant.
| Mutant / location | Mutation | Failing tests | Restored |
|---|---|---|---|
| M1, maintain-pull-request.ts, the credential fetch | `fetchContainedCredential({...})` replaced with `options.credentialProvider(repository)` (no cleanup in any maintain path) | 11 of 37: the two contract source checks, the 3 existing workflow-fix cleanup tests, the 6 new plain-maintenance tests | 37 passed |
| M2, publish.ts `fetchContainedCredential` | the `containWorkspace` call is skipped | 9 of 37 (maintenance: 3 existing + 6 new); the same mutant fails 6 of 75 in pull-request-publication.test.ts (publication's own cleanup tests) | green |
| M3, publish.ts `fetchContainedCredential` | the credential is fetched first, the cleanup runs after it (stubbed steps) | 11 of 37 (same set as M1) | 37 passed |

### MAINTAIN-TOKEN-CLEANUP, second commit: the push token is fetched after the checks

The maintain flow now reads the head and the base with a contained token that is dropped before the checks, and fetches the token that pushes (also through `fetchContainedCredential`) after the checks. Same tests plus the new order test (`runs the project's checks with no token in hand`); the maintenance file run with a scratch config that drops the post-deploy exclusion. Source restored from a copy after each mutant (compared).
| Mutant / location | Mutation | Failing tests | Restored |
|---|---|---|---|
| M4, maintain-pull-request.ts `pushCredential` | the old order: the push token is fetched once before the checks and reused (`const early = await fetchContainedCredential(...); pushCredential = async () => early`) | 2 of 40: the order test (check, cleanup, credential, push), and the "sync that leaves nothing to push asks for no push token" test | 40 passed |
| M5, maintain-pull-request.ts first fetch | the read of the head and the base takes the token from `options.credentialProvider` directly (no cleanup) | 13 of 40 (both contract source checks, the cleanup tests of a fix, a plain append and sync, the order test) | 40 passed |
M1 to M3 above still apply (the helper and its callers).

### MAINTAIN-TOKEN-CLEANUP, third commit (test only): the contract test pins every credential line

`tests/contract/worker-credential-fetch-cleanup.test.ts` now also pins, per file and in source order, every non-comment line in packages/worker/src that names `credentialProvider`, `fetchContainedCredential` or `/repository-credentials`, so any new or reshaped call fails until it is classified. Each mutant applied to the file, the contract file run, the file restored from a copy and compared with `cmp`.
| Mutant / location | Mutation (one added line) | Failing tests (of 5) | Restored |
|---|---|---|---|
| B1, publish.ts, after `fetchCredential` | `const early = await options.credentialProvider(repository);` | 2: the new pin test and the old call list | 5 passed |
| B1b, publish.ts | `const early = await options.credentialProvider(registered);` (another argument name: the Opus bypass) | 1: the new pin test (the old list test missed it) | 5 passed |
| B2, maintain-pull-request.ts, before `pushCredential` | `const early = await options["credentialProvider"](repository);` (bracket access) | 1: the new pin test | 5 passed |

### MAINTAIN-TOKEN-CLEANUP, fourth commit (test only): the pinned-line regex also catches the provider's name and factory

The pinned-line regex of `tests/contract/worker-credential-fetch-cleanup.test.ts` now also matches `\b(create)?RepositoryCredentialProvider\b`, so a new file that builds a second provider through the `./index.js` export is listed. Each mutant is one new file under packages/worker/src, removed afterwards (`git status` clean of it).
| Mutant | Mutation | Failing tests (of 5) | Removed |
|---|---|---|---|
| C1 | new file `zz-second-provider.ts`: `import { createRepositoryCredentialProvider } from "./index.js"; export const second = createRepositoryCredentialProvider;` | 1: the pin test (the pre-widening test stayed green on this shape) | 5 passed |
| C2 | new file `zz-second-type.ts`: `RepositoryCredentialProvider` imported from `./index.js` and re-exported as a type | 1: the pin test | 5 passed |

## D1-1-CORE-SAYS-MISSING-TASK (M1 to M3 on code head 9d7662435, M4 on the pre-review commit after it; on origin/code/next 800b647ed)

Tests: `tests/unit/core-task-route-answer.test.ts` and `tests/contract/d1-1-task-route-answers.test.ts` (the exact-answer table, golden recorded on the pre-D1-1 base, and the "told what a missing id is told" cases), run together after each mutant of `packages/broker/src/core-host/task-route-answer.ts` (M1 to M3) or `packages/broker/src/core-host/dev-routes.ts` (M4), each restored from a copy.

| Mutant | Result |
| --- | --- |
| M1 the core's 404 is passed through instead of becoming the missing-task answer | killed (2 tests: the answer table and the 404/401 case) |
| M2 the missing-task sentence gains a trailing full stop | killed (5 tests: the table, the words, the mapping, the not-served rule, the Cloud sentence check) |
| M3 a route the core does not serve says "not on the core yet" to everyone, readers or not | killed (2 tests: the answer table and the not-served rule) |
| M4 the script-token refusal of `GET /v1/dev/tasks/<id>/evidence` goes back before the task lookup (the pre-review M1 leak) | killed (2 tests: the answer table row and the "stranger script token" equality case) |

# WORKER-DELIVERY-IDENTITY steps 0 and (b-plus) — mutant evidence

Each mutant was applied singly to the production file in the lane worktree, the named tests were run, and the file was restored from a copy (restored files re-run green in the final focused run). Only assertion failures count as kills.

| Mutant / production location | Mutation | Failing tests | Result |
|---|---|---|---|
| M1 packages/broker/src/aws/ec2-delivery.ts (the check before the POST) | The `verifyMachine` condition made constant false, so the POST always goes out | tests/contract/worker-delivery-identity.test.ts | 12 of 12 failed (POST made, row not lost, operation not failed) |
| M2 packages/worker/src/invoke-auth.ts (expiry before workspace, REDACT review F4) | Expiry check moved back after the workspace and generation checks | tests/contract/worker-invoke-auth.test.ts | 2 failed (expired token for another workspace / generation answers wrong_workspace / wrong_generation) |
| M3 packages/broker/src/aws/machine-check.ts `machineMismatch` | The workspace tag comparison removed | tests/unit/machine-check.test.ts, tests/contract/worker-delivery-identity.test.ts | 5 failed |
| M4 packages/broker/src/aws/session-reconciler.ts (step 0 i) | The same-run `markLostNow` after terminating an unresponsive worker removed | tests/contract/session-reconciler.test.ts | 1 failed (row still READY, operation still running after the terminating run) |
| M5 packages/broker/src/aws/instance-state-change.ts | `running` added to the ending states | tests/unit/instance-state-change.test.ts | 2 failed |

## WORKER-DELIVERY-IDENTITY — second mutant round (Sonnet pre-review S3), base 1f2303930 plus the S1/S4/S6 delta in the commit that adds this entry

Each mutant applied singly to the production file in the lane worktree, run against tests/unit/machine-check.test.ts, tests/contract/worker-delivery-identity.test.ts, tests/unit/worker-delivery-identity-machines.test.ts and tests/unit/instance-state-change.test.ts (53 tests green unmutated), then restored from a copy. Only assertion failures count as kills.

| Mutant / production location | Mutation | Result |
|---|---|---|
| packages/broker/src/aws/worker-machines/session-worker-machines.ts `health` | The machine check before the ping removed | killed, 3 failed |
| same file, `deliver` | The machine check before the POST removed | killed, 3 failed |
| packages/broker/src/aws/machine-check.ts `machineMismatch` | `address_changed` branch removed | killed, 3 failed |
| same | `not_running` branch removed | killed, 13 failed |
| same, `ask` | The Describe-error branch returns "no such machine" (gone) instead of the retryable refusal | killed, 2 failed |
| packages/broker/src/aws/ec2-delivery.ts | `failOperation` call removed from the gone branch | killed, 7 failed |
| packages/broker/src/aws/instance-state-change.ts | `source !== "aws.ec2"` check removed | killed, 1 failed |
| same | instance id shape check removed | killed, 1 failed |
| packages/broker/src/aws/sessions.ts `findReadyByInstance` | Filter AND id match both removed (first READY row returned) | killed, 7 failed |
| same | Only the id match removed, or only the filter removed | survive by design: each is a second guard for the other (equivalent mutants); the new "finds the one READY session among many" and full-envelope tests kill the two-together mutant above |

New tests in this round: createEc2MachineReader through a real EC2Client over EC2's XML wire format (running, terminated with no address, InvalidInstanceID.NotFound, throttle/malformed/unauthorized as failures to ask, request filters), the FULL EventBridge state-change envelope, and the dispatcher wiring refusing an unset State table.

## WORKER-DELIVERY-IDENTITY — third round (Opus review S1)

In packages/broker/src/aws/machine-check-aws.ts `failOperation`, the `failActiveOperation` call for a cancel was made constant-false and tests/unit/machine-check.test.ts run: the cancel case failed (the targeted task stayed CANCEL_REQUESTED, the workspace stayed BUSY). Restored from a copy; green again.

## WORKER-DELIVERY-IDENTITY — WDI-SETUP (project setup runs under the machine check)

Each mutant applied singly, tests/unit/machine-check.test.ts, tests/contract/worker-delivery-identity.test.ts and tests/contract/project-setup-session.test.ts run, restored from a copy.

| Mutant / production location | Mutation | Result |
|---|---|---|
| machine-check.ts `expectedWorkspaceTag` | The setup runtime must carry the workspace's tag (instead of none) | killed, 2 failed |
| machine-check.ts the grace branch for a setup row with no instance id | Removed (such a row is refused) | killed, 2 failed |
| machine-check.ts `markRowLost` | A gone setup machine's session is never marked | killed, 5 failed |
| machine-check-aws.ts `failOperation` | The setup branch removed (the run is not ended) | killed, 1 failed (first run survived because the delivery test injected the function; a test through `dispatcherMachineChecks` was added) |
| sessions.ts `ProjectSetupSessionManager.ensureSession` | The session's instance not passed to the delivery | killed, 8 failed |

## WORKER-DELIVERY-IDENTITY — WDI-SETUP follow-up (instance id passed by the tooling, grace end date, reserved-word fix)

Each mutant applied singly to the production file, tests/unit/machine-check.test.ts, runtime-installation-registrar.test.ts, runtime-installation-cli.test.ts and dynamo-expressions-reserved-words.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| runtime-installation.ts `requireIssuedInstance` | A registration with no instance id accepted | killed, 1 failed |
| runtime-installation.ts `issueRuntimeInstallChallenge` | A standard-profile challenge without an instance accepted | killed, 1 failed |
| machine-check.ts the setup grace branch | The grace end date removed (grace never ends) | killed, 1 failed |
| packages/cli/src/admin/runtime-installation.ts | The CLI sends a standard-profile challenge without an instance id | killed, 1 failed |
| dispatcher.ts project setup `markFailed` | The `#error` alias put back to the unaliased `error` | killed, 2 failed |

## WORKER-DELIVERY-IDENTITY — leftovers after the Opus delta (S5/S1 guard, S6 subnet)

Each mutant applied singly, tests/unit/machine-check.test.ts, tests/contract/worker-delivery-identity.test.ts and tests/unit/worker-delivery-identity-machines.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| machine-check.ts `machineMismatch` | The subnet comparison removed (an instance of the right id and address in another VPC passes) | killed, 3 failed |
| machine-check-aws.ts `failOperation` | A cancel fails the active operation even when this call did not move the row | killed, 1 failed |
| same | A cancel fails the active operation even when it is not the cancel's target | killed, 1 failed |
| ec2-delivery.ts `machineToCheck` | A setup run held to the wrong subnets | killed, 2 failed |

## SI-LEASE-HANDOFF (the dispatcher hands a rebuild its lease token), code head e36884e49

Each mutant applied singly to the production file; tests/unit/saved-env-dispatch-lease.test.ts, aws-core-dispatch-host.test.ts, saved-env-rebuild.test.ts and saved-env-registry.test.ts run (103 tests), restored with git checkout.

| Mutant / production location | Mutation | Result |
|---|---|---|
| dispatch.ts `savedEnvBuildWithLease` | The token is dropped from the invocation | killed, 4 failed |
| same | A token stored in the payload wins over the registry's | killed, 1 failed |
| same | The token is written to a log line | killed, 1 failed |
| same | The job id asked for is the operation's id (not the stored job's) | killed, 5 failed |
| same | The project asked for is empty | killed, 5 failed |
| same | The operation asked for is the workspace's id | killed, 3 failed |
| same | The worker-feature check removed (the token is taken for a worker that cannot build) | killed, 1 failed |
| same | No seam wired: the build is sent without a token | killed, 1 failed |
| same | A refused lease: the build is sent without a token | killed, 5 failed |
| same | A lost write race is not retried (1 try) | killed, 1 failed |
| same | After the tries the build is sent without a token | killed, 1 failed |
| dispatch.ts prepare branch | Every preparation asks for a lease, not only a rebuild's | killed, 1 failed |
| saved-env.ts `leaseForDispatch` | The named job id is not compared (another job is marked taken) | killed, 2 failed |
| same | An expired lease is still handed over | killed, 2 failed |
| saved-env-dispatch-lease.ts `savedEnvDispatchLeaseOf` | The company asked for is the implicit one, not the seam's | killed, 1 failed |
| `savedEnvDispatchLeaseFor` | A seam is made with the switch off | killed, 2 failed |
| `savedEnvDispatchLeaseOf` | An empty operation id accepted | first survived (the test's earlier call had already taken the token); killed, 1 failed, by the added test |
| same | The result carries the whole job, not the token | killed, 3 failed |
| same | The job-id belt on the registry's answer removed | equivalent (`leaseForDispatch` already answers only for the named job); kept as a belt |
| dispatcher-core.ts | The dispatcher does not wire the seam | killed, 1 failed |

SI-LEASE-HANDOFF re-run: the lease step moved out of dispatch.ts into task-flow/saved-env-lease-step.ts (complexity ratchet), called from `preparedProject`. All 20 mutants above re-applied on code head 7c3ed5b68 (the dispatch.ts rows now apply to saved-env-lease-step.ts; "every preparation asks" removes the `savedEnvBuild === undefined` guard): 19 killed, only the job-id belt (equivalent) survives.

## SI-LEASE-HANDOFF, pre-review round (M1, S1-S3), code head 17fb72182

Each mutant applied singly; tests/unit/saved-env-dispatch-lease.test.ts, aws-core-dispatch-host, saved-env-rebuild, saved-env-registry and saved-env-ending run (114-116 tests), restored with git checkout.

| Mutant / production location | Mutation | Result |
|---|---|---|
| saved-env-lease-step.ts `savedEnvBuildFields` | The stored job-id guard removed | first survived (the check before the start refuses first); killed by the added direct tests of the step |
| `beforeMachine` | The check before the start never runs | killed, 7 failed |
| `savedEnvPrecheck` | A refusal is ignored | killed, 4 failed |
| same | A registry that cannot be read ends the operation (not a retry) | killed, 1 failed |
| same | No seam lets it through | killed, 1 failed |
| `savedEnvBuildFields` | A fault after the claim ends the operation | killed, 1 failed |
| same | An exhausted lost race ends the operation | killed, 1 failed |
| same | The pause between tries removed | first survived (timing); killed by the added pacing test |
| saved-env-dispatch-lease.ts `check` | The check takes (marks the job taken) | killed, 3 failed |
| saved-env.ts `leasableJob` | A job given to another operation is given again | killed, 6 failed |
| same | The named job id is not compared | killed, 3 failed |
| same | The run-time id guard removed | killed, 1 failed |
| saved-env-dispatch-lease.ts `wellFormed` | The id guard removed there only | killed, 1 failed (the project id is only guarded here) |
| both guards | Removed at once | killed, 3 failed |

SI-LEASE-HANDOFF Opus leftovers (N1): `beforeMachine` call in dispatch.ts, "the retry before the start is capped like the standing-instruction read": the cap replaced by `true` (retried without end) is killed by the added test (1 failed).

## CANARY-SESSION: the beta canary person's session function (2026-11-25)

Measured on lane commit 8d4eb149b (pr/canary-session-20261125 on code/next 97fdae1c0; the lane was then rebased onto 7f0c40e6f and squashed, so the same code is now 4c7344d65). Each mutant was applied alone to the file named, then `tests/contract/canary-session.test.ts` and `tests/contract/canary-session-infrastructure.test.ts` were run together (81 tests), then the file was restored with `git checkout`. The session start the function shares with the sign-in server (session-mint.ts) is proven unchanged for real sign-ins by tests/contract/company-signin-goldens.test.ts (unchanged, green).

| Mutant / location | Mutation | Failing tests (of 81) | Restored |
|---|---|---|---|
| M1, developer/canary-session.ts `CanaryRequest` | the request schema is loose (a subject, company, amr or lifetime in the request is accepted) | 10 | green |
| M2, `canarySessionConfigFromEnvironment` | the pinned-issuer check is dropped | 2 | green |
| M3, `checkPerson` | a company with two plain members still mints | 1 | green |
| M4, `mint` | the answer carries a refresh token | 4 | green |
| M5, `mint` | the session row is marked administrator | 1 | green |
| M6, `mint` | the rate counter is not consulted | 1 | green |
| M7, `mint` | the session lives 7 days instead of 30 minutes | 3 | green |
| M8, `checkPerson` | the member-role check is dropped (an admin may be minted) | 1 | green |
| M9, `checkPerson` | the GitHub-provider check on the person's row is dropped | 1 | green |
| M10, `checkPerson` | the shared-method check (a company with its own sign-in) is dropped | 1 | green |
| M11, `mint` | a row written whose token failed is not revoked | 2 | green |
| M12, `end` | canary-end revokes nothing | 4 | green |
| M13, `mint` | the access token is added to the audit log line | 2 | green |
| M14, `checkPerson` | the company record is not checked | 2 | green |
| M15, `CanaryMintStore.recorded` | an unreadable counter item is read as empty (silent fallback) | 1 | green |
| I1, infra/lib/canary-session.ts | a second principal gets an invoke permission | 3 | green |
| I2, infra/lib/canary-session.ts | the function's resources lose the condition | 3 | green |
| I3, infra/lib/canary-session.ts | `staging` is added to the environment's allowed values | 2 | green |
| I4, infra/lib/canary-session.ts | the template rule's assertion can never fail | 1 | green |
| I5, infra/lib/canary-session.ts | the role may read any person's row (`DEVELOPER#*`) | 2 | green |
| I6, infra/lib/canary-session.ts | the role may also read a secret | 1 | green |
| I7, infra/lib/developer-signin.ts | the token key's deny never names the canary role | 1 | green |

No mutant survived.

Note (CANARY-SESSION, same day): after the measurement the lane was squashed into 4c7344d65, with one change to measured code: developer/session-mint.ts `companyMayMint` is split into three small functions (the complexity limit). M10 (the shared-method check) was re-run on the split code: killed (1 test). The other results stand for developer/canary-session.ts, infra/lib/canary-session.ts and infra/lib/developer-signin.ts, which did not change in behaviour.

## CANARY-SESSION, arch ruling and Sonnet pre-review round (2026-11-25)

Measured on the working tree that was committed as the commit adding this section (parent beb7c52bf; every file but MUTANTS.md is identical to the commit), each mutant applied alone and restored from the file's own text, then `tests/contract/canary-session.test.ts`, `canary-session-infrastructure.test.ts` and `canary-session-production.test.ts` run together (94 tests). The contracts mutants (P1, P2) rebuilt `tsc -b` before the run and after the restore. This replaces the earlier 22-row table for the same code (the parameters were renamed and cut from five to four; every earlier row is re-run below under its new anchor).

| Mutant / location | Mutation | Failing tests (of 94) | Restored |
|---|---|---|---|
| M1, developer/canary-session.ts `CanaryRequest` | loose request schema (subject, company, amr or lifetime accepted) | 10 | green |
| M2, `canarySessionConfigFromEnvironment` | the issuer consistency check is dropped | 2 | green |
| M3, `checkPerson` | two plain members still mint | 1 | green |
| M4, `mint` | the answer carries a refresh token | 4 | green |
| M5, `mint` | the row is marked administrator | 1 | green |
| M6, `mint` | the rate counter is skipped | 1 | green |
| M7, `mint` | the session lives 7 days | 3 | green |
| M8, `checkPerson` | the member-role check is dropped | 1 | green |
| M9, `checkPerson` | the GitHub-provider check is dropped | 1 | green |
| M10, `checkPerson` | the shared-method check is dropped | 1 | green |
| M11, `mint` | a failed token leaves the row live | 2 | green |
| M12, `end` | canary-end revokes nothing | 5 | green |
| M13, `mint` | the access token is added to the log line | 2 | green |
| M14, `checkPerson` | the company record is not checked | 2 | green |
| M15, `CanaryMintStore.recorded` | an unreadable counter item is read as empty | 1 | green |
| M16 (pre-review S5), config | the handler's `CANARY_ENVIRONMENT !== "beta"` clause is dropped | 4 | green |
| M17 (S5), `checkPerson` | a roster with more members than one page is accepted | 1 (first run: SURVIVED, because the test's roster was empty and refused for that reason; the test now shows exactly the canary person with more following, then killed) | green |
| M18 (S5), `recorded` | canary-end skips the previous hour | 1 | green |
| M19 (S4), `clear` | the clear is unconditional (a record made meanwhile is lost) | 6 | green |
| M20 (S4), `end` | canary-end gives up after one pass | 1 | green |
| I1, infra/lib/canary-session.ts | a second principal may invoke | 3 | green |
| I2 | the function's resources lose the condition | 5 | green |
| I4 | the template rule can never fail | 1 | green |
| I5 | the role may read any person row | 2 | green |
| I6 | the role also reads a secret | 1 | green |
| I7, infra/lib/developer-signin.ts | the token key deny never names the canary role | 2 | green |
| I8 (S5), `leading()` | the `Null` guard on the leading-keys condition is dropped | 1 | green |
| I9 | the mint alarm threshold is 70 | 1 | green |
| I10 | an alarm does not tell the alerts topic | 1 | green |
| I11 | the mint log event name does not match the log line | 1 | green |
| P1, contracts canary-session-placement.ts | the environment pattern also allows `staging` | 3 | green |
| P2 | the step role pattern allows any role name (S1) | 1 | green |
| R1, scripts/release-production.ts `assertNoCanaryPlacement` | the beta exemption applies to every profile | 1 | green |
| R2 | a release naming CanarySession parameters is allowed | 1 | green |
| R3 | only the environment parameter is looked at on the live stack | 1 | green |
| R4 | the check is not called | 1 | green |
| R5 | the check runs after the repository is created | 1 | green |

No mutant survives in the final tree. Not mutated, with the reason: "canary-end revokes every session of the person instead of the recorded ones" (S5): the store has no call that lists a person's sessions, so that mutant cannot be written without new store code; the test "touches no other session of the person" stands.

## CANARY-SESSION, Opus review round (2026-11-25): account-based release exemption, step role as a name

Measured on the working tree committed as the commit adding this section (parent 3fbe5988a; every file but MUTANTS.md is identical to the commit), each mutant applied alone and restored from the file's own text, then the three canary test files (95 tests). This supersedes rows R1 to R5 of the previous section for the release check: the exemption no longer reads a profile name.

| Mutant / location | Mutation | Failing tests (of 95) | Restored |
|---|---|---|---|
| A1, scripts/release-production.ts `assertNoCanaryPlacement` | every account is exempt | 1 | green |
| A2 | an unknown beta account (variable absent) counts as beta | 1 | green |
| A3, `betaAccountFromEnvironment` | the beta account is any 12 digits in the variable text (no ARN shape) | 1 | green |
| A4, the call site | the caller identity's account is replaced by the beta account (compared with itself) | 1 | green |
| N1, contracts canary-session-placement.ts | the step role parameter also accepts an ARN of any account | 1 | green |
| N2, infra/lib/canary-session.ts | the permission's principal is the typed value as is, not the ARN built with this stack's own account | 1 | green |

No mutant survives.
## SI-2 — the saved-image rebuild as a system run (tests/unit/saved-env-run.test.ts, system-starter.test.ts, setup-check-watch.test.ts)

Each mutant applied singly to the code of 138b4422f (tests of 289e8a97d), the three files run, restored with git checkout. M9 is equivalent (see the row); M10 and M25 first survived and are killed by the tests added in 289e8a97d.

| Mutant / production location | Mutation | Result |
|---|---|---|
| starter.ts step 3 | The upkeep switch read for every kind but `setup_check` (a rebuild reads it) | killed |
| starter.ts `startable` | `saved_env_rebuild` startable with no rebuild start | killed |
| starter.ts step 3b | The rebuild's reads before the cap and the audit removed | killed |
| starter.ts step 4 | The cap refusal skipped for the rebuild | killed |
| starter.ts step 6 | The place not given back when the audit cannot be written | killed |
| starter.ts step 7 | `not_started` audit record and place give-back removed for a rebuild that had nothing to start | killed |
| saved-env-run.ts start transaction | The start record put without `when.absent()` | killed |
| same | The check on the registry row reduced to the job id (no version) | killed |
| same | The check on the registry row without the job id | survived: equivalent (a job change always changes `version`) |
| same | The watch without its own limit (50 minutes) | killed |
| same | The close record without `purpose` | killed |
| same | The run owned by a person | killed |
| same | The project index attributes written on the workspace | killed |
| same | A start record naming another company taken as a repeat / as no start | killed (2) |
| same | A failed row check not answered `nothing_queued` | killed |
| same | No second try after a lost slot race | killed |
| saved-env-slots.ts claim | The claim condition reduced to `absent`, or to "lease before year 9999" | killed (2) |
| saved-env-slots.ts `freeFor` | Another job's slot read as free; an unreadable lease read as free | killed (2) |
| saved-env-slots.ts `releaseSlots` | Delete without the job id and company | killed |
| saved-env-rebuild.ts `readRebuildFacts` | The approved-environment check removed; the "not yet handed to a worker" check removed; the commit count check removed | killed (3) |
| check.ts `closeSetupCheck` | The purpose guard removed (a rebuild's close resumes tasks) | killed |
| usage.ts `maxMinutesMsOf` | The two-hour cap for every kind | killed |

## SI-2 — re-run on the head after the split and the pre-review fixes (code of 7950013dc, tests of 9101cb647)

The earlier SI-2 table above was run on 138b4422f, before the starter and rebuild-run split. These 44 mutants were applied singly to 7950013dc and run against tests/unit/saved-env-run.test.ts and tests/unit/system-starter.test.ts, each file restored with git checkout. 42 killed, 1 equivalent, and the one other survivor (B1) killed by the test added in 9101cb647 (re-run: killed).

| Mutant / production location | Mutation | Result |
|---|---|---|
| starter.ts step 3 | upkeep switch read for every kind but `setup_check` | killed |
| starter.ts `startable` | rebuild startable with no rebuild start | killed |
| starter.ts step 3b | the rebuild's reads removed | killed |
| starter.ts step 4 | the cap refusal skipped for the rebuild | killed |
| starter.ts step 6 | place not given back when the audit cannot be written | killed |
| starter.ts `runAs` | place not given back on a start that did not happen | killed |
| starter.ts step 4 (M1 of the review) | the place written under job `nightly` | killed |
| starter.ts `giveBack` (S3b) | a repeat's failure gives back the counted place | killed |
| starter.ts `precheckOf` (S7c) | the reads' throw not caught | killed |
| saved-env-run.ts start record | put without `when.absent()` | survived, then killed by 9101cb647 (a record that lands between the reads and the write) |
| saved-env-run.ts row check | version dropped / job id and dispatched check dropped | killed / survived: equivalent (a job handed on always commits version + 1) |
| same | watch limit dropped; `purpose` dropped; job id dropped from the close record (S2); run owned by a person; project index attributes written | killed (5) |
| same | start record of another company taken as a repeat; request id not compared; `already_started` answered as busy | killed (3) |
| same | the failed row check answered `nothing_queued` at once (S1); no second try | killed (2) |
| same | expiry removed from the start record (M2), the workspace, the pointer, the operation (S6) | killed (4) |
| same | lease not required to cover the watch (S7a) | killed |
| same | older marker not put (S7b), not read in the reads (S7b, killed by 9101cb647) | killed (2) |
| same | repeat after a lost start-record race answered `already_started` (S3a); the reads' "project's check running" removed (S4); "other" start in the reads ignored | killed (3) |
| saved-env-slots.ts | claim reduced to `absent`, or to lease before year 9999; another job's slot free; unreadable lease free; delete without job id and company; expiry removed from slot rows (M2) | killed (6) |
| check.ts `closeSetupCheck` | purpose guard removed; slots not released on close (S2) | killed (2) |
| usage.ts | the two-hour cap for every kind | killed |
| saved-env-rebuild.ts `readRebuildFacts` | commit count; approved check; "not handed to a worker" check removed | killed (3) |
## RF-5-BEDROCK-ROUTE-A (lane commit 848b016b1, stacked on OE-c1 ee74af1b8)

Tests: `tests/unit/worker-eval-bedrock-route.test.ts`, `tests/unit/worker-eval-fresh-sandbox.test.ts` and `tests/unit/product-bedrock-bridge.test.ts`, run together (90 tests) after each mutant of the named source file. M8 was run after rebuilding `packages/contracts` (the tests read its `dist`).

| Mutant | Result |
| --- | --- |
| M1 `eval-gateway-access.ts`: a Bedrock path is no longer routed to the Bedrock lane (it falls to the Gemini route) | killed (17 tests) |
| M2 `eval-gateway-access.ts`: Bedrock calls are no longer taken one at a time | killed (1 test) |
| M3 `eval-gateway-access.ts`: the Bedrock lane skips the released / stopped / held-count-used guard | killed (2 tests) |
| M4 `eval-gateway-access.ts`: a Bedrock call stopped before its settle no longer leaves the cost unknown | killed (1 test) |
| M5 `eval-wiring.ts`: the Bedrock model pin does not accept the SDK's `%3A` | killed (3 tests) |
| M6 `eval-wiring.ts`: the Bedrock model pin loses its end anchor (a longer path matches) | killed (1 test) |
| M7 `eval-cost.ts`: the approval sentence ignores the Bedrock row (no "counted by the company's gateway cap") | killed (1 test) |
| M8 `eval-discovery-report.ts`: the Bedrock row accepts any model name | killed (2 tests) |
| M9 `model-sandbox-env.ts`: the bridge token segment and row id are not checked | killed (2 tests) |
| M10 `eval-bridged-exec.ts`: the bridge reads a Bedrock row as a Gemini row (wrong error shape) | killed (1 test) |
| M11 `eval-bridged-exec.ts`: the helper's row for Bedrock loses `routesTo` | killed (1 test) |
| M12 `eval-bridged-exec.ts`: the sandbox environment has no Bedrock branch | killed (2 tests) |
| M13 `eval-gateway-access.ts`: a Bedrock frame under a foreign scope is taken by the Bedrock lane | killed (1 test) |

## SESSION-HARDEN — browser sessions never refresh; sign-in session ids are logged as a short hash

Each mutant applied singly to the production file, tests/contract/developer-identity-server.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| developer/store.ts `refreshableBy` (called by `refreshTokenGrant`) | The `reviewExpiresAt` refusal removed (a browser session refreshes) | killed, 1 failed |
| same | The refusal limited to a GitHub session (earlier form, in server.ts) | killed, 1 failed |
| developer/server.ts `revoke` | `signin.session_revoked` logs the raw session id | killed, 1 failed |
| developer/server.ts `refreshTokenGrant` | `signin.refresh_grace` logs the raw session id | killed, 1 failed |
| developer/server.ts `authorizationCodeGrant` | `signin.session_started` logs the raw session id | killed, 1 failed |
| developer/session-log-id.ts `sessionLogId` | The hash is the full 64 hex instead of 12 | killed, 1 failed |

## SESSION-HARDEN round 2 — canary logs a session hash; a browser sign-in writes no refresh-token row; a refused browser refresh is logged

Each mutant applied singly to the production file, tests/contract/developer-identity-server.test.ts, developer-signin-store.test.ts and canary-session.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| developer/server.ts browser return | The browser sign-in calls `createSession` again (a refresh-token row is written) | killed, 1 failed |
| developer/server.ts `refreshRefused` | The fixed `signin.browser_refresh_refused` line removed | killed, 1 failed |
| same | The line also carries the raw session id | killed, 1 failed |
| developer/canary-session.ts | `signin.canary_session` logs the raw session id | killed, 1 failed |
| release-pipeline.ts CLOUD_PROD_DEFAULT (tag-trigger) | The variable's default turned back to `on` | killed, 1 failed |
| release-pipeline.ts CLOUD_REF default (tag-trigger) | The variable's default turned back to `latest` | killed, 1 failed |
| release-pipeline.ts Production stage (tag-trigger) | The transition into Production left enabled | killed, 1 failed |
| release-pipeline.ts CLOUD_SOURCE_COMMIT (tag-trigger) | Beta's Cloud Preflight commit variable not bound to the Cloud source's CommitId | killed, 1 failed |

## PROD-APPROVAL-BOUND — the Production stage opens with a manual approval per run (DEC 254zzz506)

Each mutant applied singly to infra/lib/release-pipeline.ts, release-pipeline-prod-approval.test.ts and release-pipeline-tag-trigger.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| release-pipeline.ts Production stage actions | The approval action left out of the stage | killed, 6 failed |
| release-pipeline.ts Production stage | The transition into Production left enabled | killed, 2 failed |
| release-pipeline.ts approvalText | The approval text without the pipeline execution id | killed, 1 failed |
| release-pipeline.ts Production Code Preflight policy | `codepipeline:PutApprovalResult` added beside DisableStageTransition | killed, 2 failed |
| release-pipeline.ts productionApproval | The 24-hour timeout dropped (the 7-day default) | killed, 1 failed |
| release-pipeline.ts productionApproval | The approval at run order 2 (beside the Code Preflight, not before it) | killed, 2 failed |

## PROD-APPROVAL-BOUND, Opus leftovers — the gate closes before the approval; the approval text says what the Cloud commit is

The approval moved from run order 1 to run order 2, after the read-only Code Preflight that closes the transition (the earlier section's "approval at run order 2" mutant is now the design, so it is replaced by the ones below). Each mutant applied singly to infra/lib/release-pipeline.ts, release-pipeline-prod-approval.test.ts and release-pipeline-tag-trigger.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| release-pipeline.ts productionApproval | The approval at run order 1 (beside the Code Preflight, before the gate closes) | killed, 3 failed |
| release-pipeline.ts productionApproval | The approval at run order 4 (a Cloud action before it) | killed, 2 failed |
| release-pipeline.ts approvalText | The old wording back ("the commit Beta resolved its Cloud ref from") | killed, 1 failed |
| release-pipeline.ts Production Code Preflight policy | `ssm:PutParameter` added (a writer before the approval) | killed, 1 failed |
| release-pipeline.ts Production stage actions | The approval placed first, ahead of the Code Preflight | killed, 2 failed |

## PROD-APPROVAL-BOUND, read-only clone for the step before the approval

The Production Code Preflight role (it runs before the owner's approval) gets two Deny statements on UseConnection unless `ProviderPermissionsRequired` is `read_only`. Each mutant applied singly to infra/lib/release-pipeline.ts, release-pipeline-prod-approval.test.ts run, restored from a copy. All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| release-pipeline.ts preflightProject | The legacy-prefix (codestar-connections) Deny left out | killed, 1 failed |
| release-pipeline.ts preflightProject | The Deny condition value `read_write` instead of `read_only` | killed, 1 failed |
| release-pipeline.ts preflightProject | The Deny block skipped for the Production Code Preflight | killed, 1 failed |
| release-pipeline.ts preflightProject | `StringEquals` instead of `StringNotEquals` (denies the read-only use) | killed, 1 failed |

### Read-only clone, condition switched (fail-safe for availability)

The two Denies now use `StringEquals ProviderPermissionsRequired = read_write` instead of `StringNotEquals read_only` (a clone whose request lacks the key is not denied, so Production cannot break at its first action; a push request carries read_write). The four mutants above were re-run against the new form; this table replaces their results (the earlier two rows for the value and the operator describe the old form). All killed.

| Mutant / production location | Mutation | Result |
|---|---|---|
| release-pipeline.ts preflightProject | The legacy-prefix (codestar-connections) Deny left out | killed, 1 failed |
| release-pipeline.ts preflightProject | The Deny condition value `read_only` instead of `read_write` (denies the clone, allows the push) | killed, 1 failed |
| release-pipeline.ts preflightProject | The Deny block skipped for the Production Code Preflight | killed, 1 failed |
| release-pipeline.ts preflightProject | `StringNotEquals` instead of `StringEquals` (denies a request without the key) | killed, 1 failed |

## SF-1a — the "bigger than Quick" record (code of ca9450f2c; the iam and contracts rows re-run on f4f4b8a26)

46 mutants applied singly, each file restored with git checkout / the original text, run against tests/unit/quick-size-rule.test.ts and tests/unit/quick-size-record.test.ts (contracts mutants rebuild packages/contracts first, because the tests read its dist). 44 killed, 2 equivalent.

| Mutant / production location | Mutation | Result |
|---|---|---|
| quick-size.ts `many` | more than 15 counted files loosened to 15 or more | killed |
| quick-size.ts `mid_size` | more than 8 loosened to 8 or more; `&& !many` removed (listed beside many_files) | killed (2) |
| quick-size.ts class | pair needs two different medium codes loosened to one; display-only lines counted as strong | killed (2) |
| quick-size.ts pair | the Set of codes replaced by a list | equivalent: each medium code is listed once, so the list is already distinct |
| quick-size.ts `design_reading` | Skip check removed; review-off check removed; high-risk filter removed; `needed === true` removed | killed (4) |
| quick-size.ts `new_service` | kind `variable` counted as a service | killed |
| quick-size.ts unread | the early return for an unread plan removed | killed |
| quick-size.ts path codes | `data_change` and `sensitive_area` read from all named paths (tests and test data included); display lines read test files | killed (3) |
| change-tier.ts `countedFilesOf` | lock files, other prose, vendored folders, generated folders, tests counted; paths not deduplicated; fixture test removed from `isTestOrFixturePath` | killed (7) |
| change-tier.ts `countedFilesOf` | `isDocsPath` skipped no more | equivalent: every path `isDocsPath` accepts is also prose, which is skipped next |
| sensitive-paths.ts `isAccessOrMoneyPath` | document exclusion removed; `iam` kept in the name words (re-run on f4f4b8a26) | killed (2) |
| risk-tier.ts | `iam` dropped from the infrastructure part; the build part dropped from the `isInfraPath` union | killed (2) |
| quick-size-record.ts `quickPlanAtGate` | Quick-only check removed; the stage check removed | killed (2) |
| quick-size-record.ts `quickSizeOps` | the setting asked for every plan; a failed read counted as "can run"; a missing seam counted as "can run"; digest bound wrong; a fault thrown into the plan write | killed (5) |
| stage-machine.ts plan write | the record dropped from the plan's commit; the record written in a second write after the commit | killed (2) |
| design-review/steps.ts `reviewCanRun` | mode `never` read as can run; the stage switch not read | killed (2) |
| contracts quick-size.ts (re-run on f4f4b8a26) | unknown class accepted; plan digest not required; `triggered` not tied to the class; unknown codes dropped by a closed list; paths not capped | killed (5) |
| contracts task-words.ts (re-run on f4f4b8a26) | sequential replace (plan text read as a placeholder); prototype names taken as codes; non-design names reach the phrase table | killed (3) |

SF-1a, after the complexity split of `quickSizeOf` (e7b661bd9): the 13 mutants of quick-size.ts (many_files, mid_size x2, pair, display-as-strong, design_reading x4, new_service, unread, data_change, sensitive_area, display-reads-tests) were re-applied to the split code and all 13 were killed again. The "Set of codes replaced by a list" row no longer exists: the split code lists each medium code once and counts entries (`medium.length >= 2`), which the `>= 1` mutant covers.

SF-1a, after `quickSizeSentence` moved from task-words.ts (kept type-only by its test) to contracts/src/quick-size.ts: the 8 contracts mutants (reader x5, sentence filler x3) were re-applied there, each with a rebuild of packages/contracts, and all 8 were killed again.

## SF-1a — after the Sonnet pre-review fixes (code and tests of 4f8bd33c3)

The earlier SF-1a rows above were run on ca9450f2c, f4f4b8a26, e7b661bd9 and the contracts move before 05cebd961 (the head the pre-review read). These 17 mutants touch the lines the review fixes changed, applied singly to 4f8bd33c3 and run against tests/unit/quick-size-rule.test.ts and tests/unit/quick-size-record.test.ts (contracts mutants rebuild packages/contracts first). 16 killed first time, 1 survived and was killed by 4f8bd33c3's added assertion (so all 17 killed).

| Mutant / production location | Mutation | Result |
|---|---|---|
| quick-size.ts `isHostLikePath` (S1) | the address test removed; host-like paths kept in `named`; host-like text paths counted as `textOnly` | killed (2), survived then killed (1) |
| quick-size-record.ts `quickSizeOps` (S2) | no removal for a Quick plan with no gate; removal also for a Full plan; no removal after a fault; `kept` not carried (writer and builder) | killed (5) |
| contracts `readKept` (S2) | kept read without its request id | killed |
| quick-size-record.ts / quick-size.ts (S3) | a failed read recorded as off, not unseen; `settingUnread` dropped from the record; unseen also marked off | killed (3) |
| quick-size-record.ts `within` (S4) | the setting read not bounded; the stored-plan read not bounded | killed (2) |
| contracts reader / words (N3, N5) | an unread record may trigger; "0 code files" shown | killed (2) |
| quick-size.ts `mediumReasons` (N4) | a CI file counted as sign-in code | killed |
## PROJECT-GRANT-RECHECK, channel access holds an old-engine task only (arch ruling a, 2026-11-25)

Killed by tests/contract/task-owner-engine-channel.test.ts (7 tests).

| Mutant | Change | Result |
| --- | --- | --- |
| E1, `taskReaderPerson` own-task answer | the engine check is dropped (a core task is held by the channel too) | red (4 of 7: removed-but-in-channel core task, both stamp-unreadable cases, the mixed page) |
| E2, same | a stamp read that fails or cannot be read counts as an old-engine task (fail open) | red (2 of 7) |
| E3, `listsAsOwn` | a channel hold is kept for the whole project (the `held` map) | red (1 of 7: one page with an old-engine and a core task of one project) |
| E4, same check | the engine is not asked at all, channel branch always on | red (4 of 7) |

## RD-2.0-READ-RULE merged with the new hotfix (d32a69fbc) and THE SLACK SHARE decided in the read rule (head 7643579f5)

What a Slack share grants (a person with no grant, not on the People list, in the channel the task is shared into: the old page rule's implicit commenter) is decided ONLY in `read-rule.ts` `CHANNEL_SHARE_PARTS`, each read its own cell (today: the plan comments and the diff, as before the rule). The page rule says who it admitted (`viaChannelShare`), the rule exempts that person from the grant seam and never gives them source code. The old page rule's cached channel-membership branch is unreachable for those reads: the page rule seam strips the Slack identity (`core-task-rule-routes.ts pageRule`); the branch itself stays for the workflow engine's tasks and the hotfix's pinned test. Each mutant applied singly on 7643579f5, one targeted run, restored with `git checkout -- <file>`.

| Mutant / location | Mutation | Killed by |
|---|---|---|
| M32 read-rule.ts `CHANNEL_SHARE_PARTS` | the diff cell withheld | the table row "channel share member" on the function and the real routes, both configurations |
| M33 read-rule.ts `CHANNEL_SHARE_PARTS` | the comments cell withheld | the same row |
| M34 read-rule.ts `firstAdmission` | a person admitted by the Slack share counted as grant-proved (source code) | "THE SLACK SHARE ..." (no source code, no code details) |
| M35 core-task-rule-routes.ts `pageRule` | the Slack identity kept (the cached channel branch reachable) | "the old page rule's cached channel-membership branch cannot be reached ..." |
| M36 read-rule.ts `firstAdmission` | the Slack share asked for the grant (narrowed from today) | the table row, function and routes |

All killed; the restored tree passes.
| session-binding.ts (session-id-at-rest) | `sameSessionBinding` always true; `sessionBindingOf` returns the raw id | killed (2) |
| the six state-row families (slack-company-install, github-connect-routes, github-account-link-routes, linear-connections + linear-connect/account-link-routes, sign-in-links) | the row keeps the raw `caller.sessionId` in place of the digest | killed (all six) |
| same | the spend's in-code digest compare removed alone | survived: equivalent (the DynamoDB condition on the digest still refuses; the two layers are redundant by design) |
| same | the in-code compare AND the condition's digest value both neutralised (condition compares the row with itself) | killed (all six) |
| slack-company-install.ts, github-connect-routes.ts, linear-connect-routes.ts `sessionBindingOfCaller` | the empty/missing session-id guard removed | killed (2 each) |

## SESSION-PEOPLE-KEY: a task's People entry is found by the person's sign-in id in the session levels (2026-11-25)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M1, `sessions/access.ts compute` | the entry is looked up by the session's hashed id again (`person.developerId`) | tests/journeys/session-people-key.test.ts and tests/unit/session-features-access.test.ts | red (4 of 5 journeys, 7 of 18 unit) |
| M2, `peopleOfItem` | a person listed twice keeps the last entry (a later `viewer` undoes a `denied`) | tests/unit/session-features-access.test.ts | red (1 of 18) |
| M3, `compute` | a person asked about with no principal reads as "no entry" (not unreadable) | same file | red (1 of 18) |
| M4, `compute` | a `slack` entry grants with no live project role | same file | red (1 of 18) |
| M5, `compute` | a denied starter keeps `owner` | same file | red (1 of 18) |
| M6, `compute` | a denial applies only while the person still holds a grant | same file | red (1 of 18) |

Review round 1 (Opus FAIL 0d9409cc3: F1 admin on a Slack entry, F2 demoted starter):

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M7, `compute` | a starter demoted to viewer or commenter keeps `owner` (only a denial clears it) | tests/unit/session-features-access.test.ts and tests/journeys/session-people-key.test.ts (c3) | red (1 of 20 unit, 1 of 7 journeys) |
| M5b, `compute` | a denied starter keeps `owner` (now seen in the journey: a company admin starter reads `owner: false`) | same unit file and the journey (c2) | red (1 of 20 unit, 1 of 7 journeys) |
| M8, `peopleEntryOf` | an entry grants on any stored role, with no grant check (the Slack-entry and company-admin cases) | tests/unit/session-features-access.test.ts | red (2 of 20) |
## LOST-RUN-ACTUAL-SPEND (money) mutants, exact sha 700db0b7da859aec04a08997565640773742cdc9 (the same code is 33f1aeb9c after the rebase onto 77226d70d, which only reshaped the settler's loop into `settleOneRun`)

Each guard below was removed or inverted in a scratch edit (restored afterwards), and `tests/unit/lost-run-actual-spend.test.ts` + `tests/unit/core-host-money-stop.test.ts` (49 tests) were run on it:

| Mutant | Result |
|---|---|
| `settleFromGateway` adds the gateway's whole actual instead of `max(0, actual - worker booked)` (double booking) | 4 failed |
| a not-final gateway figure is booked at once (the wait for settled calls removed) | 1 failed |
| the dispatcher's `deferEstimate` guard removed (it estimates before the wait) | 1 failed |
| the two-run bound on the hold-room estimate (`hasEarlierEstimate`) removed | 3 failed |
| a worker report after a `gateway-actual` settlement is booked (the late-report guard in `usage-booking.ts` removed) | 1 failed |
| Retry's spend/cap read (`retry.ts`) removed | 1 failed |
| a partial report books a lost run (`runIsBooked`'s `usageUnflushed` branch removed) | 1 failed |
| an unreadable gateway estimates at once instead of waiting (`waitedOut ? "estimate" : "wait"` -> `"estimate"`) | 5 failed |

Not mutated: the HTTP reader's per-field refusals (each has its own `it.each` case in the reader describe), the close plan's `restMicros: 0` (pinned by the close-plan case in core-host-money-stop).

## LOST-RUN-ACTUAL-SPEND pre-review round (money), mutants on the review-fix commit (the sha in the commit named "pre-review fixes")

Each guard removed or inverted in a scratch edit (restored afterwards); `tests/unit/lost-run-actual-spend.test.ts` + `tests/unit/core-host-money-stop.test.ts` (58 tests) run on it. Every one failed at least one test:

| Mutant | Result |
|---|---|
| an incomplete gateway record is booked as the actual (`charge?.complete === true` removed) | 1 failed |
| the hold is not released after the actual is booked | 2 failed |
| worker checkpoints (`usage-checkpoint:`) not counted in what the worker booked (double booking) | 3 failed |
| owner rounds read the ledger total, not the flow's spend figure (`hostedRoundCap` wiring) | 1 failed |
| a non-final gateway figure is booked as final | 1 failed |
| a route that is not served (404/501) is an hour's wait, not the estimate at the grace | 1 failed |
| the estimate books under its own entry id (two settlers can double-book one run) | 5 failed |
| the dispatcher estimates after the wait (`deferEstimate` never estimates) | 1 failed |
| a run the gateway has not seen (`seen: false`) is read as a record | 2 failed |
| a closed task's lost run is booked as a $0 estimate, not unknown (`awaiting_usage`) | 2 failed |
| a run created before the gateway began indexing by run (`indexedSince`) is read as a final sum | 1 failed |
| a gateway answer with NO `indexedSince` is read (the required-time check in `readRunCharges` removed) | 4 failed |
## TASK-ENDED-NOTICE: the hosted task-end notice to the model gateway and its reconcile (2026-11-25)

Measured on the lane's working tree over tests/unit/task-ended-notice.test.ts (25 tests). Each mutant was applied alone, the one file run, and the file restored.

| Mutant / location | Mutation | Failing tests (of the file) | Restored |
|---|---|---|---|
| M1, core-host/task-ended-http.ts answer check | any 200 body counts as delivered (no same company and task check) | 5 of 25 | green |
| M2, task-ended-http.ts status split | a 404 (an older gateway) is retried like a 5xx | 3 of 25 | green |
| M3, task-ended-http.ts `TASK_ENDED_TRIES` | four tries instead of three | 1 of 25 | green |
| M4, core/task-flow/task-end.ts `reconcileTaskEnds` | another company's markers are sent | 1 of 25 | green |
| M5, task-end.ts `callTaskEndSeam` | a "pending" answer is recorded as delivered | 5 of 25 | green |
| M6, task-end.ts `announceTaskEnd` | waits for the host without the time bound | 1 of 25 | green |
| M7, task-end.ts `reconcileTaskEnds` | the `notifiedAt` filter is dropped | SURVIVES, on purpose not killed: a delivered marker has already left the due-time index, so the filter is a second guard on a row the index no longer lists. |
| M8, task-end.ts `reconcileTaskEnds` | no age limit | 1 of 25 | green |
## SETUP-CITATION-LINES, real line numbers in the setup agent's read tool and a re-read that finds the quote

Root cause: the setup agent's `read` tool printed file text with no line numbers (Pi `read.js` returns `truncation.content`), so the model counted lines itself and cited lines about twenty early. The worker's `read` now prints `<number><TAB><line>` (sandbox-file-tools.ts `withLineNumbers`, on for a SETUP session in pi-session.ts); the broker's re-read (proposal-verify.ts + citation-locate.ts) finds a command citation's exact quote anywhere in the file at the cited commit, nearest the cited line, shows the corrected line and records the move. Each mutant applied singly to the file named (scratch edit, restored by writing the saved source back), run against tests/unit/setup-citation-reanchor.test.ts, citation-unique-quote.test.ts, setup-proposal-verify-golden.test.ts, setup-read-numbering.test.ts, par-setup-agent-flow.test.ts and tests/integration/sandbox-file-tools.test.ts. Code sha of the mutated tree: the lane head named in briefs/arch-cleanup/SETUP-CITATION-LINES-DONE.md.

| Mutant / production location | Mutation | Result |
|---|---|---|
| proposal-verify.ts `locate` (anywhere in the file) | a quote with no place still holds | killed, 25 failed |
| citation-locate.ts `quoteOccurrences` | comment lines count as places | killed, 13 failed |
| citation-locate.ts `nearestOccurrence` | the farthest place instead of the nearest | killed, 2 failed |
| citation-locate.ts `nearestOccurrence` | a tie takes the later place | killed, 1 failed |
| citation-locate.ts `nearestOccurrence` | glued places as good as clean ones | killed, 1 failed |
| proposal-verify.ts `locate` | non-command items may be found anywhere in the file | killed, 3 failed |
| citation-locate.ts `quoteOccurrences` | case-insensitive match | killed, 2 failed |
| proposal-verify.ts `movedTo` | no move is ever reported | killed, 30 failed |
| proposal-verify.ts `verifyProposalDetailed` | a move is recorded for an item that is not verified | killed, 6 failed |
| proposal-verify.ts `movedTo` | inside the old window, a far copy is a move (first run, far copy only below the cited line) | survived: the test's far copy was outside the prefix the code host was asked for |
| same | same mutant after the test put the far copy above the cited line | killed, 1 failed |
| proposal-verify.ts `locate` | the no-line guard removed (first run) | survived: dead code (the collapsed whole-file check in the window step already holds every line-less quote that is in the file); the guard is now `verdict: fails` and only needed for the type |
| proposal-verify.ts `locate` | the found place's edge characters dropped (`quote clipped` tests) | killed, 4 failed |
| proposal-verify.ts `withMovedLines` | the cited-line guard removed | killed, 1 failed |
| agent.ts `verifiedViewOf` | kept verdicts shown without the moved lines | killed, 1 failed |
| agent.ts `verifiedViewOf` | moved lines not stored with the verdicts | killed, 1 failed |
| citation-locate.ts `quoteOccurrences` | only the first line of a multi-line quote checked | killed, 2 failed |
| sandbox-file-tools.ts `withLineNumbers` | numbers start at 0 | killed, 7 failed |
| same | an image is numbered | survived: equivalent (the binary check already keeps every real image out: PNG, JPEG, GIF and WebP headers hold a NUL byte; the image check stays as a second guard) |
| same | a binary file is numbered | killed, 1 failed |
| same | the closing newline gets a number | killed, 3 failed |
| same | CR cut from the line (split on `\r?\n`) | killed, 1 failed |
| sandbox-file-tools.ts `sandboxFileTools` | the `numberedReads` option ignored | killed, 7 failed |
| pi-session.ts | a SETUP session is not numbered | killed, 1 failed |
| pi-session.ts | every session is numbered | killed, 5 failed |

After the complexity split of `locate` into `locateCited` / `locateInText` / `movedTo` / `movesOf` (proposal-verify.ts) and of `quoteOccurrences` (citation-locate.ts), the mutants on those lines were applied again in their new form (no-place-still-holds, comment lines count, farthest place, tie takes the later, glued as good as clean, no move reported, move for an unverified item, far copy inside the window, edges dropped, first line only of a multi-line quote): all killed (25, 13, 2, 1, 1, 30, 6, 1, 4, 2 failed).

## SETUP-CITATION-LINES, DEC 254zzz537 (no line numbers at all): the rule is "the exact quote is in the file at that commit"

The rows of the section above that name the numbered read tool (`withLineNumbers`, `numberedReads`, pi-session), the moved-line record (`movedTo`, `movesOf`, `withMovedLines`, the agent.ts `moved` store), the nearest place and the line window no longer apply: that code is removed. New mutants, each applied singly to the file named (scratch edit, source written back), run against tests/unit/setup-citation-quote-only.test.ts, citation-unique-quote.test.ts, setup-proposal-verify-golden.test.ts, par-setup-agent-flow.test.ts, prompt-locations-setup.test.ts and browser-evidence-suggestion.test.ts. The contracts package loads from its build, so N10 was rebuilt (`tsc -b packages/contracts`) before its run and after the restore.

| Mutant / production location | Mutation | Result |
|---|---|---|
| proposal-verify.ts `locateInText` (a command's quote anywhere in the file) | a quote with no place still holds | killed, 26 failed |
| citation-locate.ts `quoteOccurrences` | comment lines count as places | killed, 14 failed |
| citation-locate.ts `judgedOccurrence` | the first place is judged even when a clean one exists | killed, 1 failed |
| citation-locate.ts `quoteOccurrences` | case-insensitive match | killed, 1 failed |
| citation-locate.ts `placeOfLines` | only the first line of a multi-line quote checked | killed, 2 failed |
| proposal-verify.ts `locateInText` | a non-command quote always holds | killed, 1 failed |
| proposal-verify.ts `locateInText` | the found place's edge characters dropped | killed, 4 failed |
| proposal-verify.ts `locateInText` | a stored line past 100000 fails the citation (old stored line must be ignored) | killed, 1 failed |
| proposal-verify.ts `verifyProposalDetailed` | the file is read through a window again | killed, 17 failed |
| proposal-verify.ts `locateInText` | the quote is looked for in the first 50 lines only | killed, 9 failed |
| proposal-verify.ts `locationOf` | a missing file passes | killed, 2 failed |
| setup-proposal-read.ts (reader) | a line from the model's answer is kept | killed, 2 failed (after a contracts rebuild; 135 passed before it, because the tests read the build) |
| setup-draft.ts prompt | the prompt asks for the line number again | killed, 1 failed |

## SETUP-CITATION-LINES, Sonnet pre-review round (S1 to S6)

Each applied singly (scratch edit, source written back), run against tests/unit/setup-citation-quote-only.test.ts, citation-unique-quote.test.ts, setup-proposal-verify-golden.test.ts and setup-citation-comments.test.ts (S5 rows also citation-check). The comment table (citation-comments.ts) is pinned by 15 paired cases (comment refused, real code accepted) in setup-citation-comments.test.ts.

| Mutant / production location | Mutation | Result |
|---|---|---|
| proposal-verify.ts `hasName` (S1) | the found place's edges are not fed to the name check | killed, 7 failed |
| proposal-verify.ts `locateInText` (S1) | names get no edges | killed, 7 failed |
| proposal-verify.ts `locateInText` (S1) | every place counts as clean | killed, 1 failed |
| proposal-verify.ts `locateInText` (S1) | a name is judged by the command clean rule | survived at first (no test told "slash after the name" from "dash"); killed, 1 failed after the `widgets-old` then `widgets/issues` case was added |
| proposal-verify.ts `locationOf` (S5) | each citation builds the file's code text again | killed, 1 failed (30 citations of a 120000-line file must cost about one) |
| proposal-verify.ts `locationOf` (S5) | an over-cap file is not final | killed, 1 failed |
| citation-check.ts `readCitedFiles` (S5) | the 'file too large' refusal is a plain failed read | killed, 1 failed |

## SETUP-CITATION-LINES, Opus security round (M1, M2, S1, S2, S3)

Each applied singly (scratch edit, source written back), run against tests/unit/setup-citation-quote-only.test.ts and setup-citation-comments.test.ts.

| Mutant / production location | Mutation | Result |
|---|---|---|
| citation-comments.ts `codeLinesOf` (M1) | no cap on the length of a line read | killed, 2 failed |
| citation-comments.ts `blockLine` (M1) | the line-comment search is not bounded to the block start (it rescans) | survived: equivalent under the 16 KB cap (4000 blocks x 16 KB is tens of ms); the cap is what bounds the work, and the cap mutant is killed |
| citation-comments.ts `markerAt` users (S2) | a marker counts only after whitespace (not after `;` or `@`) | killed, 3 failed |
| citation-comments.ts `rubyLine` (S2) | no `=begin` | killed, 1 failed |
| citation-comments.ts `markdownLine` (S2) | indented code is not read as a script | killed, 1 failed |
| citation-comments.ts `otherLine` (S2) | a file of an unlisted type reads no comment but a line start | killed, 4 failed |
| citation-locate.ts `judgedOccurrence` (M2) | no cap on the places looked at | survived at first (the test's bound was 8 s, the search takes 2 s without the cap and 4 ms with it); killed, 1 failed after the bound became 1.5 s |
| citation-locate.ts `judgedOccurrence` (S1) | no two-line limit on a match | killed, 1 failed |
| citation-locate.ts `codeTextOf` (S1) | a blank line is dropped instead of a break token | survived: equivalent (the empty token still leaves two spaces, which no quote has, so the match is still refused) |
| proposal-verify.ts `quotesSupport` (S3) | a bare owner/name accepted after `/`, `:` or `@` | killed, 4 failed |

## SETUP-CITATION-LINES, Opus delta round (M1 again: the comment scan is one pass)

The row above that called the unbounded `blockLine` marker search equivalent was wrong: with ~1280 lines just under the cap a 20 MB file took 73 s. `markerAt` and the per-comment `indexOf` are gone; `cutComments` (citation-comments.ts) is one left-to-right pass (a pattern jumps from one possible comment start to the next, each probe starts where the last ended). Measured on this Mac for Opus's input (1280 lines of 16380 characters of `/* */ `, 20 MB): .ts 162 ms, .tf 170 ms, .vue 144 ms, unlisted type 141 ms, .sql 144 ms (before: 73 s, 74 s, 65 s, 68 s, 0.7 s). Tests: those five files under 1.5 s each, plus a counter of the characters the scanner goes over (at most twice the file's size, for ten file types and eight comment shapes), plus a scan budget (64 Mi characters per verification; past it the rest of a file reads as comment).

| Mutant / production location | Mutation | Result |
|---|---|---|
| citation-comments.ts `cutComments` | the pattern restarts from the end of the last block instead of where the last probe ended | killed: the test run hangs (the scan never advances), stopped by a timeout; the characters-scanned test would also fail |
| citation-comments.ts `codeLinesOf` | no scan budget | killed, 1 failed |

## PORT-GUARD-GATEWAY-NARROW: only the model gateway's names pass the gateway words in a deployment path and the AWS-import check (2026-11-25)

Every mutant is a change to `cloudWordsReason` in scripts/port-guard.ts, run against tests/unit/port-guard-boundary.test.ts (305 tests, all green on the real tree).

| Mutant | Change | Result |
| --- | --- | --- |
| M1 | the whole gateway block off (every gateway name passes, as after #1483) | red (27 of 305) |
| M2 | only a word that STARTS with "gateway" counts (glued `sharedgateway`, `mygateway` pass) | red (3) |
| M3b | `llm`, `llms`, `ai` join the model words AND `llmgateway`/`aigateway` leave the Cloud-only list (`llm-gateway`, `ai-gateway` pass) | red (7) |
| M3 | `llm`, `llms`, `ai` join the model words alone | survived: equivalent (`llmgateway` and `aigateway` in the Cloud-only list still refuse the same names; M3b removes both) |
| M4 | the AWS exemption ignores an earlier model/llm/ai word (`model-api-gateway`, `llm-api-gateway` pass) | red (3) |
| M5 | `llmproxy`, `aiproxy` leave the Cloud-only list (`llm-proxy`, `ai-proxy` pass) | red (5) |
| M6 | the two-word form `gate-way` is not read | red (4) |
| M7 | the words before "gateway" are read across slashes (`api/gateway.ts`, `model/gateway.ts` pass) | red (3) |
| M8 | any earlier model word makes it the model gateway (`model-api-gateway` passes) | red (2) |
| M9 | `awsImportReason` stops reading the path words for a deployment file (the AWS-import check) | red (20) |
| M10 | a glued lead (`modelgateway`) is not read as the word before the gateway | red (6) |
| M11 | `models` leaves the model words (`models-gateway` refused) | red (3) |
| M12 | "model" before the gateway no longer excuses it (the model gateway refused) | red (18) |
| M13 | an AWS gateway name (`nat-gateway`, `api-gateway-stack`) is refused too | red (13) |
| M14 | `llmgateway`, `aigateway` leave the Cloud-only list alone | survived: equivalent (the gateway rule refuses `llmgateway` and `aigateway` itself, as M3 shows from the other side) |

The restored tree passes (305 of 305).
## TASK-TAKEOVER PR A: a step runs for the task's CURRENT owner, and the owner is charged (2026-11-25)

Each mutant was applied to the source, the named suite run, and the change reverted. Rules suite: `tests/contract/task-takeover-a-rules.test.ts` (18 tests). Journeys: `tests/journeys/task-takeover-a.test.ts` (4).

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M1, `hostedTaskAccess.checkStep` | a task with a People list takes the starter rule (the list is never read) | rules suite and the journeys | red (17 of 22) |
| M2, `listStepVerdict` | no owner passes the access seam, and the step is allowed anyway | rules suite (owners the People proof passes but the seam refuses) | red (1 of 18) |
| M3, `listStepVerdict` | an orphaned list is allowed | rules suite | red (3 of 18) |
| M4, `listStepVerdict` | a list that does not read is allowed | rules suite | red (1 of 18) |
| M5, `listStepVerdict` | a proof that throws is allowed | rules suite | red (1 of 18) |
| M6, `resolveTaskListOwners` | an owner entry passes without the live People proof (the access seam still asks) | rules suite | green: the seam is the second layer, so M6c is the mutant that removes the stored-role check |
| M6b, `listStepVerdict` | the access seam is not asked for each owner (the People proof still asks) | rules suite | red (1 of 18) |
| M6c, both layers | a stale `owner` entry of a person who is gone passes (stored role alone) | rules suite (stale owner entry; seam; decision owner) | red (3 of 18) |
| M7, `acceptStep` | the step's requester (the gateway's payer) stays the starter | the journeys (hand-over, take-over, session view) | red (3 of 4) |
| M8, `chooseStepOwner` | the latest decision does not choose the payer | rules suite | red (1 of 18) |
| M9, `chooseStepOwner` | the latest take-over does not choose the payer | rules suite | red (2 of 18) |
| M10, `chooseStepOwner` | the last owner of the list, not the first, is the fallback | rules suite | red (1 of 18) |
| M11, `listStepVerdict` | the payer is chosen among owners the access seam refused | rules suite | red (1 of 18) |
| M12, `listStepVerdict` | the verdict carries no People revision fence | rules suite | red (1 of 18) |
| M13, `takeTaskOwnership` | a take-over leaves the workspace slot on the previous owner | rules suite (slot) | red (2 of 18) |
| M14, `planHandOver` | a hand-over moves the markers but not the two counters | `tests/contract/company-member-handover.test.ts` | red (2 of 29) |
| M15, `planHandOver` | the preview does not count the slot's steps | same file (15 slotted tasks fit, 16 are refused before anyone is removed) | red (1 of 29) |
| M16, `holdsOwnTask` | ignores the People list (a denied starter holds the task again with the grant back) | rules suite (re-admission) | red (1 of 18) |
| M17, session `compute` | a session's starter keeps ownership once the list moved on | `tests/unit/session-people-owner.test.ts` | red (3 of 4) |
| M18, `standingFactsOf` | a blocked no-owner task does not wait on a project admin | `tests/unit/task-standing.test.ts` | red (1 of 82) |
| M19, `hostedDecisionService` | the chat gate knows only the task's starter | `tests/unit/hosted-slack-plan-buttons.test.ts` | red (1 of 28) |
| M20, `hosted-authority` | the e2e creator proof is the starter's | `tests/unit/core-e2e-hosted-authority.test.ts` | red (1 of 36) |
| M21, `retryActorOf` | the checks rerun is recorded under the starter | `tests/unit/task-takeover-a-actor.test.ts` | red (1 of 2) |
| M22, `revisePlanWithLiveMessage` | the revision is recorded under the starter | `tests/unit/core-session-actions.test.ts` | red (1 of 4) |
| M23, session view | the session says the starter pays | the journeys (c) | red (1 of 4) |
| M24, session view | a task whose owner is a successor tells a company admin "the owner left" | the journeys (c) | red (1 of 4) |

### TASK-TAKEOVER PR A, round 2 (the press is charged; reads that fail retry; the e2e proof is the admitted person's)

All of M1 to M24 above were run again after the refactor (the same mutations, expressed against the moved code) and are killed. New:

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M25, `acceptStep` | the dispatch row's press (`by`) is not read | `tests/unit/task-takeover-a-actor.test.ts` | red (1 of 4) |
| M26, `listStepVerdict` | a presser the list still calls an owner who lost access is charged to another owner | rules suite and journey (e) | red (3 of 29) |
| M27, `listStepVerdict` | the press is ignored (the order always applies) | rules suite | red (2 of 29) |
| M28, `latestTakeoverOwner` | a history past 200 events is read from its oldest rows | rules suite (201 events) | red (1 of 23) |
| M29, session view | the payer ignores the press now running | journey (f) | red (1 of 6) |
| M30, `retryStep` | a Retry does not name the presser | journey (f) | red (1 of 6) |
| M31, `hosted-authority` | the e2e round is asked under the current payer, not the person it was admitted under | `tests/unit/core-e2e-hosted-authority.test.ts` | red (1 of 36) |
| M32, `listStepVerdict` | a read that fails refuses (and blocks the workflow) instead of throwing | rules suite | red (1 of 23) |


### TASK-TAKEOVER PR A, round 3 (Opus pass: the failed read of a presser throws; the session and page presses name the presser)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M34, `listStepVerdict` | a presser whose own proof or membership could not be read is told "no owner" | rules suite | red (1 of 24) |
| M35, session control host | the session Retry does not name the presser | `tests/unit/task-takeover-a-press-wiring.test.ts` | red (1 of 3) |
| M36, `answerUnderstandQuestions` | the Answers do not name the presser | same file | red (1 of 3) |


### TASK-TAKEOVER PR A, ruling (b) (DEC 254zzz523: a task owner needs an individual project grant; a channel-only person is a commenter or a viewer, never an owner)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M37, `reconcile` | a stored channel-only owner is kept as an owner by the read | rules suite | red (1 of 29) |
| M38, `changeTaskPeople` | a role change makes a channel-only person an owner | rules suite | red (1 of 29) |
| M39, `takeTaskOwnership` | a channel-only person takes a task over | rules suite | red (1 of 29) |
| M40, `taskOwnershipHandOverSteps` | a hand-over picks a channel-only successor | rules suite | red (1 of 29) |
| M41, `getTaskPeopleCapabilities` | the take-over is offered to a channel-only person | rules suite | red (1 of 29) |
| M42, `qualifyCurrent` | the proof never says a person is channel-only | `tests/contract/task-person-identity.test.ts` | red (1 of 6) |
| M43, `taskPersonMayOwn` | the Slack-native task exemption is dropped | rules suite | red (1 of 29) |
| M44, `planRevokeProjectAccess` | the removal plan says nothing of the channel | `tests/contract/admin-change-plans-access.test.ts` | red (1 of 12) |
| M45, `task-person-runtime` | the hosted runtime proof does not say how access was granted | `tests/contract/task-person-runtime.test.ts` | red (1 of 40) |
| M46, `developer-routes` | the route's identity proof does not say how access was granted | `tests/contract/developer-routes.test.ts` | red (1 of 48) |
| M47, `resolveTaskListOwners` | the list owners count a channel-only owner as live | rules suite | red (1 of 29) |
| M48, `reconcile` | a read's demotion of an owner with no grant of their own writes no audit event | rules suite | red (1 of 29) |
| M49, `reconcile` | that event carries no `needs_grant` reason (it reads as any role change) | rules suite | red (1 of 29) |
| M50, `CHANNEL_ACCESS_AFTER_REVOKE_WORDS` | the removal sentence leaves out "start" (says "open or own") | `tests/contract/admin-change-plans-access.test.ts` | red (1 of 12) |
| M51, `hostedTaskAccess.checkStart` | a member with no project grant may start | journey (g) | red (1 of 7) |
| M52, task page history | a `needs_grant` demotion reads as a role change ("X made Y commenter") | `tests/contract/task-people-needs-grant-history.test.ts` | red (1 of 1) |
| M53, `needsGrantEvent` | the demotion names the demoted person as its own actor | rules suite | red (1 of 29) |


### GRANT-SIGNATURE-CANONICAL: a repository grant verifies only as the string it was issued as

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| G1, `RepositoryGrantService.verify` | the signature is compared as decoded bytes again (three other spellings of the same signature verify) | `tests/unit/core-e2e-publication-callback.test.ts` (the sibling-spellings test) | red (1 of 87) |

## CLI-LOGIN-GITHUB (agentx login accepts a GitHub-only install), 2026-11-25, on base a0bc104f9

Measured on the lane's working tree over tests/contract/developer-login.test.ts (20 tests). Each mutant was applied alone, the one file run, and the file restored.

| Mutant / location | Mutation | Failing tests (of the file) | Restored |
|---|---|---|---|
| M1, cli/src/developer/login.ts `readConfiguration` | GitHub is ignored again (only Slack and the company sign-in count as on) | 2 of 20 | green |
| M2, cli/src/developer/login.ts `readConfiguration` | the no-method check is dropped, so an install with every method off is accepted | 2 of 20 | green |
## GETDEVELOPER-GITHUB (an adapter conversation's linked developer may sign in with GitHub), 2026-11-25, on base a0bc104f9

Measured on the lane's working tree over tests/contract/channel-conversation-developer-record.test.ts (8 tests). The mutant was applied alone, the one file run, and the file restored.

| Mutant / location | Mutation | Failing tests (of the file) | Restored |
|---|---|---|---|
| M1, broker/src/aws/broker-primitives.ts `channelConversationDependencies.getDeveloper` | `github` is dropped from the accepted providers again | 2 of 8 | green |

## GITHUB-NOT-ON-REVIEW-LINK (a hand-built authorize link cannot take the review-link sign-in to GitHub), 2026-11-25, on base a0bc104f9

Measured over tests/contract/company-github-signin.test.ts (33 tests). The mutant was applied alone, the one file run (--maxWorkers=1), and the file restored.

| Mutant / location | Mutation | Failing tests (of the file) | Restored |
|---|---|---|---|
| M1, broker/src/developer/server.ts `authorize` | the `method=github` check for a request carrying `browserReturnTo` is dropped | 1 of 33 | green |
## BEDROCK-BYO-CHECK-FIXES (gateway copy; same sessions tests as Rovara Cloud)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M1, `#modelCheck` (bedrock-byo-sessions.ts) | drop the retry | tests/unit/model-gateway-bedrock-byo-sessions.test.ts: "asks once more..." and "logs both asks..." | red (2 of 18) |
| M2, `classifyAnswer`/`#ask` | map `no_answer` back to `unavailable` | same file: "tells each model's state...", the retry, caller-abort and retry-log tests | red (4 of 18) |
| M7, `classifyAnswer` | any 2xx is ready | same file: "tells each model's state..." and the retry test | red (2 of 18) |
| M11, `recheckBedrock` (product-keys.ts) | a check again saves nothing new (returns the old summary) | tests/unit/model-gateway-bedrock-byo.test.ts: "a check again re-runs the test for the SAVED connection..." | red (1 of 27) |

## Pre-review round: gateway copy (Cloud 1d33e9794 bytes; append only)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M12, `classifyAnswer` | retry on any status of 400 or more | tests/unit/model-gateway-bedrock-byo-sessions.test.ts: "asks once more..." (401, 408, 413, 422, 424, 499 are one ask) | red (1 of 20) |
| M13, `expectedAnswer` | a Messages answer is ready only with stop_reason max_tokens | same file: "tells each model's state..." | red (1 of 20) |
| M14, `#modelCheck` | no budget check before the retry | same file: "does not ask again when a whole ask no longer fits..." | red (1 of 20) |
| M18, `#logCheck` | the company id is left out of the log line | same file: the logging tests | red (2 of 20) |
| M16, `answerBedrockCheck` | no per-company limit | tests/unit/model-gateway-bedrock-check-company-limit.test.ts | red (1 of 2) |
| M17, `parseDoc` | an unknown stored state word is kept as it is | tests/unit/model-gateway-bedrock-byo.test.ts: "a state word a later release stored reads as no_answer..." | red (1 of 29) |
| M17b, `validBedrockSummary` | the strict word list again | same test | red (1 of 29) |
| M9s, `recheckBedrock` | a good re-check keeps a call-time refusal marker | same file: "a check again clears a call-time refusal marker..." | red (1 of 29) |

## Product models and stale divergences (Code; append only)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M23, `gatewayBedrockCheck` | the answer is read only for the agents' picks (product models read unavailable) | tests/unit/model-gateway-bedrock-check-company-limit.test.ts: "tells the gateway the connection's product models..." | red (1 of 3) |
| M25, `runProof` | the stale-divergence check is not run | tests/contract/gateway-catch-up-proof.test.ts: "fails on a divergence record that is Cloud's own pinned blob..." | red (1 of 15) |

## RD-2a - the task page's spec read (`GET /v1/dev/tasks/{taskId}/spec`; base RD-2.0 a65c40ce7)

Production guards this lane adds: the task read's own rule in `core-host/task-spec-routes.ts` (`loadReadableTask` before anything is read), and in `core/task-view/spec.ts` the layer states (not written, superseded, unreadable with no older-version fallback, Markdown not served), the approval and gate-decision matching by digest, the comment tally (live, people's, current version only, read tolerantly), the digest waited on only at a gate, the derived decision status (answers of the approval), the design review's open questions, redaction of model text, and the Quick-only "bigger than Quick" reasons. Each mutant was applied singly to a copy of the file and restored; all in `tests/unit/rd2a-spec-read.test.ts`.

| Mutant | Mutation | Killed by (first failing tests) |
|---|---|---|
| M1 handler | the task is read without `loadReadableTask` (no access rule) | the real-task cases and the colleague / other-company refusal test |
| M2 layerOf | an unreadable structured document keeps its derived state | "an unreadable structured document is `unreadable` ..." |
| M3 stateOf | no `superseded` for a coding plan written before the Full path | "a coding plan written before the task went the Full way is history" |
| M4 decisionOn | a send-back counts as a gate decision on the plan | "a plan sent back or rejected says so ..." |
| M5 commentCounts | deleted comments counted | "a Quick plan at its gate ..." (comment counts) |
| M6 commentCounts | AgentX replies counted | same |
| M7 layerOf | comments of any version counted | same |
| M8 specOf | `waitingDocumentDigest` served when the task is not at its gate | "an approved plan ..." |
| M9 specOf | "bigger than Quick" served in any layer state | "a Quick plan that looks bigger than Quick ..." (approved case) |
| M10 decisionsOf | any answer override counts as this decision's | "an approved plan ..." (override of another decision) |
| M11 openQuestionsOf | an answered question stays open | "the design review's open questions ..." |
| M12 openQuestionsOf | question text not redacted | same |
| M13 specOf | a Quick task shows all three layers | "a Quick task with no plan yet ..." |
| M14 decisionOn | any decision of the kind counts, not only the one holding this digest | "a Full task: three layers ..." |
| M15 layerOf | a Markdown document is read as structured | "a document stored as Markdown ..." |

All 15 killed; the restored tree passes (the new file 15 tests). Evidence applies to this lane's commit; the final-head gate and review belong to 9d.

### RD-2a follow-up (Sonnet pre-review: the six surviving mutants, S1, S2, S4) - 13 more, all killed (tests/unit/rd2a-spec-read.test.ts, run singly)

The document read is now narrower (the bytes and digest only, `loadWorkflowDocument` plus the plan's redaction; no check summary or self-check read), `waitingDocumentDigest` is withheld when the waited-on layer is unreadable, and design-question ids are redacted too.

| Mutant | Mutation | Killed by |
|---|---|---|
| N1 specOf | digest offered although the waited-on layer is unreadable | "unreadable ... " (tampered) and "an approved plan whose stored bytes no longer verify ..." |
| N2 layerOf | a read beyond the document (self-check style key) | "reads only the document itself ..." |
| N3 specOf | bigger-than-Quick on any path | "bigger-than-Quick is for a Quick task only ..." |
| N4 atGate | closed task still counts as at its gate | "a closed task waits on nothing ..." |
| N5 commentCounts | a row of another task under this key counted | "only this task's own, well-formed comments ..." |
| N6 commentCounts | untyped document or version counted | same |
| N7 commentCounts | no paging (first page only) | "comments are read page by page ..." |
| N8 commentCounts | no read limit | same (the endless store throws) |
| N9 stateOf | superseded loses to a rejection or change request | "a coding plan written before the task went the Full way is history ..." |
| N10 layerOf | an unreadable layer still claims `approved` | "an approved plan whose stored bytes no longer verify ..." |
| N11 commentCounts | thread replies not counted | "a person's reply in a thread is a comment and counts ..." |
| N12 layerOf | the task's own object folder check removed | "a document whose object is not in this task's own folder is unreadable ..." |
| N13 core/task-flow/reads.ts (not this lane's file; mutated and restored) | `TASK_ACCESS_DENIED` from `canRead` not mapped to not-found | "the People list's own read rule ..." |

Not mutation-tested: `redactText` on the design question's `id`, `recommended` and option ids (the stored schema caps them at 16 characters, so no secret pattern fits; the redaction is for the literal rule only).

### RD-2a Opus leftovers (S1, N1, N2) - 2 more, both killed (tests/unit/rd2a-spec-read.test.ts)

| Mutant | Mutation | Killed by |
|---|---|---|
| P1 layerOf | the catch rethrows (a reader that throws fails the whole read) | "a document reader that THROWS ... makes the layer unreadable" |
| P2 specOf | `waitingDocumentDigest` offered for any waited-on layer, not only one whose bytes were read and verified | the Markdown test and the tampered / approved-but-unreadable tests |

N2 (`answer` of a changed decision passed through `redactText`) has no test: the stored option id is capped short by its schema, so no secret pattern fits (the redaction is for the literal rule).

## RD-2a on the read rule (rebased onto 49080fbea, 2026-11-25)

The spec handler no longer reads the task or asks any access rule: the mount asks `decideTaskRead` once and hands `context.decision` (core-host/task-screen-routes.ts); `readTaskSpec` reads `context.decision.task`. The earlier mutant "handler without the read rule" is now a mount mutant (RD-2.0-READ-RULE M-series: `routeTaskScreen` that skips `context.decide`), killed by `tests/unit/task-read-rule.test.ts` (the 18 x 14 table on the real routes, spec cells) and the golden (`tests/contract/rd-2-0-read-rule-golden.test.ts`, the four admitted persons' spec cells are listed in `CHANGED`). A share's spec answer is the table's 403 TASK_PART_NOT_SHOWN (ship B), pinned by the same table.
