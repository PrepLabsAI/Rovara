# Implementation Plan: Stop a Task That Repeats the Same Failing Tool Call

**Branch**: `feat/127-tool-loop-guard` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `packages/worker/src/tool-loop-guard.ts`: `ToolLoopGuard.observe(event)`, fed with pi's
  `tool_execution_start` and `tool_execution_end` events, returns `none`, `warn` or `stop`.
- `packages/worker/src/run-task.ts`: the task's existing pi subscription feeds the guard. On `warn` it calls
  `session.steer()`, which pi delivers before the model's next call, and records a progress event. On `stop` it
  aborts the session and fails the task with the guard's error, rather than reporting a cancellation.
- `packages/worker/src/pi-session.ts`: `PiSessionHandle.steer`, which is optional for test adapters.

## Constitution Check

PASS. Worker-only; a task that never repeats a failing call behaves as before.
