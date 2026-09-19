# Feature Specification: Safe Pull Request Lifecycle

**Feature Branch**: `main`

**Created**: 2026-09-19

**Status**: Implemented locally; AWS deployment pending

**Input**: User description: "Allow remote AgentX workers to prepare clean histories, update existing pull requests, replace pull requests when history must change, and repair merged pull requests without ever force-pushing. Fix publication so stale workspace commits are not inherited by later pull requests."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish Only the Intended Workspace Difference (Priority: P1)

A developer publishes current workspace changes after earlier publication attempts or completed pull requests. The new pull request contains a clean, reviewable change based on the latest configured default branch rather than inheriting prior AgentX publication commits.

**Why this priority**: Preventing stale history and unrelated changes is required before any additional pull-request mutation is safe.

**Independent Test**: Start with a persistent workspace whose checked-out history contains earlier AgentX publication commits, make one new file change, publish, and verify the new branch is based on the latest default branch with one AgentX commit and only the workspace difference relative to that base.

**Acceptance Scenarios**:

1. **Given** a workspace on an earlier AgentX branch with prior publication commits, **When** a developer publishes a new change, **Then** the new branch contains none of those prior commits and is rooted at the latest remote default branch.
2. **Given** a workspace tree containing changes relative to the latest default branch, **When** publication succeeds, **Then** the pull request contains exactly one newly prepared AgentX commit for the current workspace difference.
3. **Given** a workspace tree identical to the latest default branch, **When** publication is requested, **Then** the request fails before any branch or pull request is created.

---

### User Story 2 - Safely Maintain an Open Pull Request (Priority: P2)

A developer can add corrective changes to an AgentX-owned open pull request, synchronize it with the latest base branch, and change its title or description without replacing the branch history.

**Why this priority**: Normal review feedback should update the existing pull request without creating duplicates or requiring unsafe history rewriting.

**Independent Test**: Create an AgentX pull request, modify the workspace, update that pull request, synchronize its base, and update its metadata; verify every branch update is a fast-forward and the pull request identity remains unchanged.

**Acceptance Scenarios**:

1. **Given** an open AgentX-owned pull request and additional workspace changes, **When** the developer updates it, **Then** checks run and one new commit is fast-forwarded onto the existing head branch.
2. **Given** an open AgentX-owned pull request behind its base branch, **When** synchronization is requested, **Then** the base is merged into the head branch without rewriting published commits.
3. **Given** an open AgentX-owned pull request, **When** its title, description, or open/closed state is changed, **Then** the same pull request is updated and the action is recorded.
4. **Given** a pull request not created for the developer's selected workspace and repository, **When** mutation is requested, **Then** AgentX rejects it without changing GitHub state.

---

### User Story 3 - Replace a Pull Request That Needs Clean History (Priority: P3)

A developer can replace an open AgentX pull request when squashing, rebasing, or amending its published commits would otherwise require a force push. AgentX creates a clean replacement branch and pull request and closes the old pull request only after the replacement exists.

**Why this priority**: This provides the intended clean-history outcome while preserving the absolute no-force-push rule.

**Independent Test**: Replace an open multi-commit AgentX pull request and verify the replacement starts from the latest base, contains one squashed commit, links to the old pull request, and leaves the old branch history unchanged.

**Acceptance Scenarios**:

1. **Given** an open AgentX-owned pull request with unwanted commit history, **When** replacement is requested, **Then** AgentX creates a new branch from the latest base with one commit representing the desired workspace tree.
2. **Given** successful replacement creation, **When** AgentX finishes reconciliation, **Then** the original pull request is closed and both records link to each other.
3. **Given** replacement creation fails, **When** AgentX reconciles the operation, **Then** the original pull request remains open.

---

### User Story 4 - Repair a Merged Pull Request (Priority: P4)

A developer can request a safe revert of an AgentX pull request that has already been merged. AgentX creates a new reviewable pull request rather than rewriting the default branch.

**Why this priority**: Merged changes require a distinct repair workflow and must never tempt the agent to rewrite shared history.

**Independent Test**: Merge a disposable pull request, request its revert, and verify AgentX creates a new pull request that reverses the merge while leaving the default branch history intact until a human merges the revert.

**Acceptance Scenarios**:

1. **Given** a merged AgentX pull request, **When** revert is requested, **Then** AgentX creates a new branch and pull request containing the inverse change.
2. **Given** an open or closed-but-unmerged pull request, **When** merged-revert is requested, **Then** AgentX rejects the request without repository changes.
3. **Given** a merged pull request whose revert conflicts with later changes, **When** revert is requested, **Then** AgentX reports the conflicts and creates no branch or pull request.

### Edge Cases

- The remote default branch advances between validation and push.
- An existing pull request is closed, merged, or edited outside AgentX while an operation is running.
- The head branch no longer exists or no longer points to the commit recorded by AgentX.
- A workspace contains untracked files, unresolved conflicts, or no effective difference from the selected base.
- A requested pull request belongs to another repository, installation, owner, or workspace.
- A retry occurs after a branch push but before AgentX records the pull request result.
- A replacement pull request succeeds but closing the original receives an ambiguous response.
- Branch protection or GitHub permissions reject an otherwise valid non-force update.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every newly published or replacement pull request MUST be prepared from the latest remote commit of the repository's configured default branch.
- **FR-002**: New publication MUST represent the current workspace tree difference relative to that base without inheriting the workspace's current branch ancestry.
- **FR-003**: New publication MUST create no more than one AgentX-authored commit and MUST reject an empty difference.
- **FR-004**: The system MUST run all registered readiness checks before every operation that changes a remote branch.
- **FR-005**: Users MUST be able to append checked workspace changes to an open AgentX-owned pull request using only a fast-forward update.
- **FR-006**: Users MUST be able to synchronize an open AgentX-owned pull request with its latest base using a merge-based, non-rewriting update.
- **FR-007**: Users MUST be able to change the title and description and close or reopen an eligible pull request without changing its commits.
- **FR-008**: Users MUST be able to replace an eligible open pull request with a clean branch and one squashed commit when history rewriting would otherwise be required.
- **FR-009**: The original pull request MUST remain open until its replacement pull request is confirmed, and replacement retries MUST reconcile rather than duplicate pull requests.
- **FR-010**: Users MUST be able to create a revert pull request for an eligible merged pull request without changing the default branch directly.
- **FR-011**: The system MUST reject mutation of pull requests or branches not associated with the authenticated owner, selected workspace, registered repository, and recorded AgentX publication.
- **FR-012**: The system MUST NOT execute a force push, expose a force option, delete a branch, or update a default branch directly.
- **FR-013**: Repository credentials MUST remain short-lived, scoped to one registered repository and the minimum operation permissions, and unavailable to the coding agent or its shell.
- **FR-014**: Every accepted lifecycle operation MUST be fenced, idempotent, durably recorded, and return non-secret evidence including affected pull-request numbers, branches, commits, checks, and reconciliation status.
- **FR-015**: Operations MUST detect remote state changes and fail safely rather than overwrite commits when the expected head or base no longer matches.
- **FR-016**: Local orchestration MUST expose explicit lifecycle tools and MUST continue to withhold filesystem, shell, Git, and GitHub credentials from the local agent.
- **FR-017**: Automated contract and integration tests MUST prove fast-forward-only updates, clean-base publication, ownership enforcement, retry reconciliation, and absence of force-push command paths.

### Key Entities

- **Publication Record**: The durable association among workspace, repository, operation, head branch, base branch, published commit, and pull-request identity.
- **Pull Request Mutation**: An authenticated, fenced request to append changes, synchronize the base, edit metadata, or change open/closed state.
- **Replacement Link**: The relationship between an original pull request and its clean replacement, including both branches and reconciliation status.
- **Revert Publication**: A new publication derived from an eligible merged pull request and targeted at its original base branch.
- **Remote Ref Expectation**: The commit identities that must still match before a non-force remote update is permitted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In all automated stale-workspace scenarios, newly published pull requests contain zero commits inherited from earlier AgentX publication branches.
- **SC-002**: One hundred percent of remote branch updates in contract and integration tests are fast-forward updates; no force-push argument or equivalent capability is reachable.
- **SC-003**: A developer can update the content or metadata of an eligible open pull request in one explicit request while retaining the same pull-request number.
- **SC-004**: A developer can obtain a clean-history replacement pull request with one commit while the original branch remains unchanged.
- **SC-005**: A merged pull request can be repaired through a new revert pull request without rewriting the default branch.
- **SC-006**: Replaying an accepted request produces no duplicate branch, commit, replacement, or pull request in all automated retry scenarios.
- **SC-007**: Unauthorized and stale-state mutation attempts produce zero observable repository changes in all automated security tests.

## Assumptions

- Raw rebase and amend are allowed only for commits that have never been pushed. Once published, clean-history changes use replacement branches and pull requests.
- Synchronizing an existing pull request with its base uses a merge commit because rebasing published commits would require a force push.
- Pull-request lifecycle operations apply only to repositories and publications already registered and recorded by AgentX.
- Closing or reopening a pull request does not delete its branch.
- Merging, approving, assigning reviewers, adding labels, and deleting branches remain outside this feature.
- Human reviewers continue to decide whether to merge normal, replacement, and revert pull requests.
