# Feature Specification: Stop a Task That Repeats the Same Failing Tool Call

**Feature Branch**: `feat/127-tool-loop-guard`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #127

## User Scenario

### A looping model is corrected, and stopped if it keeps looping (Priority: P1)

On 2026-09-27 a Sample-Project-A task on `amazon.nova-pro-v1:0` ran the same failing command more than 56 times,
and only terminating its instance stopped it. The worker now notices a repeat: it tells the model once and, if the
model keeps repeating, fails the task with a reason the Slack thread can show.

## Requirements

- **FR-001**: A call MUST count as a repeat when its tool, its arguments (in any key order) and its error all
  match the previous failing call, ignoring digits in the error.
- **FR-002**: At the 3rd identical failure in a row, the worker MUST tell the model once, before its next call,
  that it is repeating a failing call and must change approach.
- **FR-003**: At the 5th, the worker MUST abort the turn and fail the task with `OPERATION_INTERRUPTED` and a message
  naming the tool and the count.
- **FR-004**: Any successful call MUST end a streak. Repeated successful calls, and edit-then-rerun debugging,
  are never stopped.
- **FR-005**: A task that starts more than 200 tool calls MUST fail with a message saying so.

## Success Criteria

- **SC-001**: A real pi session with a scripted model that repeats a failing command sees the warning on its 4th
  call, and the task fails after the 5th.
- **SC-002**: Typecheck, lint and the full test suite pass.
