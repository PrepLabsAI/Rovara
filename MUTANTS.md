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
