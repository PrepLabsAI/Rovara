# Feature Specification: Apply Non-Disk Settings From the Latest Revision

**Feature Branch**: `mainline`

**Created**: 2026-09-24

**Status**: Implemented

**Input**: Issue #18: "Apply non-disk project settings (GitHub MCP policy, instructions, readiness, CodeBuild gates) from the latest revision."

**Constitution**: Version 2.0.0. No principle changes. Project revisions stay immutable; only the revision a running thread reads its non-disk settings from changes.

## Context

Since #13 a new Slack thread starts on the project's latest registered revision, but an existing thread read every setting from the revision its workspace was created with. Several of those settings never touch the workspace's disk, so pinning them served no purpose and had two consequences: an existing thread never received newly enabled GitHub tools, new instructions or a corrected test command, and — the security case — withdrawing a GitHub write tool or narrowing its arguments in a new revision left every existing thread on the older, more permissive policy indefinitely.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - New Settings Reach a Running Thread (Priority: P1)

An administrator registers a revision that enables a GitHub issue tool and corrects the project's test command. The next mention in a thread that has been running for a week uses both.

**Independent Test**: Register a revision that adds a policy; take the next turn in an existing thread; observe the tools are advertised and callable, and the thread is told its settings moved.

**Acceptance Scenarios**:

1. **Given** a thread whose workspace is pinned to revision 1, **When** revision 2 adds a GitHub MCP policy, **Then** the thread's next turn discovers and can call those tools.
2. **Given** the same thread, **When** revision 3 changes `orchestratorInstructions`, **Then** the next turn runs with the new instructions.
3. **Given** the same thread, **When** revision 3 changes `readiness` or a repository's `codeBuildGates`, **Then** its next publication runs the new checks and gates.

---

### User Story 2 - Withdrawal Takes Effect At Once (Priority: P1)

An administrator removes a write tool from the policy. Every thread loses it immediately, including one holding a schema discovered while the tool was approved.

**Independent Test**: Approve a tool, discover it, register a revision without it, and call it with the discovered schema hash. The call is rejected.

---

### User Story 3 - The Disk Stays Where It Was (Priority: P1)

Nothing about the workspace's checkout changes. Repositories, setup steps and the environment image stay on the revision the workspace was prepared with, until #12.

## Requirements *(mandatory)*

- **FR-001**: `integrations.githubMcp` MUST be read from the project's latest registered revision on every discovery and every tool call. The repositories a tool may address MUST come from that revision.
- **FR-002**: `orchestratorInstructions` MUST come from the latest revision on every hosted turn.
- **FR-003**: `readiness` and each repository's `codeBuildGates` MUST come from the latest revision on every publication and maintenance run.
- **FR-004**: `repositories`, `setup` and `environment` MUST stay pinned to the workspace's revision, including the `revision` field the worker checks against its manifest.
- **FR-005**: A readiness command whose `cwd` is not a directory in the workspace MUST fail that check with an explanatory result, never be skipped.
- **FR-006**: Every operation record and every GitHub MCP invocation record MUST name the revision whose settings applied.
- **FR-007**: A thread MUST be told, once, when its settings move to a newer revision. A thread's first observed revision is recorded without an announcement.

## Success Criteria *(mandatory)*

- **SC-001**: Enabling a policy in a new revision makes the tools usable in an existing thread on its next turn, with no new thread and no re-binding.
- **SC-002**: Withdrawing a tool rejects the next call from every existing thread, including calls carrying a previously discovered schema.
- **SC-003**: A publication from a thread pinned to an older revision runs the latest revision's readiness commands and CodeBuild gates.
- **SC-004**: The invocation sent to the worker still carries the pinned revision's repositories, setup and environment.
- **SC-005**: Audit records answer "which revision's settings applied" for every operation and MCP call.

## Decisions

- **Repositories the MCP tools may address** come from the latest revision, as decided on 2026-09-24. A repository added in a later revision becomes addressable at once; one dropped from it stops being addressable.
- **A readiness command whose repository the workspace lacks fails the publication**, rather than being skipped, so a gate never silently goes unrun.
- **The thread is told** when its settings revision changes, as decided on 2026-09-24.

## Assumptions and Scope

- The hosted orchestrator already discovers its GitHub MCP catalog on every turn, because the Slack service builds a fresh runtime per turn. The 007 quickstart's "restart the orchestrator to refresh its catalog" no longer applies to the hosted service.
- Threads that existed before this change record their first observed revision silently, so deploying it announces nothing.
- The applied revision is stored on the operation and invocation records, not added to the public operation contract.
- Settings that change the workspace's disk are #12's subject and stay pinned here.
