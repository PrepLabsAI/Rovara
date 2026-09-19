# Feature Specification: AgentX Foundation

**Feature Branch**: Not created; feature directory is `specs/001-agentx-foundation`.

**Created**: 2026-09-17

**Status**: Ready for implementation planning

**Input**: Build AgentX with a local pi orchestrator and remote pi coding workers on
AgentCore. Administrators prepare product environments before coding. Developers select
shared local project definitions with `--project`, but every writable workspace instance
is isolated. Preserve code and conversation across feedback and reconnects.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Administrator prepares a product (Priority: P1)

An administrator registers the product's fixed environment, repositories, setup instructions,
and access rules, then prepares a developer's isolated workspace before coding begins.

**Why this priority**: Every coding session depends on an already prepared project and workspace.

**Independent Test**: Prepare a sample product and one developer workspace, without submitting
a coding prompt; verify the starting files and readiness status. Repeat preparation safely.

**Acceptance Scenarios**:

1. **Given** an administrator-defined product, **When** preparation succeeds, **Then** the
   workspace contains its initial repositories and passes the configured readiness checks
   before it can accept coding work.
2. **Given** a prepared workspace containing edits, **When** preparation is retried, **Then**
   those edits remain intact and initialization is not repeated destructively.
3. **Given** failed setup, **When** a developer selects the product, **Then** the client reports
   the setup failure and cannot submit coding work to that workspace.

### User Story 2 - Developer selects an isolated project workspace (Priority: P1)

Alice and Bob select the same product definition but connect to independent workspaces.

**Why this priority**: Shared configuration must never expose a colleague's private working state.

**Independent Test**: Connect as two identities to the same product, change Alice's files,
and verify Bob cannot see the files or access Alice's workspace by altering an identifier.

**Acceptance Scenarios**:

1. **Given** four registered local products, **When** Alice selects one by name, **Then** AgentX
   resolves only that product and Alice's prepared workspace.
2. **Given** Alice's uncommitted edits, **When** Bob opens the same product, **Then** Bob retains
   his independent checkout and cannot read Alice's code, artifacts, or agent history.
3. **Given** a missing, malformed, or unauthorized project, **When** selected, **Then** AgentX
   explains the error without starting a coding task or modifying local source files.
4. **Given** Alice publishes changes, **When** Bob explicitly integrates them from the shared
   repository, **Then** they become visible in Bob's workspace.

### User Story 3 - Delegate coding through the local client (Priority: P1)

A developer describes a task locally; the orchestrator delegates it to a remote coding worker
and displays progress, results, changes, and test outcomes.

**Why this priority**: This is the first complete useful AgentX coding workflow.

**Independent Test**: Request a small fixture-repository change and verify all code edits and
tests occurred remotely, with progress and a resulting diff visible locally.

**Acceptance Scenarios**:

1. **Given** a ready workspace, **When** a task is submitted, **Then** the remote worker edits
   and tests the code and the client presents the result with evidence.
2. **Given** instructions to edit or execute code locally, **When** the local agent processes
   them, **Then** its capabilities permit only remote delegation and orchestration.
3. **Given** a duplicated submission after a connection error, **When** retried, **Then** AgentX
   identifies the existing accepted operation rather than starting a second coding run.
4. **Given** a local orchestration failure after task acceptance, **When** the client reconnects,
   **Then** the accepted task remains discoverable with its current status.

### User Story 4 - Resume work and give feedback (Priority: P1)

A developer continues a task after feedback, client exit, or replacement of remote compute.

**Why this priority**: Repeated human-agent interaction must preserve unfinished work.

**Independent Test**: Make uncommitted and untracked changes, reconnect, then replace worker
compute and verify the same files and saved conversation are available for follow-up work.

**Acceptance Scenarios**:

1. **Given** a completed turn with unfinished changes, **When** feedback is sent, **Then** the
   worker continues in the same workspace and conversation without recloning or resetting.
2. **Given** saved code and conversation, **When** compute stops and later resumes, **Then**
   both remain available; interrupted commands are reported and reconciled explicitly.
3. **Given** an existing workspace, **When** a new conversation starts, **Then** existing
   files stay intact while the new conversation has a distinct identity.

### User Story 5 - Control and inspect remote work (Priority: P2)

A developer can inspect task state and request cancellation; administrators can stop idle
compute and inspect setup/runtime failures without implicitly deleting workspaces.

**Why this priority**: These controls make the first workflow practical for daily use.

**Independent Test**: Cancel a running fixture command, reconnect to inspect its final state,
and stop/resume idle compute while preserving files.

**Acceptance Scenarios**:

1. **Given** an active task, **When** cancellation is requested, **Then** the worker attempts
   to stop its subprocesses and reports completion or interruption honestly; edits remain.
2. **Given** one active mutating task, **When** another is submitted to that workspace,
   **Then** it receives a busy result; tasks in other workspaces can proceed.
3. **Given** an idle workspace, **When** compute is stopped, **Then** storage is retained.
4. **Given** a project environment update, **When** an existing workspace resumes, **Then**
   its recorded environment stays pinned unless an explicit migration is performed.

### Edge Cases

- Preparation crashes after cloning only some repositories; retry validates and resumes steps.
- Two clients for one developer resolve or submit work simultaneously; one default instance
  and one active writer remain authoritative.
- A caller alters owner, project, workspace, conversation, or artifact identifiers.
- A worker dies after a tool side effect but before saving its result; no blind automatic replay.
- Credentials expire, a repository is unreachable, or the selected environment is unavailable.
- Disk fills or a setup command fails; mark the workspace unhealthy and preserve diagnostic data.
- A project definition changes while an older workspace exists; no silent image or code reset.
- A streaming connection fails; durable task status and recorded events remain retrievable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Administrators MUST register versioned product definitions and prepare initial
  repository contents and environments before accepting coding tasks (US1).
- **FR-002**: Developers MUST select a locally registered project by name; malformed, missing,
  or unsupported configuration MUST fail with an actionable error (US2).
- **FR-003**: The system MUST distinguish project definitions, workspace instances,
  conversations, and task operations (US1–US4).
- **FR-004**: Every workspace MUST have an authenticated owner; access to files, conversations,
  artifacts, and operations MUST enforce ownership and project membership (US2).
- **FR-005**: The local agent MUST have only orchestration tools; project instructions and
  discovered extensions MUST NOT enable local coding or command execution (US3).
- **FR-006**: Remote workers MUST perform coding, repository inspection, builds, and tests,
  and expose progress, changes, and outcomes to the client (US3).
- **FR-007**: Working files, including uncommitted and untracked files, and saved agent
  conversations MUST survive client reconnection and planned worker replacement (US4).
- **FR-008**: Preparation and accepted-task retries MUST preserve existing work and avoid
  duplicate initialization or duplicate task execution (US1, US3).
- **FR-009**: Only one mutating task MAY execute per workspace; different workspace instances
  MUST support independent concurrent work (US5).
- **FR-010**: Developers MUST be able to give follow-up instructions, inspect status, start a
  new conversation without resetting code, and request cancellation (US4, US5).
- **FR-011**: Project definitions MUST reference credentials securely rather than embed secret
  values; credentials and private output MUST NOT leak to other owners or public logs (US1, US2).
- **FR-012**: Stop, resume, migration, and deletion MUST be distinct lifecycle operations;
  selecting a project MUST NOT delete or reset its workspace (US4, US5).
- **FR-013**: Existing instances MUST retain their recorded environment revision on resume;
  environment migration requires an explicit operation outside normal task submission (US5).
- **FR-014**: Publishing code to the shared repository MUST be explicit; commits and publication
  MUST NOT occur as a side effect of saving a conversation or reconnecting (US2–US4).
- **FR-015**: Operations and diagnostic events MUST expose setup, task, cancellation, and
  interruption states and support retrieval after a client disconnect (US3–US5).

### Key Entities *(include if feature involves data)*

- **Project definition**: Shared product name, revision, prepared environment, repository layout,
  setup/readiness instructions, and access policy.
- **Workspace instance**: Owner's private working copy of a project, prepared revision, readiness
  state, persistent storage association, and current operation.
- **Conversation**: Saved agent interaction history within a workspace, independent of its files.
- **Operation**: Uniquely identified preparation, coding, or lifecycle request with status and result.
- **Artifact/event**: Owner-scoped progress, diagnostic output, changes, or test evidence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator prepares one product and two isolated developer workspaces
  before either developer submits a coding task; repeated preparation preserves their files.
- **SC-002**: In the two-developer acceptance scenario, zero private edits, conversations,
  or artifacts are accessible across owners, including identifier-tampering attempts.
- **SC-003**: A developer completes a fixture coding task and one follow-up, sees its diff and
  test result, and no local project source file or local shell command is used for that work.
- **SC-004**: Reconnection and planned compute-replacement scenarios retain all saved tracked
  edits, untracked files, and completed conversation entries in the acceptance fixture.
- **SC-005**: Repeated identical task submissions produce one accepted operation; simultaneous
  submissions to one workspace produce no overlapping writers.
- **SC-006**: Developers can recover task status after disconnect and distinguish successful,
  failed, cancelled, and interrupted work in every lifecycle acceptance scenario.

## Assumptions

- Initial users are developers within one company; its existing identity provider supplies
  stable developer identity. Account/region/provider configuration is a deployment input.
- Initially each developer has one default instance per project; the data model permits
  additional instances later without changing the shared project definition.
- Administrators explicitly prepare developer instances before coding. Onboarding a product
  does not mean every future developer's private volume must already exist.
- The local client remains responsible for orchestration. An accepted remote task can finish
  after client disconnection; starting further autonomous tasks while offline is out of scope.
- Automatic checkpoints, Dev Container integration, nested Docker/Compose environments,
  multiple simultaneous coding writers in one instance, automated merging, and deployment
  of generated applications are deferred.
- Behavioral tests for preparation, ownership, local tool restrictions, retry behavior,
  and persistence are required deliverables. Cloud acceptance requires configured AWS access.
- Deployment has two explicit profiles. `instances-ebs` remains the production target.
  `demo-microvm` is a VPC-free demonstration profile using AgentCore managed session storage;
  it does not satisfy the production EBS acceptance criteria.
- The demo profile accepts managed session storage's current Preview constraints: 1 GiB per
  session, reset after 14 days without invocation, reset after a runtime version update, and
  an eight-hour maximum compute lifetime. A stable broker-owned runtime session ID is therefore
  required for reconnects, and demo data is disposable.
