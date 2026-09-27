# Feature Specification: File Tools and the Devcontainer Shell Agree on the Repository Path

**Feature Branch**: `feat/128-devcontainer-paths`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #128 (follow-up to #121)

## User Scenario

### The agent can use the devcontainer's path in every tool (Priority: P1)

In Sample-Project-A's first production run, the agent's shell reported the repository at `/workspaces/sample-project-a`,
the devcontainer's own path. The agent's `read` calls on that path failed in the worker, so it fell back to `cat` and
here-documents through the shell for every read and write.

## Requirements

- **FR-001**: When the devcontainer mounts the repository at a different path from the worker's, a file tool
  (`read`, `edit`, `write`, `grep`, `find`, `ls`) given a path under the container folder MUST act on the same file
  under the host folder.
- **FR-002**: Any other path MUST be used as given, including a sibling that merely shares the prefix, and paths outside
  both folders stay refused as before.
- **FR-003**: The agent's context MUST name both folders and say they are the same files.
- **FR-004**: Preparation MUST record the container folder in the manifest's devcontainer entry.
- **FR-005**: Workspaces without a devcontainer, or whose devcontainer uses the host path, MUST be unchanged.

## Success Criteria

- **SC-001**: pi's real `read`, `write`, `edit` and `ls` tools, given `/workspaces/<repo>/...`, act on the host files.
- **SC-002**: Typecheck, lint and the full test suite pass.
