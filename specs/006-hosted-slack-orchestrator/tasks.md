# Tasks: Hosted Slack Orchestrator

**Input**: Design documents from `/specs/006-hosted-slack-orchestrator/`

**Tests**: Required by FR-035 and written alongside each implementation boundary.

## Phase 1: Contracts and Control Plane

- [X] T001 Add Slack binding, thread key, requester, and thread-workspace result contracts, with validation tests, in `packages/contracts/src/slack.ts` and `tests/contract/slack-contracts.test.ts`
- [X] T002 Add the administrator channel-binding API (`PUT`/`DELETE /v1/admin/slack/bindings/{teamId}/{channelId}`) in `packages/broker/src/aws/broker.ts`, with authorization tests
- [X] T003 Add the IAM-authorized service route identity. It accepts only the configured orchestrator role, derives thread owner keys from the Slack headers, and requires a bound channel. Tests cover rejected callers, unbound channels, and disjoint thread and personal owner keys
- [X] T004 Add thread workspace preparation with a single transaction for the workspace record and the member and organization limit counters. Tests cover limit refusal, concurrent requests for the last slot, and idempotent repeat preparation
- [X] T005 Route existing task, follow-up, event, status, and pull-request handlers through the service identity. Record `requestedBy` and append Slack requesters to pull request bodies. Tests cover cross-thread and personal-workspace isolation
- [X] T006 Add `agentx admin slack bind` and `agentx admin slack unbind` in `packages/cli/src/admin/slack.ts` and `packages/cli/src/main.ts`, with CLI tests

### Phase 1 evidence (local only)

- `tests/contract/slack-contracts.test.ts`, `tests/contract/slack-control-plane.test.ts`, and `tests/contract/slack-admin-cli.test.ts` cover: service identity, bindings, one workspace per thread, member and organization limits (including a race for the last slot), isolation from personal logins and other threads, and requester attribution on tasks and pull requests.
- Broker tests use `tests/support/fake-dynamodb.ts`, which evaluates condition and update expressions and applies transactions all-or-nothing.
- Full suite (34 files, 163 tests), typecheck, and lint pass, including with git identity auto-detection disabled.

## Phase 2: Slack Ingress

- [ ] T007 Implement the ingress handler in `packages/broker/src/aws/slack-ingress.ts`: signature and timestamp verification, the `url_verification` challenge, human `app_mention` filtering, bound-channel and same-team checks, duplicate suppression, the pending counter, FIFO enqueue, and acknowledgement or queued notice
- [ ] T008 Add ingress tests for invalid, stale, and valid signatures; bot, edited, direct-message, unbound, and Slack Connect events; duplicate `event_id`; and thread-root derivation in `tests/contract/slack-ingress.test.ts`

## Phase 3: Hosted Orchestrator Service

- [ ] T009 Create the `packages/slack-service` workspace package, with a SigV4 signing `fetch` for `/v1/service` that adds the thread and user headers
- [ ] T010 Implement the queue consumer: visibility heartbeat, thread workspace ensure with setup notices, conversation creation, one orchestrator turn, chunked replies, safe failures, pending-counter decrement, and message deletion
- [ ] T011 Persist and restore each thread's Pi session in S3 with `SessionManager.open`
- [ ] T012 Derive deterministic tool request IDs from `(event_id, tool-call index)` so redelivery resumes existing operations
- [ ] T013 Add consumer tests for per-thread ordering, parallel threads, redelivery after a crash (no duplicate operation, result posted), limit refusal messaging, and conversation restore in `tests/integration/slack-service.test.ts`
- [ ] T014 Add `environments/slack/Dockerfile`, pinned by digest from ECR Public, and a local build and smoke test

## Phase 4: Infrastructure

- [ ] T015 Extend `infra/lib/control-plane.ts` with the service and Slack routes, the ingress Lambda, the FIFO queue and dead-letter queue, the `SlackThreads` table, the Slack secret and orchestrator-role parameters, and the limit parameters
- [ ] T016 Add `infra/lib/slack-orchestrator.ts` (ECS cluster, Fargate ARM service, 443-only security group, thread session bucket, task role, log retention) and register it in `infra/bin/agentx.ts`
- [ ] T017 Add CDK assertions for route authorization types, least-privilege roles (the orchestrator gets no state-table access), FIFO configuration, the Fargate architecture, and security group egress in `tests/contract/infrastructure.test.ts`

## Phase 5: Release Pipeline

- [ ] T018 Generalize the worker-image reuse decision to per-image inputs, and add orchestrator image build, push, and conditional stack deployment in `scripts/release-production.ts`
- [ ] T019 Update the pipeline trigger patterns, the ECR repository permissions, and the stack describe permissions in `infra/lib/release-pipeline.ts`
- [ ] T020 Extend the release command and pipeline tests for the orchestrator inputs, the trigger coverage, and the permissions

## Phase 6: Retire Local Slack Mode

- [ ] T021 Remove `slack run`, `configure`, and `login`, the Socket Mode code, and `@slack/bolt`. Keep `slack logout`. Update `tests/contract/slack-mode.test.ts` and `tests/contract/cli-main.test.ts`
- [ ] T022 Replace the README Slack section with the hosted setup, and add the hosted Slack path to `docs/architecture-production.md`

## Phase 7: Local Validation

- [ ] T023 Run typecheck, lint, the full test suite (including with git identity auto-detection disabled), infrastructure synthesis, both image builds with smoke tests, and a production release dry run

## Phase 8: Deployment and Live Acceptance

- [ ] T024 Create the Slack secret, switch the Slack app from Socket Mode to the Events API request URL, and bind the project channel
- [ ] T025 Deploy the control-plane changes and the first `AgentXSlackOrchestrator` stack manually with its parameters. After that, the pipeline releases it
- [ ] T026 Live: a new thread is acknowledged within 5 seconds, prepares a workspace, and posts its result
- [ ] T027 Live: a second member's follow-up runs in the same workspace, after the first request
- [ ] T028 Live: two threads run in parallel in separate workspaces
- [ ] T029 Live: with temporarily lowered limits, a new thread over the limit is declined with the correct message
- [ ] T030 Live: restarting the orchestrator mid-task creates no duplicate operation, and the result is posted

## Dependencies

- T001 precedes all other tasks.
- T002–T005 establish the control-plane boundary that T007 and T009–T013 call.
- T015–T017 depend on T003, T007, and T010 for the resources they wire together.
- T018–T020 depend on T014 and T016.
- T021–T022 are independent of Phases 2–5, and can run in parallel with them.
- T024–T030 require explicit AWS and Slack administration authorization.
