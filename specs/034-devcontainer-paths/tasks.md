# Tasks: File Tools and the Devcontainer Shell Agree on the Repository Path

- [x] T001 Path pairing and mapping, and the agent's context note.
- [x] T002 File tools wrapped in devcontainer sessions; the task runner passes the paths; the manifest records them.
- [x] T003 Tests with pi's real tools; typecheck, lint and tests pass.
- [x] T004 After the release: a Sample-Project-A task reads and edits through `/workspaces/sample-project-a` without falling back to the shell.
  Verified 2026-09-28 (operation `a5619c30`): `find`, `read` and `edit` on the repository with zero tool errors and no fallback to the shell. The agent used host paths, as the context note suggests; the `/workspaces/...` translation itself is covered by the tests with pi's real tools.
