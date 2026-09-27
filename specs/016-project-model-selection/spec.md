# Feature Specification: Project Worker Model Selection

**Feature Branch**: `feature/031-project-model-selection`
**Created**: 2026-09-27
**Status**: Approved
**Input**: Issue #31: select the coding-worker model from an administrator-approved project list through deterministic Slack commands.

## User Scenarios & Testing

### User Story 1 - Select a Project Model (Priority: P1)

A member in a Slack channel bound to a project can list approved coding models and select one. The selection applies to every workspace in that project beginning with its next coding turn.

**Independent Test**: Send `@agentx models`, then `@agentx use <label>` and verify a task in another project thread receives the selected model.

**Acceptance Scenarios**:

1. **Given** approved models, **When** a member sends `@agentx models`, **Then** AgentX lists only those models and marks the effective selection.
2. **Given** an approved label, **When** a member sends `@agentx use <label>`, **Then** AgentX stores the project-wide selection and explains that it takes effect next turn.
3. **Given** an unknown or ambiguous name, **When** it is selected, **Then** AgentX makes no change and lists valid choices.

### User Story 2 - Resolve Every Coding Task Safely (Priority: P1)

Every accepted coding task resolves its worker model from the latest project revision. A valid selection wins, followed by the project default and the deployed worker fallback.

**Independent Test**: Dispatch tasks with a valid selection, no selection, a removed selection, and no project model configuration; inspect the worker invocation and usage.

**Acceptance Scenarios**:

1. **Given** a valid saved selection, **When** a task is accepted, **Then** the invocation names that provider and model ID.
2. **Given** no selection, **When** a task is accepted, **Then** the project default is used.
3. **Given** a selection removed by a newer revision, **When** a task is accepted, **Then** the current default is used with a user-visible diagnostic.
4. **Given** a legacy project without model configuration, **When** a task runs, **Then** the worker uses its deployment fallback.

### Edge Cases

- Labels match case-insensitively; provider/model IDs can be selected exactly.
- Duplicate provider/model IDs and labels are rejected at registration.
- Model commands do not create a workspace or invoke the Slack orchestrator.
- A mid-thread selection applies to the next turn; an accepted task keeps its resolved model.
- User-supplied routing structures reject `provider` and `modelId`.

## Requirements

- **FR-001**: A project definition MUST optionally declare one default worker model and 1–16 administrator-approved models.
- **FR-002**: The default MUST be approved; provider/model pairs and labels MUST be unique.
- **FR-003**: A bound Slack project member MUST be able to list models with `@agentx models` without creating a workspace.
- **FR-004**: A bound Slack project member MUST be able to select an approved model with `@agentx use <name>` without creating a workspace.
- **FR-005**: Confirmation MUST say selection is project-wide and starts on the next coding turn.
- **FR-006**: Unknown or ambiguous selectors MUST make no change and show valid choices.
- **FR-007**: The control plane MUST persist selection outside immutable revisions with updater and time.
- **FR-008**: Every task MUST revalidate selection against the latest revision and resolve selection, project default, then deployment fallback.
- **FR-009**: A removed selection MUST fall back to the current default with a diagnostic.
- **FR-010**: The task payload MAY carry the resolved model; workers MUST use environment fallback when absent.
- **FR-011**: Usage MUST describe the model actually used by the coding session.
- **FR-012**: The Slack orchestrator model and model-selection tool arguments are out of scope.
- **FR-013**: User-supplied routing MUST reject `provider` and `modelId` fields.
- **FR-014**: Projects without model configuration MUST work unchanged.

### Key Entities

- **Project model policy**: Immutable default and approved worker models.
- **Project model selection**: Mutable project-wide model with updater identity and timestamp.
- **Resolved task model**: Server-selected pair attached to a newly accepted task.

## Success Criteria

- **SC-001**: A member lists or selects models with one Slack command and no deployment.
- **SC-002**: Tests demonstrate project-wide effect across two Slack threads.
- **SC-003**: Tests demonstrate safe fallback after an administrator removes a selection.
- **SC-004**: Existing projects and invocations without model fields remain compatible.

## Assumptions

- Existing Slack binding and membership checks authorize commands.
- Administrators verify every approved model is available in the deployment account and region.
- Thinking level and cache retention remain deployment controlled.
- Orchestrator model selection is tracked by issue #32.
