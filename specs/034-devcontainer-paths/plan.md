# Implementation Plan: File Tools and the Devcontainer Shell Agree on the Repository Path

**Branch**: `feat/128-devcontainer-paths` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `packages/worker/src/devcontainer.ts`:
  - `devcontainerPaths` pairs `devcontainer up`'s `remoteWorkspaceFolder` with the host folder, or returns
    undefined when they are the same.
  - `hostPath` maps a path.
  - `devcontainerContextFile` is the agent's note.
- `packages/worker/src/pi-session.ts`: `devcontainerFileTools` wraps pi's own six file-tool definitions, rewriting
  `path` in `execute`. They are registered as custom tools, which replace the built-ins of the same name, and the
  note is appended to the context files.
- `packages/worker/src/run-task.ts`: the paths come from the `ensureDevcontainer` result each task already gets.
- `packages/worker/src/prepare.ts`: records `containerWorkspaceFolder` in the manifest.

## Constitution Check

PASS. Worker-only; no path outside the workspace becomes reachable, and workspaces without a devcontainer are unchanged.
