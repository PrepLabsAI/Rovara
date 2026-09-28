# Tasks: A Failed Model Call Fails the Task

- [x] T001 Judge the turn by its last assistant message; fail on error, cancel or fail on abort.
- [x] T002 Record the cancellation before aborting.
- [x] T003 Real-pi tests with the faux model; typecheck, lint and tests pass.
- [x] T004 After the release: a model error in production fails its task, and the thread says why.
  Verified 2026-09-28: with OpenRouter answering HTTP 402, task `c149be91` failed with `RUNTIME_UNAVAILABLE: the model call failed: OpenRouter request failed; check the key's credit balance and spending limit`, and the orchestrator did not retry.
