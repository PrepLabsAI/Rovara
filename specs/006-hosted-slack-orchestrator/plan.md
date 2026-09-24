# Implementation Plan: Hosted Slack Orchestrator

## Summary

Replace the local Socket Mode bridge with a hosted pipeline. Slack's Events API calls a new unauthenticated route on the existing HTTP API. A small ingress Lambda verifies Slack's signature, filters the event, discards duplicates, and acknowledges in the thread. It then enqueues the request on an SQS FIFO queue whose message group is the thread. An always-on ECS Fargate service consumes the queue and runs the existing Pi orchestrator and its AgentX tools. It calls the control plane through a new IAM-authorized service route that is limited to Slack thread workspaces.

The control plane treats each thread as a workspace owner. The existing one-workspace-per-owner-and-project model therefore gives exactly one workspace per thread. A conditional transaction enforces the per-member (3) and organization (20) limits when a thread workspace is created.

## Technical Context

- TypeScript 5.9 / Node.js 22.23.2 monorepo. AWS CDK 2.269. Vitest.
- Control plane: API Gateway HTTP API. The `ANY /{proxy+}` route uses a JWT authorizer, and `POST /v1/internal/{proxy+}` uses worker callback capabilities. Broker, Dispatcher, and OutboxPublisher Lambdas, and a DynamoDB state table with a stream.
- Workspaces are keyed `OWNER#<ownerKey>` / `PROJECT#<projectName>`, one default workspace per owner and project. Preparation is asynchronous (`POST /v1/admin/workspaces/prepare` returns `202` with `PREPARING`) but is currently administrator-only.
- The orchestrator is already injectable. `createOrchestratorRuntime({ api, context, model })` takes any `OrchestrationApi` implementation. `ControlPlaneApi` accepts a custom `fetch`, and `assertOrchestrationOnly` enforces the tool boundary.
- The Pi SDK `SessionManager.open(path)` reopens a saved session file, so thread conversations can be persisted and restored.
- Production release pipeline: `AgentXReleasePipeline` runs `release:prod` (feature 005).

## Constitution Check (v1.2.0)

- **I:** The hosted orchestrator reuses `createOrchestrationTools` and `assertOrchestrationOnly`, so it gets no repository, file, or shell tools. It accepts only Slack-signed events from members of bound channels, and acts through an IAM service identity limited to thread owners.
- **II:** The channel-to-project binding and the project definition remain administrator-managed. Thread workspace preparation completes before any task is submitted, and only the Slack acknowledgement precedes it.
- **III:** Thread owner keys are derived from `slack-thread` plus team, channel, and root timestamp. This namespace is disjoint from OIDC owner keys, so the service route can never reach personal workspaces, and personal logins can never reach thread workspaces.
- **IV:** Durable event deduplication, deterministic request IDs, and persisted thread conversations. Per-thread FIFO ordering keeps one mutating run per checkout.
- **V:** This spec, plan, and tasks; behavioral tests for isolation, limits, retries, and recovery; live evidence recorded separately from local validation.

## Design

### 1. Control plane (broker and `ControlPlaneStack`)

1. **Channel bindings.** Administrators manage bindings with `PUT` and `DELETE /v1/admin/slack/bindings/{teamId}/{channelId}`, with body `{ projectName }`, through the existing JWT route and `requireAdministrator`. A binding names the project only. When a new thread workspace is created, the broker queries the project's revision records (`PROJECT#<name>`, sort keys `REV#<zero-padded>`, descending, limit 1) and uses the latest. *(Amended for issue #13; bindings originally named an exact revision.)* Bindings are stored as `SLACK_BINDING#<teamId>` / `CHANNEL#<channelId>`. The CLI adds `agentx admin slack bind` and `agentx admin slack unbind`.
2. **Service route.** A new `ANY /v1/service/{proxy+}` route with `AWS_IAM` authorization. The broker maps `/v1/service/<rest>` to `/v1/<rest>`, so the orchestrator reuses the ordinary API paths. The broker accepts it only when the caller's IAM role equals the configured orchestrator task role. Each request carries `x-agentx-slack-thread` (team, channel, root timestamp) and `x-agentx-slack-user`. The broker:
   - derives the thread owner key and an identity from those headers
   - verifies that the channel is bound
   - dispatches to the existing workspace, task, follow-up, event, status, and pull-request handlers with that identity

   Personal routes reject thread owner keys, and the service route cannot produce OIDC owner keys.
3. **Thread workspace preparation.** `POST /v1/service/threads/workspace` reuses the prepare logic with `targetOwnerKey` set to the thread key and no administrator check. A new thread creates the workspace in a single DynamoDB `TransactWriteItems` that:
   - puts the default-workspace record, conditional on it not existing
   - increments `SLACK_LIMIT#<teamId>` / `ORG`, conditional on the count being below the organization limit
   - increments `SLACK_LIMIT#<teamId>` / `MEMBER#<userId>`, conditional on the count being below the member limit
   - records the starter

   A failed condition returns `SLACK_WORKSPACE_LIMIT` with the limit that was hit and, for the member limit, the member's thread links. Counters never decrease, because deletion is out of scope.
4. **Limits configuration.** `SlackMemberWorkspaceLimit` (default 3) and `SlackOrganizationWorkspaceLimit` (default 20) are `ControlPlaneStack` parameters, passed to the broker environment.
5. **Requester attribution.** Operations created through the service route record `requestedBy: { teamId, userId }`. Pull requests created or updated from a thread get an appended line naming the requesting Slack users.

### 2. Slack ingress (`ControlPlaneStack`)

- **Route.** `POST /v1/slack/events` with authorization `NONE`, handled by a new `SlackIngress` Lambda (Node 22, ARM, 10-second timeout).
- **Processing steps:**
  1. Verify the `v0` HMAC-SHA256 signature over `v0:<timestamp>:<rawBody>` with the signing secret, rejecting timestamps older than 5 minutes.
  2. Answer `url_verification` challenges.
  3. Accept only `event_callback` payloads with `app_mention` events from human users: no `bot_id` and no `subtype`, in a bound channel, where the event's user team equals the bound team (this excludes Slack Connect externals).
  4. Discard duplicates with a conditional put on `EVENT#<event_id>` in a new `SlackThreads` table (TTL 14 days).
  5. Increment the thread's `pendingRequests` in `SlackThreads`, then send to `SlackRequests.fifo` with `MessageGroupId` set to a hash of the thread key and `MessageDeduplicationId` set to `event_id`.
  6. Post "Accepted" or "Queued behind N request(s)" in the thread with `chat.postMessage`, then return `200`. Slack retries are safe because of step 4.
- **Secrets.** One Secrets Manager secret `{ signingSecret, botToken }`. Its ARN is a stack parameter, and it is created manually, so it is never in code or CloudFormation.
- **Queue.** `SlackRequests.fifo`, with a dead-letter queue after 5 receives. The visibility timeout starts at 15 minutes and is extended by the consumer.

### 3. Hosted orchestrator (new package `packages/slack-service`, new stack `AgentXSlackOrchestrator`)

- **Service.** ECS Fargate ARM64, 0.5 vCPU / 1 GiB, one task, in the production foundation's private subnets (existing NAT egress). Its security group allows only outbound 443. Subnets and security group are stack parameters, like the runtime's capacity-provider parameter.
- **Consumer loop, per message:**
  1. Extend visibility every 5 minutes, up to SQS's 12-hour maximum.
  2. Load the thread record and its Pi session file from an S3 bucket (`threads/<threadKey>/session.jsonl`, versioned and encrypted).
  3. Ensure the thread workspace through the service route. For a new workspace, post "Setting up a new workspace…", then follow the prepare operation to `READY`.
  4. Create the thread's control-plane conversation on first use.
  5. Post "Started…".
  6. Run one orchestrator turn with the mention text. The API is `ControlPlaneApi` with a signing `fetch` (SigV4 for `execute-api`) that targets `/v1/service` and adds the thread and user headers.
  7. Post the response in chunks, or a safe failure message.
  8. Save the session file, decrement `pendingRequests`, and delete the message.
- **Idempotency.** Tool request IDs are UUIDv5 of `(event_id, tool-call index)`. On redelivery, the same submission returns the existing operation and the tool polls it (FR-022, FR-023).
- **Task role.**
  - SQS receive, delete, and change-visibility on the queue
  - `execute-api:Invoke` on `/v1/service/*` only
  - Bedrock invoke on the configured model
  - S3 read and write on the thread bucket
  - read on the Slack secret
  - `UpdateItem` on `SlackThreads`

  It has no access to the control-plane state table.
- **Model.** A stack parameter, default `amazon.nova-pro-v1:0`.

### 4. Release pipeline (feature 005 extension)

- **Image.** A new ECR repository `agentx-slack-orchestrator` and `environments/slack/Dockerfile`, pinned by digest from ECR Public.
- **`release:prod` changes:**
  - Build, smoke-test, and push the orchestrator image. It uses the reuse decision generalized to per-image inputs: `packages/slack-service`, `packages/cli`, `packages/contracts`, the Dockerfile, the lockfile, and tsconfigs.
  - Deploy `AgentXSlackOrchestrator` after the control plane, and only if the stack already exists. The first deployment is manual, because it needs the secret and subnet parameters.
- **Trigger paths.** Collapse the package patterns into `packages/{broker,cli,contracts,slack-service,worker}/**`, staying within 8 patterns.
- **Pipeline role.** Push to the new repository and describe the new stack.

### 5. Retire local Slack mode (`packages/cli`)

- Remove `slack run`, `configure`, and `login`, together with `slack.ts`, `slack-config.ts`, the Socket Mode transport, and the `@slack/bolt` dependency.
- Keep `slack logout` to delete stored tokens.
- Replace the README Slack section with the hosted setup.

## Project Structure

- `packages/contracts/src/slack.ts`: binding, thread key, limit error, and requester contracts
- `packages/broker/src/aws/broker.ts`: bindings API, service route identity, thread preparation with limits, and requester attribution
- `packages/broker/src/aws/slack-ingress.ts`: the ingress Lambda
- `packages/slack-service/`: queue consumer, visibility heartbeat, session persistence, signing fetch, Slack posting, and Dockerfile entry point
- `packages/cli/src/{main,admin}.ts`: `admin slack bind` and `unbind`; local Slack mode removed
- `infra/lib/control-plane.ts`: service and Slack routes, ingress Lambda, FIFO queue and dead-letter queue, `SlackThreads` table, and limit parameters
- `infra/lib/slack-orchestrator.ts` and `infra/bin/agentx.ts`: the new stack
- `infra/lib/release-pipeline.ts` and `scripts/release-production.ts`: second image, deployment, trigger paths, IAM
- `environments/slack/Dockerfile`
- `tests/contract/` and `tests/integration/`: ingress, service auth, isolation, limits, consumer ordering and recovery, CDK, and pipeline coverage
- `README.md` and `docs/architecture-production.md`: hosted Slack setup and architecture

## Complexity Tracking

- **New package and stack.** The orchestrator runs long, stateful turns (hours) that exceed Lambda's 15-minute limit. It needs its own image and lifecycle, separate from the worker.
- **Separate `SlackThreads` table.** It keeps the ingress Lambda and orchestrator away from the control-plane state table, which holds every workspace and credential reference.
- **IAM service route rather than minting tokens.** API Gateway's JWT authorizer only accepts Cognito tokens, and IAM authentication gives a non-forgeable caller identity with no new secret.

## Risks

- **Duplicate result message.** A crash between posting the result and recording it can post the result twice. Delivery is at-least-once by design; losing a result would be worse.
- **Recovery re-runs the orchestrator turn** from the saved session. Deterministic request IDs prevent duplicate remote work for repeated tool calls. A differently worded model decision could still start new work, which is accepted and logged.
- **Limits eventually block new threads** until deletion exists (spec assumption). Administrators can raise the parameters.
- **Slack's 3-second acknowledgement deadline** with Lambda cold starts. Ingress keeps its work minimal, and a slow response is harmless because retries are deduplicated.
