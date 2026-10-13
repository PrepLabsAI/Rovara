# Design Plan: Task Dependencies Within an AgentX Workflow

## Objective boundary

Extend the native task-to-PR workflow so an owner can approve an understandable task breakdown with
dependencies. Keep AgentX as the executor and existing project checks, human approvals, GitHub, and
merge authority intact. Do not alter the CharterArc objective or claim implementation, verification
or live qualification without evidence for the exact candidate.

## Current serial phase

The owner approved one repository, one final PR, whole-graph reapproval and pause on failure. The
current contract uses 1–8 items, 12 dependency links and 16,384 canonical graph bytes. It runs through
the existing coding-plan approval, worker operation, final checks and reviews, publication and human
merge. The current task is to qualify the runtime connection and its live TEST journey.

Keep deployment default OFF. `WorkflowDependenciesEnabled` supplies the broker's
`AGENTX_WORKFLOW_DEPENDENCIES_ENABLED`; eligible coding planners receive the task's canonical ID
and repository from its starting project revision. Existing durable progress acknowledgement and
operation-attempt fences control serial execution. Worker compatibility is required before delivery.

The review page replaces the draft's Canvas-first presentation. Slack and MCP retain equal actions.
Production activation and older-version recovery remain separately qualified. OFF prevents new
graph starts and retries but does not make older code understand retained graph records.

## Design work

1. Define the immutable task-graph and work-item contracts, including stable IDs, graph revisions,
   dependency validation, and candidate/evidence references.
2. Draw the owner experience in the Full path: review graph, understand blockers, approve, revise,
   and inspect progress from concise Slack messages plus the linked Canvas.
3. Specify serialized execution, failure propagation, cancellation, retries, and restart recovery.
4. Define how the graph maps onto the existing workflow candidate and single/multiple PR tracking.
5. Review repository isolation and integration requirements before proposing any parallel execution.
6. Add estimates and acceptance tests only after the design and unresolved decisions are reviewed.

## Guardrails

- Do not dispatch implementation from a proposed or unapproved graph.
- Do not allow cycles or ambiguous dependency resolution.
- Do not allow a failure in one branch to hide the state of independent work.
- Do not treat task completion as PR merge, deployment, or production validation.
- Do not enable concurrent writes to a shared checkout.
