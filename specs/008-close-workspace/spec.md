# Feature Specification: Close Slack Thread Workspace

**Feature Branch**: `feature/024-close-workspace`

**Created**: 2026-09-24

**Status**: Implemented; owner-authorized discard extension in progress

**Input**: User description: "Issue #24: close a workspace from its attached Slack thread and release its resources."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Close a clean workspace from Slack (Priority: P1)

A channel member asks AgentX to close the workspace from the Slack thread that owns it. AgentX checks that the workspace contains no unpublished work, releases its dedicated runtime and persistent storage, and confirms completion in that same thread.

**Why this priority**: This is the requested resource-release path and prevents workspaces from consuming persistent resources indefinitely.

**Independent Test**: Create a clean thread workspace, send `close this workspace` in that thread, and verify that its dedicated resources are deleted and the completion response is posted to the same thread.

**Acceptance Scenarios**:

1. **Given** a ready, clean workspace owned by a Slack thread, **When** a channel member asks AgentX in that thread to close it, **Then** AgentX fences new work, verifies the workspace, releases its runtime session and persistent storage, records it as closed, and confirms completion in the thread.
2. **Given** no workspace has ever existed for a Slack thread, **When** a user asks to close it, **Then** AgentX explains that there is no workspace to close and does not create one.
3. **Given** a close request from another thread or an unauthorized caller, **When** it targets a workspace, **Then** no workspace information or resources are exposed or changed.

---

### User Story 2 - Protect unpublished and active work (Priority: P2)

A user cannot accidentally delete a workspace while work is running or while repository changes exist only in that workspace.

**Why this priority**: Resource deletion is irreversible and must preserve the constitution's durable-work and single-writer guarantees.

**Independent Test**: Attempt closure for busy and dirty workspaces and verify that storage remains, new work cannot race a close in progress, and Slack explains how to resolve the block.

**Acceptance Scenarios**:

1. **Given** a workspace with an active operation, **When** a user asks to close it, **Then** closure is refused with a clear message and no resource is deleted.
2. **Given** a workspace with uncommitted, untracked, or unpushed repository work, **When** closure preflight runs, **Then** deletion is blocked, the workspace returns to an available state, and Slack identifies the repositories that require publication or cleanup.
3. **Given** closure has fenced a workspace, **When** a queued or concurrent task tries to start, **Then** that task cannot acquire the workspace or write to its storage.

---

### User Story 3 - Retry safely and keep the thread closed (Priority: P3)

Repeated delivery, partial cleanup failures, and later messages preserve one understandable closed lifecycle rather than duplicating cleanup or recreating resources.

**Why this priority**: Slack and cloud operations are retried, so closure must remain safe across failures and redelivery.

**Independent Test**: Redeliver the close event, inject a cleanup failure, retry it, and send a later ordinary mention; verify one deletion, an accurate final status, and no automatic replacement workspace.

**Acceptance Scenarios**:

1. **Given** the same close event is delivered more than once, **When** it is processed, **Then** AgentX reuses the same close operation and never deletes another workspace.
2. **Given** resource deletion succeeds but recording completion is interrupted, **When** the close is retried, **Then** already-absent resources are treated as cleaned up and the workspace reaches the closed state.
3. **Given** a workspace is closed, **When** a later message arrives in its Slack thread, **Then** AgentX says the workspace is closed and does not create or resume a workspace.

### User Story 4 - Explicitly discard unpublished work while closing (Priority: P2)

The workspace owner can explicitly request that AgentX discard unpublished repository state and close the isolated workspace. AgentX records the requester and the preflight findings, then deletes the workspace's dedicated compute and storage through the normal fenced close lifecycle. Ordinary close requests continue to refuse unpublished work.

**Independent Test**: With uncommitted, untracked, and unpushed changes in a workspace, request `discard unpublished work and close this workspace` as the Slack thread starter or call the developer-task close tool with `discard_unpublished: true`. Verify only that owner's workspace closes, storage is deleted once, counters are released once, and the durable task/operation audit remains.

**Acceptance Scenarios**:

1. **Given** an idle workspace contains unpublished work, **When** its authenticated owner explicitly requests discard and close, **Then** AgentX records the request and preflight findings, fences the workspace, deletes its dedicated compute and storage, and marks it closed.
2. **Given** an ordinary close request contains no discard authorization, **When** preflight finds unpublished work, **Then** AgentX keeps the workspace and its storage and reports the findings as before.
3. **Given** a Slack member other than the thread starter requests discard, **When** AgentX receives the request, **Then** it refuses without starting deletion or exposing workspace findings.
4. **Given** a discard close is retried or its completion races, **When** AgentX processes the repeat, **Then** it reuses the existing close operation and releases storage and quota at most once.

### Edge Cases

- A close message arrives while preparation, a task, publication, maintenance, resume, or cancellation owns the workspace.
- A second close message arrives while the preflight operation is running or after preflight succeeded but resource deletion has not completed.
- One repository is clean while another contains uncommitted, untracked, local-only, or unpushed commits.
- The runtime session or persistent volume is already absent during a retry.
- The Slack channel is rebound or unbound between workspace creation and closure.
- Cleanup of orchestrator conversation state fails after the workspace resources were deleted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: AgentX MUST recognize an explicit request to close the workspace from a message in the Slack thread that owns it.
- **FR-002**: A close request MUST resolve the workspace exclusively from the authenticated team, channel, and thread identity; it MUST NOT accept a workspace identifier from Slack message text.
- **FR-003**: A close request for a thread without an existing workspace MUST NOT create a workspace.
- **FR-004**: Any channel member whose signed Slack event is accepted for the bound project MAY request closure from the owning thread.
- **FR-005**: AgentX MUST refuse to begin closure while another operation owns the workspace and MUST leave that operation and its resources unchanged.
- **FR-006**: Beginning closure MUST durably fence the workspace before checking its contents so no new mutating operation can race resource deletion.
- **FR-007**: The closure preflight MUST inspect every prepared repository for uncommitted changes, untracked files, commits not reachable from any configured remote, and local branches containing commits not reachable from any configured remote.
- **FR-008**: If unpublished work is found, AgentX MUST retain the workspace and its storage, return it to an available state, and identify the affected repositories in the Slack response. Automatic preservation is deferred to Issue #4.
- **FR-009**: If preflight succeeds, AgentX MUST delete the dedicated capacity-provider session that owns the production EBS volume. A stopped runtime alone does not satisfy closure.
- **FR-010**: AgentX MUST retain a durable closed workspace tombstone, its operation history, and its thread binding while removing ephemeral orchestrator conversation state.
- **FR-011**: AgentX MUST release the workspace's organization and starter-member quota exactly once after resource deletion succeeds.
- **FR-012**: Closure MUST be idempotent for Slack redelivery, repeated close messages, worker callback retries, already-absent cloud resources, and interrupted state recording.
- **FR-013**: AgentX MUST report preflight progress, blocked closure, cleanup failure, and successful closure in the original Slack thread.
- **FR-014**: Later messages in a closed thread MUST receive a closed-workspace response and MUST NOT provision a replacement. Creating a fresh workspace in that thread is outside this feature.
- **FR-015**: Other threads, personal identities, and callers other than the configured Slack orchestrator role MUST NOT close or discover the workspace.
- **FR-016**: The demo deployment mode MUST record closure and remove its resumable orchestrator state, while clearly reporting that the platform provides no production EBS session to delete.
- **FR-017**: A separate, explicit owner-authorized discard-and-close action MAY remove unpublished repository state by deleting the isolated workspace storage through the existing fenced close lifecycle. Ordinary close MUST retain its existing unpublished-work refusal.
- **FR-018**: Slack discard-and-close MUST require the thread starter; developer-task discard-and-close MUST require the task owner. The accepted close operation MUST durably record that discard was explicitly authorized, its requester, and the close preflight result.
- **FR-019**: Discard-and-close MUST NOT invoke coding tools or mutate/publish repository contents. It MUST delete only the exact workspace's dedicated compute and storage, and preserve the durable task/operation audit and quota/idempotency guarantees.

### Key Entities

- **Workspace**: The thread-owned writable environment. It gains closing and closed lifecycle states, closure timestamps, and the close operation that fenced it.
- **Close Operation**: An idempotent, requester-attributed operation that performs the unpublished-work preflight before resource deletion.
- **Close Preflight Result**: A bounded list of repository findings indicating whether deletion is safe.
- **Slack Thread Record**: The retained association between the Slack thread, its starter, and the closed workspace tombstone.
- **Workspace Quota Record**: Organization and starter-member counters adjusted once when closure completes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every accepted close request for a clean, idle production workspace deletes its dedicated persistent-storage session and posts confirmation in the originating thread.
- **SC-002**: In automated concurrency tests, zero tasks acquire a workspace after it enters closing state and zero busy or dirty workspaces lose storage.
- **SC-003**: Replaying the same close request at least ten times produces one close operation, one quota release, and one closed workspace tombstone.
- **SC-004**: All tested unauthorized and cross-thread close requests leave the target workspace unchanged and reveal no target metadata.
- **SC-005**: A later ordinary message in every tested closed thread creates zero worker operations and zero replacement workspaces.

## Assumptions

- An exact, case-insensitive `close this workspace` or `close workspace` instruction, after removing the leading app mention and surrounding punctuation, is the initial close command.
- Busy workspaces are not cancelled automatically; users must wait for or cancel active work before retrying closure.
- Issue #4 will add preservation. Until then, detection of any unpublished work blocks deletion.
- Cloud deletion APIs may report an already-absent session on retry; this is treated as successful cleanup.
- The existing Slack ingress membership check and signed service identity remain the authority for channel membership.
