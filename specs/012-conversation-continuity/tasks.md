# Tasks: Continue a Conversation Through the Task Path

**Input**: Design documents from `/specs/012-conversation-continuity/`

## Phase 1: Failing tests on the real task path

- [X] T001 Add `tests/integration/conversation-continuity.test.ts` driving `runTaskInvocation` twice on one conversation ID, with an adapter that records creates and opens
- [X] T002 Cover lost state, escapes, a second conversation, cancellation, a model change and a schema-1 manifest in the same file

## Phase 2: Contracts

- [X] T003 Add the `CONVERSATION_STATE_LOST` error code
- [X] T004 Add the optional `conversationStarted` field to the task payload

## Phase 3: Worker

- [X] T005 Move the conversation manifest to schema 2 with a recorded model, reading 1 and 2
- [X] T006 Add `tryResolve` and `recordTurn`, and resolve the session directory through symlinks
- [X] T007 Report a missing transcript as `CONVERSATION_STATE_LOST`, and carry the public conversation ID into a newly created session
- [X] T008 Resolve, reopen or register in `runTaskInvocation`, register before the prompt, and never fall back to create
- [X] T009 Keep the transcript path out of the events and the operation result

## Phase 4: Control plane

- [X] T010 Pass `conversationStarted` from the `CONVERSATION` record into the task invocation
- [X] T011 Mark `startedAt` once from the worker's lifecycle event
- [X] T012 Cover both in `tests/contract/slack-control-plane.test.ts`

## Phase 5: Documentation

- [X] T013 State the retention and recovery boundary in the README
- [X] T014 Record the spec, plan and tasks
- [X] T015 Say in both release scripts why the control plane deploys last, and lock the order with a test in `tests/contract/release-command.test.ts`

## Not done

- [ ] T016 Truncate a trailing incomplete turn on reopen, if Pi or Bedrock rejects a transcript that ends in an unanswered `tool_use` block. Behaviour is unverified; `reconcile.ts` is the place.
- [ ] T017 Deployed two-turn acceptance, after separate deployment authorization: a unique first-turn instruction, a disconnect and reconnect, and evidence of the reopen, with the image digest and commit recorded.

## Evidence

- `npm run typecheck`, `npm run lint` and `npx vitest run` (46 files, 271 tests) pass locally on Node 22.23.2.
- The new worker tests were confirmed to fail against the previous `run-task.ts` (8 of 9), the new control-plane test against the previous `broker.ts`, and the release-order test against a deliberately reordered script.
- Rebased onto the close-workspace (#26) and usage-telemetry (#28) merges. `tests/integration/worker-usage.test.ts` asserted that the task result carried Pi's internal session ID; it now asserts the broker's conversation ID, which is what FR-006 changes.
- No AWS call was made and no deployment was performed. Nothing here is evidence of deployed behaviour.
