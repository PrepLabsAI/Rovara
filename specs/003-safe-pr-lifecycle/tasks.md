# Tasks: Safe Pull Request Lifecycle

**Input**: Design documents from `/specs/003-safe-pr-lifecycle/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Contract and integration tests are required by FR-017 and precede implementation.

**Organization**: Tasks are grouped by independently testable user story.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish shared lifecycle vocabulary and safety assertions.

- [X] T001 Add failing lifecycle request/result schema coverage for all actions and conditional constraints in `tests/contract/contracts.test.ts`
- [X] T002 [P] Add failing no-force push argument/refspec coverage in `tests/contract/git-safety.test.ts`
- [X] T003 Define pull-request lifecycle request, state, result, and operation-kind schemas in `packages/contracts/src/operation.ts`
- [X] T004 Define clean publish modes and maintain worker invocation variants in `packages/contracts/src/protocol.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add durable PR identity, GitHub state APIs, and credential-safe transport shared by all stories.

- [X] T005 Add failing GitHub lookup/update/state transition and permission-scope tests in `tests/contract/github-app.test.ts`
- [X] T006 Implement canonical GitHub pull-request lookup and metadata/state update operations in `packages/broker/src/github-app.ts`
- [X] T007 Add durable `PullRequestRecord` persistence and expected-head validation helpers in `packages/broker/src/aws/broker.ts`
- [X] T008 Enforce rejection of force flags and plus-prefixed refspecs in `packages/worker/src/git-auth.ts`
- [X] T009 Extend scoped callback and repository-grant capabilities for lifecycle actions in `packages/broker/src/aws/broker.ts`, `packages/worker/src/callback-client.ts`, and `packages/worker/src/repository-credentials.ts`

**Checkpoint**: Lifecycle actions have a durable, ownership-checked identity and no-force transport boundary.

---

## Phase 3: User Story 1 - Publish Only the Intended Workspace Difference (Priority: P1) 🎯 MVP

**Goal**: New PRs start at latest remote base, contain one commit, and never inherit prior AgentX publication ancestry.

**Independent Test**: Publish from a stale AgentX branch in a disposable repository and prove the new head has the fetched base as parent and one current workspace-difference commit.

- [X] T010 [US1] Add failing stale-branch, concurrent-base, conflict, empty-diff, and retry integration cases in `tests/integration/pull-request-publication.test.ts`
- [X] T011 [US1] Implement credentialed fetch plus workspace-tree capture and three-way replay onto the preparation baseline/latest base in `packages/worker/src/publish.ts`
- [X] T012 [US1] Remove empty publication commits and create exactly one clean AgentX commit in `packages/worker/src/publish.ts`
- [X] T013 [US1] Persist successful create publication identity and head evidence from the callback in `packages/broker/src/aws/broker.ts`

**Checkpoint**: The reported stale commit regression is independently fixed and verified.

---

## Phase 4: User Story 2 - Safely Maintain an Open Pull Request (Priority: P2)

**Goal**: Append checked changes, merge the latest base, edit metadata, and close/reopen the same eligible PR without history rewriting.

**Independent Test**: Update one disposable open PR through every action and prove branch transitions are fast-forward-only and PR identity is stable.

- [X] T014 [US2] Add failing lifecycle route authorization, idempotency, stale-head, and metadata/state contract cases in `tests/contract/cloud-handlers.test.ts`
- [X] T015 [US2] Add failing append/sync fast-forward and conflict integration cases in `tests/integration/pull-request-maintenance.test.ts`
- [X] T016 [US2] Implement append and merge-based sync execution with readiness gates in `packages/worker/src/maintain-pull-request.ts` and dispatch it from `packages/worker/src/main.ts`
- [X] T017 [US2] Implement lifecycle acceptance, ownership checks, worker dispatch, callbacks, and broker-completed edit/close/reopen operations in `packages/broker/src/aws/broker.ts`
- [X] T018 [US2] Add lifecycle HTTP client methods and CLI `pr update|append|sync|close|reopen` commands in `packages/cli/src/control-plane-api.ts`, `packages/cli/src/pull-request.ts`, and `packages/cli/src/main.ts`
- [X] T019 [US2] Expose orchestration-only update/sync/close/reopen Pi tools with explicit non-force descriptions in `packages/cli/src/orchestration-tools.ts` and `packages/cli/src/orchestrator.ts`

**Checkpoint**: Open PR review feedback can be handled without creating a duplicate PR or rewriting history.

---

## Phase 5: User Story 3 - Replace a Pull Request That Needs Clean History (Priority: P3)

**Goal**: Create a clean replacement before closing the original PR.

**Independent Test**: Replace a disposable multi-commit PR and prove the new branch has one commit, the old branch is unchanged, and create-before-close ordering is enforced.

- [X] T020 [US3] Add failing replacement ordering, reconciliation, and ownership cases in `tests/contract/cloud-handlers.test.ts` and `tests/integration/pull-request-publication.test.ts`
- [X] T021 [US3] Implement replacement publish mode and result linkage in `packages/worker/src/publish.ts` and `packages/contracts/src/protocol.ts`
- [X] T022 [US3] Implement create-then-close reconciliation and bidirectional durable links in `packages/broker/src/aws/broker.ts` and `packages/broker/src/github-app.ts`
- [X] T023 [US3] Add CLI and local Pi replacement entry points in `packages/cli/src/main.ts` and `packages/cli/src/orchestration-tools.ts`

**Checkpoint**: Clean published history is available without force push.

---

## Phase 6: User Story 4 - Repair a Merged Pull Request (Priority: P4)

**Goal**: Create a reviewable revert PR for an eligible merged PR without changing the default branch directly.

**Independent Test**: Revert a merged disposable PR and prove the new PR inverses the merge while conflict and unmerged cases create no remote ref.

- [X] T024 [US4] Add failing merged-state, one/two-parent revert, and conflict cases in `tests/contract/github-app.test.ts` and `tests/integration/pull-request-maintenance.test.ts`
- [X] T025 [US4] Implement revert publication mode with parent detection, conflict abort, readiness checks, and non-force push in `packages/worker/src/publish.ts`
- [X] T026 [US4] Implement merged-PR reconciliation plus CLI and local Pi revert entry points in `packages/broker/src/aws/broker.ts`, `packages/cli/src/main.ts`, and `packages/cli/src/orchestration-tools.ts`

**Checkpoint**: Merged changes can be repaired only through a new reviewed PR.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T027 Update lifecycle usage, limitations, and recovery guidance in `README.md` and `specs/003-safe-pr-lifecycle/quickstart.md`
- [X] T028 Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run infra:synth:demo`; record evidence in `specs/003-safe-pr-lifecycle/quickstart.md`
- [ ] T029 Build/deploy the demo worker and control plane and run non-destructive live create/update/replace/revert acceptance in `specs/003-safe-pr-lifecycle/quickstart.md`

---

## Dependencies & Execution Order

- Setup T001–T004 blocks all implementation.
- Foundational T005–T009 blocks every user story.
- US1 fixes the regression and is the MVP.
- US2 depends on durable records produced by US1.
- US3 depends on clean publication from US1 and lifecycle identity from US2.
- US4 depends on lifecycle identity and clean publication but remains independently testable.
- Polish follows the selected stories.

## Parallel Opportunities

- T001 and T002 can run in parallel.
- T005 can be prepared while T007 record shapes are designed after schemas stabilize.
- Within US2, route contract cases and Git integration fixtures can be authored in parallel.
- US3 and US4 test fixtures touch different scenarios but implementation converges on shared files and must be sequenced there.

## Implementation Strategy

1. Deliver US1 first to stop stale-history publication.
2. Add ordinary open-PR maintenance in US2.
3. Add replacement semantics in US3 instead of any force-push escape hatch.
4. Add merged repair through revert PRs in US4.
5. Run full local gates before deployment; never use a live repository for destructive history tests.
