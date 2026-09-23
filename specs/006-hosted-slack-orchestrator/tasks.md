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

- [X] T007 Implement the ingress handler in `packages/broker/src/aws/slack-ingress.ts`: signature and timestamp verification, the `url_verification` challenge, human `app_mention` filtering, bound-channel and same-team checks, duplicate suppression, the pending counter, FIFO enqueue, and acknowledgement or queued notice
- [X] T008 Add ingress tests for invalid, stale, and valid signatures; bot, edited, direct-message, unbound, and Slack Connect events; duplicate `event_id`; and thread-root derivation in `tests/contract/slack-ingress.test.ts`

### Phase 2 evidence (local only)

- 16 ingress tests cover signatures, the challenge, filtering, thread-root lanes, queued-ahead notices, duplicate events, empty mentions, enqueue-failure retry, and no request text in logs.
- A failed enqueue undoes the pending increment and the event claim, then returns 500, so Slack's retry is processed as new.
- The shared helpers `slackRequestText`, `splitSlackMessage`, and the queue message schema now live in `packages/contracts/src/slack.ts`.
- Full suite (35 files, 179 tests), typecheck, and lint pass.

## Phase 3: Hosted Orchestrator Service

- [X] T009 Create the `packages/slack-service` workspace package, with a SigV4 signing `fetch` for `/v1/service` that adds the thread and user headers
- [X] T010 Implement the queue consumer: visibility heartbeat, thread workspace ensure with setup notices, conversation creation, one orchestrator turn, chunked replies, safe failures, pending-counter decrement, and message deletion
- [X] T011 Persist and restore each thread's Pi session in S3 with `SessionManager.open`
- [X] T012 Derive deterministic tool request IDs from `(event_id, tool-call index)` so redelivery resumes existing operations
- [X] T013 Add consumer tests for per-thread ordering, parallel threads, redelivery after a crash (no duplicate operation, result posted), limit refusal messaging, and conversation restore in `tests/integration/slack-service.test.ts`
- [X] T014 Add `environments/slack/Dockerfile`, pinned by digest from ECR Public, and a local build and smoke test

### Phase 3 evidence (local only)

- **CLI changes for reuse.**
  - `@agentx/cli` now exports `orchestrator`, `control-plane-api`, and `event-client`.
  - `createOrchestratorRuntime` accepts an existing `sessionFile` and a `requestId` generator. The local CLI keeps random request IDs.
  - `runOrchestratorTurn` and `lastAssistantText` now live in `orchestrator.ts`.
- **Workspace response.** The thread workspace response now carries the project's `orchestratorInstructions`, so the hosted orchestrator uses the same system prompt as the local one.
- **Tests.** `tests/integration/slack-service.test.ts` (14 tests) covers:
  - deterministic request IDs, and SigV4 signing with path rewriting and thread headers
  - the new-thread, follow-up, limit, setup-failure, and turn-failure paths
  - retry versus final-attempt handling, and identical tool request IDs on redelivery
  - per-thread ordering with parallel threads, keeping a failed thread's messages for redelivery, and visibility heartbeats
- **Not unit-tested.** S3 session persistence and the AWS wiring in `src/main.ts` are verified only by the Phase 8 live tests.
- **Images.** `environments/slack/Dockerfile` builds for linux/arm64 locally, and every module resolves in the container. The worker Dockerfile now copies `packages/slack-service/package.json` for `npm ci`; that file is a worker image input, and the rebuilt worker still reports `Healthy`.
- **Phase 5 work done early.** The pipeline trigger now covers `packages/{broker,cli,contracts,slack-service,worker}/**`.
- **Checks.** Full suite (36 files, 193 tests), typecheck, and lint pass.

## Phase 4: Infrastructure

- [X] T015 Extend `infra/lib/control-plane.ts` with the service and Slack routes, the ingress Lambda, the FIFO queue and dead-letter queue, the `SlackThreads` table, the Slack secret and orchestrator-role parameters, and the limit parameters
- [X] T016 Add `infra/lib/slack-orchestrator.ts` (ECS cluster, Fargate ARM service, 443-only security group, thread session bucket, task role, log retention) and register it in `infra/bin/agentx.ts`
- [X] T017 Add CDK assertions for route authorization types, least-privilege roles (the orchestrator gets no state-table access), FIFO configuration, the Fargate architecture, and security group egress in `tests/contract/infrastructure.test.ts`

### Phase 4 evidence (local only)

- **The orchestrator task role lives in `AgentXControlPlane`**, not the orchestrator stack. The control plane must know the role before the orchestrator exists: the broker only accepts `/v1/service` calls from that role. The role's queue, table, bucket, secret, Bedrock, and `/v1/service/*` invoke permissions live there too.
- **`AgentXSlackOrchestrator` only runs the container.** It uses L1 resources with parameters for the image digest, task role, queue, table, bucket, secret, VPC, and private subnets. This matches the foundation-to-runtime pattern: values are handed over through outputs and parameters, not CloudFormation exports.
- **The Slack secret is created with a generated placeholder `signingSecret`**, so no request passes signature verification until an operator stores the real values with `put-secret-value`. Real tokens never pass through CloudFormation.
- **Tests.** Infrastructure tests (19) cover:
  - authorization type per route
  - the FIFO queue with a dead-letter queue after 5 receives
  - thread record TTL, the secret placeholder, and limit parameters
  - broker environment wiring for the orchestrator role and limits
  - an orchestrator role limited to service routes, with no state-table access
  - ingress state-table reads limited to `SLACK_BINDING#*` keys
  - ARM64 Fargate with no public IP and a deployment circuit breaker
  - outbound-HTTPS-only networking, and image pulls limited to `agentx-slack-orchestrator`
- **Checks.** `cdk synth` of all stacks succeeds. Full suite (36 files, 200 tests), typecheck, and lint pass.

## Phase 5: Release Pipeline

- [X] T018 Generalize the worker-image reuse decision to per-image inputs, and add orchestrator image build, push, and conditional stack deployment in `scripts/release-production.ts`
- [X] T019 Update the pipeline trigger patterns, the ECR repository permissions, and the stack describe permissions in `infra/lib/release-pipeline.ts`
- [X] T020 Extend the release command and pipeline tests for the orchestrator inputs, the trigger coverage, and the permissions

### Phase 5 evidence (local only)

- **Shared helpers.** `buildAndPushImage` (in `scripts/release-demo.ts`) and `reusableImage` (in `scripts/release-production.ts`) are shared by both images; `buildAndPushWorker` and `reusableWorkerImage` are thin wrappers, so the worker path is unchanged.
- **New release steps.** After the control plane is deployed, `release:prod`:
  1. builds or reuses the Slack orchestrator image
  2. smoke-tests that its modules resolve inside the container
  3. deploys `AgentXSlackOrchestrator`, passing control-plane and foundation outputs as parameters
- **Creating the stack.** If the stack does not exist, the release skips it, unless an operator passes `--create-slack-orchestrator`. The pipeline never passes that flag.
- **Pipeline permissions.** The build role may push to `agentx-slack-orchestrator` and describe `AgentXSlackOrchestrator`. These permissions reach AWS only when `AgentXReleasePipeline` is redeployed by hand (T025).
- **Tests.** Slack orchestrator Dockerfile coverage, trigger coverage for both images' inputs, the creation flag, repository-name agreement between the script and the infrastructure, and pipeline IAM.
- **Checks.** Full suite (36 files, 202 tests), typecheck, and lint pass.
- **Unchanged pre-existing errors.** A stricter compile of scripts and tests with `tsconfig.lint.json` reports the same errors on `mainline` as on this branch. None are in files or lines this feature added. CI does not run that check.

## Phase 6: Retire Local Slack Mode

- [X] T021 Remove `slack run`, `configure`, and `login`, the Socket Mode code, and `@slack/bolt`. Keep `slack logout`. Update `tests/contract/slack-mode.test.ts` and `tests/contract/cli-main.test.ts`
- [X] T022 Replace the README Slack section with the hosted setup, and add the hosted Slack path to `docs/architecture-production.md`

### Phase 6 evidence (local only)

- **CLI.** `agentx slack` keeps only `logout`, which still deletes the `slack:<project>` entry that the local mode stored in the OS credential store. The retired subcommands exit with an error.
- **Removed code.**
  - `packages/cli/src/slack.ts` and `slack-config.ts` are deleted.
  - `slack-credentials.ts` keeps only the deletion helper.
  - `@slack/bolt` and its 99 transitive packages are gone from the lockfile.
- **README.** The setup now covers:
  - reading the Slack stack outputs
  - storing the signing secret and bot token without echoing them
  - switching the Slack app from Socket Mode to the Events API request URL
  - channel binding and rebinding per project revision
  - thread behavior, limits, diagnostics, and retries
- **Architecture doc.** `docs/architecture-production.md` gains a hosted Slack section with a diagram. It covers ingress, per-thread ordering, session restore, the service identity, and the atomic limits, and states which stack owns each resource.
- **Checks.** Full suite (36 files, 198 tests) and lint pass. The test count drops from 202 because the Socket Mode bridge tests were removed with the bridge.

## Phase 7: Local Validation

- [X] T023 Run typecheck, lint, the full test suite (including with git identity auto-detection disabled), infrastructure synthesis, both image builds with smoke tests, and a production release dry run

### Phase 7 evidence (local, plus read-only AWS diffs)

- **Checks.** Typecheck, lint, and the full suite (36 files, 198 tests) pass, with git identity auto-detection disabled.
- **Synthesis.** `cdk synth` in `instances-ebs` mode produces all five stacks. The only validation warning is the pre-existing `GitHubAppPrivateKeySecretArn` "looks like a password" false positive: the parameter is an ARN, not a secret.
- **Images.** Both images build for linux/arm64 and pass the release smoke tests.
  - Slack orchestrator (186 MB): the orchestrator, control-plane client, and consumer modules resolve.
  - Worker (219 MB): `/ping` reports `Healthy`.
- **Dry run.** `release:prod --dry-run` prints the plan with and without `--create-slack-orchestrator`. Step 7 now says the orchestrator image is built only when its stack exists or is being created.
- **`AgentXControlPlane` diff against AWS.**
  - Adds the Slack parameters, secret, threads table, queue and dead-letter queue, session bucket, orchestrator task role, ingress Lambda and its log group, the two routes, and the Slack outputs.
  - Updates the three existing Lambdas in place.
  - Replaces or removes nothing.
  - Until the secret is set and the Slack app points at the events URL, the new ingress rejects every request.
- **`AgentXReleasePipeline` diff against AWS.** It only adds build-role permissions: `DescribeStacks` on `AgentXSlackOrchestrator`, and push access to `agentx-slack-orchestrator`.
- **Deployment order (confirmed by reading `stackExists`).** `stackExists` throws on `AccessDenied`. If `mainline` releases this branch before `AgentXReleasePipeline` is redeployed, the run deploys the runtime and control plane and then fails at the orchestrator step. Redeploy the pipeline stack before merging. Its changes only add permissions and widen the trigger, so they are compatible with the current `mainline`.

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
