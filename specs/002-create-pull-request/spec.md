# Feature Specification: Create Pull Request

**Feature Branch**: `[002-create-pull-request]`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Implement the feature to create a pull request from changes in an AgentX remote workspace."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish Validated Workspace Changes (Priority: P1)

A developer asks AgentX to publish changes from one configured repository in their private remote
workspace. AgentX validates the changes, creates a dedicated publication branch and commit, pushes
that branch, opens a pull request against the configured default branch, and returns a clickable
pull-request reference.

**Why this priority**: Publication is the missing step that turns isolated remote coding work into
a reviewable team contribution.

**Independent Test**: Prepare a workspace, make one source change, request a pull request, and
verify that exactly one reviewable pull request contains the expected commit and diff.

**Acceptance Scenarios**:

1. **Given** an authenticated developer owns a ready workspace with uncommitted changes in one
   configured repository, **When** they explicitly request publication and all registered checks
   pass, **Then** AgentX creates one non-default branch, one commit, and one ready-for-review pull
   request targeting that repository's configured default branch.
2. **Given** publication succeeds, **When** AgentX reports the result, **Then** the developer sees
   the pull-request URL and number, source and target branches, published commit, and check results.
3. **Given** the developer is using the local interactive orchestrator, **When** they ask it to
   create a pull request, **Then** the orchestrator delegates the explicit publication request and
   presents the same result without gaining local repository or shell access.

---

### User Story 2 - Block Unsafe or Unverified Publication (Priority: P2)

A developer receives a clear failure without a pushed branch or pull request when the workspace is
not publishable, including failed checks, no changes, unresolved conflicts, an unconfigured
repository, or missing publication permission.

**Why this priority**: A publication feature must not bypass validation or publish ambiguous work.

**Independent Test**: Configure a failing registered check, request publication, and verify that no
remote branch, commit, or pull request is created and that the failed check is identified.

**Acceptance Scenarios**:

1. **Given** any registered check fails, **When** publication is requested, **Then** AgentX reports
   the failed check and does not commit, push, or open a pull request.
2. **Given** the selected repository has no changes relative to its prepared base, **When**
   publication is requested, **Then** AgentX reports that there is nothing to publish.
3. **Given** the requested repository is not part of the registered project or the caller does not
   own the workspace, **When** publication is requested, **Then** AgentX denies the request without
   exposing workspace or repository information.
4. **Given** publication credentials or permissions are unavailable, **When** publication reaches
   the external repository step, **Then** AgentX reports a recoverable publication failure without
   exposing credentials.

---

### User Story 3 - Retry Without Duplicate Pull Requests (Priority: P3)

A developer can safely retry or reconnect to an accepted publication request without creating a
second branch, commit, or pull request.

**Why this priority**: Remote runtimes, queues, and external repository services can fail after a
side effect succeeds, so retry safety is required for trustworthy automation.

**Independent Test**: Interrupt publication after the branch is pushed, retry the same request, and
verify that AgentX resumes or reconciles the original publication and returns exactly one pull
request.

**Acceptance Scenarios**:

1. **Given** a publication request was already accepted, **When** the identical request is retried,
   **Then** AgentX returns or resumes the original operation rather than starting a duplicate.
2. **Given** the publication branch was pushed but the result was not recorded, **When** AgentX
   retries, **Then** it reconciles the existing branch and pull request without force-pushing or
   creating a duplicate.
3. **Given** the same request identifier is reused with different publication content, **When** it
   is submitted, **Then** AgentX rejects it as a conflicting request.

### Edge Cases

- The workspace contains changes in more than one configured repository.
- The selected repository contains untracked files, ignored files, a detached base, or an empty diff.
- The default branch advanced after workspace preparation.
- A generated publication branch already exists from an earlier attempt.
- The external service accepts the branch push but times out before acknowledging pull-request creation.
- The requested title or description is empty, excessively long, or contains control characters.
- A check times out or the worker is replaced while checks are running.
- The GitHub App installation is removed or its write permissions are not approved.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Pull-request creation MUST be a separate, explicit developer action and MUST NOT occur
  automatically at the end of an ordinary coding task.
- **FR-002**: The system MUST accept publication only for a repository in the authenticated
  developer's ready workspace and registered project definition.
- **FR-003**: A publication request MUST identify exactly one configured repository and include a
  non-empty title; a description MAY be supplied.
- **FR-004**: The system MUST rerun the registered project checks applicable to the selected
  repository immediately before any commit or external publication side effect.
- **FR-005**: The system MUST stop before commit, push, or pull-request creation if a required check
  fails, times out, or cannot run, and MUST return bounded diagnostic evidence.
- **FR-006**: The system MUST refuse publication when there are no changes to publish or when the
  selected checkout has unresolved conflicts.
- **FR-007**: The system MUST create a dedicated AgentX-owned source branch and MUST NOT commit to,
  push to, or rewrite the configured default branch.
- **FR-008**: The system MUST create one commit containing the selected repository's publishable
  workspace changes while leaving other configured repositories unchanged.
- **FR-009**: The system MUST use a stable AgentX commit identity and record the authenticated
  requestor in publication metadata without impersonating that developer's Git identity.
- **FR-010**: The system MUST open a ready-for-review pull request from the publication branch to the
  configured default branch with the requested title and description.
- **FR-011**: The system MUST return the pull-request URL and number, repository, source branch,
  target branch, published commit, and final check outcomes.
- **FR-012**: Publication credentials MUST be short-lived, limited to the exact configured
  repository and required publication actions, excluded from project definitions and durable
  operation records, and redacted from errors and logs.
- **FR-013**: Retrying the same publication request MUST NOT create duplicate operations, branches,
  commits, or pull requests.
- **FR-014**: Reusing a request identifier with different publication input MUST be rejected.
- **FR-015**: Publication MUST respect the workspace's single-writer fence so coding and publication
  cannot mutate the same checkout concurrently.
- **FR-016**: The local interactive orchestrator MUST expose publication as an orchestration action
  while retaining no local file, Git, or shell capability.
- **FR-017**: The command-line client MUST support direct non-interactive publication and stable
  machine-readable output in addition to interactive orchestration.
- **FR-018**: Failures after an external side effect MUST preserve enough non-secret publication
  state to reconcile a retry and report whether a remote branch or pull request already exists.
- **FR-019**: The system MUST NOT force-push, merge, approve, or delete branches as part of this
  feature.
- **FR-020**: Pull requests spanning multiple repositories or requiring coordinated merge order MUST
  be rejected as outside this feature's scope.

### Key Entities

- **Publication Request**: An idempotent request containing the workspace, selected repository,
  title, optional description, and request identity.
- **Publication Operation**: The fenced remote execution that runs checks, creates the commit,
  publishes the branch, and reconciles external state.
- **Publication Result**: The non-secret record of checks, repository, branches, commit, and created
  pull request.
- **Repository Publication Credential**: A short-lived authorization limited to the selected
  configured repository and publication actions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a ready workspace with passing checks and one changed repository, a developer can
  create a reviewable pull request through one explicit AgentX request without manually cloning or
  pushing from their laptop.
- **SC-002**: In acceptance testing, 100% of failed or timed-out checks result in zero new commits,
  remote branches, and pull requests.
- **SC-003**: Replaying an accepted request at least three times results in exactly one publication
  branch, one published commit, and one pull request.
- **SC-004**: Every successful response contains all six review identifiers: repository,
  pull-request URL and number, source branch, target branch, and commit.
- **SC-005**: Credential-redaction tests find zero private keys or repository tokens in operation
  records, queue payloads, workspace manifests, Git remote URLs, logs, and user-visible failures.
- **SC-006**: A developer can start publication from either the interactive client or a direct CLI
  command and receives the terminal result within one continuous workflow.

## Assumptions

- The first delivery supports one GitHub repository per pull request and uses the repository's
  configured default branch as the target.
- Registered readiness commands are the initial publication check policy and administrators are
  responsible for including the project's required automated tests in that policy.
- The GitHub App installation will be granted repository-content write and pull-request write
  permissions before live publication is enabled.
- AgentX generates publication branch names and uses a stable service commit identity.
- Pull requests are ready for review by default; draft selection, reviewers, labels, merge,
  coordinated multi-repository publication, and CI-system integrations are later features.
- Existing workspace ownership, operation fencing, dispatch, callback, and artifact-retention rules
  continue to apply.
