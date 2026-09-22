# Feature Specification: CodeBuild Publication Gates

**Feature Branch**: `main`

**Created**: 2026-09-19

**Status**: Implemented and validated locally; AWS deployment pending

**Input**: User description: "Integrate AgentX with AWS CodeBuild so remote changes are tested before a pull request is created or updated."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Validate a Candidate Before Creating a Pull Request (Priority: P1)

A developer asks AgentX to publish a repository change. AgentX pushes the exact candidate commit, runs every administrator-configured CodeBuild gate for that repository, and creates the pull request only when all gates succeed.

**Why this priority**: A pre-PR gate is the minimum useful integration and prevents known-bad changes from entering review.

**Independent Test**: Configure one fake CodeBuild gate, publish a candidate, and verify the exact commit is submitted, successful evidence is returned, and the PR callback occurs only after success.

**Acceptance Scenarios**:

1. **Given** a repository with one or more configured gates, **When** all builds for the pushed candidate commit succeed, **Then** AgentX creates the pull request and returns build evidence.
2. **Given** any configured build fails, stops, faults, or times out, **When** AgentX evaluates the gate, **Then** no pull request is created and the operation fails with non-secret evidence.
3. **Given** a repository without CodeBuild gates, **When** a change is published, **Then** existing readiness and PR behavior remains unchanged.

---

### User Story 2 - Validate Before Advancing an Existing Pull Request (Priority: P2)

A developer appends or synchronizes an AgentX-owned pull request. AgentX publishes the candidate to a temporary validation branch, runs the configured CodeBuild gates, and advances the visible PR branch only after all gates pass.

**Why this priority**: Updating an existing PR before validation would expose broken code and make failure recovery ambiguous.

**Independent Test**: Append a candidate to an existing PR, fail its gate, and prove the PR head is unchanged; repeat with a successful gate and prove the PR head fast-forwards once.

**Acceptance Scenarios**:

1. **Given** an open AgentX PR, **When** an append or sync candidate passes all gates, **Then** AgentX updates the PR branch with one ordinary non-force push.
2. **Given** a gate failure, **When** append or sync is requested, **Then** the existing PR head and durable expected-head record remain unchanged.
3. **Given** an already-synchronized PR, **When** sync needs no branch change, **Then** AgentX does not start redundant builds.

---

### User Story 3 - Observe and Retry External Validation Safely (Priority: P3)

An operator or developer can inspect which CodeBuild project tested which commit, its terminal status, and its logs link. Retries reconcile an existing build rather than knowingly creating duplicate builds.

**Why this priority**: External validation is asynchronous and must remain diagnosable across transient worker or callback failures.

**Independent Test**: Replay start and status requests for one operation and gate, verify the same durable build identity is returned, and reject requests outside the operation's registered scope.

**Acceptance Scenarios**:

1. **Given** a transient callback retry, **When** the same operation requests the same gate and commit, **Then** AgentX returns the recorded build instead of starting another.
2. **Given** a terminal build, **When** status is requested, **Then** AgentX returns the terminal status, source revision, timing, phase summary, and logs URL when available.
3. **Given** an unconfigured project, wrong repository, wrong commit, or stale operation capability, **When** a worker requests a build, **Then** the broker rejects it without invoking CodeBuild.

### Edge Cases

- CodeBuild queues longer than the configured gate timeout.
- CodeBuild accepts a start request but the broker response or persistence step is interrupted.
- A build reports a resolved source revision different from the requested candidate commit.
- A candidate branch is pushed but a build subsequently fails.
- The same CodeBuild project is accidentally listed twice in a repository definition.
- A callback arrives after the publication operation has reached a terminal state.
- The CodeBuild project, source connection, service role, build image, or buildspec is changed outside AgentX.
- A repository requires browser tests; Playwright dependencies are missing from its CodeBuild image.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Administrators MUST be able to define zero or more named CodeBuild gates per registered repository, including a project name and timeout, with a total configured timeout no greater than 420 minutes.
- **FR-002**: Gate names and CodeBuild project names MUST be unique within a repository definition, and project names MUST satisfy the configured AgentX allow-list prefix.
- **FR-003**: Existing project definitions without gates MUST remain valid and retain existing publication behavior.
- **FR-004**: AgentX MUST run local registered readiness checks before pushing any validation candidate.
- **FR-005**: AgentX MUST push the immutable candidate commit to a non-default branch before requesting CodeBuild.
- **FR-006**: Every CodeBuild start request MUST use that exact candidate commit as `sourceVersion` and MUST NOT accept worker-provided source, buildspec, image, service-role, artifact, or secret overrides.
- **FR-007**: The broker MUST authorize a build only when its repository, gate, project, commit, operation, workspace, and fence match the accepted operation's immutable scope.
- **FR-008**: The remote worker MUST receive no AWS credentials and MUST access CodeBuild only through its scoped callback capability.
- **FR-009**: The broker IAM role MUST permit only `codebuild:StartBuild` and `codebuild:BatchGetBuilds` on CodeBuild projects matching the AgentX project-name prefix.
- **FR-010**: AgentX MUST require every configured gate to report `SUCCEEDED` before creating a new PR or advancing an existing PR branch.
- **FR-011**: `FAILED`, `FAULT`, `STOPPED`, `TIMED_OUT`, source-revision mismatch, invalid response, or gate deadline expiry MUST fail publication and MUST NOT create or advance a PR.
- **FR-012**: Existing-PR append and sync MUST validate a temporary candidate ref and update the PR head only afterward with an ordinary fast-forward push; force push remains forbidden.
- **FR-013**: AgentX MUST durably associate each build with the workspace, operation, repository, gate, project, and candidate commit and MUST reconcile repeated start requests.
- **FR-014**: Publication results MUST include non-secret build evidence: gate, project, build ID, status, requested and resolved revisions, timestamps, phase, and logs URL when present.
- **FR-015**: Build polling MUST be bounded by the registered gate timeout plus a small queue allowance and MUST not expose build log contents or secret environment values.
- **FR-016**: CodeBuild project creation, GitHub CodeConnections authorization, service roles, images, and repository buildspecs MUST remain administrator-managed infrastructure outside the coding worker.
- **FR-017**: Repository-specific unit, integration, and Playwright commands MUST be defined by that repository's CodeBuild project/buildspec rather than hard-coded in AgentX.
- **FR-018**: Automated contract, integration, and infrastructure tests MUST cover authorization, exact-commit validation, success/failure ordering, retry reconciliation, and least-privilege IAM.

### Key Entities

- **CodeBuild Gate Definition**: Immutable repository configuration naming an approved CodeBuild project and its maximum wait time.
- **Build Gate Record**: Durable operation-scoped association between a gate, candidate commit, CodeBuild build ID, and latest observed evidence.
- **Validation Candidate**: A commit reachable through a non-default remote ref and tested before publication becomes visible as a PR or PR-head update.
- **Build Evidence**: Sanitized status metadata returned to the developer without log contents or environment secrets.

## Success Criteria *(mandatory)*

- **SC-001**: In all automated failure cases, zero new PRs are created and zero existing PR heads are advanced.
- **SC-002**: One hundred percent of started builds receive the exact candidate commit as `sourceVersion`.
- **SC-003**: Replaying a gate start for the same operation and candidate returns one durable build identity in automated tests.
- **SC-004**: A successful publication result identifies every configured gate and provides a CodeBuild logs link when AWS supplies one.
- **SC-005**: Worker runtime roles and containers contain no CodeBuild AWS permission or long-lived AWS credential added by this feature.
- **SC-006**: Existing repositories with no gates continue to pass all pre-existing publication tests unchanged.

## Assumptions and Scope

- CodeBuild projects already exist and use a repository source authorized through AWS CodeConnections or another administrator-approved source credential.
- CodeBuild project names used by AgentX begin with `agentx-`; changing this allow-list requires an infrastructure change.
- Candidate branches may remain after failed validation for diagnosis; automated branch cleanup is outside this feature.
- One publication operation targets one registered repository. Coordinated testing and atomic PR creation for unpublished commits across multiple repositories is a separate change-set feature.
- CodeBuild batch builds and secondary sources may be used by an administrator inside a configured project, but AgentX does not yet coordinate multiple candidate commits.
- AgentX never merges pull requests automatically.
