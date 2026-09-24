# Feature Specification: Continue a Conversation Through the Task Path

**Feature Branch**: `feat/conversation-continuity`

**Created**: 2026-09-24

**Status**: Implemented locally; not validated on a deployed runtime

**Input**: Issue #1: "Fix task-path conversation continuity: reopen saved Pi sessions with stable workspace-scoped IDs."

**Constitution**: Version 2.0.0. No principle changes. Principle IV already requires that pi
conversation state persist independently of the worker process and that reconnects resume it
without resetting code; this feature makes the task path obey it.

## Context

Everything a follow-up turn needs already exists and nothing connects it. The control plane creates
a durable `CONVERSATION` record per workspace, refuses a task whose conversation is not registered
there, and puts `conversationId` in the worker invocation. The worker has
`WorkspaceConversationStore`, a workspace-local manifest from conversation ID to session file, and
`openRegisteredWorkspacePiSession`, which reopens a saved Pi session. The Slack service already
keeps one conversation ID per thread.

`runTaskInvocation` ignores all of it and calls `createWorkspacePiSession` for every task. The
second turn of a thread starts with an empty transcript on top of the first turn's files, so the
model sees changed code it has no memory of making. The existing resumption test exercises the
helpers with a fixture adapter, never the task path, so nothing fails.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Follow-Up Continues the Same Conversation (Priority: P1)

A developer says "use the existing button style for this work", the task completes, their client
disconnects and reconnects, and they say "now add the Done filter". The second task reopens the
first task's session and the workspace's files are untouched.

**Acceptance Scenarios**:

1. **Given** a conversation whose first task finished, **When** a second task arrives for it,
   **Then** the worker opens the saved session and never creates a second one.
2. **Given** the worker process was replaced between the two tasks, **When** the second task
   arrives, **Then** it still reopens that session, because the mapping is on the workspace volume.
3. **Given** Pi's internal session ID differs from the conversation ID, **When** events, results
   and the manifest are written, **Then** all of them carry the control plane's conversation ID.

### User Story 2 - Lost Context Is Reported, Never Papered Over (Priority: P1)

A conversation the control plane records as started arrives at a workspace that cannot produce its
transcript. The task fails with a typed error instead of starting the thread over silently.

**Acceptance Scenarios**:

1. **Given** the control plane says the conversation started, **When** the workspace has no mapping
   for it, **Then** the task fails `CONVERSATION_STATE_LOST` before any model call.
2. **Given** a registered conversation whose transcript file is missing or unreadable, **When** a
   task arrives, **Then** it fails the same way rather than creating a session.
3. **Given** a conversation created before this feature shipped, **When** its next task arrives,
   **Then** it starts a session normally, because "started" is a recorded attribute and not an
   inference from absence.

### User Story 3 - A Reopened Conversation Is Context, Not Authority (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a mapping that points outside the workspace session directory, by relative path or
   through a symlink, **When** a task tries to use it, **Then** it is rejected before the model
   runs.
2. **Given** a different conversation in the same workspace, **When** its task runs, **Then** it
   gets its own session and the source files are not reset.
3. **Given** a cancelled turn, **When** the next task arrives, **Then** it reopens the conversation
   and the cancelled prompt is not replayed.

## Requirements *(mandatory)*

- **FR-001**: The task path MUST resolve `payload.conversationId` against the workspace manifest and
  reopen the registered session when one exists.
- **FR-002**: On a conversation's first task the worker MUST create exactly one session and register
  the mapping before sending the prompt.
- **FR-003**: A failed resolution MUST NOT fall back to creating a session.
- **FR-004**: The control plane MUST record, once, that a conversation owns a session, and MUST tell
  each task whether its conversation has already started.
- **FR-005**: The worker MUST fail `CONVERSATION_STATE_LOST` when the control plane says started and
  the workspace cannot produce the transcript.
- **FR-006**: The public conversation ID MUST appear unchanged in the invocation, the lifecycle and
  result events, and the manifest, whatever Pi calls the session internally.
- **FR-007**: Session paths MUST stay server-owned and inside `agent-sessions`, checked after
  symlink resolution.
- **FR-008**: Events and operation results MUST NOT carry the transcript's real path.
- **FR-009**: The manifest MUST record the model a transcript was built on, and a turn that runs on
  another model MUST be reported to the thread.
- **FR-010**: Existing per-workspace fencing, ownership, cancellation and authorization checks are
  unchanged; a restored transcript grants nothing.

## Success Criteria *(mandatory)*

- **SC-001**: Two tasks through `runTaskInvocation` with one conversation ID produce one session
  file containing both prompts, with a test adapter that fails if `create` runs twice.
- **SC-002**: Every recovery failure is a typed error; no path silently starts a new transcript.
- **SC-003**: Conversations that predate the change keep working without a backfill.

## Decisions

- **The authoritative "started" marker is a `startedAt` attribute on the DynamoDB `CONVERSATION`
  item**, set by the worker's first lifecycle event and read into the task payload. The workspace
  manifest alone cannot distinguish "never started" from "volume replaced". Decided 2026-09-24.
- **No backfill.** Conversations registered before this ships carry no `startedAt`, so their next
  task creates a session. Gating on the attribute's presence, never on its absence meaning started,
  is what keeps them out of the fail-closed path.
- **The deployed model wins on a model change**, and the stored model exists to detect and report
  it. A stack update is allowed to move live conversations; a hard freeze would strand them.
- **No summary replay, no vector store, no second memory service.** Reopening the saved session is
  the whole fix; a summary can omit context and must never be presented as exact continuation.

## Assumptions and Scope

- Supported restart boundary: client reconnect, and worker-process replacement with the workspace
  volume retained. A conversation does not survive losing the volume, and that case is reported
  rather than hidden.
- The release order already covers the window: `scripts/release-production.ts` deploys the runtime
  before the control plane, so the new worker, which accepts the optional `conversationStarted`
  field, is running before any broker sends it. Reversing that order would fail every task in the
  window, because the task payload is strict.
- Whether Pi reopens a transcript whose last turn is an unanswered `tool_use` block is **UNKNOWN**
  and untested here. It is the likeliest production failure; `reconcile.ts` is where a trailing
  incomplete turn would be truncated.
- Deployed acceptance is not claimed. No live task was invoked for this change.
