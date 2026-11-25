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
