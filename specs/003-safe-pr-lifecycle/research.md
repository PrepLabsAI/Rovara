# Research: Safe Pull Request Lifecycle

## Decision: Never rewrite a published branch

**Rationale**: Git rejects non-fast-forward updates by default; replacing rebased or amended published history requires bypassing that rule. AgentX instead creates a new clean branch and replacement PR.

**Alternatives considered**: `--force` and `--force-with-lease` were rejected because both rewrite published history and expose an unsafe capability contrary to the user requirement.

## Decision: Replay the workspace tree onto the latest default branch

**Rationale**: Persistent workspaces may be checked out on an earlier AgentX publication branch. Capturing the current index/worktree as a tree, modeling it as a child of the preparation baseline, and performing a three-way tree merge onto the fetched default branch preserves workspace changes without inheriting prior publication ancestry. The resulting branch is committed once.

**Alternatives considered**: Branching from current `HEAD` caused the reported stale-commit defect. Resetting to the base and applying a two-way patch can delete upstream additions or mishandle concurrent edits. A temporary clone would duplicate workspace data and dependencies.

## Decision: Fast-forward append and merge-based synchronization

**Rationale**: An existing PR can accept additional commits through a normal fast-forward push. Bringing the base into the head uses a merge commit, which preserves published commit IDs. The worker-side merge keeps readiness validation and conflict evidence in the same execution boundary.

**Alternatives considered**: Rebasing or amending the published head was rejected because updating the branch would require a non-fast-forward push.

## Decision: Broker owns PR identity and metadata mutation

**Rationale**: GitHub's pull-request update endpoint supports title, body, and open/closed state with Pull requests write permission. The broker already owns the App key and can verify durable workspace/repository/publication association before issuing the narrowly scoped token.

**Alternatives considered**: Giving GitHub tokens or general HTTP tools to the worker/Pi was rejected because it expands credential exposure and bypasses ownership policy.

## Decision: Replacement is create-then-close

**Rationale**: The original PR remains reviewable if replacement creation fails. Only after the new PR is confirmed does the broker close the original and store a bidirectional replacement link.

**Alternatives considered**: Closing first risks leaving no active review. Editing the original head requires force push.

## Decision: Merged repairs use revert PRs

**Rationale**: A revert commit preserves default-branch history and returns the change through normal review. The worker creates it on a new AgentX branch and never pushes to the default branch.

**Alternatives considered**: Resetting or force-pushing the default branch was rejected as destructive to collaborators and existing clones.

## Decision: Enforce no-force at command construction and tests

**Rationale**: GitHub Contents write is necessary to create/update branches and cannot itself be narrowed to non-force. AgentX withholds tokens from Pi, constructs the exact push command internally, rejects force-like arguments/refspecs, and tests every reachable publication path.

**Alternatives considered**: Relying only on branch protection is deployment-specific and does not prove the application lacks the capability.
