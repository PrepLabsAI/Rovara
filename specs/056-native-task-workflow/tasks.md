# Tasks: Native AgentX Task Workflow

- [x] Add Quick/Full workflow-path selection to Slack and MCP task starts; persist the selection
  with the canonical workflow and enforce each path's approval stages. Keep project-required checks,
  reviews and human authority gates enabled in both paths.

- [x] 1. Specify workflow types, valid transitions, version and stale-binding rules in contracts.
- [x] 2. Add RED tests for valid/invalid transitions, stale artifact approval, owner authorization,
  disallowed skips, and replayed decisions; implement transition helpers until GREEN.
- [x] 3. Persist versioned workflow state and plan metadata; atomically bind the owner decision to
  the implementation operation. Verify actor ownership, revision and digest, replay safety, and
  plan-run recovery in the broker sample flow. (Full interruption/restart matrix remains open.)
- [x] 4. Add read-only planning worker configuration; verify plan mode saves a plan but emits no
  code diff or check report, and the post-approval operation is server-selected as IMPLEMENT.
- [x] 5. Add owner-authenticated plan decision and retry routes, MCP tools, and shared Slack status
  projection. (Project-admin decisions and Slack approval are not enabled.)
- [x] 6. Record the Slack-first plan UX: short thread messages, linked task-specific details, locked
  project-required checks, owner-selectable optional checks, and one canonical AgentX approval.
- [x] 7. Add Canvas link permissions to the generated Slack app manifest and cover the scopes with
  installer tests. Existing installed apps still need a user-driven reinstall to grant the scopes.
- [x] 8a. On plan completion, verify the saved artifact digest, create a channel-readable task
  Canvas, and post a short Slack link. Fall back with a clear next step when Canvas is unavailable.
- [x] 8b. Start Slack-originated workflows with `@AgentX workflow: <request>`, bind them to that
  thread, show plan approve/change controls, and collect optional project-approved checks in a modal.
  Broker transitions recheck the Slack task owner, exact thread, plan revision and digest.
- [ ] 9. Extend the sample flow through independent candidate checks, read-only review, PR-ready
  state and GitHub reconciliation. Candidate-bound checks and separate operation-bound reviews
  are implemented. GitHub webhook ingress and merge reconciliation are a separate change. Slack/MCP
  review controls and automatic review scheduling remain open.
- [ ] 10. Run the full repository suite and interruption/recovery matrix. Quick/Full phase
  contracts and task flow have focused Node 22 coverage. The full suite and complete restart/replay
  matrix remain outstanding.
