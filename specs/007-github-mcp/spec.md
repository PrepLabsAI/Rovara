# Feature Specification: Discovered GitHub MCP integration

**Created**: 2026-09-23
**Status**: Initial bridge deployed; hosted Slack correction implemented and validated locally, not deployed
**Input**: Use MCP discovery and dynamically expose approved tools instead of individual GitHub wrappers.
Discuss the separate AgentX tool after implementation.

## User Scenarios & Testing

### User Story 1 - Discover and read approved tools (P1)

A member asks AgentX to list/read project issues and comments without a coding worker.
The administrator approves native MCP tools in the registered project revision.
Acceptance: upstream descriptions/schemas drive tool registration; only approved, compatible tools
appear. A newly approved compatible tool requires no new action code. Disabled/cross-owner/non-member/
unknown-repository requests are denied before contacting GitHub.

### User Story 2 - Manage issues through native tools (P2)

A member explicitly asks to create an issue, comment, or assign a specified GitHub username.
Acceptance: native arguments/results are forwarded through the generic bridge. Repeated identical
write requests execute at most once. Conflicting input IDs fail. Interrupted writes remain uncertain
and cannot automatically execute again. AgentX does not promise assignment without verification.

### Edge Cases

Unavailable endpoint, missing installation permissions, incompatible schemas, upstream schema drift,
oversized responses, concurrent duplicates, process loss after write, invalid assignees, PR numbers
accepted by GitHub issue APIs, untrusted instructions in tool output.

## Functional Requirements

- **FR-001**: Administrator-owned project policy MUST opt in and approve tool names and access levels.
- **FR-002**: Every request MUST authorize workspace ownership, membership and registered repository.
- **FR-003**: The control plane MUST discover native names/descriptions/schemas and expose their approved
  intersection dynamically. No per-tool implementations or hand-written action schemas.
- **FR-004**: Tokens MUST remain in the control plane, scoped to repository and Issues permissions.
- **FR-005**: Writes MUST have durable deduplication, input conflicts and non-replayable unknown outcomes.
- **FR-006**: Requests/results/transport MUST be bounded; external content untrusted; errors sanitized.
- **FR-007**: Existing coding and PR validation/publication tools MUST remain unchanged.
- **FR-008**: Tests MUST cover authorization, credentials, actual SDK protocol exchange, dynamic registration,
  schema/policy validation, deduplication and uncertainty.
- **FR-009**: Owner/repo MUST be server-bound; execution MUST revalidate the discovered schema/policy hash.
- **FR-010**: Native semantics MUST be preserved; assignment is not a custom read/union/write wrapper.

## Success Criteria

- **SC-001**: Initial approvals expose listing, issue/comment reading, creation, commenting and assignment.
- **SC-002**: Unauthorized/disabled requests cause zero upstream calls.
- **SC-003**: Replayed/concurrent identical writes cause at most one upstream mutation attempt.
- **SC-004**: Unknown outcomes never report verified success.
- **SC-005**: Existing project configurations and coding/PR regression tests pass.
- **SC-006**: A synthetic newly discovered approved tool registers and executes without implementation changes.

## Assumptions and Scope

Existing GitHub App installation; administrator approves Issues permission before live use. No personal
OAuth, arbitrary endpoints, non-repository tools or other permission families in this release.
Native assignment may replace existing assignees or silently omit ineligible users: orchestrator must
read existing state when adding people and verify afterward. External concurrent changes are not atomic.
Live deployment and external test writes are separate from local implementation. Separate AgentX workflow
tools remain; consolidating them or exposing an AgentX MCP server is a later discussion.

## Scope correction: hosted Slack is the required user interface

The initial CLI-only implementation did not satisfy the user's intended workflow. A signed Slack mention
in an administrator-bound channel MUST reach the hosted orchestrator, discover the tools approved for
that thread workspace's registered project revision, execute through IAM-authenticated control-plane
routes, and reply in the same thread. Local CLI interaction is not an acceptance criterion.

- **FR-011**: Hosted turns MUST receive enabled repository aliases from the control plane, not user text.
- **FR-012**: Service MCP routes MUST enforce the configured IAM role, bound channel/project, thread
  ownership and project membership; personal JWT users and other threads cannot access the workspace.
- **FR-013**: MCP execution records MUST attribute the requesting Slack user; event redelivery MUST
  retain stable invocation IDs even when the model generates new tool-call IDs.
- **SC-007**: A hosted Slack processor/runtime integration test discovers and executes a tool and
  replies in the original thread without submitting a coding task. Disabled projects expose none.
