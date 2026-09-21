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
