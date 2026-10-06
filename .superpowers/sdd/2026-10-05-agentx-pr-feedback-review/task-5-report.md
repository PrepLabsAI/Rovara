# Task 5 report: fresh approval and worker-start dispatch fence

## Objective and authority

- Executed against `MSDLC-OBJ-001@0.4`, digest `707543b940253c8e068da55af87b81b4c57dd8d0e82f83436be13f5391cdf0c2`.
- Scope: bind owner approval to fresh linked-PR state, atomically reserve implementation dispatch, and reauthorize at worker start per FR-009/011/012/013.
- Local implementation and focused verification only. No live GitHub, Slack, or AWS calls; no push, merge, deployment, release, or Canvas deletion.
- Preserved Task 4 correction commit `d1a85a2a`.

## Implemented

- The browser review decision path now reloads current GitHub state for every linked open/unknown PR before recording a new decision. Exact duplicate request IDs return the prior decision without refreshing or dispatching again; conflicting reuse is rejected.
- Approval performs a second GitHub reconciliation immediately before the conditional DynamoDB reservation. The task workflow update, implementation operation, and durable outbox are committed through the existing `acceptTask` transaction with the same request ID. A revision, stage, state, pending-review, review-digest, proposal-digest, or closed-task mismatch prevents the reservation.
- The persisted dispatch binding carries task ID, request ID, owner ID, decision and active workflow revisions, candidate digest, review/proposal/bundle digests, and selected finding/comment IDs. A shared contract matcher additionally proves that those selected findings/comments and bundle identities, PR membership, comment-set digests, heads, and candidate bindings are the exact immutable report inputs.
- The worker calls the signed broker `feedback-approval` callback before it reads the preparation manifest or accesses the workspace. The broker re-fetches every linked PR from GitHub, then consistently reloads task state and validates the owner, open PR set, candidate, review/proposal/bundle digests, selected finding/comment IDs, decision request ID, and active revision. Missing GitHub access, changed PR state, invalidated workflow state, or any mismatch fails closed.
- New collection/reconciliation clears the persisted dispatch approval. Request-changes and dismiss decisions do not enqueue code. The prompt contains only selected approved report findings and their original comments, labels GitHub content as untrusted data, preserves required checks/reviews, and forbids GitHub reply/review side effects.
- Added regression coverage for the queue gap: after an implementation outbox is reserved, the workflow revision is invalidated before worker startup. The broker callback performs a fresh GitHub read and refuses authorization. A worker-level test confirms callback denial stops execution before workspace access.

## State transition and race boundary

`WAIT_FOR_MERGE / WAITING / review PENDING` → fresh GitHub reconciliation → owner decision → second fresh reconciliation → one conditional transaction stores the decision, `IMPLEMENT / RUNNING` workflow with approval binding, operation, and outbox → worker startup calls broker authorization → fresh GitHub read plus exact persisted-binding check → only then may the worker inspect its workspace and execute.

GitHub reads cannot be atomic with DynamoDB writes. The second read narrows the decision-to-reservation window; the DynamoDB transaction fences concurrent task/workflow changes; the signed worker-start authorization is the final dispatch boundary and catches a GitHub change or webhook/CAS invalidation that lands while the outbox is waiting. An event arriving after worker authorization is a later event and cannot retroactively stop code already authorized. This implementation does not claim an atomic GitHub-plus-DynamoDB transaction.

The outbox uses the existing request/operation idempotency and operation fence. A retry with the same exact decision request resolves to the existing decision/dispatch rather than creating another implementation operation. Conflicting request reuse is rejected. No separate ambiguous-delivery recovery protocol was added; restart/replay orchestration remains in Task 7.

## Slack boundary

The current Slack feedback action payload still binds the older `feedbackId` and candidate digest. It does not carry the new review/proposal/bundle digests or selected finding IDs required by this approval contract. This Task 5 change therefore does not claim that Slack actions use the new canonical approval path. Task 6 must update the Slack action payload and route it through `submitWorkflowFeedbackDecision`, binding team, user, channel, thread, task owner/revision, request ID, digests, and selected findings. Until then, the new reviewed-fix approval path is available through the authenticated AgentX page; the legacy Slack controls are not parity for this path.

## Changed files

- Broker: `packages/broker/src/aws/broker.ts`, `cancellation.ts`, `developer-routes.ts`, `developer-task-actions.ts`, `developer-tasks.ts`, `github-webhooks.ts`.
- Contracts: `packages/contracts/src/operation.ts`, `protocol.ts`, `task-workflow.ts`.
- Worker: `packages/worker/src/callback-client.ts`, `run-task.ts`.
- Tests: `tests/contract/feedback-review-web.test.ts`, `github-webhook-signature.test.ts`, `task-workflow-contracts.test.ts`, `tests/integration/no-change-task.test.ts`.

## Verification

- Node `v22.23.0`: `PATH=/private/tmp/node-v22.23.0-darwin-arm64/bin:$PATH npm run build` — passed.
- Node `v22.23.0`: `PATH=/private/tmp/node-v22.23.0-darwin-arm64/bin:$PATH npm exec vitest -- run tests/contract/task-workflow-contracts.test.ts tests/contract/feedback-review-web.test.ts tests/contract/github-webhook-signature.test.ts tests/integration/no-change-task.test.ts --reporter=dot` — 4 files passed, 98 tests passed.
- `git diff --check` — passed before the final contract assertion adjustment; rerun before commit.
- Full repository suite intentionally not run; Task 7 owns full-suite classification and end-to-end recovery. Live Slack/GitHub/AWS behavior remains unverified.

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.4
objective_digest_match: true
alignment: pass
result_status: verified
evidence_added:
  - Node 22 TypeScript build passed
  - four focused suites passed, 98 tests
  - worker-start callback regression performs fresh GitHub read then rejects invalidated workflow
  - worker callback denial occurs before workspace access
decision_proposals: []
assumption_changes: []
scope_delta: Slack decision action binding remains assigned to Task 6
contradictions:
  - Slack legacy action payload does not yet use the new feedback approval binding
objective_change_attempted: false
```

Independent review is pending; report status remains `verified` until review is complete.
