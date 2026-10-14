# Native P0 journey acceptance record

This record covers a local, synthetic acceptance journey for the managed native E2E path. It is not live endpoint qualification, a customer result, or production delivery evidence.

## Journey and evidence

The contained journey exercises project setup, canonical feature proposal and owner approval, implementation, protected candidate export, multi-group native CHECKS, current-round qualification, review, and exact-head local publication. It also covers an `UNKNOWN` required browser criterion, a required E2E assertion failure while ordinary checks pass, Owner SendBack with a fresh candidate and round, authenticated task enrollment and proof import, authority revocation and restoration with explicit retry, cancellation and late-result rejection, and setup/workspace domain separation. Ordinary check results and required E2E qualification remain separate: ordinary PASS does not erase a required E2E FAIL or UNKNOWN.

The previously verified local candidate was `69f9ead7425604125c989d1b12f395ef59e5a4d8` (tree `2c5eb1128b2dc6df3a9298471d3a8c529539675a`). On that candidate, all six source and acceptance gates passed: build, strict typecheck, lint, ordinary tests (10,804 passed; 20 optional tests skipped), native profile (28 passed; zero skipped), and offline synth. A qualified independent whole-branch review found no blocking issue. These results are candidate-bound and do not verify the current integration merge. Re-run the acceptance launcher and review against the integrated commit before treating the branch as verified.

The prior run used the pinned Node 22.23.2 runtime and the locally available pinned Linux ARM64 verifier image. Its original task, worker, current/stale round, cancellation/retry, source/export, publication, and immutable evidence receipts remain in the private external evidence collection alongside this checkout. The launcher records its source head, runtime, emitted verifier identity, and evidence roots in a preflight receipt. Run `scripts/acceptance/p0-native-journey.sh` with `AGENTX_NODE22`, a fresh private `TMPDIR`, and pre-created private evidence directories in the required sibling collection layout documented by the script; it does not pull the verifier image.

The causal defect/fix journey preserves the browser-required `UNKNOWN` control separately from portable source-interface success. The red/fix candidate, approval, and round identities are distinct; approved expectations and fixture definitions remain bound to their canonical artifacts. Local Git publication verified the reviewed commit and tree at an owned bare remote. Synthetic model and reviewer transports, local strict storage/HTTP doubles, and a local Git remote were used; no real provider, Slack, GitHub, cloud, or customer action occurred.

## Limits and outstanding verification

The reported 69f candidate evidence does not establish the result of later follow-up commits or this integration. Integrated source gates and parent acceptance rerun remain pending until recorded against the exact integrated commit. External identity-provider revocation races and any live endpoint, customer, payment, or production outcome remain unverified. Earlier failed and unavailable runs remain diagnostics and are not replaced by the passing candidate run.

## Objective integrity

The implementation keeps the canonical approved plan and current candidate/round evidence authoritative. Worker, model, display, and CLI projections do not independently grant readiness or publication authority. Unknown browser/native obligations remain visible and block aggregate readiness. No product objective or release authority was changed by this local acceptance work.
