# Tasks: Close Slack Thread Workspace

**Input**: Design documents from `specs/008-close-workspace/`
**Tests**: Required by the specification and constitution for isolation, retries, fencing, and resumption.

## Phase 1: Setup

- [x] T001 Create feature specification, research, data model, contracts, quickstart, and requirements checklist in `specs/008-close-workspace/`
- [x] T002 Verify existing TypeScript, Docker, ESLint, and npm ignore configuration for the unchanged monorepo structure in `.gitignore`, `.dockerignore`, and `eslint.config.js`

---

## Phase 2: Foundational Contracts

- [x] T003 Add `CLOSING` and `CLOSED` workspace lifecycle fields and close preflight/result schemas in `packages/contracts/src/workspace.ts` and `packages/contracts/src/slack.ts`
- [x] T004 Add `close` operation and worker invocation variants in `packages/contracts/src/operation.ts` and `packages/contracts/src/protocol.ts`
- [x] T005 [P] Add contract coverage for strict close schemas and legacy workspace compatibility in `tests/contract/slack-contracts.test.ts`

**Checkpoint**: Broker, worker, and Slack service share strict close contracts.

---

## Phase 3: User Story 1 - Close a clean workspace from Slack (Priority: P1)

**Goal**: A clean, idle thread workspace closes from an explicit message and releases its capacity-provider session.

**Independent Test**: Process a close message for a clean prepared workspace and verify preflight, one session deletion, closed state, state cleanup, and a same-thread confirmation.

- [x] T006 [P] [US1] Add close-command recognition and processor tests that prove it bypasses model execution and workspace creation in `tests/integration/slack-service.test.ts`
- [x] T007 [P] [US1] Add clean repository preflight tests in `tests/integration/workspace-close.test.ts`
- [x] T008 [P] [US1] Add broker close start/completion, AgentCore deletion, and same-thread isolation tests in `tests/contract/slack-control-plane.test.ts`
- [x] T009 [US1] Implement bounded repository close preflight in `packages/worker/src/close-workspace.ts` and route it from `packages/worker/src/main.ts`
- [x] T010 [US1] Implement broker close start/completion routes, fencing, callback handling, tombstone creation, and delete-session dependency in `packages/broker/src/aws/broker.ts`
- [x] T011 [US1] Add `DeleteCapacityProviderSession` IAM permission in `infra/lib/control-plane.ts`
- [x] T012 [US1] Add close API calls, explicit command routing, progress messages, and conversation-session cleanup in `packages/slack-service/src/processor.ts` and `packages/slack-service/src/main.ts`

**Checkpoint**: A clean production workspace closes without invoking the orchestrator model.

---

## Phase 4: User Story 2 - Protect unpublished and active work (Priority: P2)

**Goal**: Busy or unpublished workspaces retain storage and explain the block.

**Independent Test**: Attempt closure during another operation and with every unpublished-work category; verify zero session deletions and a usable retained workspace.

- [x] T013 [P] [US2] Extend worker tests for uncommitted, untracked, unpushed HEAD, and unpushed local branch findings in `tests/integration/workspace-close.test.ts`
- [x] T014 [P] [US2] Extend broker tests for busy refusal, close fencing, unsafe callback recovery, and queued task rejection in `tests/contract/slack-control-plane.test.ts`
- [x] T015 [US2] Return unsafe preflight results to the prior runnable state without permitting cleanup in `packages/broker/src/aws/broker.ts`
- [x] T016 [US2] Render bounded repository-level unpublished-work guidance in `packages/slack-service/src/processor.ts`

**Checkpoint**: No active or dirty workspace can lose storage.

---

## Phase 5: User Story 3 - Retry safely and keep the thread closed (Priority: P3)

**Goal**: Redelivery and partial failure converge on one closed tombstone and later messages remain closed.

**Independent Test**: Repeat and interrupt closure, then send a later message; verify one cleanup, one quota release, and no replacement workspace.

- [x] T017 [P] [US3] Add retry, already-absent session, quota, and closed-resolution tests in `tests/contract/slack-control-plane.test.ts`
- [x] T018 [P] [US3] Add duplicate close and later-message tests in `tests/integration/slack-service.test.ts`
- [x] T019 [US3] Make close idempotency and quota release transactional in `packages/broker/src/aws/broker.ts`
- [x] T020 [US3] Persist closed Slack thread state, remove its S3 session object, and refuse later model turns in `packages/slack-service/src/main.ts` and `packages/slack-service/src/processor.ts`

**Checkpoint**: Retries converge and closed threads never recreate resources implicitly.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T021 [P] Document the close command, unpublished-work block, retention, and fresh-workspace boundary in `README.md`
- [x] T022 Run focused contract and integration tests for close behavior using `npm test -- --run tests/contract/slack-contracts.test.ts tests/contract/slack-control-plane.test.ts tests/integration/workspace-close.test.ts tests/integration/slack-service.test.ts`
- [x] T023 Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run infra:synth`
- [x] T024 Reconcile implementation against `specs/008-close-workspace/spec.md`, record validation evidence in `specs/008-close-workspace/quickstart.md`, and mark completed tasks

## Dependencies & Execution Order

- Phase 1 precedes all contract and implementation work.
- T003–T005 block worker, broker, and Slack implementation.
- US1 is the MVP and blocks the safety and retry refinements.
- US2 depends on the close preflight and broker state transition from US1.
- US3 depends on the closed tombstone and cleanup path from US1.
- Documentation and full validation follow all stories.

## Parallel Opportunities

- T005 can proceed beside initial implementation once T003–T004 define schemas.
- Within US1, T006–T008 cover different test files and can be prepared independently.
- T013 and T014 cover worker and broker safety independently.
- T017 and T018 cover broker and Slack retry behavior independently.
- T021 can proceed after externally visible behavior stabilizes.

## Implementation Strategy

Implement the P1 path first: strict contracts, exact command recognition, fenced clean preflight, capacity-session deletion, and same-thread confirmation. Then add the P2 deletion blocks and P3 convergence behavior before documenting or claiming completion.
