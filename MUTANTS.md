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
