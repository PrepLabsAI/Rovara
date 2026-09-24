# Research: Close Slack Thread Workspace

## AgentCore resource deletion

**Decision**: Delete an `instances-ebs` workspace with `DeleteCapacityProviderSession` using the capacity-provider ID parsed from the stored ARN and the workspace runtime session ID.

**Rationale**: The existing stop command only stops compute. AgentCore models the persistent EBS allocation as the capacity-provider session, and deleting that session is the available API that releases it.

**Alternatives considered**: Stopping the runtime session leaves storage allocated. Deleting the shared capacity provider would affect every workspace and is outside the workspace boundary.

## Unpublished-work policy

**Decision**: Block deletion when any prepared repository has worktree changes, untracked files, a HEAD commit unreachable from remote refs, or a local branch with commits unreachable from remote refs. Return repository-level reasons to Slack. Do not auto-push or archive in this issue.

**Rationale**: Issue #4 has not selected a preservation format. Blocking is safe, testable, and prevents Issue #24 from silently choosing a publication or retention policy.

**Alternatives considered**: Uploading a diff misses ignored files and some Git objects. Auto-pushing changes changes repository state and needs a branch naming and authorization policy. Deleting despite a warning violates durable working-state requirements.

## Command recognition

**Decision**: Recognize exact, case-insensitive `close this workspace` and `close workspace` phrases after removing the leading Slack app mention and surrounding punctuation.

**Rationale**: Deterministic recognition bypasses the model and, critically, runs before the create-or-resolve endpoint. It avoids creating a workspace in a thread whose only request is to close one.

**Alternatives considered**: An orchestrator tool would require creating/resolving the workspace and lets model interpretation vary. A slash command needs another Slack ingress surface and configuration.

## Busy behavior

**Decision**: Refuse closure while an operation is active. Do not automatically cancel it.

**Rationale**: Cancellation cannot always prove that all subprocesses stopped. Refusal preserves the single-writer guarantee and keeps deletion explicit.

**Alternatives considered**: Automatic cancellation adds an uncertain state and could delete while a late worker still writes.

## Closed-thread retention

**Decision**: Keep the control-plane workspace and thread records as tombstones and keep operation history. Remove the hosted Pi session transcript and live conversation reference. Later messages do not recreate a workspace.

**Rationale**: A retained tombstone makes retries and later messages deterministic while deleting the user-facing conversational state and expensive workspace resources.

**Alternatives considered**: Removing every record makes a later mention indistinguishable from a new thread and would recreate resources. Retaining the transcript conflicts with an explicit close expectation and consumes unnecessary session storage.

## Quota release

**Decision**: Decrement the organization counter and the original starter's member counter exactly once when the broker records `CLOSED`. Retain the thread record with closure metadata.

**Rationale**: Closed workspaces no longer consume the limited persistent resource. Using the starter stored on the thread record releases the same member slot that creation consumed, regardless of who requests closure.

**Alternatives considered**: Keeping the quota consumed would prevent users from replacing deliberately closed workspaces. Charging the closer would corrupt a different member's count.
