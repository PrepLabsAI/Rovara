# Feature Specification: Cancel a Running Task from Slack or as an Administrator

**Feature Branch**: `feat/126-cancel-task`  
**Created**: 2026-09-28  
**Status**: Approved  
**Input**: Issue #126

## User Scenario

### A member stops a runaway task from its thread (Priority: P1)

On 2026-09-27 a looping task could only be stopped by terminating its instance. A thread's Slack messages are
processed in order, and a running task keeps the orchestrator's turn open, so a "stop" sent to the orchestrator
would wait behind the very task it should stop.

## Requirements

- **FR-001**: A whole-message stop (`stop`, `abort`, `halt`, optionally with `it`, `the task` and similar, or
  `cancel` with such an object, optionally with `please`) MUST be handled by the Slack ingress before the
  thread's queue. A bare `cancel` stays a confirmation reply.
- **FR-002**: The ingress MUST ask the broker to cancel the thread's running task. The broker keeps the state table
  and callback key; the ingress gets only permission to invoke it. The internal request MUST never be reachable
  through API Gateway.
- **FR-003**: Any member of the bound channel MAY stop the thread's task. A channel that is not bound MUST be refused.
- **FR-004**: Only a coding task is cancelled; a preparation or publication is left to finish.
- **FR-005**: When a task is running, the ingress MUST reply that it is stopping and not queue the message. When
  nothing is running, the message MUST go to the orchestrator as usual. A failed request MUST be reported in the
  thread.
- **FR-006**: An administrator MUST be able to cancel any workspace's running task with
  `POST /v1/admin/workspaces/{id}/cancel` and `agentx admin workspace cancel --workspace <id>`.

## Success Criteria

- **SC-001**: Tests cover the phrases that match and those that don't; the ingress paths (stop, nothing
  running, failure, not wired); and the broker paths (member stop, repeated stop, idle thread, unbound channel, an
  API Gateway request that looks internal, and the administrator route).
- **SC-002**: After the release, `@AgentX stop` in a thread with a running task ends it as CANCELLED, and the
  thread says so.
