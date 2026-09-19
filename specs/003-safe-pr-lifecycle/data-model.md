# Data Model: Safe Pull Request Lifecycle

## PullRequestRecord

Durable record keyed beneath one workspace and repository.

- `workspaceId`: UUID; owning workspace.
- `repository`: registered repository name, 1–63 lowercase letters/digits/hyphens.
- `repositoryUrl`: canonical registered HTTPS URL.
- `number`: positive GitHub pull-request number.
- `url`: canonical HTTPS GitHub pull-request URL.
- `headBranch`: `agentx/<operation UUID>`.
- `baseBranch`: configured repository default branch.
- `headCommit`: 40–64 lowercase hexadecimal characters.
- `state`: `open`, `closed`, or `merged` as last reconciled.
- `createdByOperationId`: UUID of the original publication.
- `replacementFor`: optional positive PR number.
- `replacedBy`: optional positive PR number.
- `updatedAt`: ISO timestamp.

Validation: repository URL/branch must match the immutable project revision; the record's workspace is the authorization boundary. A record is updated only if the expected head commit still matches.

## PullRequestLifecycleRequest

- `requestId`: UUID idempotency key.
- `repository`: registered repository name.
- `pullRequestNumber`: positive integer.
- `action`: `append`, `sync`, `edit`, `close`, `reopen`, `replace`, or `revert`.
- `title`: optional 1–256 character string without control characters; required for replacement/revert unless inherited.
- `body`: optional UTF-8 string up to 32,768 bytes without NUL.

Conditional validation:

- `edit` requires at least title or body.
- `close` and `reopen` accept no title/body.
- `append` and `sync` operate only on an open record.
- `replace` operates only on an open record and creates a new head branch.
- `revert` operates only on a merged record and creates a new head branch.

## LifecycleOperation

Extends the existing operation envelope.

- `kind`: `maintain` for append/sync, `publish` for create/replace/revert, or a broker-completed metadata mutation.
- `action`: requested lifecycle action.
- `targetPullRequestNumber`: positive integer.
- `expectedHeadCommit`: immutable remote-ref expectation captured at acceptance.
- `replacementHeadBranch`: optional deterministic `agentx/<operation UUID>`.
- Existing fence, status, request hash, timestamps, result, and error fields remain unchanged.

## State Transitions

```text
new workspace diff -> create publication -> open PR record
open PR -> append -> same open PR, new head commit
open PR -> sync -> same open PR, merge/fast-forward head commit
open PR -> edit/close/reopen -> same PR identity, updated metadata/state
open PR -> replace -> new open PR + old closed PR + replacement link
merged PR -> revert -> new open revert PR
```

No transition deletes a branch, updates the default branch, or rewrites a published ref.
