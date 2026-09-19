---
description: "Dependency-ordered implementation tasks for AgentX pull-request creation"
---

# Tasks: Create Pull Request

**Input**: Design documents from `specs/002-create-pull-request/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Behavioral tests are required by the specification's acceptance and success criteria.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Fix the feature boundary and prepare shared contracts.

- [X] T001 Record the `publish` operation, request/result validation, and worker invocation schemas in `packages/contracts/src/operation.ts`, `packages/contracts/src/protocol.ts`, and `tests/contract/contracts.test.ts`
- [X] T002 [P] Extend exact repository grants with verbatim access constraint `clone | push` and denial tests in `packages/broker/src/repository-access.ts` and `tests/contract/admin-preparation.test.ts`
- [X] T003 [P] Extract credential-safe Git askpass execution shared by clone and push in `packages/worker/src/git-auth.ts`, `packages/worker/src/prepare.ts`, and `tests/contract/git-safety.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add least-privilege GitHub primitives and publication transport used by every story.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 Add tests for contents-write token scoping, pull-request-only token scoping, canonical PR response validation, and no-body error redaction in `tests/contract/github-app.test.ts`
- [X] T005 Implement permission-scoped installation tokens plus find-or-create pull-request reconciliation in `packages/broker/src/github-app.ts`
- [X] T006 [P] Add worker push-credential and pull-request callback client contracts in `packages/worker/src/repository-credentials.ts`, `packages/worker/src/callback-client.ts`, and `tests/contract/repository-credentials.test.ts`

**Checkpoint**: Access scopes, credential handling, and external PR reconciliation are independently testable.

---

## Phase 3: User Story 1 - Publish Validated Workspace Changes (Priority: P1) 🎯 MVP

**Goal**: Turn one changed configured repository into one validated, ready-for-review pull request.

**Independent Test**: Prepare a temporary Git repository, make one change, publish through fixture
Git/pull-request sinks, and verify one branch, commit, and complete PR result.

### Tests for User Story 1

- [X] T007 [P] [US1] Add real-Git successful publication and registered-check evidence tests in `tests/integration/pull-request-publication.test.ts`
- [X] T008 [P] [US1] Add durable broker route, ownership, fence, outbox, and internal PR callback contract tests in `tests/contract/cloud-handlers.test.ts`
- [X] T009 [P] [US1] Add direct CLI and local orchestration-tool contract tests in `tests/contract/cli-execution.test.ts`, `tests/contract/cli-main.test.ts`, and `tests/contract/orchestrator-boundary.test.ts`

### Implementation for User Story 1

- [X] T010 [US1] Implement worker checks, deterministic branch, AgentX commit, non-force push, and PR callback in `packages/worker/src/publish.ts` and export it from `packages/worker/src/index.ts`
- [X] T011 [US1] Dispatch `publish` invocations without starting Pi in `packages/worker/src/main.ts`
- [X] T012 [US1] Implement authenticated publish acceptance, exact-repository grants, atomic writer fencing/outbox, and internal PR reconciliation in `packages/broker/src/aws/broker.ts`
- [X] T013 [US1] Add publication calls and terminal waiting to `packages/cli/src/control-plane-api.ts` and `packages/cli/src/pull-request.ts`
- [X] T014 [US1] Add `agentx --project <name> pr create --repository --title [--body]` routing and stable output in `packages/cli/src/main.ts` and `packages/cli/src/output.ts`
- [X] T015 [US1] Add `agentx_create_pull_request` to the local-only orchestration allowlist and explicit-publication prompt boundary in `packages/cli/src/orchestration-tools.ts` and `packages/cli/src/orchestrator.ts`

**Checkpoint**: A single changed repository can be published from direct CLI or local Pi with complete result metadata.

---

## Phase 4: User Story 2 - Block Unsafe or Unverified Publication (Priority: P2)

**Goal**: Guarantee failed checks, conflicts, empty diffs, bad repository selection, and missing permission cause no publication.

**Independent Test**: Exercise every pre-publication failure and assert zero push/PR sink calls and bounded redacted errors.

### Tests for User Story 2

- [X] T016 [P] [US2] Add failed/timed-out check, unresolved-conflict, empty-diff, and cross-repository no-side-effect tests in `tests/integration/pull-request-publication.test.ts`
- [X] T017 [P] [US2] Add invalid title/body/repository, unauthorized owner, busy workspace, and permission-denial contract tests in `tests/contract/contracts.test.ts`, `tests/contract/authorization.test.ts`, and `tests/contract/github-app.test.ts`

### Implementation for User Story 2

- [X] T018 [US2] Enforce pre-side-effect validation, bounded check output, conflict/empty detection, and repository containment in `packages/worker/src/publish.ts`
- [X] T019 [US2] Enforce request validation, registered repository selection, owner-not-found behavior, and busy denial before durable acceptance in `packages/broker/src/aws/broker.ts`

**Checkpoint**: Every specified invalid or unverified case is proven to create no external side effect.

---

## Phase 5: User Story 3 - Retry Without Duplicate Pull Requests (Priority: P3)

**Goal**: Make accepted request retries and ambiguous external outcomes converge to one publication.

**Independent Test**: Replay the same request three times, inject a timeout after push/PR creation,
and verify one operation, branch, commit, and PR; changed payload with the same ID conflicts.

### Tests for User Story 3

- [X] T020 [P] [US3] Add three-replay idempotency, payload-conflict, existing-branch, and post-create-timeout reconciliation tests in `tests/integration/pull-request-publication.test.ts` and `tests/contract/github-app.test.ts`

### Implementation for User Story 3

- [X] T021 [US3] Reconcile deterministic local branch/commit and treat identical non-force pushes as success in `packages/worker/src/publish.ts`
- [X] T022 [US3] Reconcile existing head/base pull requests before and after ambiguous creation failures in `packages/broker/src/github-app.ts` and preserve non-secret result state in `packages/broker/src/aws/broker.ts`

**Checkpoint**: All retry paths converge and conflicting reuse is rejected.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validate security, infrastructure, documentation, and live prerequisites.

- [X] T023 [P] Update user workflow, GitHub App Contents/Pull requests write permission instructions, and non-goals in `README.md` and `specs/002-create-pull-request/quickstart.md`
- [X] T024 [P] Assert the broker alone retains exact-secret access and the runtime receives no GitHub secret environment in `tests/contract/infrastructure.test.ts`
- [X] T025 Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run infra:synth:demo`; record corrections in affected source/tests and check off completed tasks in `specs/002-create-pull-request/tasks.md`
- [X] T026 Build and health-check the ARM64 worker image, then deploy and run live acceptance only after the GitHub App permission upgrade is approved, recording evidence in `specs/002-create-pull-request/quickstart.md`

  Local build and `/ping` health check passed on 2026-09-19. The control plane and runtime were
  deployed, schema-v2 workspaces were prepared, and the live empty-diff guard passed. After the
  installation owner approved Contents and Pull requests write permissions, changed-diff operation
  `201e1ceb-1f0d-47f5-8ee1-0eba290ecd18` created private-repository PR #1 successfully. The test PR
  was then closed without merging.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup**: Starts immediately.
- **Foundational**: Depends on shared contracts from T001–T003 and blocks user stories.
- **US1**: Depends on T004–T006 and delivers the MVP.
- **US2**: Builds on US1 publication stages but has independent no-side-effect acceptance.
- **US3**: Builds on US1 identifiers and GitHub reconciliation; can proceed alongside US2 after US1.
- **Polish**: Depends on all selected stories. Live deployment additionally depends on external App permission approval.

### Parallel Opportunities

- T002 and T003 are independent after the contract shape is agreed.
- T006 can proceed alongside T004/T005 using the written contracts.
- T007, T008, and T009 are independent test surfaces.
- T016 and T017 cover separate worker/broker boundaries.
- T020 retry tests can be written while US2 hardening is implemented.
- T023 and T024 touch documentation and infrastructure tests independently.

## Parallel Example: User Story 1

```text
Task: T007 real-Git worker publication integration tests
Task: T008 durable broker/internal callback contract tests
Task: T009 CLI and local orchestration-tool contract tests
```

## Implementation Strategy

### MVP First

1. Complete T001–T006.
2. Write T007–T009 before implementation and confirm the new cases fail.
3. Complete T010–T015.
4. Validate US1 independently before hardening retry and denial cases.

### Incremental Delivery

1. Contracts and credential boundary.
2. Successful one-repository publication.
3. Pre-side-effect denial guarantees.
4. Retry/external reconciliation.
5. Documentation, full local gates, then permission-gated live deployment.

## Notes

- Every task follows the required checkbox, ID, optional parallel marker, story label, and file-path format.
- Do not broaden this feature to merge, approval, draft metadata, reviewers, labels, branch deletion,
  multi-repository coordination, or external CI orchestration.
