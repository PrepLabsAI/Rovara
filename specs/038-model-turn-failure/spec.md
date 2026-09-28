# Feature Specification: A Failed Model Call Fails the Task

**Feature Branch**: `fix/136-model-error-task`  
**Created**: 2026-09-28  
**Status**: Approved  
**Input**: Issue #136

## User Scenario

### A model error reaches the thread as a failure (Priority: P1)

On 2026-09-28 OpenRouter rejected every request with HTTP 402. Each task was nonetheless reported SUCCEEDED with zero
tokens, and the orchestrator retried three more times. A failed model call must fail the task with its reason.

## Requirements

- **FR-001**: When a task's last assistant message ended with `stopReason: "error"`, the task MUST fail with
  `RUNTIME_UNAVAILABLE: the model call failed: <message>`. The message MUST be redacted and bounded to 1,000 characters.
- **FR-002**: The turn MUST be judged by its last model call, so a transient error that pi retries successfully is still
  a success.
- **FR-003**: A turn that ended `"aborted"` MUST be CANCELLED when a cancellation was requested, and FAILED
  (`OPERATION_INTERRUPTED`) otherwise. The cancellation is recorded before the session is aborted, so the task always
  sees it.
- **FR-004**: The loop guard's stop (#127) MUST keep its own reason.

## Success Criteria

- **SC-001**: With a real pi session and pi's faux model:
  - a model error fails the task with its message and records FAILED usage;
  - credentials in the message are redacted;
  - a retried transient error and a normal answer both succeed;
  - a cancelled turn ends CANCELLED.
- **SC-002**: Typecheck, lint and the full test suite pass.
