# Implementation Plan: Apply Non-Disk Settings From the Latest Revision

## Summary

Split every project read in the broker into two: the workspace's pinned revision for anything that describes its disk, and the project's latest registered revision for the settings that only describe behaviour. `requireLatestProject`, added for #13, already answers the second with one consistent query on the zero-padded revision keys.

## Technical Context

- Four read sites existed, all `requireProject(..., workspace.projectRevision)`: the GitHub MCP route, `existingThreadWorkspace`, publication and maintenance.
- The worker receives a whole `ProjectDefinition` in its invocation and uses it for readiness, repository paths and its manifest check, so the definition it receives has to be merged rather than replaced.
- The Slack service asks for the thread workspace once per turn and builds a fresh orchestrator runtime, so both the instructions and the MCP catalog are already re-read every turn.

## Constitution Check (v2.0.0)

- **I:** The orchestration boundary is unchanged. Withdrawing a tool now takes effect immediately, which strengthens the boundary rather than widening it.
- **II:** Revisions stay immutable and administrator-registered. What changes is which registered revision a running thread reads behaviour from.
- **III:** Thread ownership and isolation are untouched; no cross-thread data is introduced.
- **IV:** Disk state stays pinned, so resume checks and the preparation manifest are unaffected.
- **V:** This spec, plan and tasks, with behavioural tests for each acceptance criterion.

## Design

### 1. GitHub MCP

The route resolves the policy and the repository alias from `requireLatestProject`. Both discovery and execution take the same path, so a withdrawn tool fails at the route, before any credential is minted, and a narrowed policy rejects a call whose schema was discovered while it was still approved. `GitHubMcpContext` carries `settingsRevision`, which `executeGitHubTool` writes into the durable invocation record.

### 2. Hosted turns

`existingThreadWorkspace` reads two records: the pinned one, which it still hands to `retryWorkspacePreparation` because that rebuilds the disk, and the latest one, which supplies `orchestratorInstructions`, the MCP repository list and `settingsRevision`. The result field is sent only to a service that asks for it with `includeSettingsRevision`, because a deployed older service parses this result strictly.

### 3. Publication and maintenance

`publicationProject` returns the definition to work from and the revision that supplied its settings. When the latest revision is the pinned one it returns the pinned record unchanged. Otherwise it returns the pinned definition with `readiness` replaced and each repository's `codeBuildGates` overlaid from the latest revision's repository of the same name. A repository the latest revision dropped keeps the gates it was registered with. `repositories`, `setup`, `environment` and the `revision` field itself stay pinned, so the worker's manifest check and repository paths are unaffected.

### 4. Readiness against a workspace that lacks the directory

`runReadinessChecks` checks each command's `cwd` before running it and, when it is not a directory, records a failed check naming the command and the directory. The publication then stops on the existing "one or more registered readiness checks failed" path, with evidence that explains why.

### 5. Announcement

The Slack service stores the revision each thread was last told about. When the broker reports a different one it posts `Settings updated to revision N.` and stores the new value. A thread with no stored revision records it silently, so existing threads say nothing on the first turn after release.

### 6. Audit

Operation records carry `settingsRevision` beside the publication and maintenance detail. It is stored on the record rather than added to the public operation contract, because it is audit data rather than something a client acts on.

## Testing

Broker contract tests drive both directions of the policy change through the service path, the publication's merged definition and the recorded revision. A Slack service test covers the announcement's three cases. A worker integration test covers the missing readiness directory. The hand-rolled document-client fakes in two contract tests gained a `QueryCommand` branch, because the broker now runs the latest-revision query on paths they exercise.
