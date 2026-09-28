# Implementation Plan: A Failed Model Call Fails the Task

**Branch**: `fix/136-model-error-task` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

- `packages/worker/src/run-task.ts`: the task's pi subscription keeps the last assistant `message_end` outcome. After
  `prompt()` resolves and the loop guard's check, `failedTurn` turns `"error"` or `"aborted"` into the task's error. The
  existing catch then records FAILED or CANCELLED and the usage outcome.
- `packages/worker/src/cancel.ts`: `cancel()` marks the operation cancelled before aborting its session, because pi's
  abort ends the prompt normally.

## Constitution Check

PASS. Worker-only; successful tasks are unchanged.
