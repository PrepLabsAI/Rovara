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
