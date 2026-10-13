# Task 2A implementation report

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.4
objective_digest: sha256:707543b940253c8e068da55af87b81b4c57dd8d0e82f83436be13f5391cdf0c2
alignment: pass
result_status: implemented
evidence_added:
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a/red-receipts.md
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a/focused-green-final2.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a/build-green-final2.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a/typecheck-green-final2.log
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
objective_digest_match: true
```

## Implemented boundary

`packages/broker/src/e2e/discovery.ts` adds bounded immutable-source discovery and strict setup proposal normalization. It verifies candidate identity, source byte hashes, path membership, snapshot completeness and file/total limits; it rejects unsafe source paths, symlink/submodule content, and fabricated graph references. Discovery parses manifests as data and never imports or executes candidate code. It emits per-package web/API/Electron/React Native targets, Android/iOS targets when native metadata is present, native Windows/macOS/Linux metadata targets, API-schema dependency edges, and source-bound portable export candidates. A conflict between `start` and `dev` is a targeted blocker. Missing native runtime profiles are visible mock-substitutable gaps.

The detector is intentionally bounded. Package app recipes are fixed `npm run start` or `npm run dev` launches only where the app is web/API and the choice is unambiguous. It does not install or run Android, iOS, Windows, macOS, Linux, Electron, or API service toolchains. Native desktop discovery currently recognizes `.csproj`/`.sln`, Xcode project/workspace metadata, and Linux CMake/Meson markers; it does not claim those applications are buildable or runnable. Unsupported/ambiguous feature behavior remains for later approved feature-plan input. A source-only proposal has zero scenarios and cannot create an executable smoke case, qualify a run, or produce PASS; it is setup discovery only. A registered source/module-interface baseline and actual execution are later-unit work.

`packages/broker/src/e2e/execution-plan.ts` adds deterministic bounded planning. The planner retains required criteria and evidence/component floors across requested target expansion, separates requested from `contract-` effective target identity, derives stable criterion/case/upstream test identities, binds the upstream test ID to the fixed `.agentx/e2e/generated-contract.test.ts` path and digest-only title, and uses agent ID `default`. It refuses empty scenarios, invalid snapshots, absent qualified sandbox substrate and unsupported candidate operations; unavailable criteria stay visible. Groups remain mock-only and subject to the contract limits. No candidate output supplies expected feature behavior and no provider call or native runtime execution occurs here.

`packages/cli/src/setup/project-files.ts` adds a GitHub snapshot API that resolves the ref once, reads the exact commit tree and selected regular blobs, requires a complete non-truncated tree, verifies bounds and byte counts, and records a canonical `createCandidateManifest` identity plus per-file SHA-256. `packages/cli/src/setup/project-add.ts` adds a typed normal registration seam: it validates the snapshot and proposal graph, shows one setup-plan confirmation without command/test prompts, and omits E2E policy plus setup commands if declined. This is an additive seam; the production registrar, persisted round binding, broker workflow, compiler/upstream tuple verification, and actual sandbox execution remain units 2B/4/5.

## Verification

Focused suites passed: 62 tests across discovery, execution planning, immutable GitHub snapshot access, and `addProject` acceptance/decline. `npm run build`, `npm run typecheck:all` (strict baseline remains zero), and `git diff --check` passed using the pinned Node 22.23.2 toolchain at `/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin`. Exact logs and original first-red excerpts are in the sibling evidence directory. These checks verify local implementation contracts only; they do not establish a complete E2E workflow or runtime qualification.

## Handoff seams

- Unit 2B should consume `inspectE2ERepository`/`proposeE2ESetup`, compile only supported source/module-interface templates, and verify the generated fixed test path and digest title against the authoritative upstream tuple.
- Unit 4 should execute the actual exported candidate module for the supported portable profile, using its verified candidate path and export binding. It must report native profiles as unavailable until supported; do not rewrite candidate behavior as a simulation.
- Unit 5 should load authenticated stored policy/runtime availability and compose the registrar, approval, execution and evidence workflow. The current `addProject` hook is not persisted production workflow evidence.

## Local source state

Implementation was started from clean `9b0ed42d69fa830990fdfe793916e36daa6fe2a1` on `codex/rovara-e2e-p0-20261012`. Final source commit and tree are recorded by the accompanying local commit receipt. No push, PR, deployment, live call, or real secret retrieval was performed.
