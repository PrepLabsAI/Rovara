# Design Plan: Task Dependencies Within an AgentX Workflow

## Objective boundary

Extend the native task-to-PR workflow so an owner can approve an understandable task breakdown with
dependencies. Keep AgentX as the executor and existing project checks, human approvals, GitHub, and
merge authority intact. Do not alter the CharterArc objective or claim this design is implemented.

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
