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
  - "tests/fixtures/p02-request-recovery.json (sha256 3982a8cf4cf86343ab65ab9338c5c2f3e81b503df44c6fe4934712b11679910d)"
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
on both `067ea9e82a6affee106c4854416cc693ed444d77` and this branch, and compare failure rates per test file. Until then the
correct status for suite stability is `unknown`.

## Independent review round 1 — one reproducible B2 defect, fixed

**Finding (valid).** Submitting `AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA` through the real
generic `POST /tasks` handler returned `202`; recovering that same id returned `404`.

**Cause.** `parseRequestLookupPath` lowercased both path segments. Task acceptance stores the
caller's spelling verbatim and keys its idempotency index on that exact string — `ownerKey \0
workspaceId \0 requestId` in memory, `REQUEST#<requestId>` as the AWS sort key. The schema
accepts uppercase and mixed-case UUIDs, so case-folding on the read path looked up a key
acceptance had never written. Recovery of an uppercase or mixed-case request was impossible,
and it failed in the single worst way for this route: reporting a job that existed as absent.

**Fix.** Preserve the identifiers exactly as received. One line, plus the reasoning recorded
where the next reader will need it.

No stored identity was normalized and no persisted hash changed. `requestId` is not an input
to `taskPayloadHash`, so the published vectors and the fixture digest are untouched.

**Semantics now pinned:** request identity is byte-for-byte. Two spellings of one UUID are two
distinct request identities at every layer, so recovering with a different spelling correctly
answers `404` — and, as everywhere on this route, that `404` must not trigger a resubmission.
Canonicalizing would have to happen at acceptance, consistently, with a migration; it must
never be bolted onto the read path alone.

**My own test had encoded the bug.** `matches only well-formed UUID pairs` asserted that an
uppercase workspace id came back lowercased. Corrected to assert exact preservation. A test
that asserts the defect is worse than no test, and this one existed because I wrote the
assertion from the implementation instead of from the acceptance path's storage behavior.

**Regression coverage**, verified RED by reintroducing the case-folding — 6 tests fail across
both real handlers, then pass with the fix:

| Test | Handler |
|---|---|
| `REVIEW recovers an accepted uppercase request ID without creating new work` (adopted verbatim) | generic |
| `submits and recovers a uppercase request id through the real handlers` | generic |
| `submits and recovers a mixed-case request id through the real handlers` | generic |
| `still refuses a case-variant request id to another owner` | generic |
| `treats a different spelling of the same UUID as a different request identity` | generic |
| `submits and recovers a uppercase request id through the real AWS handlers` | AWS |
| `submits and recovers a mixed-case request id through the real AWS handlers` | AWS |
| `matches only well-formed UUID pairs` (corrected) | path parsing |

Each submits through the real acceptance handler and recovers through the real lookup handler,
and each still asserts read-only behavior (full store snapshot equality), ownership and
membership refusal, one outbox record, and zero `acceptTask` / `acquireWriter` / publication
calls.

### Regression receipt with actual exit statuses

Tree: working tree of `codex/lane-agentx` at the review fix. Node 22.23.2.

```
npm run clean && npm run build   BUILD_EXIT=0
npm run typecheck                TYPECHECK_EXIT=0
npm run lint                     LINT_EXIT=0
npm test                         TEST_EXIT=0

 Test Files  43 passed (43)
      Tests  285 passed | 1 skipped (286)
   Duration  10.05s
```

Exit statuses are the real ones, captured with `$?` on the command itself rather than through
a pipe. That pipe is what lost the flake's identity in the first place.

### The unidentified flake remains unresolved

This green run does **not** explain or close it. One earlier full-suite run failed one
unidentified test; it has not recurred, and repeated passes are not evidence of a cause. The
observed record is now 1 failure in roughly 28 runs, still unattributed and still uncompared
against the baseline. Suite stability stays `unknown` until a reviewer runs the loop with
`--reporter=json --outputFile` on both `067ea9e82a6affee106c4854416cc693ed444d77` and this
branch and compares per-file failure rates.

### Handoff corrections

- The fixture digest is
  `3982a8cf4cf86343ab65ab9338c5c2f3e81b503df44c6fe4934712b11679910d` in full. The abbreviated
  form is removed from this log. The fixture bytes are deliberately unchanged, so the digest
  the reviewer verified still holds; the case-sensitivity rule is documented in
  `docs/p02-request-recovery.md` rather than churning a digest other lanes may have pinned.
- The advice to rebind evidence to a changed published head is withdrawn and replaced. Changed
  code is different code: it requires new verification and a new approval, and the earlier
  evidence and decision are invalidated. Evidence binds to the exact candidate digest it was
  produced against, and moving that binding would let unverified code inherit a verdict it
  never earned.

## Isolated fixture worker and mock-only model route

Continuation from `b948278d16adec5e743b5c6357f08f84634fc81c`, tree
`3f386a283c3ac317138a9b8040237470cd781485`, verified clean at entry. Objective
`MSDLC-OBJ-001@0.3`, digest `bc902e9d…845843`. Governed by DEC-038 and its runtime
addendum; no ManagedSDLC commit was copied into this repository.

### What changed about the evidence

The previous in-process Pi fixture was component evidence. It showed the durable host
drives the real worker; it never showed isolation, and `npm test -- packages/host` could
not close that gap by itself. The same real code now runs inside an invocation-owned
container with no network, and the model route is a mock-only broker with real
accounting. See `docs/isolated-mock-execution.md`.

### Runtime inputs

| Field | Value |
|---|---|
| Runtime CLI | `/Users/abhishekgarg/Documents/ChatGPT/ManagedSDLC/.local/toolchain/bin/docker` |
| `DOCKER_HOST` | `unix:///Users/abhishekgarg/.colima/charterarc-team-tasks/docker.sock` |
| Daemon | Server 29.5.2, `linux/arm64` |
| Base registry reference + platform digest | `node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9` (linux/arm64) |
| Built local image ID | `sha256:8620a338e2807f68d3b259aa18dd0eaf333db7a9e6d37a50996f8787bf1ae6fb` |
| Image tag | `agentx-fixture-worker:lane-b` |
| Added to base | `git` 1:2.39.5-0+deb12u3 |

The local image ID is **not** a distributable registry pin; this image was never pushed
and no registry digest exists for it.

### Slot check before running

Inspected non-secret runtime metadata first. No running containers. Stale **exited**
resources from other work were present and were left completely untouched: D's
`charterarc-c-browser-838712f8-*` containers and its `charterarc-c-browser-838712f8_local`
network, plus `charterarc-team-tasks-*` containers from two days earlier. Nothing was
stopped, removed or reconfigured, and the existing daemon was used as-is.

Per run: one container, 2 GiB, 256 pids, 2 CPUs, ten-minute whole-run deadline — inside
the approved three-container / 6 GiB aggregate ceiling. After the final run, no container
carrying `charterarc.lane=b` remained.

### Two defects the tests caught

1. **Cleanup reported success for a container it never saw.** `docker rm --force` exits 0
   for an id that never existed, so trusting its exit status reported a clean removal of
   something this process never owned. `cleanupOutcomeFor` now returns `removed` only
   after observing the container present, removing it, and observing it gone; everything
   else is `unknown`.
2. **A denial probe passed because a tool was missing.** The other-run-network probe ran
   `ip`, which is not in this image, so it reported "denied" whether or not a network was
   attached. It now reads `/sys/class/net`, and both directions were verified by hand:
   `lo` alone with `--network none`, `eth0` present when a network is attached. The
   external-network probe was verified the same way — it resolves `example.com` when a
   network is attached and fails without one.

### Commands and results (Node v22.23.2, verified before running)

```
npm run build                      BUILD_EXIT=0
npm run typecheck                  TYPECHECK_EXIT=0
npm run lint                       LINT_EXIT=0
npm test -- packages/host          7 files, 44 passed, 8 skipped (container cases ungated)
npm test -- <7 affected suites>    7 files, 96 passed, 1 skipped
npm test                           50 files, 329 passed, 9 skipped, FULL_EXIT=0
CHARTERARC_REQUIRE_ISOLATED_MOCK=1 \
  npm test -- packages/host/tests/isolated-mock-execution.test.ts
                                   1 file, 17 passed, 0 skipped, EXIT=0
```

Skip counts: the 8 skips in the ungated host run and 9 of the full-suite skips are the
container cases plus the pre-existing desired-behaviour test. **Under
`CHARTERARC_REQUIRE_ISOLATED_MOCK=1` the skip count is zero**; a missing prerequisite
fails rather than skipping, so a green gated run cannot mean the containers were absent.

RED before implementation: the whole file failed with
`Cannot find module '../src/isolated/runtime.js'`, with and without the flag.

### Changes outside `packages/host/**` and `environments/fixture-worker/**`

- `eslint.config.js`: added `environments/fixture-worker/**/*.mjs` to the existing
  `disableTypeChecked` list that already covers `environments/team-tasks/**/*.mjs`, plus
  `Buffer` to that block's globals. Lint wiring for a new environment file, following the
  established pattern; no rule was relaxed for any other path.
- **No change was needed in `packages/worker/src/**`.** The real `runTaskInvocation` is
  reused as-is through its existing `piAdapter`, `eventSink` and `artifactSink` injection
  points. No worker file was edited, duplicated or re-exported.
- No dependency was added and no lockfile was touched. SQLite is Node 22's built-in
  `node:sqlite`; the container uses the image's own `tar` and `git`.

### Still false, still unknown

`enforced_scope` remains false: a container confines which filesystem the worker sees, not
which paths inside it may be written, and capture-time refusal is detection. Requests
requiring path containment are rejected rather than silently unenforced. `enforced_deadline`
is not asserted either: the orchestrator terminates the container and its children, which
is real termination, but it is not a per-job deadline inside the executor. No ManagedSDLC
capability flag is set by this package or by the mock route.

Callback authority is proven at the host boundary, not inside the container: the container
has no network and is never given a capability.

The unidentified historical flake remains unresolved. Nothing in this package explains it.
