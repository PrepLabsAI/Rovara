# Lane B — AgentX Execution: work log

Local implementation log for the unified CharterArc product convergence. This file records
preflight, authority and verification facts. It is not evidence qualification, an approval,
or a deployment record.

## Preflight

```yaml
objective_snapshot: MSDLC-OBJ-001@0.3
objective_digest: sha256:bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843
task: >-
  Lane B — AgentX request identity (B1/AX1), authenticated read-only request recovery
  (B2/AX2), and an evidence-backed execution-capability inventory (B3).
contributes_to: >-
  Replaceable-executor principle and honest lifecycle states. Gives the canonical control
  plane a way to recover an already accepted execution request after a lost response
  without dispatching a second job.
decision_rights: implement
must_preserve:
  - Persisted AWS payload-hash bytes for already accepted operations
  - Complete frozen candidate export, including new and deleted files
  - Candidate creation separate from pull-request publication
  - Executor output stays Claimed; CharterArc owns evidence qualification and approval
  - Existing tests and fixtures not weakened to obtain a green result
non_goals:
  - A second orchestrator, queue, memory service or workflow engine
  - Cloud deployment, credentials, paid agent runs, external messages
  - Real PR publication, push, merge, or broader security/identity changes
  - Claiming live/AWS support from offline tests
assumptions_relied_on:
  - The pinned AgentX baseline has no repository AGENTS.md/CLAUDE.md; shared governance is
    read from the ManagedSDLC checkout instead (confirmed by inspection, see below).
  - Zod 4 normalizes parsed object key order to schema shape order, so a shared serializer
    can reproduce the persisted AWS hash bytes exactly (verified empirically, see below).
required_evidence:
  - RED then GREEN test output for each implemented behavior
  - Storage snapshot equality and zero worker/queue calls for lookup
  - Named test commands and results on the stated tree
stop_conditions:
  - Incompatible shared contract or fixture change
  - Any need for credentials, network, cloud or publication authority
  - A governance contradiction that blocks execution
```

### Governance read (pinned)

Read in the mandated order from ManagedSDLC revision
`cd873f70eca2a68d236555e7d950f41d003c3fb9`:

| File | SHA-256 of blob at that revision |
|---|---|
| `AGENTS.md` | `a05238581ddc46ed0d1896df4483826cc591c4cf3aa0979209f91cf4b7d53758` |
| `product/OBJECTIVE.md` | `bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843` |
| `product/LEDGER.md` | `a9280db90e9eabc133ffcbb256bb81abfcdcdbc2e74fe2e09287f88e5d649342` |
| `product/EVIDENCE.md` | `7fcb50724320428f298813d2ccd87b3a48df830a7851a54d20e737216a99c6f5` |

`OBJECTIVE.md` digest matches the governing objective stated in the lane contract.
`CLAUDE.md` at that revision is a symlink to `AGENTS.md` (mode `120000`), so there is one
instruction source.

Applicable rules summarized before editing:

- **Scope.** Implement inside the approved lane contract. Routine in-lane file corrections
  need no new approval. Objective changes, broader authority and Tier 2/3 changes do.
- **Isolation.** Separate worktree from the approved exact commit; never reset or overwrite
  another task's branch or worktree; do not edit ManagedSDLC files from this lane.
- **Testing.** Reproduce required behavior with a failing test, implement the smallest
  coherent change, then run relevant broader checks. Record exact commands and results.
- **Authority.** A lane implementation assignment does not authorize credentials, paid model
  calls, live provider actions, cloud resources, deployment, external notifications, real PR
  publication, push or merge.
- **Honesty.** `Implemented`, `Verified`, `Delivered` and `Validated` stay distinct. Unknown
  evidence stays visible and is never coerced into a pass. Executors and model output are
  untrusted for authoritative evidence.

### AgentX repository instructions

The pinned AgentX baseline contains no `AGENTS.md`, `CLAUDE.md` or equivalent ancestor
agent-instruction file. Verified by:

```
find . -path ./node_modules -prune -o \( -iname 'AGENTS.md' -o -iname 'CLAUDE.md' \) -print
```

which returned nothing. `.agents/skills/` holds Spec Kit workflow skills and
`.specify/memory/constitution.md` holds Spec Kit project memory; neither is an agent
instruction file that overrides the shared governance. Their absence is recorded, not
treated as a blocker and not invented.

## Isolation

| Fact | Value |
|---|---|
| Source repository | `/Users/abhishekgarg/Documents/ChatGPT/AgentX-charterarc-demo` |
| Base commit | `067ea9e82a6affee106c4854416cc693ed444d77` |
| Base tree | `a94e07fec36998cabce78b724f2d7c8941d97ef3` |
| Branch | `codex/lane-agentx` (created at the pinned commit; did not previously exist) |
| Worktree | `/Users/abhishekgarg/Documents/ChatGPT/AgentX-lane-agentx` |
| Offline only | true |

Pre-existing branches and worktrees were inspected before creating this one and none were
reset, cleaned or reused: `codex/full-demo-delivery` (main checkout, at the pinned commit),
`codex/agentx-candidate-handoff` (separate worktree), `codex/agentx-unified-execution`,
`codex/charterarc-demo-setup`, `demo-ready-codex`, `mainline`.

## Environment

The repository declares `node >=22.19.0 <23` with `.node-version` `22.23.2` and
`engine-strict=true`. The machine default is Node v20.19.5, which cannot install or honestly
run this repository. An official Node 22.23.2 darwin-arm64 build was therefore unpacked into
the session scratchpad and used only by prefixing `PATH`; no system, shell profile or
package-manager state was modified.

- Tarball SHA-256 `5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1`,
  matching the published `SHASUMS256.txt` entry for `node-v22.23.2-darwin-arm64.tar.xz`.
- `node --version` → `v22.23.2`; `npm --version` → `10.9.8`.

Test setup was inspected before running anything: `vitest.config.ts` declares no
`setupFiles` or `globalSetup`; no `AWS_*` or `AGENTX_*` variables are present in the
environment; the AWS-path tests construct fake `documentClient`/`s3` objects and inject them
into `createAwsBrokerHandler`, and set placeholder `process.env` values inside the fixture
rather than reading ambient credentials. No live suite exists or was run.

## Baseline verification (before any edit)

```
npm run build     # tsc -b, exit 0
npm test          # vitest run
```

Result: `Test Files 40 passed (40)`, `Tests 222 passed (222)`, exit code 0.

`npm test` must be preceded by `npm run build`, because the workspace packages resolve
through their `dist` entry points; without a build 34 of 40 files fail with
`Failed to resolve entry for package "@agentx/contracts"`. That is a build-order fact about
the pinned baseline, not a defect introduced by this lane.

## Handoff receipt

```yaml
lane: B
result_status: implemented          # not verified by an independent reviewer; not delivered; not validated
base_commit: "067ea9e82a6affee106c4854416cc693ed444d77"
base_tree: "a94e07fec36998cabce78b724f2d7c8941d97ef3"
branch: codex/lane-agentx
result_commit: "5e537d69d2db18a5875ecdef957e74f910db280f"
tree: "b0a44096c224fdc24cdc2b2915f64f631bfd94df"
contract_revision: unified-private-r1
fixture_sha256: "3982a8cf4cf86343ab65ab9338c5c2f3e81b503df44c6fe4934712b11679910d"
node_version: "22.23.2"
tests:
  - command: "npm run build && npm test"
    tree: "a94e07fec36998cabce78b724f2d7c8941d97ef3 (baseline, pre-edit)"
    result: "40 files / 222 tests passed, exit 0"
  - command: "npm test -- tests/contract/task-payload.test.ts"
    result: "RED before AX1: missing helper, not an environment failure"
  - command: "npm test -- tests/contract/idempotency.test.ts (original operations.ts)"
    result: "RED: acceptTask resolved with the earlier job instead of rejecting"
  - command: "npm run clean && npm run build && npm run typecheck && npm run lint && npm test"
    tree: "b0a44096c224fdc24cdc2b2915f64f631bfd94df (committed)"
    result: "build 0, typecheck 0, lint 0, tests 43 files / 278 passed, 1 skipped, exit 0"
  - command: "npm test -- task-payload request-lookup idempotency candidate-broker-routes"
    tree: "13be686b88810ad9067538403455aaec18f53cea (B2 commit)"
    result: "4 files / 74 tests passed"
independent_review: not_yet_done
offline_live_boundary: offline_only
capabilities_added:
  - "taskPayloadHash: one complete idempotency serializer shared by both acceptance paths"
  - "OperationStore.getByRequest: owner-scoped read-only request index lookup"
  - "GET /v1/workspaces/{workspaceId}/requests/{requestId} on both real handlers"
  - "RequestIndexIntegrityError mapped to a safe 503, never to 404"
capabilities_preserved:
  - "Persisted AWS payloadHash bytes; the golden-vector assertion is unchanged"
  - "Complete frozen candidate export including new and deleted files"
  - "Candidate creation separate from pull-request publication"
  - "Executor output remains Claimed; no evidence qualification added"
known_gaps:
  - "nativeConversationRestore unsupported: the task path never reopens a session"
  - "Exact-candidate publication unsupported: publishWorkspace refuses candidate authorization"
  - "Per-job deadline/budget/allowed_paths absent from the wire, enforced by nothing"
  - "Generic handler answers 400 CONFIG_INVALID for an expired token, not 401"
  - "Real Pi conversation-history restoration is unknown; the resumption test uses a fake adapter"
files_outside_lane: []
integration_dependencies:
  - "Cross-repository vector equality with Lane A needs both reviewed implementations"
deployment_performed: false
objective_change_attempted: false
```

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.3
alignment: pass
result_status: implemented
evidence_added:
  - "tests/fixtures/p02-request-recovery.json (sha256 3982a8cf…acd16e)"
  - "docs/p02-request-recovery.md"
  - "docs/unified-execution-capabilities.md"
  - "tests/contract/task-payload.test.ts, request-lookup.test.ts, unified-execution-capabilities.test.ts"
decision_proposals: []
assumption_changes:
  - "Confirmed empirically that Zod 4 normalizes parsed key order to schema shape order, which
     is what lets one serializer reproduce the persisted AWS hash bytes."
scope_delta: >-
  Two additions beyond the literal AX1/AX2 file lists, both inside the lane and neither
  changing a contract: packages/broker/src/request-lookup.ts, so the two handlers share path
  parsing and failure mapping rather than diverging again; and an off-by-default failItemRead
  fault hook in the existing AWS test fixture, so a storage read failure could be tested
  without duplicating the fixture. Every pre-existing assertion in that fixture is unchanged.
contradictions:
  - "The AX2 route spec says 401/403 uses the 'existing authentication envelope'. On
     createBrokerHandler an expired token actually produces 400 CONFIG_INVALID. Pinned as
     current behavior and documented rather than silently changing authentication semantics
     for every route on that handler."
  - "The lane plan asks to preserve that publication cannot silently change verified code. It
     is preserved, but the stronger reading does not hold on this branch: exact-candidate
     publication is refused outright, and the legacy path merges onto a moved base, so a
     published head can differ from the verified tree. Recorded as a gap with successor S5."
objective_change_attempted: false
objective_digest_match: true
```

Status semantics: `implemented` means an executor produced a candidate and its named offline
tests pass on the stated tree. It is not `verified` (no independent reviewer), not `delivered`
(nothing deployed), and not `validated` (no outcome observed). No AWS route exists until a
separately authorized deployment and live test establish one.

## Unresolved: one non-reproducing test failure

Recorded as an open unknown rather than rounded to a pass.

One full-suite run on the final tree reported `Test Files 1 failed | 42 passed (43)`,
`Tests 1 failed | 277 passed | 1 skipped (279)`. The command piped output through `grep`, so
the failing test's name and assertion were not captured and the exit status was lost.

Attempts to reproduce on the same tree, same Node build, same machine:

- 12 consecutive full-suite runs: 0 failures.
- 8 consecutive runs of the timing-sensitive subset (`task-controls`, `demo-run-deadline`,
  `candidate-broker-routes`, `unified-execution-capabilities`): 0 failures.
- 6 further full-suite runs during the same session: 0 failures.

So the observed rate is 1 failure in roughly 27 runs, and the failing test is unidentified.

What this does and does not mean:

- It is **not** evidence that the suite is green in the sense of "always passes". The honest
  statement is that 26 of 27 observed runs passed and one did not, for reasons not determined.
- It is **not** attributed to this lane's changes. Several pre-existing tests in this
  repository are timing- and process-sensitive: `task-controls` spawns real child process
  groups and relies on `SIGTERM`/`SIGKILL` grace windows, `demo-run-deadline` is wall-clock
  driven, and `candidate-broker-routes` coordinates concurrent handler calls through barriers.
  Any of those is a more likely source than the read-only lookup or the characterization
  tests, but that is inference, not evidence.
- It has **not** been compared against the unmodified baseline, which would be the way to
  establish whether the flake pre-dates this lane.

Smallest next step for a reviewer: run the suite with `--reporter=json --outputFile` in a loop
on both `067ea9e8…` and this branch, and compare failure rates per test file. Until then the
correct status for suite stability is `unknown`.
