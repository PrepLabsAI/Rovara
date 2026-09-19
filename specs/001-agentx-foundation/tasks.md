# Tasks: AgentX Foundation

**Input**: Design documents in `specs/001-agentx-foundation/`.
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).
**Status**: Implementation in progress; completed tasks are checked below.
**Tests**: Behavioral verification is required by the specification and constitution.

## Format and Conventions

Each task has a checkbox, sequential ID, optional `[P]`, story label when applicable, and
implementation file paths. `[P]` denotes independent work after the stated prerequisites;
it does not authorize concurrent coding agents inside the same AgentX workspace.
Paths below are planned files, not claims that implementation exists.

## Phase 1: Setup

**Purpose**: Confirm dependencies and establish reproducible tooling.

- [X] T001 Verify released pi package/API, Node compatibility, AgentCore Instances SDK operations, CDK support and documented region limits; record pinned choices and distinguish documentation evidence from live evidence in `docs/decisions/001-compatibility.md` and `scripts/preflight.ts`.
- [X] T002 Establish the npm/TypeScript workspace, compatible local Node tooling, exact dependency pins, lockfile and package boundaries in `package.json`, `package-lock.json`, `tsconfig.json`, `.node-version`, and `packages/{contracts,cli,broker,worker}/package.json` (after T001).
- [X] T003 [P] Configure typecheck, lint, build and Vitest scripts with fixture helpers in `vitest.config.ts`, `eslint.config.js`, and `tests/fixtures/` (after T002).
- [X] T004 [P] Add CI running locked install, typecheck, tests and infrastructure synthesis in `.github/workflows/ci.yml`; keep live AWS tests explicitly configured in a separate job (after T002; job enabled when scripts exist).

## Phase 2: Foundational Contracts and Routing

**Purpose**: Shared state and access boundaries required by every story.

- [X] T005 Implement strict shared entity/message/error schemas in `packages/contracts/src/{project,workspace,operation,protocol,errors}.ts`: `schemaVersion` is exactly `1`; names match `^[a-z][a-z0-9-]{0,62}$`; revision is a positive integer; IDs are UUIDs; task prompt is non-empty UTF-8 text, at most 64 KiB; reject unknown keys and unsupported enum/state values from `data-model.md`.
- [X] T006 Implement verified issuer/subject identity, configured admin claims, project membership and ownership checks in `packages/broker/src/{auth,authorization}.ts`; reject body-supplied identity and developer runtime routing fields (after T005).
- [X] T007 Implement conditional workspace creation, writer lease/fence, operation payload-hash idempotency and transactional outbox in `packages/broker/src/{registry,operations,outbox}.ts`: at most one default instance per `(ownerKey, projectName)`; same request ID plus different payload returns `IDEMPOTENCY_CONFLICT`; terminal results are immutable (after T005–T006).
- [X] T008 Implement outbox delivery, retryable dispatch and operation-scoped callback capabilities in `packages/broker/src/{outbox-consumer,dispatcher,callbacks}.ts`; renewal requires the bound active operation/fence; never grant workers broad shared registry/artifact access (after T007).
- [X] T009 Implement broker routes and CDK foundations for JWT auth, DynamoDB/outbox stream, SQS/DLQ, Lambda, private artifacts and scoped roles in `packages/broker/src/handler.ts` and `infra/{bin/agentx.ts,lib/control-plane.ts}`; developer roles cannot directly invoke/command/stop AgentCore (after T006–T008).
- [X] T010 Verify tampered owners/IDs, unauthorized direct invocation policy, concurrent default resolution, duplicate/outbox retries, stale callback fences and artifact scope in `tests/contract/{authorization,idempotency,dispatch}.test.ts`; local checks must pass before story work (after T005–T009).

**Milestone**: An authenticated request can resolve only its owner's records and be accepted durably.

## Phase 3: US1 — Administrator Prepares a Product (P1)

**Goal**: Produce a ready, isolated workspace before any coding prompt.
**Independent test**: Prepare the fixture for one owner; validate initial files; retry after an
uncommitted edit and verify no destructive setup repeat.

- [X] T011 [P] [US1] Specify setup failure/retry, partial clone, existing-edit preservation and task-before-readiness tests in `tests/integration/preparation.test.ts` using a fixture repository (after Phase 2).
- [X] T012 [P] [US1] Add versioned project registration and scoped admin CLI routes in `packages/broker/src/projects.ts` and `packages/cli/src/admin/register.ts`; reject secret values, developer routing IDs, and image references lacking `@sha256:` followed by 64 lowercase hex digits (after Phase 2).
- [X] T013 [US1] Build the administrator's fixed pi/toolchain image and image publication instructions in `environments/base/Dockerfile` and `docs/environment-build.md`; pin base image and pi release, keep changing source and credentials out of image layers (after T012).
- [X] T014 [US1] Provision capacity provider, runtime, EBS mount, encryption and readiness preflight in `infra/lib/agent-runtime.ts`; mount is `/mnt/workspace`, networking comes from the provider, runtime lifetime cannot exceed provider lifetime, and regional support is validated (after T013).
- [X] T015 [US1] Implement responsive AgentCore `/ping` and `/invocations` handlers with operation journal/duplicate acknowledgment in `packages/worker/src/{server,journal}.ts`; use HTTP 200 for accepted worker invocations and Healthy/HealthyBusy status (after T014).
- [X] T016 [US1] Implement initialization-only setup and atomic manifest in `packages/worker/src/prepare.ts`: repository paths are unique relative POSIX paths; absolute paths, `..` segments and overlaps are rejected; symlinks stay inside workspace; configured default branches resolve to full commit IDs recorded in the workspace manifest; commands use argv, bounded cwd and positive timeout (after T015).
- [X] T017 [US1] Implement explicit admin workspace preparation and scoped repository credential grants in `packages/broker/src/{prepare,repository-access}.ts` and `packages/cli/src/admin/prepare.ts`; worker has no cross-owner secret access and setup retry never resets an existing checkout (after T016).
- [X] T018 [US1] Complete readiness/failure reporting and run the preparation acceptance cases in `packages/worker/src/readiness.ts` and `tests/integration/preparation.test.ts`; READY requires completed manifest plus configured readiness checks (after T017).

**Milestone**: Administrator can prepare a product without asking a coding agent to initialize it.

## Phase 4: US2 — Select an Isolated Workspace (P1)

**Goal**: One shared product definition selects separate owner-bound instances.
**Independent test**: Alice and Bob select the same product; Alice's private edits/history/artifacts
remain inaccessible to Bob, including deliberately altered identifiers.

- [X] T019 [P] [US2] Add name/path/config and two-owner selection denial cases in `tests/contract/project-selection.test.ts` and `tests/integration/workspace-isolation.test.ts` (after Phase 2; use prepared-workspace fixtures).
- [X] T020 [P] [US2] Implement local YAML resolution and `--project`/`--config-dir` in `packages/cli/src/{config,main}.ts`; reject traversal/unknown schema keys, require HTTPS except explicit loopback test mode, never execute config or discover arbitrary local extensions (after Phase 2).
- [X] T021 [US2] Implement browser PKCE login with configured OIDC issuer/client/audience and protected token storage in `packages/cli/src/{auth,token-store}.ts`; avoid token output and keep secrets outside shared config (after T020).
- [X] T022 [US2] Implement owner-default lookup, pinned revision validation and missing-preparation errors in `packages/broker/src/workspaces.ts` and `packages/cli/src/connect.ts`; server-owned routing IDs are never accepted from clients (after T021 and US1).
- [X] T023 [US2] Add four illustrative product definitions and config validation guidance in `examples/projects/{payments,storefront,inventory,analytics}.yaml` and `docs/project-configuration.md`; use visibly illustrative URLs/digests and no developer state (after T022).
- [X] T024 [US2] Verify private storage, conversation/artifact route authorization, concurrent owner resolution and explicit Git publication/integration behavior in `tests/integration/workspace-isolation.test.ts` (after T023).
- [X] T025 [US2] Implement project/instance/readiness status output and documented CLI error/JSON exit behavior in `packages/cli/src/{status,output}.ts` and `tests/contract/cli-output.test.ts` (after T024).

**Milestone**: `agentx --project payments` reliably selects the authenticated developer's ready instance.

## Phase 5: US3 — Delegate Remote Coding (P1)

**Goal**: Complete a coding task remotely and display progress, diff and test evidence locally.
**Independent test**: Fixture task modifies remote files and runs remote tests, while local
instrumentation observes no coding shell execution or source edits.

- [X] T026 [P] [US3] Add local tool/extension restriction and remote delegation contract cases in `tests/contract/orchestrator-boundary.test.ts` (after Phase 2).
- [X] T027 [P] [US3] Implement worker pi session creation, workspace cwd, default conversation and per-workspace model configuration in `packages/worker/src/pi-session.ts`; session paths are server-generated beneath `/mnt/workspace/agent-sessions/` (after US1).
- [X] T028 [US3] Implement task validation, lease acquisition and durable dispatch through `packages/broker/src/tasks.ts` and `packages/worker/src/run-task.ts`; journal before effects, reject non-READY state and duplicate/conflicting requests (after T027 and US2).
- [X] T029 [US3] Implement bounded event batches and private diff/log/test artifacts in `packages/worker/src/{events,artifacts}.ts` and `packages/broker/src/events.ts`; event sequences increase monotonically, page size defaults to 100 with range 1–500, and credentials are redacted (after T028).
- [X] T030 [US3] Implement local pi custom orchestration tools in `packages/cli/src/orchestration-tools.ts`: submit task, status, result/diff retrieval and follow-up delegation; no local read/edit/write/bash coding tools (after T029).
- [X] T031 [US3] Embed pi interactive mode and controlled resource loading in `packages/cli/src/orchestrator.ts`; disable built-ins, allow only approved custom tools, block discovered extensions and local shell shortcuts, apply project instructions as data (after T030).
- [X] T032 [US3] Implement polled progress rendering and single-prompt JSON mode in `packages/cli/src/{tui,event-client}.ts`; handle cursors/disconnects without task resubmission (after T031).
- [X] T033 [US3] Run the remote fixture task, tool-boundary instrumentation and duplicate-submission checks in `tests/integration/remote-coding.test.ts`; show a diff and test outcome and verify no implicit commit/push (after T032).
- [X] T034 [US3] Verify durable acceptance across client exit and dispatcher restart in `tests/integration/accepted-task-recovery.test.ts`; accepted work must remain discoverable and at most one worker run may start (after T033).

**Milestone**: First complete coding demonstration. US4/US5 are still required for the initial release.

## Phase 6: US4 — Resume and Give Feedback (P1)

**Goal**: Preserve unfinished code and agent history across feedback, reconnect and compute replacement.
**Independent test**: Retain tracked edits, an untracked file and completed conversation entries
through client reconnection and planned worker replacement; a new conversation preserves files.

- [X] T035 [P] [US4] Add repeat-turn, new-conversation and process-restart persistence scenarios in `tests/integration/resumption.test.ts` (after US3).
- [X] T036 [P] [US4] Implement saved pi-session reopen and independent conversation creation in `packages/worker/src/conversations.ts` and `packages/broker/src/conversations.ts`; never accept arbitrary session-file paths or rerun repository setup (after US3).
- [X] T037 [US4] Implement local reconnect state and feedback routing in `packages/cli/src/{client-state,feedback}.ts`; server reauthorizes stored display IDs/cursors and returns busy for a concurrent writer (after T036).
- [X] T038 [US4] Implement stopped-workspace resume and manifest/digest checks in `packages/broker/src/resume.ts` and `packages/worker/src/resume.ts`; mounts must be present before state access and normal resume cannot change the pinned revision (after T037).
- [X] T039 [US4] Implement interrupted-operation reconciliation and fencing in `packages/worker/src/reconcile.ts`; lease timeout alone cannot start another writer, and ambiguous shell effects are reported INTERRUPTED without blind replay (after T038).
- [X] T040 [US4] Run retained-code/history tests and document the boundary between saved files and lost live processes in `tests/integration/resumption.test.ts` and `docs/resumption.md`; ordinary resume must need neither Git commits nor checkpoints (after T039).

**Milestone**: Human-agent back-and-forth survives client and worker process replacement.

## Phase 7: US5 — Controls and Operational Visibility (P2)

**Goal**: Support cancellation, busy behavior, idle stop and actionable lifecycle diagnostics.
**Independent test**: Cancel a real child process, stop/resume idle compute without data loss,
and verify independent workspaces can run concurrently while one checkout has one writer.

- [X] T041 [P] [US5] Add cancellation, dual-submission, independent-owner concurrency and pinned-update scenarios in `tests/integration/task-controls.test.ts` (after US4).
- [X] T042 [P] [US5] Implement cooperative pi cancellation and tracked process-group cleanup in `packages/worker/src/cancel.ts` and `packages/cli/src/cancel.ts`; cancellation preserves edits and reports actual terminal status (after US4).
- [X] T043 [US5] Implement idle stop and lifecycle reporting in `packages/broker/src/lifecycle.ts` and `packages/cli/src/admin/stop.ts`; separate stop from deletion and reject busy stop until cancellation/termination is resolved (after T042).
- [X] T044 [US5] Add structured correlation, secret redaction, setup/runtime failures, disk-full and expired-auth diagnostics in `packages/worker/src/diagnostics.ts` and `packages/broker/src/diagnostics.ts`; run T041 control scenarios (after T043).

### Phase 7A: VPC-free demo deployment enablement

**Goal**: Provide a locally validated AgentCore microVM deployment profile that needs no VPC,
while retaining Instances/EBS as the production target and keeping its acceptance gate open.

- [X] T044A Record the `demo-microvm`/`instances-ebs` boundary and managed-session-storage limitations across `specs/001-agentx-foundation/{spec,plan,research,data-model,quickstart}.md` and `contracts/worker-protocol.md` (after T044).
- [X] T044B Add failing contract coverage for deployment-mode workspace bindings and a VPC-free runtime with PUBLIC networking, `/mnt/workspace` session storage, bounded lifecycle, worker environment, IAM role and no capacity provider in `tests/contract/{contracts,infrastructure}.test.ts` (after T044A).
- [X] T044C Implement the mode-aware workspace contract and preparation allocation in `packages/contracts/src/workspace.ts` and `packages/broker/src/prepare.ts`, plus the selectable microVM runtime stack in `infra/{bin/agentx.ts,lib/demo-runtime.ts}` (after T044B).
- [X] T044D Build the worker for `linux/arm64`, run the container health contract locally, and document the architecture-specific immutable image workflow in `environments/base/Dockerfile`, `package.json`, and `docs/deployment-demo.md` (after T044C).
- [X] T044E Run locked typecheck, lint, contract/integration tests, production synthesis and demo synthesis; record the local evidence and unverified AWS boundary in `docs/validation/agentx-foundation.md` (after T044D).

### Phase 7B: Deployable control plane and executable thin client

**Goal**: Replace synthesized placeholders with durable AWS handlers, close the worker terminal
callback loop, and expose the implemented developer/administrator workflows through `agentx`.

- [X] T044F Update the control API, project configuration contract, plan and quickstart for administrator-supplied runtime binding, subject-based workspace preparation, durable Lambda state, worker terminal callbacks and the executable command surface in `specs/001-agentx-foundation/{plan,quickstart}.md` and `contracts/{control-api,project-config,worker-protocol}.md` (after T044E).
- [X] T044G Add failing contract coverage for packaged (non-inline) broker/outbox/dispatcher Lambdas, DynamoDB/S3/SQS environment and grants, worker terminal callbacks, API Gateway event adaptation, and CLI command routing in `tests/contract/{infrastructure,worker-server,cloud-handlers,cli-main}.test.ts` (after T044F).
- [X] T044H Implement durable DynamoDB/S3 broker, DynamoDB-stream outbox publisher and SQS AgentCore dispatcher handlers in `packages/broker/src/aws/{broker,outbox-publisher,dispatcher,lambda}.ts`; enforce JWT-derived ownership, administrator bootstrap, project runtime binding, per-owner session allocation, atomic task acceptance and capability-scoped callbacks (after T044G).
- [X] T044I Package the real handlers with CDK Node.js bundling and scoped IAM in `infra/lib/control-plane.ts`, and implement worker terminal result reporting for prepare/task success and failure in `packages/worker/src/{callback-client,server,main}.ts` (after T044H).
- [X] T044J Wire login, project connection, status, conversation creation, single-prompt polling, interactive orchestration, cancellation and administrator register/prepare/stop commands through `packages/cli/src/{main,control-plane-api}.ts` and existing client modules; never expose runtime routing fields to developer commands (after T044I).
- [X] T044K Run typecheck, lint, all tests, both infrastructure syntheses and the ARM64 container health contract; update `docs/{deployment-demo.md,validation/agentx-foundation.md}` with executable sequencing and remaining live-only evidence (after T044J).

- [ ] T045 [US5] Execute configured-account acceptance for EBS isolation/stop-resume, background HealthyBusy lifecycle, cold dispatch retries, IAM bypass denial and two-owner concurrency in `tests/e2e/agentcore.test.ts`; record actual region/image/runtime evidence in `docs/validation/agentx-foundation.md` (after T044; requires deployment inputs).
- [ ] T046 [US5] Document retention, environment pinning, interrupted-task recovery, credential configuration, costs/idle controls and explicit destructive-cleanup semantics in `docs/operations.md`; distinguish observed cloud behavior from unverified paths (after T045).

**Milestone**: All five stories have end-to-end evidence, including live platform behavior.

## Phase 8: Polish and Convergence

- [ ] T047 [P] Finish developer/admin onboarding and executable examples in `README.md` and `docs/getting-started.md`; run the scenarios from `specs/001-agentx-foundation/quickstart.md` (after US5).
- [ ] T048 [P] Review packaged client/runtime dependencies, image contents and role/artifact boundaries in `tests/contract/release-boundaries.test.ts` and `docs/validation/release-review.md` (after US5).
- [ ] T049 Measure config-load and event-visibility targets and run the complete locked build/typecheck/test/synthesis checks; record results and remaining limitations in `docs/validation/agentx-foundation.md` (after T047–T048).
- [ ] T050 Run `$speckit-converge` against the implemented feature; update `specs/001-agentx-foundation/tasks.md` and record convergence evidence in `docs/validation/convergence.md`; mark completion only after required behavior is verified (after T049).

## Dependencies and Execution Order

```text
Setup T001–T004
  -> Foundation T005–T010
  -> US1 T011–T018: administrator preparation
  -> US2 T019–T025: project selection and isolation
  -> US3 T026–T034: remote coding (first coding milestone)
  -> US4 T035–T040: persistence and feedback
  -> US5 T041–T044: controls
  -> Demo T044A–T044E: VPC-free deployment profile and local gates
  -> Deployable demo T044F–T044K: durable control plane, callbacks and CLI wiring
  -> US5 T045–T046: production EBS live acceptance
  -> Polish T047–T050
```

The main delivery order is sequential. Contract tests and selected components may be built
against fixtures earlier where prerequisites explicitly permit it; story acceptance still
requires real predecessor integrations. No AWS resource creation is necessary for local
contract work. The demo profile removes the VPC input but still needs an account, region,
identity, repository, model and published ARM64 image for live use. T045 remains the
configured-account Instances/EBS acceptance gate.

## Parallel Examples

- Setup: T003 test tooling and T004 CI can proceed independently after T002.
- US1: T011 acceptance cases and T012 registration use separate files after foundation.
- US2: T019 selection/isolation cases and T020 local loader can proceed against shared contracts.
- US3: T026 local boundary cases and T027 worker pi integration have separate concerns.
- US4: T035 persistence scenarios and T036 conversation implementation use separate files.
- US5: T041 control scenarios and T042 cancellation implementation use separate files.

Tests should demonstrate failure before the corresponding behavior is implemented. Parallel
examples describe implementation scheduling, not a requirement to launch additional agents.

## Requirement Coverage

| Requirement | Tasks |
|---|---|
| FR-001 | T011–T018 |
| FR-002 | T019–T025 |
| FR-003 | T005, T007, T022, T027, T036 |
| FR-004 | T006, T008–T010, T019, T024, T045, T048 |
| FR-005 | T026, T030–T033, T048 |
| FR-006 | T027–T033 |
| FR-007 | T035–T040, T045 |
| FR-008 | T007–T010, T011, T016–T018, T028, T034 |
| FR-009 | T007, T028, T039, T041–T045 |
| FR-010 | T025, T030, T035–T043 |
| FR-011 | T008–T010, T012–T013, T017, T021, T029, T044, T048 |
| FR-012 | T038–T043, T046 |
| FR-013 | T022, T038, T041, T046 |
| FR-014 | T024, T033, T040 |
| FR-015 | T007–T008, T025, T029, T032, T034, T039, T044 |
| SC-001 | T018, T024, T045 |
| SC-002 | T010, T024, T045, T048 |
| SC-003 | T033, T037, T040 |
| SC-004 | T040, T045 |
| SC-005 | T010, T034, T041, T045 |
| SC-006 | T034, T039–T045 |

## Implementation Strategy

Start with T001 and T002. Deliver administrator preparation as the first independently
demonstrable slice. Continue through US3 for a useful coding demonstration. Complete all
remaining stories and live acceptance before describing AgentX as ready for team use.

Automatic checkpoints, Dev Container integration, nested Docker/Compose, autonomous offline
orchestration, parallel coding within one checkout, environment migration, workspace deletion,
automated merges and application deployment belong in later feature specifications.
