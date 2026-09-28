# Tasks: Stop a Task That Repeats the Same Failing Tool Call

- [x] T001 `ToolLoopGuard` with repeat warning, repeat limit and tool-call cap.
- [x] T002 Wire it into the task runner: steer on warning, abort and fail on stop.
- [x] T003 Tests: guard rules, a task with a fake looping session, a real pi session with a scripted looping model.
- [ ] T004 After the release: the next looping task in production stops itself.
  Not yet observed: no task has looped in production since the release (the models in use have not repeated a failing call).
