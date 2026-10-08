# Implementation Plan: Native AgentX Task Workflow

## Architecture

Extend the existing typed Developer Task contract and DynamoDB task record with a versioned
workflow snapshot and append-only decision/event history. The broker is the sole transition
authority. Keep existing task statuses and task APIs compatible. Run planning without write tools;
only the authenticated broker transition after approval enables implementation tools. Slack is the
primary surface for Slack-originated workflows: a concise thread update links to task-specific plan
details and offers authorized actions. Developer MCP reads and acts on that same workflow record.

## Implementation sequence

1. Add Zod contracts and transition rules with failing unit/contract tests.
2. Persist workflow state and idempotent decisions in the developer task store with concurrency,
   owner isolation, and interruption tests.
3. Add a read-only planning capability and demonstrate that plan generation cannot mutate files.
4. Add plan artifact submission/approval/revision, task status, and MCP actions.
5. Add recovery and compatibility checks for existing tasks without workflow state.
6. Start Slack-originated workflows in a bound project channel and keep request, plan review,
   progress and PR updates in the task thread.
7. Publish a short Slack message with a link to a task-specific Canvas; keep the complete plan in
   the versioned AgentX artifact store as the authority record.
8. Add signed Slack controls for approve, request changes, cancel and optional check selection.
   Project-required checks stay selected and cannot be switched off by a task owner.

## Risks and controls

- State/operation divergence: use conditional updates and idempotency keys; never infer a workflow
  transition from a worker summary.
- Unauthorized decision: derive actor from existing authenticated developer/Slack identity and
  verify task ownership/project administration server-side.
- Mutation before approval: remove write-capable tools in the planning worker's effective tool
  set; test denied writes at the worker adapter boundary.
- Stale approval: bind to workflow revision and artifact digest.
- No Canvas permissions or Canvas unavailable: keep the task at the review gate, explain the issue
  briefly, and do not start implementation.
- Canvas changes: never treat user edits to the Canvas as a new authorized plan; publish a new
  version and require approval of its AgentX artifact digest.
- Required-check weakening: render project-required checks as fixed; only allow choices from the
  registered project's optional-check policy.

## Verification

Run focused contract, broker, worker-tool, MCP, and recovery tests, then the repository suite and
typecheck. Use a scripted worker and in-memory/fake DynamoDB; no paid model eval or live GitHub
workflow is part of local verification.
