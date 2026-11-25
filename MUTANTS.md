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
