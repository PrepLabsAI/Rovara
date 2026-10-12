# Lane C final lifecycle correction

## Scope and authority

Executed against `MSDLC-OBJ-001@0.4`, objective SHA-256 `707543b940253c8e068da55af87b81b4c57dd8d0e82f83436be13f5391cdf0c2`. The clean starting source pin was `e03031e86bf31cfac43835501234656b88ead5e4`, tree `7be1b3c8690e63c9c22ae935d01646c885b435b3`; Node `v22.23.3`, npm `10.9.9`. Rights were local implementation, test, commit and independent review only.

## Corrections

R3 now admits a caller through a fresh read and current required role before the legacy closed-task response. Continue, cancel, pull-request and share retain their existing closed refusal, while terminal `MERGED` and `CLOSED` workflow stages are refused before any legacy mutation even when `closedAt` is absent. Existing workspace, operation, candidate, People revision and write fences remain in place. Contract coverage checks current creator and co-owner refusals, plus no task, People, operation or audit changes.

R4's signed Slack authorization port now performs a fresh current read and role check so a terminal feedback card reaches the canonical lifecycle check. The mutation route still enforces its open-task gate. The integrated cases cover the legacy Owner and current co-owner receiving the stale-card answer; revoked and UNKNOWN viewers receive the generic refusal, with no workflow, People or invocation changes.

No objective or authority change was made. No production configuration, live integration, AWS resource, role, secret, invitation, deployment or release state was changed.

## RED/GREEN evidence

Before the fix, the owned closed-task contracts and terminal feedback scenario reproduced the reported `TASK_NOT_FOUND` and ownership-denial responses. The new focused terminal authorization contract also failed at the current Owner's 404 response. These raw outputs are retained in `final-lifecycle-fix-raw/targeted-before.log`, `expanded-red.log`, and `terminal-auth-red.log`.

After the fix, the three owned contract files passed **50/50 tests** and workflow-e2e 8.3 plus 8.3b passed **2/2 selected tests**. The co-owner case reached the retired-card lifecycle response; revoked and UNKNOWN cases returned the generic refusal without changing workflow state or the People sidecar. The broader `08-merge-close.test.ts` run had one separate failure at 8.10: its expected named-owner copy differs from the current generic role refusal. That assertion is explicitly reserved to Lane D. The output is retained in `targeted-green.log`; it is not counted as an R3/R4 pass.

## Verification

Fresh final commands from this checkout, all using Node `v22.23.3`:

- `npm run build` — exit 0 (`build-verified.log`)
- `npx vitest run tests/contract/developer-task-actions-routes.test.ts tests/contract/developer-task-share-route.test.ts tests/contract/task-terminal-owner-authority.test.ts` — exit 0, 50 passed (`contracts-verified.log`)
- `npx vitest run tests/integration/workflow-e2e/08-merge-close.test.ts -t '8\\.3'` — exit 0, 2 selected passed (`workflow-83-verified.log`)
- `node --max-old-space-size=6144 node_modules/typescript/bin/tsc -p tsconfig.lint.json --noEmit --pretty false --incremental false` — exit 0 (`strict-verified.log`)
- `npm run typecheck:all` — exit 0, stricter baseline 0 errors in 0 files (`typecheck-all-verified.log`)
- `npx eslint packages/broker/src/aws/developer-tasks.ts packages/broker/src/aws/broker.ts tests/contract/developer-task-actions-routes.test.ts tests/contract/developer-task-share-route.test.ts tests/contract/task-terminal-owner-authority.test.ts tests/integration/workflow-e2e/08-merge-close.test.ts` — exit 0 (`scoped-lint-verified.log`)
- `git diff --check` — exit 0

The frozen branch's default full-suite gate remains the previously observed 27 failures / 15 files. This lane did not rerun or alter that suite. No typecheck baseline, build output, lint configuration, ignore rule, or test realism setting was changed.

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.4
alignment: pass
result_status: implemented
evidence_added:
  - R3 current-role and closed/terminal lifecycle regression coverage
  - R4 terminal UI authorization, retired-card stale response, and no-effect regressions
  - raw commands and outputs under final-lifecycle-fix-raw/
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
objective_digest_match: true
```

Independent review is pending before integration. This lane's local commit does not authorize push, PR, merge, deployment or activation.
