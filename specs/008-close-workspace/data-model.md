# Data Model: Close Slack Thread Workspace

## Workspace

Existing fields remain. New values and optional fields:

| Field | Constraint | Meaning |
| --- | --- | --- |
| `status` | Adds `CLOSING` and `CLOSED` | Durable lifecycle state |
| `closeOperationId` | UUID, optional | Operation that most recently fenced closure |
| `closedAt` | ISO timestamp, optional; required when `CLOSED` | Confirmed resource cleanup time |
| `closedBy` | Valid Slack requester, optional; required for Slack closure | Requester attribution |
| `closeError` | At most 16,384 characters, optional | Retry-visible cleanup failure |

State transitions:

```text
READY or STOPPED ──request close──> CLOSING
CLOSING ──unsafe/failed preflight──> READY or STOPPED
CLOSING ──safe preflight + cleanup──> CLOSED
CLOSING ──cleanup failure───────────> CLOSING (retryable)
CLOSED ──repeat/later message───────> CLOSED
```

`PREPARING`, `BUSY`, `RESUMING`, `UNHEALTHY`, and any workspace with an active operation cannot begin closure.

## Close Operation

Uses the existing operation record with:

| Field | Constraint |
| --- | --- |
| `kind` | `close` |
| `requestId` | Deterministic UUID from the Slack event |
| `requestedBy` | Authenticated Slack team/user |
| `payloadHash` | Hash of workspace and close intent |
| `fence` | Positive integer matching the workspace close fence |
| `result` | `ClosePreflightResult` after worker success |

## ClosePreflightResult

| Field | Constraint |
| --- | --- |
| `safeToClose` | Boolean |
| `repositories` | At most 32 findings |
| `repositories[].name` | Registered repository name |
| `repositories[].reasons` | Unique set of `worktree_changes`, `untracked_files`, `unpushed_head`, `unpushed_branch`; at least one when listed |

The result is bounded and contains no file content, paths outside registered repository paths, credentials, diffs, or commit messages.

## Slack Thread Record

The existing record retains `thread`, `starterUserId`, `workspaceId`, and requester history. It gains optional `closedAt` and `closeOperationId` to support audit and idempotent quota release.

## Slack Orchestrator Thread State

The existing thread state gains `closedAt`. On closure, `conversationId` and the S3 session object are removed while `workspaceId` and `closedAt` remain.

## Quota Records

The organization count and starter-member count are decremented in the same durable completion transaction that marks the workspace closed. Member `threads` removes the closed thread. Conditions prevent either count from becoming negative or being released twice.
