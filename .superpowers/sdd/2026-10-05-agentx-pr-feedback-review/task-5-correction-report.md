# Task 5 correction report: require worker approval capability

## Scope

Addressed the independent review finding on commit `13de4f0c`: an approved PR-feedback implementation could be posted to a worker that advertised `task.workflowMode` but did not advertise support for the `workflowFeedbackApproval` invocation field.

## Change

- Added the explicit `task.workflowFeedbackApproval` worker invocation feature.
- The worker advertises that feature through its existing `/ping` response.
- EC2 delivery now requires the feature whenever an invocation carries a feedback approval. Missing capability fails before signing or posting to `/invocations`; it does not strip the binding or downgrade authorization.
- Other invocations retain the existing feature negotiation behavior.
- Added regression tests for rejection before POST and successful delivery to a worker advertising both workflow mode and approval authorization. Updated the worker ping contract expectation.

## Verification

- Test-first RED on Node `v22.23.0`: the new rejection test failed because the invocation was incorrectly delivered (`DELIVERED`).
- Node `v22.23.0`: `npm run build` — passed.
- Node `v22.23.0`: `npm test -- tests/contract/ec2-dispatch.test.ts tests/contract/worker-server.test.ts --run` — 2 files passed, 47 tests passed.
- `git diff --check` — passed.

## Limits and postflight

- No live worker, AWS, Slack, or GitHub service was used. No push, merge, deployment, release, or Canvas deletion occurred.
- Full repository suite remains assigned to Task 7 for base comparison and failure classification.

```yaml
executed_against: MSDLC-OBJ-001@0.4
objective_digest_match: true
alignment: pass
result_status: verified
evidence_added:
  - red regression test reproduced downgrade-to-delivery before fix
  - Node 22 build passed
  - focused EC2 dispatcher and worker-server contracts: 47 passed
  - git diff --check passed
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
```
