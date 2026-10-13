# Tasks: Task Dependencies Within an AgentX Workflow

## Approved serial phase

- [x] Implement bounded graph contracts, deterministic serial execution and canonical progress.
- [x] Bind whole-graph approval to the plan, current Owner authority, workflow and workspace.
- [x] Preserve final candidate checks, read-only review and one PR for human merge.
- [x] Locally verify the default-OFF broker configuration and task-bound planner instructions.
- [x] Locally verify the route-to-worker journey, failure pauses, explicit retries and channel parity.
- [ ] Complete independent review and required checks on the final runtime candidate.
- [ ] Observe a linked sequence in TEST and retain its exact candidate and transition evidence.
- [ ] Qualify older-broker compatibility before production activation.

Parallel and multi-repository execution remain later phases. Completing this serial phase does not
claim those phases are implemented. See [the current specification](spec.md) and
[operational guidance](../../docs/ordered-work.md).

## Historical design checklist (2026-10-05)

The first-phase repository/PR, whole-graph approval and size choices below are superseded by the
approved serial phase. The original checklist is retained as design history.

- [x] 1. Draft the task-graph user flow, statuses, approval binding, failure behavior, and proposed
  sequencing phases.
- [ ] 2. Resolve how graph revisions affect already-completed items and descendant approvals.
- [ ] 3. Resolve how work-item outputs map to candidate repositories and one or more pull requests.
- [ ] 4. Define graph size limits and readable Slack Canvas presentation.
- [ ] 5. Turn the reviewed design into an implementation contract, tests, and a phased plan.
