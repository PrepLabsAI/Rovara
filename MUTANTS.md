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
