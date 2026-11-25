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
