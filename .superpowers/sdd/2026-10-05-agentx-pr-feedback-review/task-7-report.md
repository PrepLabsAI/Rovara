# Task 7 implementation report

## Scope and status

Implemented locally against `MSDLC-OBJ-001@0.4` and the approved PR feedback review spec. This report covers the Task 7 owner journey, recovery fixture additions, and aggregate measures. The parent task owns the full base/candidate suite comparison, typecheck/lint/infra synth, and independent whole-branch review; those results are not claimed here.

## Added and connected

- Added a two-linked-PR owner journey fixture. It reads findings bound to each PR head and approves both in one owner decision; the broker records both bundle digests/selections and queues exactly one implementation operation.
- Added privacy-safe aggregate events for notice-to-decision time, whether an owner followed or changed recommendations, and newly reopened feedback. Events contain only a static event name, measure name, count, and timestamp.
- Notice latency uses the exact delivered Slack notice marker for the current task/review/revision. Missing marker data omits that latency sample; telemetry lookup failure does not block an owner decision.
- Recommendation events run only after the decision commits. A duplicate decision returns through the idempotency path and does not emit a second event.
- Reopened feedback is emitted only after a successful workflow save when a previously resolved thread is reopened or gains newly eligible feedback. Duplicate/replay reconciliation does not emit another count.
- Added assertions that analytics contain no task, finding, reviewer, comment, diff, Slack identity, or comment-body values.
- The review page now reads workflow state/stage/outcome/blocker and any active operation from the current task/workspace records. Its current next action is derived from those live records; the older owner decision remains a historical decision only.
- The page hides approval controls when there are no recommended findings, and it also suppresses them when the current workflow is blocked.

## Recovery and journey evidence

The existing broker contract suites exercise service-level retry/replay paths: current bundles across two linked PRs; duplicate and delayed webhook deliveries; changed comments and heads; concurrent revision conflicts followed by fresh recollection; approval bound to exact current digests; refusal before dispatch when state changes; idempotent owner retry; worker-start reauthorization; and completion only after all required PRs are GitHub-observed merged. These tests do **not** prove process-crash or consumer-restart recovery. The added persisted-state test recreates the review-page handler at the review and approval boundaries and confirms it reads the stored decision and subsequent blocked/merged workflow state. Webhook-consumer restart recovery remains unverified.

No `tests/e2e` directory or browser automation infrastructure exists in this checkout. Keyboard, focus, narrow-screen, zoom, and semantic browser interaction checks remain unverified and need a suitable browser harness. Canvas deletion recovery is also open; Canvas closeout/deletion belongs to the companion plan and was not implemented here.

## Verification

- Node `22.23.0`: `node ./node_modules/vitest/vitest.mjs run tests/contract/feedback-review-measures.test.ts tests/contract/feedback-review-web.test.ts tests/contract/github-webhook-signature.test.ts tests/contract/task-workflow-contracts.test.ts` — 4 files passed, 76 tests passed.
- Node `22.23.0`: `npm run build` — passed (`tsc -b`).
- `git diff --check` — passed.
- Full base/candidate test suites, `npm run typecheck`, `npm run lint`, `npm run infra:synth`, live services, and browser accessibility checks were not run in this subtask.

## Review correction

The persisted-state journey recreates the review-page handler before/after owner approval and after workflow transitions to blocked and merged. It asserts current workflow state, active operation status, blocker, and next action, so an earlier `APPROVE` record cannot make a later blocked task appear to be progressing. The review page's approval controls are omitted for a zero-recommendation advisory. The API Gateway route throttling assertion and named control-plane template snapshot now include the public `/review/*` route.

Focused correction verification (Node `22.23.0`): `feedback-review-web`, measure, webhook, workflow, sign-in infrastructure, and named-template suites passed (6 files / 108 tests). `npm run build` (`tsc -b`) and `git diff --check` passed.

## Limits

No live Slack, GitHub, or AWS services were used. The implementation records aggregate events through the existing broker logging path; it does not add a new analytics datastore. Browser accessibility and live delivery remain explicit verification gaps.
