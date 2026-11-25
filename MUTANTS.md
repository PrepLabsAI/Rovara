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
