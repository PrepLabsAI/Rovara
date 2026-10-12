# Task 1: E2E contracts foundation

```yaml
executed_against: MSDLC-OBJ-001@0.4
objective_digest: sha256:707543b940253c8e068da55af87b81b4c57dd8d0e82f83436be13f5391cdf0c2
alignment: pass
result_status: implemented
evidence_added:
  - tests/contract/e2e-policy.test.ts
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task1
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
objective_digest_match: true
```

Added strict, versioned E2E policy, target, scenario, recipe, mock, availability, criterion, execution-plan, run-binding, round, artifact, coverage, and result contracts with bounded values and canonical policy, bundle, plan, and binding digests. Project policy remains optional. The `project-e2e` identity is reserved from ordinary checks. Required E2E workflow records cannot advance from VERIFY into review or publication until a trusted aggregate gate is implemented.

The contracts preserve requested and effective target identities, group case manifests, shared round identity/deadline, and explicit unavailable required criteria. Exploratory or simulation/fixture evidence, absent required cases, insufficient evidence scope, missing real components, and unconfirmed cleanup cannot qualify as PASS. A null model route rejects agent steps and model receipts.

Added the verifier workspace skeleton without browser or model dependencies. Existing project/workflow records remain valid when E2E is absent.

Verification on Node 22.23.2:

- `npm exec vitest -- run tests/contract/e2e-policy.test.ts tests/contract/task-workflow-contracts.test.ts tests/contract/project-command-env.test.ts tests/contract/project-model-selection.test.ts tests/contract/contracts.test.ts tests/contract/workflow-proposed-checks.test.ts` — 5 files, 100 tests passed.
- `npm run build` — passed.
- `npm run typecheck:all` — passed; strict baseline 0 errors, unchanged.
- `git diff --check` — passed.
- Red/green command output is retained under `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task1`. The hard-ceiling and null-route receipt regressions were each observed failing under a deliberate temporary mutation or missing rule, then passing after correction.

The required E2E review interlock is intentionally conservative until authenticated aggregate verification is integrated. Compiler, discovery, execution, report adaptation, runtime, model bridge, broker admission, UI, release, and live acceptance remain deferred. This report records Task 1 only and does not claim P0 completion.
