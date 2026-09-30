# Phase 25d: Admin Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AgentX admin can look at AgentX from their AI tool: health, failed tasks, turn records,
usage, projects, channel bindings, credentials and workspaces, through eight admin read tools that
the MCP server offers only while this computer holds an unexpired admin sign-in. Reads need no
confirmation, change nothing, and never carry a secret.

**Architecture:**
- **Admin read routes live in the broker, behind today's admin JWT authorizer** (FR-038). A new
  module, `packages/broker/src/aws/admin-reads.ts`, serves `GET /v1/admin/projects`,
  `/slack/bindings`, `/workspaces`, `/failures`, `/usage` and `/me`; `admin-health.ts` serves
  `/health`. `GET /v1/admin/turns` gains filters in `turns.ts`. `GET /v1/admin/credentials` already
  exists. Each route checks the admin claim, as today's list routes do (FR-038's "same admin check").
- **Derived indexes come from the state table's stream** (FR-038). The outbox publisher, already a
  reader of every committed change in every deployment, also writes a failure index item
  (`FAILURE#<day>` / `<endedAt>#<operationId>`) when an operation ends `FAILED` or `INTERRUPTED`,
  and a usage index item (`USAGE#<day>` / `<at>#<operationId>`) when a worker stores its `usage`
  event (spec 011). No new stream reader (C7). Each index item carries `indexExpiresAt` (30 days
  on): in installed (named) environments the State table's TTL deletes it; the legacy deployment,
  whose template stays byte-identical, keeps no TTL, and there the session reconciler deletes index
  days older than 30 days **(Q5, owner answer changed)**.
- **A project catalog** (`PROJECT_CATALOG` / `PROJECT#<name>`) is written with every registration
  from this phase on; the admin project list is the catalog, the bound channels' projects and the
  calling admin's own memberships **(Q2)**, so no route ever scans the table.
- **The MCP server gets an admin client and eight admin read tools** in `@agentx/mcp`. They are
  registered with the developer tools but enabled only while an admin sign-in is present
  (FR-028); the SDK sends `notifications/tools/list_changed` when that changes. A transport guard
  answers a direct call to a hidden admin tool with `ADMIN_REQUIRED` (US5 scenario 2). The admin API
  has its own version, `ADMIN_API_VERSION = "1.0"`, reported beside the developer API's **(Q1)**.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4
(4.6.5), Vitest, `@modelcontextprotocol/sdk` 1.30.1, AWS SDK v3 3.1134.0 (`lib-dynamodb`,
`util-dynamodb`, `client-cloudwatch`, `client-sqs`, `client-lambda`), AWS CDK.

**Spec:** [../spec.md](../spec.md), the binding authority. Phase 25d delivers the phase README's row:
- FR-028 (the tool list depends on the admin sign-in, with `list_changed`);
- FR-030's admin read tools: `agentx_admin_health`, `agentx_admin_failed_tasks`,
  `agentx_admin_turns`, `agentx_admin_usage`, `agentx_admin_list_projects`,
  `agentx_admin_list_channels`, `agentx_admin_list_credentials`, `agentx_admin_list_workspaces`
  (`agentx_admin_changes` is 25e's, with the audit records it reads);
- FR-038 (the failure index; `GET /v1/admin/projects`, `/slack/bindings`, `/workspaces`,
  `/failures`, `/usage`, `/health` and `/me`; `/changes` is 25e's);
- FR-029 and SC-004 for every admin result; FR-049's `ADMIN_REQUIRED`; User Story 5;
- 25c's carry-over: `agentx_admin_turns`'s `task_id` filter, which also lists the task's channel
  turns (25c's "Not in this phase").

The phase map is in [README.md](README.md). The product questions and the owner's answers
(2026-09-30) are in [phase-25d-questions.md](phase-25d-questions.md); every task that depends on
one says "Depends on Q<n>".

**Branch:** `feat/025d-admin-reads`, cut from mainline `59ff7e3` (25c merged as PR #159). One PR,
against `mainline`. No stacked PRs.

## Decisions recorded by this plan

Each ruling is written into the code by the task named. Rulings marked **(Q<n>)** follow the
recommendation of an open owner question.

- **A1. The admin API has its own version (Q1).** `ADMIN_API_VERSION = "1.0"` in the contracts;
  `/v1/auth/.well-known/agentx-configuration` gains `adminApiVersion`. `DEVELOPER_API_VERSION`
  stays `1.2`, so a 25d CLI keeps every developer tool against a 25c control plane; there the admin
  tools are not offered and `agentx_whoami` says an AgentX upgrade adds them. A control plane whose
  admin major differs, or whose admin minor is older than the tools need, gets no admin tools
  (and a direct call answers `UPGRADE_REQUIRED` with "ask your AgentX admin to upgrade AgentX").
  Tasks 1, 10, 14, 16.
- **A2. Every admin read route checks the admin claim only**, like today's `GET /v1/admin/turns`
  and `GET /v1/admin/credentials` (FR-038: "the same admin check as today"). No membership is
  needed to read; FR-015's membership applies to 25e's changes. A developer token on `/v1/admin/*`
  is refused by the API Gateway authorizer and again by the broker (FR-009), unchanged. Task 2.
- **A3. The project catalog (Q2).** Registration writes `PROJECT_CATALOG` / `PROJECT#<name>` in
  its own transaction, with `firstRegisteredAt` set only if absent. The admin project names are
  the catalog's, those of the environment team's bindings, and those of the caller's own
  `MEMBER#<ownerKey>` rows; each name counts only when `PROJECT#<name>` still has a revision. A
  project registered before this release that no channel binds and that the caller did not
  register appears after its next revision. No scan. Tasks 2, 9.
- **A4. The derived index writer lives in the outbox publisher.** It already reads every stream
  record (legacy included) and may write the State table, so the index needs no new reader (C7),
  grant or template change. The index is best effort: a failed index write is logged
  (`activity_index.write_failed`, error name only) and never fails the batch, so dispatch is never
  delayed or repeated by it. Writes are `attribute_not_exists(pk)` puts, so a replayed stream
  record writes nothing twice. Task 4.
- **A5. What an index item holds.** A failure: operation and workspace IDs, project, origin
  (`ai_tool` when the workspace has a developer task pointer, else `slack`), requester (the
  operation's `requestedBy`: a Slack member by team and user ID, or a developer by ID, provider and
  display name; `none` when absent, such as an admin-prepared workspace), operation kind, status,
  failure category (25b's `failureCategory`), the error redacted and cut to 1,000 characters
  (`redactAndCap`), the end time, and the task ID or thread subject for the turn record link. A
  usage item: the same identity fields, the time of the `usage` event, the task's duration (the
  event's time less the operation's creation), input and output tokens, and `costUsd` as the
  telemetry carries it (spec 011, `null` when unknown). Task 4.
- **A6. Index items expire after 30 days (Q5, owner answer 2026-09-30: changed).** Each failure
  and usage item carries `indexExpiresAt`, epoch seconds 30 days after its time (A5). In installed
  (named) environments the State table gets a TTL on `indexExpiresAt` (named environments only; no
  other State item carries that attribute today, which a test pins), so DynamoDB deletes the items.
  The legacy deployment's template stays byte-identical, with no TTL; there, and only there, each
  reconciler run deletes `FAILURE#` and `USAGE#` items of the days 31 to 45 back (at most 500
  deletes a run). The reconciler knows which by `INDEX_EXPIRY=ttl`, set on it in named environments
  only. Every read also stops at 30 days, and skips an item whose `indexExpiresAt` has passed
  (DynamoDB deletes up to 48 hours late). Tasks 1, 4, 5, 6, 8, 13.
- **A7. Failures (FR-038, US5 scenario 3).** `GET /v1/admin/failures?since&until&project&limit`:
  `since` defaults to 24 hours ago, `until` to now, the window is at most 30 days, `limit` is 1 to
  100 (25 by default). Newest first, day partition by day, each read `sk BETWEEN`. An item that no
  longer parses is left out and counted in `skipped`. Task 6.
- **A8. Turn filters.** `GET /v1/admin/turns` accepts, beside `since` and `cursor`: `until`,
  `origin` (`slack` or `ai_tool`), `project`, `thread` (a thread subject), `task` (a task ID; it
  matches the task's AI-tool records and the channel turns that carry its ID, 25c's C13), and
  `limit` (1 to 100). `until` is a key condition (`exportSk BETWEEN`); `origin`, `thread` and
  `task` are filter expressions on the same `byTime` query; `project` is matched after the
  existing workspace lookup. With a filter, one call reads at most 10 index pages to fill `limit`,
  then answers with a cursor. The cursor keeps its format; a cursor past `until` is refused. The
  CLI's export, which sends none of these, reads exactly as before. Task 7.
- **A9. Usage (Q6).** `GET /v1/admin/usage?since&until&group_by`: per group (`project`,
  `requester`, `origin` or `day`), `turns` (Slack turn records), `tasks` (worker usage items),
  `taskDurationMs`, `inputTokens` and `outputTokens` (the worker's, plus the orchestrator's from
  Slack turn records' `usage`), `costUsd` (the sum of known costs) and `costUnknown` (how many
  entries had none). It reads at most 5,000 usage items and 5,000 turn records, and says
  `truncated` when it stopped early. Task 8.
- **A10. Workspaces.** `GET /v1/admin/workspaces?project&status&limit`: from spec 041's
  `byWorkspaceProject` index, per project of A3, newest first; without `status`, closed workspaces
  are left out. Each row: ID, project, origin, owner (the thread link for a Slack thread, from
  `SLACK_THREAD#<ownerKey>`; the task ID and developer name for a task, from its pointer and task
  record), status, whether busy, and last activity. Plus the limits `readWorkspaceLimits` gives
  (setting or stack parameters, FR-053) and the organization counters' counts. At most `limit`
  rows (1 to 100, 50 by default), `truncated` when more exist. Workspaces created before spec 041
  are not in the index, as spec 041 already says. Task 9.
- **A11. Channels (Q7, owner answer 2026-09-30: changed to the middle option).**
  `GET /v1/admin/slack/bindings`: the bindings of the environment's Slack team, or of `team=<T...>`
  where the environment records none (the legacy deployment). Names come from DeveloperIdentity's
  channel-info lookup where it is set up. A public channel's name is always shown. A private
  channel's name is shown only when the calling admin's linked Slack user (A12) is a member of it,
  checked with DeveloperIdentity's channel-members lookup (`conversations.members`, the same
  10-minute cache as the developer access checks); otherwise it is listed by ID with
  `private: true`. A failed or missing membership check fails closed (ID only). Without the
  channel-info lookup, channels are listed by ID with the notice `channel_names_unavailable`.
  Tasks 3 (public names, private by ID), 11 (a member admin sees the private name).
- **A12. Who the admin is (Q3).** `GET /v1/admin/me` answers the token's issuer and subject, and a
  name and verified email: from the token's own claims when it carries them, else from the admin
  issuer's OIDC `userinfo` endpoint, called with the admin's own bearer token (found through the
  issuer's discovery document, HTTPS only, 3-second timeout, cached per token for 5 minutes). An
  email counts only when `email_verified` is `true` (Cognito answers the string `"true"`). With a
  verified email and DeveloperIdentity set up, `slack.linked` says whether it matches one Slack user
  (FR-012's `users.lookupByEmail`), else a `reason`. 25e's Slack Confirm button and audit name use
  it (FR-041, FR-051). Task 11.
- **A13. Health.** `GET /v1/admin/health` answers: the API versions, and the release when the
  broker knows it (`AGENTX_RELEASE_VERSION`, absent in this phase, so "unknown"); the environment's
  alarms and their states (CloudWatch `DescribeAlarms` by the environment's alarm name prefix); the
  dead-letter queues' depths; a Slack token check (`auth.test` through DeveloperIdentity); a GitHub
  App check (its installations); per worker mode (`ec2-ebs`, the only one, FR-024), whether any
  project's latest revision binds it and the newest `worker_unavailable` failure in 24 hours; and
  open workspaces by status. Each probe has a 3-second limit and answers `unknown` with a reason
  when it is not set up or fails; the route never fails because a probe did. Only named
  environments get the new grants; the legacy deployment answers `unknown` for alarms, queues and
  Slack. Tasks 12, 13.
- **A14. The MCP server's admin session (Q4).** The admin tools use the admin sign-in `agentx
  login --admin` stored, for the environment `agentx login <url>` recorded, through the deployment
  settings `agentx admin` commands already read. An absent or expired admin token is
  `ADMIN_REQUIRED` ("run npx @charterarc/agentx login --admin"); it is not refreshed, exactly like
  every `agentx admin` command today. A 401 from an admin route is `ADMIN_REQUIRED` too. Task 16.
- **A15. The tool list (FR-028).** Every tool is registered once; admin read tools start disabled.
  An availability check (the admin token is present and unexpired, and the control plane's admin
  API fits) runs when the client initializes, every 30 seconds, and after every tool call; the
  SDK's `enable()` and `disable()` send `notifications/tools/list_changed` when the set changes. A
  direct call to a hidden admin tool is answered by a transport guard, before the SDK, with
  `ADMIN_REQUIRED` (or `UPGRADE_REQUIRED`, A1), since the SDK's own answer ("Tool ... disabled")
  carries no code. Task 14.
- **A16. Results.** Every admin tool's result goes through the server's existing `safeStructured`
  (FR-029: `redactSecrets`, then caps), like the developer tools. The routes redact the fields
  that can hold text taken from elsewhere (errors, channel names), so neither side alone is
  trusted. Tasks 4, 15.
- **A17. Not changed:** the developer tools, `DEVELOPER_API_VERSION`, every `agentx admin`
  command, the CLI's `turns export` (its requests are unchanged, A8), and the legacy templates.

## Owner questions

[phase-25d-questions.md](phase-25d-questions.md) lists seven questions the spec leaves open. The
owner answered all seven on 2026-09-30: five as recommended; Q5 changed (TTL in named environments,
the reconciler cleanup only in the legacy deployment, A6) and Q7 changed (a private channel's name
for an admin who is a member of it, A11). This plan follows the answers. Task 18 records them in
the spec.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Legacy snapshots never change. Never run vitest with
  `-u`. No test and no step of the live check touches production's stacks, `/agentx/production/*`,
  production's Slack app or its secrets. Every grant and environment variable this phase adds
  exists only in named environments (D14), and code that needs one checks for it.
- **The 25a to 25c live checks' lessons hold:** no resource that CloudFormation validates at create
  time against our own API; every retained resource in a named environment uses
  `RetainExceptOnCreate` (this phase adds none); the live check runs in a throwaway named
  environment with the owner present, and only one throwaway environment fits in the account at a
  time (the Elastic IP quota).
- **No test reaches AWS, Slack, GitHub or an IdP.** Every client is injected. The only real network
  use in tests is `127.0.0.1`.
- **Never printed, logged, stored in local files, or put in a tool result or error message:** access
  tokens (developer or admin), refresh tokens, the Slack bot token, secret values, and turn or task
  text in logs. Logs carry event names, IDs, reasons and error names only. Every task that handles
  one plants a known value and asserts it appears nowhere it must not.
- **Reads change nothing.** No admin read route writes the State table, the TurnRecords table or
  the sign-in table (the index writer and the legacy expiry sweep are background jobs, not routes).
- **Live testing is deferred** (owner, 2026-09-30): no live check runs until 25d, 25e and spec 040
  phases 2 to 4 are all built. Task 19 is the checklist for that combined final live check, not a
  step of this phase.
- **Least privilege.** New IAM statements name exact actions and resources (the environment's alarm
  prefix, the dead-letter queues' ARNs); no `*` resource unless the action has no resource type,
  and then the task says so with the Service Authorization Reference's words.
- **No developer task code reads the deployment mode** (FR-024). The health route names worker
  modes from the stored project bindings, never from the runtime binding's mode switch.
- **Exact names and values:**
  - routes `GET /v1/admin/projects`, `/v1/admin/slack/bindings`, `/v1/admin/workspaces`,
    `/v1/admin/failures`, `/v1/admin/usage`, `/v1/admin/health`, `/v1/admin/me`; `GET
    /v1/admin/turns` gains `until`, `origin`, `project`, `thread`, `task`, `limit`;
  - tools `agentx_admin_health`, `agentx_admin_failed_tasks`, `agentx_admin_turns`,
    `agentx_admin_usage`, `agentx_admin_list_projects`, `agentx_admin_list_channels`,
    `agentx_admin_list_credentials`, `agentx_admin_list_workspaces`;
  - items `PROJECT_CATALOG`/`PROJECT#<name>`, `FAILURE#<yyyy-mm-dd>`/`<endedAt>#<operationId>`,
    `USAGE#<yyyy-mm-dd>`/`<at>#<operationId>`;
  - `ADMIN_API_VERSION = "1.0"`; `DEVELOPER_API_VERSION` stays `"1.2"`;
  - limits: lists 1 to 100; failures 25 by default, since 24 hours ago by default; workspaces 50 by
    default; windows at most 30 days; errors at most 1,000 characters; usage reads at most 5,000
    of each source; filtered turn reads at most 10 index pages per call; probes 3 seconds; the
    availability check every 30 seconds;
  - DeveloperIdentity invoke kinds `slack-user-by-email` and `slack-auth-check`;
  - the index items' TTL attribute `indexExpiresAt` (epoch seconds), and the reconciler's
    `INDEX_EXPIRY=ttl` (named environments only).
- **Copy:** plain words; every error says what to do next; no em dashes in any user-facing text,
  tool description, AWS resource name or description.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Existing suites:** no assertion is removed or weakened (SC-008). Lists of routes, tools,
  invoke kinds and constants gain the new entries by appending. Where a test pinned behaviour this
  phase deliberately changes, the task names the test, the old assertion and its replacement.
- **Build process:** the owner approves this plan before building. Building uses
  superpowers:subagent-driven-development, with a fresh implementer and a fresh reviewer per task.
  PRs target mainline.

## Review Focus

1. **An admin signs in with `agentx login --admin` while Claude Code is open.** Expected: within
   about 30 seconds (or at once after any tool call) the admin tools appear, the client gets
   `notifications/tools/list_changed`, and when the admin token later expires they disappear the
   same way; a call to one while hidden answers `ADMIN_REQUIRED` with `login --admin`. Pinned in
   Task 14 (`mcp-admin-offer.test.ts`, "offers the admin tools once the admin signs in, and sends
   list_changed each way").
2. **A worker's failure text quotes a secret** (`ghp_...` in an npm log line), and it is the newest
   failure. Expected: the failure index holds it redacted, `GET /v1/admin/failures` and
   `agentx_admin_failed_tasks` show `[REDACTED]`, and no log line of the index writer names it.
   Pinned in Task 4 (`activity-index.test.ts`, "stores a failure's error redacted and cut, and logs
   only IDs") and Task 17 (SC-004 sweep).
3. **The index write fails (DynamoDB throttles) while the outbox publisher dispatches.** Expected:
   the outbox record is still published and marked queued exactly once, the batch succeeds, and
   one `activity_index.write_failed` line names the error class. Pinned in Task 4
   (`outbox-publisher-index.test.ts`, "dispatches the batch even when the index write throws").
4. **An admin asks for a task's turn records with `task_id`, for a task shared in continue mode.**
   Expected: the task's AI-tool records and its teammates' channel turns, newest first, within
   `limit`, and a cursor when more remain; a filtered call never reads more than 10 index pages.
   Pinned in Task 7 (`turn-export-filters.test.ts`, "matches a task's AI-tool records and its
   channel turns, and stops after ten pages").
5. **The admin's issuer has no `userinfo` endpoint, or it times out.** Expected: `GET /v1/admin/me`
   still answers the issuer and subject, with `slack: { linked: false, reason: "no_email" }`, and
   takes at most about 3 seconds; nothing is cached for a failure. Pinned in Task 11
   (`admin-me.test.ts`, "answers without an email when userinfo is missing or slow").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/admin.ts` | admin read shapes, index records and keys, `ADMIN_API_VERSION`, limits | 1 |
| `packages/contracts/src/developer.ts` (modify) | the two new DeveloperIdentity invoke requests | 1 |
| `packages/contracts/src/index.ts` (modify) | export `admin.ts` | 1 |
| `packages/broker/src/aws/admin-reads.ts` | the admin read routes and their shared helpers | 2, 3, 6, 8, 9, 11, 12 |
| `packages/broker/src/aws/broker.ts` (modify) | the catalog write, the route wiring, the admin read dependencies, the probes | 2, 8, 10, 11, 13 |
| `packages/broker/src/aws/activity-index.ts` | the failure and usage index writer | 4 |
| `packages/broker/src/aws/outbox-publisher.ts` (modify) | run the index writer after dispatch | 4 |
| `packages/broker/src/aws/index-expiry.ts` | delete index days older than 30 days, legacy deployment only | 5 |
| `packages/broker/src/aws/session-reconciler.ts` (modify) | run the expiry | 5 |
| `packages/broker/src/aws/turns.ts` (modify) | the turn filters | 7 |
| `packages/broker/src/developer/server.ts`, `slack-directory.ts` (modify) | the two invoke kinds; `authTest` | 10 |
| `packages/broker/src/aws/developer-routes.ts` (modify) | the two through-lambda helpers; configuration fields | 10 |
| `packages/broker/src/aws/admin-me.ts` | who the admin is: claims, userinfo, Slack link | 11 |
| `packages/broker/src/aws/admin-health.ts` | the health route and its probes | 12 |
| `packages/broker/src/github-app.ts` (modify) | `installationCount()` | 12 |
| `infra/lib/control-plane.ts`, `infra/lib/developer-task-notifier.ts` (modify) | the health grants and variables, the State table's TTL on `indexExpiresAt`, the reconciler's `INDEX_EXPIRY=ttl`; named environments only | 13 |
| `packages/mcp/src/admin-client.ts` | the admin control-plane client | 14 |
| `packages/mcp/src/offer.ts` | availability, enable and disable, the transport guard | 14 |
| `packages/mcp/src/server.ts`, `client.ts`, `compatibility.ts`, `tools.ts`, `index.ts` (modify) | register admin tools, the admin version, the context's admin client | 14, 16 |
| `packages/mcp/src/admin-tools.ts` | the eight admin read tools | 15 |
| `packages/cli/src/mcp/serve.ts`, `packages/cli/src/main.ts` (modify) | the admin session from the token store | 16 |
| `tests/support/admin-read-broker.ts` | the developer task broker plus an admin caller | 2 |
| `tests/support/fake-dynamodb.ts` (modify) | filters, index ranges, `LastEvaluatedKey`, two helpers | 2 |
| `tests/support/slack-broker.ts`, `developer-task-broker.ts` (modify) | pass-through broker and developer options | 10 |
| `tests/support/mcp-broker-client.ts` (modify) | an admin-signed-in MCP client | 16, 17 |
| `specs/025-mcp-server/spec.md`, `plans/README.md` (modify) | record the rulings and answers | 18 |

---
### Task 1: The contracts for admin reads

A1, A5, A7 to A13's shapes, and the two new DeveloperIdentity invoke requests. **Depends on Q1**
(the admin API version).

**Files:**
- Create: `packages/contracts/src/admin.ts`
- Modify: `packages/contracts/src/index.ts` (append `export * from "./admin.js";`)
- Modify: `packages/contracts/src/developer.ts` (after `ChannelInfoRequestSchema`)
- Test: `tests/contract/admin-read-contracts.test.ts`

**Interfaces:**
- Consumes: `DeveloperTaskFailureCategorySchema` (developer-tasks.ts), `DeveloperTaskPolicySchema`
  (project.ts), `SlackTeamIdSchema`, `SlackUserIdSchema`, `SlackChannelIdSchema` (slack.ts),
  `WorkspaceStatusSchema` (workspace.ts).
- Produces (all exported from `@agentx/contracts`):
  - constants `ADMIN_API_VERSION = "1.0"`, `ADMIN_LIST_MAX = 100`, `ADMIN_FAILURES_DEFAULT_LIMIT = 25`,
    `ADMIN_WORKSPACES_DEFAULT_LIMIT = 50`, `ADMIN_FAILURES_DEFAULT_HOURS = 24`,
    `ADMIN_INDEX_RETENTION_DAYS = 30`, `ADMIN_ERROR_TEXT_MAX = 1_000`, `ADMIN_USAGE_READ_MAX = 5_000`,
    `ADMIN_TURN_FILTER_PAGES = 10`, `PROJECT_CATALOG_PK = "PROJECT_CATALOG"`;
  - keys `failureIndexKey(endedAt, operationId)`, `usageIndexKey(at, operationId)`,
    `projectCatalogKey(name)`, `indexDay(at)`;
  - A6: `INDEX_EXPIRY_ATTRIBUTE = "indexExpiresAt"` and `indexExpiresAt(at: string): number` (epoch
    seconds, 30 days after `at`);
  - `AdminOriginSchema`, `AdminRequesterSchema` / `AdminRequester`;
  - `FailureIndexRecordSchema` / `FailureIndexRecord`, `UsageIndexRecordSchema` / `UsageIndexRecord`;
  - wire schemas (non-strict, so a newer control plane may add fields): `AdminProjectsResponseSchema`,
    `AdminBindingsResponseSchema`, `AdminFailuresResponseSchema`, `AdminUsageGroupBySchema`,
    `AdminUsageResponseSchema`, `AdminWorkspacesResponseSchema`, `AdminHealthResponseSchema`,
    `AdminMeResponseSchema`, and a type for each (`AdminProjectsResponse`, and so on);
  - in developer.ts: `SlackUserByEmailRequestSchema` / `SlackUserByEmailRequest`,
    `SlackUserByEmailResponse`, `SlackAuthCheckRequestSchema` / `SlackAuthCheckRequest`,
    `SlackAuthCheckResponse`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-read-contracts.test.ts
// Spec 025 phase 25d, Task 1: the admin read shapes (FR-038) and the derived index records (A5).
import { describe, expect, it } from "vitest";
import {
  ADMIN_API_VERSION,
  ADMIN_INDEX_RETENTION_DAYS,
  AdminHealthResponseSchema,
  AdminMeResponseSchema,
  AdminRequesterSchema,
  AdminUsageGroupBySchema,
  AdminWorkspacesResponseSchema,
  DEVELOPER_API_VERSION,
  FailureIndexRecordSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  SlackAuthCheckRequestSchema,
  SlackUserByEmailRequestSchema,
  UsageIndexRecordSchema,
  failureIndexKey,
  indexDay,
  indexExpiresAt,
  projectCatalogKey,
  usageIndexKey,
} from "../../packages/contracts/src/index.js";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ENDED = "2026-09-30T08:15:00.000Z";

describe("the index keys (FR-038, A5)", () => {
  it("keys a failure by its day and end time, as FR-038 names it", () => {
    expect(failureIndexKey(ENDED, OPERATION)).toEqual({ pk: "FAILURE#2026-09-30", sk: `${ENDED}#${OPERATION}` });
    expect(usageIndexKey(ENDED, OPERATION)).toEqual({ pk: "USAGE#2026-09-30", sk: `${ENDED}#${OPERATION}` });
    expect(indexDay("2026-09-30T23:59:59.999Z")).toBe("2026-09-30");
    expect(projectCatalogKey("payments")).toEqual({ pk: "PROJECT_CATALOG", sk: "PROJECT#payments" });
  });

  it("refuses an index key for a time that is not an ISO instant", () => {
    expect(() => failureIndexKey("yesterday", OPERATION)).toThrow("an ISO time");
  });

  it("gives each index item its TTL attribute, 30 days on (A6, Q5)", () => {
    expect(INDEX_EXPIRY_ATTRIBUTE).toBe("indexExpiresAt");
    expect(indexExpiresAt(ENDED)).toBe(Math.floor(Date.parse(ENDED) / 1000) + 30 * 86_400);
  });
});

describe("the index records (A5)", () => {
  const failure = {
    operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "ai_tool",
    requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" },
    kind: "prepare", status: "FAILED", category: "setup_failed", error: "npm ci exited 1", endedAt: ENDED,
    taskId: "33333333-3333-4333-8333-333333333333",
  };

  it("reads a failure with each requester kind, and refuses an unknown category", () => {
    expect(FailureIndexRecordSchema.parse(failure)).toMatchObject({ origin: "ai_tool", category: "setup_failed" });
    expect(AdminRequesterSchema.parse({ kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" })).toMatchObject({ kind: "slack" });
    expect(AdminRequesterSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
    expect(FailureIndexRecordSchema.safeParse({ ...failure, category: "cosmic_rays" }).success).toBe(false);
    expect(FailureIndexRecordSchema.safeParse({ ...failure, error: "x".repeat(1_001) }).success).toBe(false);
  });

  it("reads a usage item whose cost is unknown", () => {
    const usage = { ...failure, at: ENDED, durationMs: 90_000, inputTokens: 1_200, outputTokens: 300, costUsd: null };
    for (const key of ["kind", "status", "category", "error", "endedAt"]) delete (usage as Record<string, unknown>)[key];
    expect(UsageIndexRecordSchema.parse(usage)).toMatchObject({ costUsd: null, durationMs: 90_000 });
  });
});

describe("the wire shapes", () => {
  it("adds the admin API version beside the developer one, which stays 1.2 (A1)", () => {
    expect(ADMIN_API_VERSION).toBe("1.0");
    expect(DEVELOPER_API_VERSION).toBe("1.2");
    expect(ADMIN_INDEX_RETENTION_DAYS).toBe(30);
  });

  it("groups usage only four ways (FR-030)", () => {
    expect(AdminUsageGroupBySchema.options).toEqual(["project", "requester", "origin", "day"]);
  });

  it("reads a workspace list and a health answer, and keeps fields a newer control plane adds", () => {
    const workspaces = AdminWorkspacesResponseSchema.parse({
      workspaces: [{ id: WORKSPACE, project: "payments", origin: "slack", owner: { threadUrl: "https://slack.com/archives/C0123456789/p1695500000000100" }, status: "READY", busy: false, lastActivityAt: ENDED }],
      limits: { perPerson: 3, perOrganization: 20, source: "parameters" }, counts: { organization: 1 }, truncated: false, extra: "kept",
    });
    expect(workspaces).toMatchObject({ extra: "kept" });
    const health = AdminHealthResponseSchema.parse({
      version: { developerApi: "1.2", adminApi: "1.0" },
      alarms: [{ name: "agentx-live25d-SlackDeadLetters", state: "OK" }], alarmsCheck: { status: "ok" },
      deadLetterQueues: [{ name: "dispatch", depth: 0 }], slack: { status: "unknown", detail: "not set up" }, github: { status: "ok", detail: "installed on 1 account" },
      workerModes: [{ mode: "ec2-ebs", configured: true }], workspaces: { READY: 2 }, workspacesTruncated: false,
    });
    expect(health.slack).toEqual({ status: "unknown", detail: "not set up" });
  });

  it("says why an admin has no Slack link", () => {
    expect(AdminMeResponseSchema.parse({ issuer: "https://identity.example.test", subject: "admin-subject", slack: { linked: false, reason: "no_email" } }).slack.reason).toBe("no_email");
    expect(AdminMeResponseSchema.safeParse({ issuer: "i", subject: "s", slack: { linked: false, reason: "because" } }).success).toBe(false);
  });
});

describe("DeveloperIdentity's new invoke requests (A11 to A13)", () => {
  it("takes an email lookup and an auth check, and nothing else", () => {
    expect(SlackUserByEmailRequestSchema.parse({ kind: "slack-user-by-email", email: "ada@example.com" })).toMatchObject({ email: "ada@example.com" });
    expect(SlackUserByEmailRequestSchema.safeParse({ kind: "slack-user-by-email", email: "not an email" }).success).toBe(false);
    expect(SlackAuthCheckRequestSchema.parse({ kind: "slack-auth-check" })).toEqual({ kind: "slack-auth-check" });
    expect(SlackAuthCheckRequestSchema.safeParse({ kind: "slack-auth-check", token: "xoxb-1" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-read-contracts.test.ts`
Expected: FAIL, `failureIndexKey` and the other new exports are not defined.

- [ ] **Step 3: Add the contracts**

```ts
// packages/contracts/src/admin.ts
// Spec 025 phase 25d: the admin read routes' shapes (FR-038) and the records of the derived
// failure and usage indexes (A5). The wire schemas are not strict: a newer control plane may add
// fields, and an older CLI must still read the answer.
import { z } from "zod";
import { DeveloperTaskFailureCategorySchema } from "./developer-tasks.js";
import { DeveloperTaskPolicySchema } from "./project.js";
import { SlackChannelIdSchema, SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";
import { WorkspaceStatusSchema } from "./workspace.js";

/** A1 (Q1): the admin API's own version, reported beside DEVELOPER_API_VERSION. */
export const ADMIN_API_VERSION = "1.0";
export const ADMIN_LIST_MAX = 100;
export const ADMIN_FAILURES_DEFAULT_LIMIT = 25;
export const ADMIN_WORKSPACES_DEFAULT_LIMIT = 50;
export const ADMIN_FAILURES_DEFAULT_HOURS = 24;
/** FR-038: index days are kept 30 days, like turn records (A6). */
export const ADMIN_INDEX_RETENTION_DAYS = 30;
export const ADMIN_ERROR_TEXT_MAX = 1_000;
/** A9: the most usage items, and the most turn records, one usage answer reads. */
export const ADMIN_USAGE_READ_MAX = 5_000;
/** A8: the most index pages one filtered turn read takes. */
export const ADMIN_TURN_FILTER_PAGES = 10;
export const PROJECT_CATALOG_PK = "PROJECT_CATALOG";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const Uuid = z.string().uuid();
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

/** The UTC day an index item belongs to. */
export function indexDay(at: string): string {
  if (!ISO.test(at)) throw new Error("an index key needs an ISO time such as 2026-09-30T08:15:00.000Z");
  return at.slice(0, 10);
}
export function failureIndexKey(endedAt: string, operationId: string): { pk: string; sk: string } {
  return { pk: `FAILURE#${indexDay(endedAt)}`, sk: `${endedAt}#${operationId}` };
}
export function usageIndexKey(at: string, operationId: string): { pk: string; sk: string } {
  return { pk: `USAGE#${indexDay(at)}`, sk: `${at}#${operationId}` };
}
/**
 * A6 (Q5, owner answer 2026-09-30): the TTL attribute of every failure and usage item. Named
 * environments' State table expires items on it; the legacy deployment's reconciler deletes them.
 */
export const INDEX_EXPIRY_ATTRIBUTE = "indexExpiresAt";
export function indexExpiresAt(at: string): number {
  indexDay(at);
  return Math.floor(Date.parse(at) / 1000) + ADMIN_INDEX_RETENTION_DAYS * 86_400;
}
/** A3: one row per registered project, written with each registration from 25d on. */
export function projectCatalogKey(name: string): { pk: string; sk: string } {
  return { pk: PROJECT_CATALOG_PK, sk: `PROJECT#${name}` };
}

export const AdminOriginSchema = z.enum(["slack", "ai_tool"]);
export type AdminOrigin = z.infer<typeof AdminOriginSchema>;

/** A5: who asked for the operation, as the operation record says. */
export const AdminRequesterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack"), teamId: SlackTeamIdSchema, userId: SlackUserIdSchema }).strict(),
  z.object({ kind: z.literal("developer"), developerId: Hex64, provider: z.enum(["slack", "oidc"]), name: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type AdminRequester = z.infer<typeof AdminRequesterSchema>;

const IndexIdentity = {
  operationId: Uuid,
  workspaceId: Uuid,
  project: z.string().min(1).max(63),
  origin: AdminOriginSchema,
  requester: AdminRequesterSchema,
  /** The turn record link: a developer task's ID, or a Slack thread's subject. */
  taskId: Uuid.optional(),
  thread: z.string().min(1).max(128).optional(),
};

export const FailureIndexRecordSchema = z.object({
  ...IndexIdentity,
  kind: z.string().min(1).max(32),
  status: z.enum(["FAILED", "INTERRUPTED"]),
  category: DeveloperTaskFailureCategorySchema,
  /** Redacted, then cut to 1,000 characters (redactAndCap). */
  error: z.string().max(ADMIN_ERROR_TEXT_MAX),
  endedAt: z.string().regex(ISO),
});
export type FailureIndexRecord = z.infer<typeof FailureIndexRecordSchema>;

export const UsageIndexRecordSchema = z.object({
  ...IndexIdentity,
  at: z.string().regex(ISO),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** spec 011: null when the provider gave no cost. */
  costUsd: z.number().nonnegative().nullable(),
});
export type UsageIndexRecord = z.infer<typeof UsageIndexRecordSchema>;

export const AdminProjectSchema = z.object({
  name: z.string(),
  latestRevision: z.number().int().positive(),
  registeredAt: z.string(),
  repositories: z.array(z.object({ name: z.string(), url: z.string() })),
  runtimeMode: z.string(),
  connectors: z.array(z.object({ name: z.string(), type: z.string() })),
  developerTasks: DeveloperTaskPolicySchema,
});
export const AdminProjectsResponseSchema = z.object({ projects: z.array(AdminProjectSchema) });
export type AdminProjectsResponse = z.infer<typeof AdminProjectsResponseSchema>;

export const AdminBindingSchema = z.object({
  teamId: SlackTeamIdSchema,
  channelId: SlackChannelIdSchema,
  /** A public channel's name only (A11). */
  channelName: z.string().optional(),
  private: z.boolean().optional(),
  projectName: z.string(),
  updatedAt: z.string(),
});
export const AdminBindingsResponseSchema = z.object({ bindings: z.array(AdminBindingSchema), notices: z.array(z.string()) });
export type AdminBindingsResponse = z.infer<typeof AdminBindingsResponseSchema>;

export const AdminFailuresResponseSchema = z.object({
  failures: z.array(FailureIndexRecordSchema),
  since: z.string(),
  until: z.string(),
  skipped: z.number().int().nonnegative().optional(),
});
export type AdminFailuresResponse = z.infer<typeof AdminFailuresResponseSchema>;

export const AdminUsageGroupBySchema = z.enum(["project", "requester", "origin", "day"]);
export type AdminUsageGroupBy = z.infer<typeof AdminUsageGroupBySchema>;
export const AdminUsageGroupSchema = z.object({
  key: z.string(),
  turns: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  taskDurationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  costUnknown: z.number().int().nonnegative(),
});
export const AdminUsageResponseSchema = z.object({
  groupBy: AdminUsageGroupBySchema,
  since: z.string(),
  until: z.string(),
  groups: z.array(AdminUsageGroupSchema),
  truncated: z.boolean(),
});
export type AdminUsageResponse = z.infer<typeof AdminUsageResponseSchema>;

export const AdminWorkspaceSchema = z.object({
  id: Uuid,
  project: z.string(),
  origin: AdminOriginSchema,
  owner: z.object({ threadUrl: z.string().optional(), taskId: Uuid.optional(), developerName: z.string().optional() }),
  status: WorkspaceStatusSchema,
  busy: z.boolean(),
  lastActivityAt: z.string(),
});
export const AdminWorkspacesResponseSchema = z.object({
  workspaces: z.array(AdminWorkspaceSchema),
  limits: z.object({ perPerson: z.number().int().positive(), perOrganization: z.number().int().positive(), source: z.enum(["setting", "parameters"]) }),
  counts: z.object({ organization: z.number().int().nonnegative(), developerOrganization: z.number().int().nonnegative().optional() }),
  truncated: z.boolean(),
});
export type AdminWorkspacesResponse = z.infer<typeof AdminWorkspacesResponseSchema>;

export const AdminHealthCheckSchema = z.object({ status: z.enum(["ok", "warn", "failed", "unknown"]), detail: z.string().max(300).optional() });
export type AdminHealthCheck = z.infer<typeof AdminHealthCheckSchema>;
export const AdminHealthResponseSchema = z.object({
  version: z.object({ developerApi: z.string(), adminApi: z.string(), release: z.string().optional() }),
  alarms: z.array(z.object({ name: z.string(), state: z.string() })),
  alarmsCheck: AdminHealthCheckSchema,
  deadLetterQueues: z.array(z.object({ name: z.string(), depth: z.number().int().nonnegative().nullable() })),
  slack: AdminHealthCheckSchema,
  github: AdminHealthCheckSchema,
  workerModes: z.array(z.object({
    mode: z.string(),
    configured: z.boolean(),
    latestDispatchFailure: z.object({ at: z.string(), operationId: z.string(), error: z.string() }).optional(),
  })),
  workspaces: z.record(z.string(), z.number().int().nonnegative()),
  workspacesTruncated: z.boolean(),
});
export type AdminHealthResponse = z.infer<typeof AdminHealthResponseSchema>;

export const AdminMeResponseSchema = z.object({
  issuer: z.string(),
  subject: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  slack: z.object({
    linked: z.boolean(),
    userId: SlackUserIdSchema.optional(),
    reason: z.enum(["no_email", "no_match", "slack_unavailable", "not_set_up"]).optional(),
  }),
});
export type AdminMeResponse = z.infer<typeof AdminMeResponseSchema>;
```

In `packages/contracts/src/developer.ts`, after `ChannelInfoResponse`, add:

```ts
/** Spec 025 A12: the broker asks DeveloperIdentity which Slack user owns a verified email (FR-012's lookup). */
export const SlackUserByEmailRequestSchema = z.object({ kind: z.literal("slack-user-by-email"), email: z.string().email().max(254) }).strict();
export type SlackUserByEmailRequest = z.infer<typeof SlackUserByEmailRequestSchema>;
export type SlackUserByEmailResponse = { ok: true; userId?: string } | { ok: false; error: "slack_unavailable" | "invalid_request" };

/** Spec 025 A13: the health route's Slack token check (auth.test), through DeveloperIdentity. */
export const SlackAuthCheckRequestSchema = z.object({ kind: z.literal("slack-auth-check") }).strict();
export type SlackAuthCheckRequest = z.infer<typeof SlackAuthCheckRequestSchema>;
export type SlackAuthCheckResponse = { ok: true; teamId: string } | { ok: false; error: string };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-read-contracts.test.ts tests/contract/developer-contracts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/admin.ts packages/contracts/src/index.ts packages/contracts/src/developer.ts tests/contract/admin-read-contracts.test.ts
git commit -m "feat(contracts): admin read shapes, index records and the admin API version (spec 025 phase 25d)"
```

---

### Task 2: The project catalog and `GET /v1/admin/projects`

A2, A3. The module every later route lives in, and the test harness they share. **Depends on Q2.**

**Files:**
- Create: `packages/broker/src/aws/admin-reads.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`registerProject`'s transaction; the admin route
  block after `identityFromJwtClaims`; `AwsBrokerDependencies`)
- Create: `tests/support/admin-read-broker.ts`
- Modify: `tests/support/fake-dynamodb.ts` (filters, index ranges, `LastEvaluatedKey`, two helpers)
- Test: `tests/contract/admin-read-projects.test.ts`

**Interfaces:**
- Consumes: `projectCatalogKey`, `AdminProjectsResponse` (Task 1); `developerTaskPolicy`,
  `WorkspaceInstance` (contracts); `AuthenticatedIdentity` (`packages/broker/src/auth.ts`).
- Produces:
  - `export interface AdminReadDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; turnRecordsTableName?: string; slackTeamId?: string; channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>; limitDefaults: { member: number; organization: number }; me?: AdminMeDependencies; health?: AdminHealthProbes; now(): number; log(entry: Record<string, unknown>): void }`
    (`AdminMeDependencies` is Task 11's, `AdminHealthProbes` Task 12's; until then both fields are
    typed `unknown` and left out, and each task replaces its own field's type);
  - `export async function routeAdminRead(deps: AdminReadDependencies, identity: AuthenticatedIdentity, request: { method: string; headers: Record<string, string | undefined> }, url: URL): Promise<unknown | undefined>`:
    the answer for an admin read route, or `undefined` when the path is not one;
  - `export async function adminProjectNames(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<string[]>` (sorted, unique; A3);
  - `export async function latestProjectRecord(deps: AdminReadDependencies, name: string): Promise<{ definition: ProjectDefinition; runtimeBinding: { deploymentMode: string }; registeredAt: string } | undefined>`;
  - `export async function queryAllItems(deps: AdminReadDependencies, pk: string, prefix: string, options?: { limit?: number; newestFirst?: boolean }): Promise<Array<Record<string, unknown>>>`;
  - `AwsBrokerDependencies.adminReads?: Partial<Pick<AdminReadDependencies, "me" | "health" | "now" | "log">>`;
  - test support: `createAdminReadBroker(options?)` returns `createDeveloperTaskBroker`'s harness plus
    `admin(method, path, options?: { admin?: boolean; subject?: string; headers?: Record<string, string> })`.

- [ ] **Step 1: Write the test support**

```ts
// tests/support/admin-read-broker.ts
// Spec 025 phase 25d: the developer task broker (payments registered and bound to the test channel,
// two signed-in developers) with an admin caller for the admin read routes.
import { randomUUID } from "node:crypto";
import { createDeveloperTaskBroker } from "./developer-task-broker.js";
import { issuer } from "./slack-broker.js";

export const ADMIN_SUBJECT = "admin-subject";

export async function createAdminReadBroker(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const harness = await createDeveloperTaskBroker(options);
  /** The OIDC entry point as an admin (the `groups` claim holds `admins`), or as a non-admin. */
  const admin = async (method: string, path: string, call: { admin?: boolean; subject?: string; headers?: Record<string, string> } = {}) => {
    const claims = { iss: issuer, sub: call.subject ?? ADMIN_SUBJECT, groups: call.admin === false ? [] : ["admins"] };
    const response = await harness.handler({
      version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "",
      headers: { authorization: "Bearer admin-token-for-tests", ...call.headers },
      requestContext: { requestId: randomUUID(), http: { method }, authorizer: { jwt: { claims } } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { ...harness, admin };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/admin-read-projects.test.ts
// Spec 025 A2, A3: GET /v1/admin/projects lists every project an admin can find without a scan.
import { describe, expect, it } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { registerRevision } from "../support/developer-task-broker.js";

describe("GET /v1/admin/projects (FR-038, FR-030)", () => {
  it("lists a project with its latest revision, repositories, mode, connectors and task policy", async () => {
    const { admin, handler } = await createAdminReadBroker();
    await registerRevision(handler, 2, { share: "required" });
    const answer = await admin("GET", "/v1/admin/projects");
    expect(answer.status).toBe(200);
    expect(answer.body.projects).toEqual([{
      name: "payments", latestRevision: 2, registeredAt: expect.any(String) as unknown,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }],
      runtimeMode: "ec2-ebs", connectors: [],
      developerTasks: { enabled: true, share: "required", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true },
    }]);
  });

  it("writes the catalog row with the registration, and keeps its first registration time", async () => {
    const { db, handler } = await createAdminReadBroker();
    const first = db.get("PROJECT_CATALOG", "PROJECT#payments") as { firstRegisteredAt: string };
    expect(first).toMatchObject({ entityType: "PROJECT_CATALOG", name: "payments" });
    await registerRevision(handler, 2, {});
    expect(db.get("PROJECT_CATALOG", "PROJECT#payments")).toMatchObject({ firstRegisteredAt: first.firstRegisteredAt });
  });

  it("still finds a project registered before the catalog, through its binding or the admin's membership (A3)", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.delete("PROJECT_CATALOG", "PROJECT#payments");
    expect((await admin("GET", "/v1/admin/projects")).body.projects).toEqual([expect.objectContaining({ name: "payments" })]);
    // Unbound as well: only the registering admin's membership row names it now.
    for (const binding of db.find((item) => item.entityType === "SLACK_BINDING")) db.delete(String(binding.pk), String(binding.sk));
    expect((await admin("GET", "/v1/admin/projects")).body.projects).toEqual([expect.objectContaining({ name: "payments" })]);
    expect((await admin("GET", "/v1/admin/projects", { subject: "another-admin" })).body.projects).toEqual([]);
  });

  it("leaves out a catalog name whose project has no revision, and never scans", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#ghost", entityType: "PROJECT_CATALOG", name: "ghost", firstRegisteredAt: "2026-09-01T00:00:00.000Z" });
    const answer = await admin("GET", "/v1/admin/projects");
    expect((answer.body.projects as Array<{ name: string }>).map((project) => project.name)).toEqual(["payments"]);
    expect(db.commandNames()).not.toContain("ScanCommand");
  });

  it("refuses a caller without the admin claim, with FORBIDDEN (A2)", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("GET", "/v1/admin/projects", { admin: false })).body.error).toEqual({ code: "FORBIDDEN", message: "administrator claim is required" });
  });

  it("keeps POST /v1/admin/projects as registration", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("POST", "/v1/admin/projects")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
```

- [ ] **Step 2b: Teach the fake table what the admin reads send**

The admin reads use four things `tests/support/fake-dynamodb.ts` does not model yet: a
`FilterExpression`, an index key condition with a sort key range, `LastEvaluatedKey` when `Limit`
cut a query short, and two test helpers. Add them, keeping every existing branch's behaviour:

```ts
  /** Constructor names of every command sent, in order (spec 025 A3: no route scans). */
  private readonly sent: string[] = [];
  commandNames(): string[] { return [...this.sent]; }
  /** Removes one item without a stream record, as seeding does. */
  delete(pk: string, sk: string): void { this.items.delete(itemKey(pk, sk)); }
```

In `send`, push `command.constructor.name` onto `sent` first, and answer `QueryCommand` with
`this.queryPage(input)`:

```ts
  /**
   * DynamoDB's order of work: the key condition, the start key, then `Limit` items evaluated, then
   * the filter. LastEvaluatedKey is handed out only when `Limit` stopped the read early, keyed by
   * the table's keys plus, for an index, the index's own key attributes.
   */
  private queryPage(input: Record<string, unknown>): { Items: Item[]; LastEvaluatedKey?: Record<string, unknown> } {
    const limit = input.Limit as number | undefined;
    const evaluated = this.query({ ...input, Limit: undefined });
    const page = limit === undefined ? evaluated : evaluated.slice(0, limit);
    const filter = input.FilterExpression as string | undefined;
    const names = (input.ExpressionAttributeNames ?? {}) as Names;
    const values = (input.ExpressionAttributeValues ?? {}) as Values;
    const items = filter === undefined ? page : page.filter((item) => evaluateCondition(filter, item, names, values));
    const last = page.at(-1);
    if (limit === undefined || evaluated.length <= limit || last === undefined) return { Items: items };
    const indexKeys = input.IndexName === undefined ? [] : this.indexAttributes(input);
    return { Items: items, LastEvaluatedKey: Object.fromEntries(["pk", "sk", ...indexKeys].map((name) => [name, last[name]])) };
  }
```

In `query`, before the existing index branch, add the index range shapes the turn and workspace
reads use (`<attr> = :v AND <sort> >= :a` and `<attr> = :v AND <sort> BETWEEN :a AND :b`, names
allowed), sorted by the sort attribute and honouring `ScanIndexForward` and an
`ExclusiveStartKey` on that sort attribute:

```ts
    if (input.IndexName !== undefined) {
      const names = (input.ExpressionAttributeNames ?? {}) as Names;
      const name = (token: string) => (token.startsWith("#") ? names[token]! : token);
      const ranged = /^(#?[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+) AND (#?[A-Za-z0-9_]+) (>=|BETWEEN) (:[A-Za-z0-9_]+)(?: AND (:[A-Za-z0-9_]+))?$/.exec(String(input.KeyConditionExpression));
      if (ranged) {
        const [partition, sort] = [name(ranged[1]!), name(ranged[3]!)];
        const low = values[ranged[5]!] as string;
        const high = ranged[6] === undefined ? undefined : values[ranged[6]] as string;
        const found = this.find((item) => item[partition] === values[ranged[2]!] && typeof item[sort] === "string"
          && compareKeys(item[sort] as string, low) >= 0 && (high === undefined || compareKeys(item[sort] as string, high) <= 0))
          .sort((left, right) => compareKeys(left[sort] as string, right[sort] as string));
        if (input.ScanIndexForward === false) found.reverse();
        const start = input.ExclusiveStartKey as Record<string, unknown> | undefined;
        const after = start === undefined ? found : found.filter((item) => compareKeys(item[sort] as string, String(start[sort])) * (input.ScanIndexForward === false ? -1 : 1) > 0);
        return after.map((item) => structuredClone(item));
      }
      // ...the existing single-attribute index branch follows, unchanged.
```

and `indexAttributes(input)` returns the two attribute names that branch matched (for the
single-attribute branch, the one attribute). The main table's `begins_with` and `BETWEEN` branches
already sort and honour `ExclusiveStartKey` (add the start-key filter to the `BETWEEN` branch the
same way the `begins_with` branch does it). `Limit` now moves from `query` to `queryPage`, so remove
the three `limit` slices from `query`'s branches.

Then run the whole suite once (`npm test`): the fake now hands out `LastEvaluatedKey` where it used
to cut a limited query short silently, so a loop that stopped early now reads on. Every existing
test must still pass; one that does not is a real bug the old fake hid, and is raised with the
owner, never fixed by weakening its assertion.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-read-projects.test.ts`
Expected: FAIL: `GET /v1/admin/projects` answers the catch-all `FORBIDDEN` ("AgentX developer
workflows run in the project's Slack channel...").

- [ ] **Step 4: Write the catalog row with each registration**

In `registerProject` in `packages/broker/src/aws/broker.ts`, add a third item to the
`TransactItems` beside `record` and `membership`:

```ts
      // Spec 025 A3: the admin project list reads this row instead of scanning the table.
      { Update: {
        TableName: dependencies.tableName,
        Key: projectCatalogKey(definition.name),
        UpdateExpression: "SET entityType = :entity, #name = :name, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": definition.name, ":now": now },
      } },
```

and import `projectCatalogKey` from `@agentx/contracts`. A duplicate registration returns before
the transaction, so it writes nothing, as before.

- [ ] **Step 5: Write the module**

```ts
// packages/broker/src/aws/admin-reads.ts
// Spec 025 phase 25d, FR-038: the admin read routes. Each checks the admin claim only, as today's
// list routes do (A2), and reads by key or by index: no route scans the table, and no route writes.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  PROJECT_CATALOG_PK,
  agentXError,
  developerTaskPolicy,
  type AdminProjectsResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ProjectDefinition,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

export interface AdminReadDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  turnRecordsTableName?: string;
  /** The environment's Slack team (named environments); absent in the legacy deployment. */
  slackTeamId?: string;
  /** DeveloperIdentity's channel-info lookup (R10), where developer sign-in is set up. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** The stack parameters' workspace limits, used when no setting exists (FR-053). */
  limitDefaults: { member: number; organization: number };
  /** Task 11 replaces this field's type with AdminMeDependencies. */
  me?: unknown;
  /** Task 12 replaces this field's type with AdminHealthProbes. */
  health?: unknown;
  now(): number;
  log(entry: Record<string, unknown>): void;
}

/** Every item under `pk` with the sort key prefix, or the first `limit` of them. */
export async function queryAllItems(deps: AdminReadDependencies, pk: string, prefix: string, options: { limit?: number; newestFirst?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true,
      ...(options.newestFirst ? { ScanIndexForward: false } : {}),
      ...(options.limit === undefined ? {} : { Limit: options.limit - items.length }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined && (options.limit === undefined || items.length < options.limit));
  return items;
}

export async function getStateItem(deps: AdminReadDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/** The latest revision's record, or undefined when the project has none. */
export async function latestProjectRecord(deps: AdminReadDependencies, name: string): Promise<{ definition: ProjectDefinition; runtimeBinding: { deploymentMode: string }; registeredAt: string } | undefined> {
  const [item] = await queryAllItems(deps, `PROJECT#${name}`, "REV#", { limit: 1, newestFirst: true });
  if (item === undefined) return undefined;
  return item as unknown as { definition: ProjectDefinition; runtimeBinding: { deploymentMode: string }; registeredAt: string };
}

/**
 * A3 (Q2): the catalog's names, the environment team's bound projects, and the caller's own
 * membership rows. Sorted and unique; a name is kept only while the project has a revision.
 */
export async function adminProjectNames(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<string[]> {
  const [catalog, bindings, memberships] = await Promise.all([
    queryAllItems(deps, PROJECT_CATALOG_PK, "PROJECT#"),
    deps.slackTeamId === undefined ? Promise.resolve([]) : queryAllItems(deps, `SLACK_BINDING#${deps.slackTeamId}`, "CHANNEL#"),
    queryAllItems(deps, `MEMBER#${identity.ownerKey}`, "PROJECT#"),
  ]);
  const names = new Set<string>();
  for (const item of catalog) if (typeof item.name === "string") names.add(item.name);
  for (const item of bindings) if (typeof item.projectName === "string") names.add(item.projectName);
  for (const item of memberships) if (typeof item.projectName === "string") names.add(item.projectName);
  const sorted = [...names].sort();
  const exists = await Promise.all(sorted.map(async (name) => (await queryAllItems(deps, `PROJECT#${name}`, "REV#", { limit: 1 })).length > 0));
  return sorted.filter((_, index) => exists[index]);
}

type Definition = ProjectDefinition & { integrations?: { githubMcp?: unknown; connectors?: Array<{ name?: unknown; type?: unknown }> } };

/** FR-030: name, latest revision, registration time, repositories, mode, connectors and task policy. Never the instructions. */
async function listProjects(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<AdminProjectsResponse> {
  const projects: AdminProjectsResponse["projects"] = [];
  for (const name of await adminProjectNames(deps, identity)) {
    const latest = await latestProjectRecord(deps, name);
    if (latest === undefined) continue;
    const definition = latest.definition as Definition;
    const connectors = (definition.integrations?.connectors ?? [])
      .filter((entry): entry is { name: string; type: string } => typeof entry.name === "string" && typeof entry.type === "string")
      .map((entry) => ({ name: entry.name, type: entry.type }));
    // A revision from before feature 013 names GitHub MCP directly.
    if (definition.integrations?.githubMcp !== undefined && !connectors.some((entry) => entry.type === "github")) connectors.push({ name: "github", type: "github" });
    projects.push({
      name,
      latestRevision: definition.revision,
      registeredAt: latest.registeredAt,
      repositories: definition.repositories.map((repository) => ({ name: repository.name, url: repository.url })),
      runtimeMode: latest.runtimeBinding.deploymentMode,
      connectors,
      developerTasks: developerTaskPolicy(definition),
    });
  }
  return { projects };
}

export async function routeAdminRead(
  deps: AdminReadDependencies,
  identity: AuthenticatedIdentity,
  request: { method: string; headers: Record<string, string | undefined> },
  url: URL,
): Promise<unknown | undefined> {
  if (request.method !== "GET") return undefined;
  const read = ADMIN_READS[url.pathname];
  if (read === undefined) return undefined;
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  return read(deps, identity, url, request);
}

type AdminRead = (deps: AdminReadDependencies, identity: AuthenticatedIdentity, url: URL, request: { headers: Record<string, string | undefined> }) => Promise<unknown>;

/** Each later task adds its route here. */
const ADMIN_READS: Record<string, AdminRead> = {
  "/v1/admin/projects": (deps, identity) => listProjects(deps, identity),
};
```

- [ ] **Step 6: Wire the route**

In `packages/broker/src/aws/broker.ts`:
- add to `AwsBrokerDependencies`, after `slackThreadsTableName`:

```ts
  /** Spec 025 phase 25d: the admin read routes' injected probes and clock; the defaults serve production. */
  adminReads?: Partial<Pick<AdminReadDependencies, "me" | "health" | "now" | "log">>;
```

- add, beside `developerTaskActions`:

```ts
/** Spec 025 phase 25d: what the admin read routes need, from the broker's own dependencies. */
function adminReadDependencies(dependencies: AwsBrokerDependencies): AdminReadDependencies {
  const developer = dependencies.developer;
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turnRecordsTableName: dependencies.turnRecordsTableName }),
    ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    ...(developer?.channelInfo === undefined ? {} : { channelInfo: developer.channelInfo }),
    limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
    now: Date.now,
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    ...dependencies.adminReads,
  };
}
```

- in `createAwsBrokerHandler`, build it once beside `tasks`: `const adminReads = adminReadDependencies(dependencies);`
- right after `const body = parseBody(request.body);` in the admin block, add:

```ts
      // Spec 025 phase 25d: the admin read routes (FR-038), each behind the admin claim (A2).
      const adminRead = await routeAdminRead(adminReads, identity, request, url);
      if (adminRead !== undefined) return json(adminRead, request.requestId);
```

`GET /v1/admin/turns` and `GET /v1/admin/credentials` keep their own branches below (Task 7 extends
the turns branch); `routeAdminRead` does not name them.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/admin-read-projects.test.ts tests/contract/admin-preparation.test.ts tests/contract/slack-admin-cli.test.ts && npm run typecheck`
Expected: PASS. Registration's existing tests pass unchanged: they check the project and
membership rows, which are written as before.

- [ ] **Step 8: Commit**

```bash
git add packages/broker/src/aws/admin-reads.ts packages/broker/src/aws/broker.ts tests/support/admin-read-broker.ts tests/support/fake-dynamodb.ts tests/contract/admin-read-projects.test.ts
git commit -m "feat(broker): the project catalog and GET /v1/admin/projects (spec 025 phase 25d)"
```

---

### Task 3: `GET /v1/admin/slack/bindings`

A11's public names, with private channels by ID; Task 11 adds the owner's Q7 answer (a private
channel's name for an admin who is a member of it), once the admin's Slack link exists.
**Depends on Q7.**

**Files:**
- Modify: `packages/broker/src/aws/admin-reads.ts`
- Test: `tests/contract/admin-read-bindings.test.ts`

**Interfaces:**
- Consumes: `AdminReadDependencies`, `queryAllItems`, `ADMIN_READS` (Task 2); `AdminBindingsResponse`
  (Task 1); `CHANNEL_MEMBERS_MAX_CHANNELS` (contracts).
- Produces: `export async function channelLabels(deps: AdminReadDependencies, channelIds: readonly string[]): Promise<{ labels: Map<string, { name?: string; private: boolean }>; available: boolean }>`
  (Task 9 and 25e reuse it); the route.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-read-bindings.test.ts
// Spec 025 A11: channel bindings, with public channels' names and private channels by ID only.
import { describe, expect, it, vi } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { bindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

describe("GET /v1/admin/slack/bindings (FR-038, FR-030)", () => {
  it("lists the environment team's bindings with public names, and a private channel by ID only", async () => {
    const channelInfo = vi.fn(async (request: { channelIds: string[] }) => ({
      ok: true as const,
      channels: request.channelIds.map((channelId) => (channelId === SLACK_CHANNEL
        ? { channelId, name: "payments-dev", isPrivate: false }
        : { channelId, name: "secret-launch", isPrivate: true })),
    }));
    const { admin, handler } = await createAdminReadBroker({ channelInfo });
    await bindChannel(handler, "C0PRIVATE01");
    const answer = await admin("GET", "/v1/admin/slack/bindings");
    expect(answer.body).toEqual({
      bindings: [
        { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, channelName: "payments-dev", private: false, projectName: "payments", updatedAt: expect.any(String) as unknown },
        { teamId: SLACK_TEAM, channelId: "C0PRIVATE01", private: true, projectName: "payments", updatedAt: expect.any(String) as unknown },
      ],
      notices: [],
    });
    expect(JSON.stringify(answer.body)).not.toContain("secret-launch");
  });

  it("lists channels by ID with a notice when the name lookup is not set up or fails", async () => {
    const unset = await createAdminReadBroker({ channelInfo: null });
    expect((await unset.admin("GET", "/v1/admin/slack/bindings")).body).toMatchObject({
      bindings: [{ channelId: SLACK_CHANNEL, projectName: "payments" }], notices: ["channel_names_unavailable"],
    });
    const failing = await createAdminReadBroker({ channelInfo: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect((await failing.admin("GET", "/v1/admin/slack/bindings")).body.notices).toEqual(["channel_names_unavailable"]);
  });

  it("asks for team= where the environment records no Slack team, and refuses a malformed one", async () => {
    const { admin } = await createAdminReadBroker({ slackTeamId: null });
    expect((await admin("GET", "/v1/admin/slack/bindings")).body.error).toEqual({
      code: "CONFIG_INVALID", message: "this environment records no Slack team; send team=<team ID>, such as team=T0123456789",
    });
    expect((await admin("GET", `/v1/admin/slack/bindings?team=${SLACK_TEAM}`)).body.bindings).toHaveLength(1);
    expect((await admin("GET", "/v1/admin/slack/bindings?team=<script>")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a non-admin", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("GET", "/v1/admin/slack/bindings", { admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-read-bindings.test.ts`
Expected: FAIL: the route answers the catch-all `FORBIDDEN`.

- [ ] **Step 3: Add the route**

In `packages/broker/src/aws/admin-reads.ts`, import `CHANNEL_MEMBERS_MAX_CHANNELS`,
`SlackTeamIdSchema` and `type AdminBindingsResponse`, and add:

```ts
/** A11: names for public channels, privacy for all; `available` is false when no name could be read. */
export async function channelLabels(deps: AdminReadDependencies, channelIds: readonly string[]): Promise<{ labels: Map<string, { name?: string; private: boolean }>; available: boolean }> {
  const labels = new Map<string, { name?: string; private: boolean }>();
  const unique = [...new Set(channelIds)].sort();
  if (deps.channelInfo === undefined) return { labels, available: unique.length === 0 };
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const answer = await deps.channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
      if (!answer.ok) return { labels, available: false };
      for (const channel of answer.channels) {
        // Until Task 11 adds the member check (Q7 as answered), a private channel stays ID only.
        labels.set(channel.channelId, channel.isPrivate ? { private: true } : { name: channel.name, private: false });
      }
    }
  } catch (error) {
    deps.log({ event: "admin.channel_info_failed", error: error instanceof Error ? error.name : "unknown" });
    return { labels, available: false };
  }
  return { labels, available: true };
}

async function listBindings(deps: AdminReadDependencies, url: URL): Promise<AdminBindingsResponse> {
  const asked = url.searchParams.get("team");
  const team = asked === null ? deps.slackTeamId : SlackTeamIdSchema.safeParse(asked).success ? asked : null;
  if (team === null) throw agentXError("CONFIG_INVALID", "team must be a Slack team ID, such as T0123456789");
  if (team === undefined) throw agentXError("CONFIG_INVALID", "this environment records no Slack team; send team=<team ID>, such as team=T0123456789");
  const items = await queryAllItems(deps, `SLACK_BINDING#${team}`, "CHANNEL#");
  const rows = items.filter((item) => typeof item.channelId === "string" && typeof item.projectName === "string");
  const { labels, available } = await channelLabels(deps, rows.map((item) => String(item.channelId)));
  return {
    bindings: rows
      .map((item) => {
        const label = labels.get(String(item.channelId));
        return {
          teamId: team,
          channelId: String(item.channelId),
          ...(label?.name === undefined ? {} : { channelName: label.name }),
          ...(label === undefined ? {} : { private: label.private }),
          projectName: String(item.projectName),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
        };
      })
      .sort((left, right) => left.channelId.localeCompare(right.channelId)),
    notices: available ? [] : ["channel_names_unavailable"],
  };
}
```

and add `"/v1/admin/slack/bindings": (deps, _identity, url) => listBindings(deps, url),` to
`ADMIN_READS`. The existing `PUT` and `DELETE` routes on `/v1/admin/slack/bindings/<team>/<channel>`
are different paths and are untouched. Sorting by channel ID puts `C0123456789` before
`C0PRIVATE01`, which the first test's order expects.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-read-bindings.test.ts tests/contract/slack-admin-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-reads.ts tests/contract/admin-read-bindings.test.ts
git commit -m "feat(broker): GET /v1/admin/slack/bindings with public channel names (spec 025 phase 25d)"
```

---

### Task 4: The failure and usage indexes, from the state table's stream

A4, A5. FR-038's failure index, and the usage index A9 reads.

**Files:**
- Create: `packages/broker/src/aws/activity-index.ts`
- Modify: `packages/broker/src/aws/outbox-publisher.ts`
- Test: `tests/contract/activity-index.test.ts`, `tests/contract/outbox-publisher-index.test.ts`

**Interfaces:**
- Consumes: `failureIndexKey`, `usageIndexKey`, `FailureIndexRecord`, `UsageIndexRecord`,
  `AdminRequester`, `ADMIN_ERROR_TEXT_MAX`, `INDEX_EXPIRY_ATTRIBUTE`, `indexExpiresAt` (Task 1); `TaskUsageTelemetrySchema`, `redactAndCap`
  (contracts); `failureCategory`, `taskPointerKey`, `taskKey` (`packages/broker/src/developer/task-records.ts`);
  `StreamRecord` (`packages/broker/src/developer/notifications.ts`).
- Produces:
  - `export interface IndexStore { get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined>; put(item: Record<string, unknown>): Promise<void> }`
    (`put` is conditioned `attribute_not_exists(pk)` and treats a failed condition as done);
  - `export async function indexActivity(records: readonly StreamRecord[], store: IndexStore, log: (entry: Record<string, unknown>) => void): Promise<{ failures: number; usage: number; failed: number }>`;
  - `createOutboxPublisherHandler`'s dependencies gain `index?: (records: readonly StreamRecord[]) => Promise<unknown>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/activity-index.test.ts
// Spec 025 A4, A5: an operation that ends FAILED or INTERRUPTED, and a worker's usage event, become
// index items the admin routes read without scanning.
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { indexActivity, type IndexStore } from "../../packages/broker/src/aws/activity-index.js";
import type { StreamRecord } from "../../packages/broker/src/developer/notifications.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const TASK = "33333333-3333-4333-8333-333333333333";
const OWNER = "a".repeat(64);
const PLANTED = `ghp_${"A".repeat(36)}`;

function store(items: Record<string, unknown>[] = []): IndexStore & { puts: Record<string, unknown>[] } {
  const puts: Record<string, unknown>[] = [];
  return {
    puts,
    get: async (key) => items.find((item) => item.pk === key.pk && item.sk === key.sk),
    put: async (item) => { puts.push(item); },
  };
}
const modified = (before: Record<string, unknown>, after: Record<string, unknown>, eventID = "e1"): StreamRecord => ({
  eventID, eventName: "MODIFY", dynamodb: { NewImage: marshall(after, { removeUndefinedValues: true }), OldImage: marshall(before, { removeUndefinedValues: true }) },
});
const inserted = (item: Record<string, unknown>, eventID = "e2"): StreamRecord => ({ eventID, eventName: "INSERT", dynamodb: { NewImage: marshall(item, { removeUndefinedValues: true }) } });
const operation = (extra: Record<string, unknown>) => ({
  pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, entityType: "OPERATION", id: OPERATION, workspaceId: WORKSPACE,
  kind: "task", status: "RUNNING", createdAt: "2026-09-30T08:00:00.000Z", updatedAt: "2026-09-30T08:00:00.000Z", fence: 2, ...extra,
});
const slackWorkspace = [
  { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments", ownerKey: OWNER },
  { pk: `SLACK_THREAD#${OWNER}`, sk: "META", thread: "T0BSHLLUGBD/C0123456789/1695500000.000100" },
];
const taskWorkspace = [
  { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments", ownerKey: OWNER },
  { pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: "d".repeat(64) },
  { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, developerName: "Maya Chen" },
];

describe("the failure index (FR-038, A5)", () => {
  it("indexes a Slack task that ends FAILED, with its thread as the turn record link", async () => {
    const index = store(slackWorkspace);
    const result = await indexActivity([modified(operation({}), operation({
      status: "FAILED", error: "npm test exited 1", updatedAt: "2026-09-30T08:15:00.000Z", requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" },
    }))], index, vi.fn());
    expect(result).toEqual({ failures: 1, usage: 0, failed: 0 });
    expect(index.puts).toEqual([{
      pk: "FAILURE#2026-09-30", sk: `2026-09-30T08:15:00.000Z#${OPERATION}`, entityType: "FAILURE_INDEX",
      indexExpiresAt: Math.floor(Date.parse("2026-09-30T08:15:00.000Z") / 1000) + 30 * 86_400,
      operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "slack",
      requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" },
      kind: "task", status: "FAILED", category: "task_failed", error: "npm test exited 1", endedAt: "2026-09-30T08:15:00.000Z",
      thread: "T0BSHLLUGBD/C0123456789/1695500000.000100",
    }]);
  });

  it("indexes a developer task's interrupted run as ai_tool, naming the developer and the task", async () => {
    const index = store(taskWorkspace);
    await indexActivity([modified(operation({}), operation({
      status: "INTERRUPTED", updatedAt: "2026-09-30T09:00:00.000Z", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" },
    }))], index, vi.fn());
    expect(index.puts[0]).toMatchObject({
      origin: "ai_tool", category: "interrupted", taskId: TASK, error: "the task operation ended INTERRUPTED",
      requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" },
    });
  });

  it("stores a failure's error redacted and cut, and logs only IDs", async () => {
    const index = store(slackWorkspace);
    const log = vi.fn();
    await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z", error: `auth failed for ${PLANTED} ${"x".repeat(2_000)}` }))], index, log);
    const error = String(index.puts[0]?.error);
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain(PLANTED);
    expect(error.length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(log.mock.calls)).not.toContain("auth failed");
  });

  it("indexes nothing for a success, a repeat of a terminal status, or another entity", async () => {
    const index = store(slackWorkspace);
    await indexActivity([
      modified(operation({}), operation({ status: "SUCCEEDED" })),
      modified(operation({ status: "FAILED" }), operation({ status: "FAILED", updatedAt: "2026-09-30T08:20:00.000Z" })),
      modified({ entityType: "WORKSPACE", status: "READY" }, { entityType: "WORKSPACE", status: "PREPARATION_FAILED" }),
    ], index, vi.fn());
    expect(index.puts).toEqual([]);
  });

  it("names the project unknown when the workspace record is gone, and the requester none when absent", async () => {
    const index = store([]);
    await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z" }))], index, vi.fn());
    expect(index.puts[0]).toMatchObject({ project: "unknown", origin: "slack", requester: { kind: "none" } });
  });
});

describe("the usage index (A5, A9)", () => {
  const usageEvent = (payload: unknown) => inserted({
    pk: `OPERATION#${OPERATION}`, sk: "EVENT#000000000007", entityType: "EVENT", workspaceId: WORKSPACE, operationId: OPERATION,
    type: "usage", timestamp: "2026-09-30T08:10:00.000Z", payload,
  });
  const telemetry = {
    schemaVersion: 1, outcome: "SUCCEEDED", provider: "bedrock", modelId: "anthropic.claude", cacheRetention: "long",
    tokens: { input: 1_000, output: 200, cacheRead: 50, cacheWrite: 0, total: 1_250 }, cacheReadRatio: 0.05, costUsd: 0.42,
  };

  it("indexes a worker's usage event with the task's duration, tokens and cost", async () => {
    const index = store([...slackWorkspace, operation({ requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" } })]);
    const result = await indexActivity([usageEvent(telemetry)], index, vi.fn());
    expect(result.usage).toBe(1);
    expect(index.puts[0]).toEqual({
      pk: "USAGE#2026-09-30", sk: `2026-09-30T08:10:00.000Z#${OPERATION}`, entityType: "USAGE_INDEX",
      indexExpiresAt: Math.floor(Date.parse("2026-09-30T08:10:00.000Z") / 1000) + 30 * 86_400,
      operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "slack",
      requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, thread: "T0BSHLLUGBD/C0123456789/1695500000.000100",
      at: "2026-09-30T08:10:00.000Z", durationMs: 600_000, inputTokens: 1_000, outputTokens: 200, costUsd: 0.42,
    });
  });

  it("keeps an unknown cost as null, and skips a usage payload it cannot read, counting it", async () => {
    const index = store([...slackWorkspace, operation({})]);
    const log = vi.fn();
    const result = await indexActivity([usageEvent({ ...telemetry, costUsd: null }), usageEvent({ tokens: "lots" })], index, log);
    expect(index.puts[0]).toMatchObject({ costUsd: null });
    expect(result).toEqual({ failures: 0, usage: 1, failed: 1 });
    expect(log).toHaveBeenCalledWith({ event: "activity_index.usage_unreadable", operationId: OPERATION });
  });

  it("goes on after one record's write fails, and reports it by error name", async () => {
    const index = store(slackWorkspace);
    let first = true;
    index.put = async (item) => {
      if (first) { first = false; throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }); }
      index.puts.push(item);
    };
    const log = vi.fn();
    const failed = (id: string, at: string) => modified(operation({ id }), operation({ id, sk: `OPERATION#${id}`, status: "FAILED", updatedAt: at }), id);
    const result = await indexActivity([failed(OPERATION, "2026-09-30T08:15:00.000Z"), failed("44444444-4444-4444-8444-444444444444", "2026-09-30T08:16:00.000Z")], index, log);
    expect(result).toEqual({ failures: 1, usage: 0, failed: 1 });
    expect(log).toHaveBeenCalledWith({ event: "activity_index.write_failed", operationId: OPERATION, error: "ThrottlingException" });
  });
});
```

```ts
// tests/contract/outbox-publisher-index.test.ts
// Spec 025 A4: the outbox publisher dispatches as before and indexes after; the index never fails the batch.
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";

const outbox = { eventName: "INSERT", dynamodb: { NewImage: marshall({ pk: "OUTBOX#o1", sk: "OUTBOX", entityType: "OUTBOX", status: "PENDING", id: "o1", operationId: "op", workspaceId: "ws" }) } };

describe("the outbox publisher with the index (A4)", () => {
  it("hands every record of the batch to the index after dispatching", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const index = vi.fn(async () => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued, index });
    expect(await handler({ Records: [outbox] })).toEqual({ published: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(index).toHaveBeenCalledWith([outbox]);
  });

  it("dispatches the batch even when the index write throws", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued, index: async () => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); } });
    expect(await handler({ Records: [outbox] })).toEqual({ published: 1 });
    expect(markQueued).toHaveBeenCalledWith("o1");
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(JSON.stringify({ component: "outbox-publisher", event: "activity_index.write_failed", error: "ThrottlingException" }));
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/activity-index.test.ts tests/contract/outbox-publisher-index.test.ts`
Expected: FAIL: `activity-index.js` does not exist; the publisher takes no `index`.

- [ ] **Step 3: Write the index writer**

```ts
// packages/broker/src/aws/activity-index.ts
// Spec 025 A4, A5: the failure index (FR-038) and the usage index, from the state table's stream.
// The outbox publisher runs it after dispatching; it is best effort, and never fails the batch.
// Logs carry event names, IDs and error names only: an operation's error can quote anything.
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ADMIN_ERROR_TEXT_MAX,
  INDEX_EXPIRY_ATTRIBUTE,
  TaskUsageTelemetrySchema,
  failureIndexKey,
  indexExpiresAt,
  redactAndCap,
  usageIndexKey,
  type AdminRequester,
  type FailureIndexRecord,
  type UsageIndexRecord,
} from "@agentx/contracts";
import { failureCategory, taskKey, taskPointerKey } from "../developer/task-records.js";
import type { StreamRecord } from "../developer/notifications.js";

export interface IndexStore {
  get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined>;
  /** Conditioned attribute_not_exists(pk): a replayed record writes nothing twice. */
  put(item: Record<string, unknown>): Promise<void>;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const FAILED = new Set(["FAILED", "INTERRUPTED"]);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

interface Context { project: string; origin: "slack" | "ai_tool"; taskId?: string; thread?: string; developerName?: string }

/** A5: the project, the origin and the turn record link, from the workspace's own records. */
async function contextOf(store: IndexStore, workspaceId: string): Promise<Context> {
  const workspace = await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  const project = text(workspace?.projectName) ?? "unknown";
  const pointer = await store.get(taskPointerKey(workspaceId));
  const taskId = text(pointer?.taskId);
  if (taskId !== undefined) {
    const task = await store.get(taskKey(taskId));
    const developerName = text(task?.developerName);
    return { project, origin: "ai_tool", taskId, ...(developerName === undefined ? {} : { developerName }) };
  }
  const ownerKey = text(workspace?.ownerKey);
  const thread = ownerKey === undefined ? undefined : text((await store.get({ pk: `SLACK_THREAD#${ownerKey}`, sk: "META" }))?.thread);
  return { project, origin: "slack", ...(thread === undefined ? {} : { thread }) };
}

function requesterOf(value: unknown, developerName: string | undefined): AdminRequester {
  const requester = record(value);
  if (requester?.kind === "developer" && typeof requester.developerId === "string" && (requester.provider === "slack" || requester.provider === "oidc")) {
    return { kind: "developer", developerId: requester.developerId, provider: requester.provider, ...(developerName === undefined ? {} : { name: developerName }) };
  }
  if (typeof requester?.teamId === "string" && typeof requester.userId === "string") return { kind: "slack", teamId: requester.teamId, userId: requester.userId };
  return { kind: "none" };
}

const link = (context: Context) => ({ ...(context.taskId === undefined ? {} : { taskId: context.taskId }), ...(context.thread === undefined ? {} : { thread: context.thread }) });

async function failureItem(store: IndexStore, next: Record<string, unknown>): Promise<Record<string, unknown>> {
  const workspaceId = String(next.workspaceId);
  const context = await contextOf(store, workspaceId);
  const kind = String(next.kind);
  const status = String(next.status) as FailureIndexRecord["status"];
  const error = text(next.error);
  const endedAt = new Date(text(next.updatedAt) ?? Date.now()).toISOString();
  const indexed: FailureIndexRecord = {
    operationId: String(next.id), workspaceId, project: context.project, origin: context.origin,
    requester: requesterOf(next.requestedBy, context.developerName),
    kind, status, category: failureCategory(kind, status, error),
    error: redactAndCap(error ?? `the ${kind} operation ended ${status}`, ADMIN_ERROR_TEXT_MAX).text,
    endedAt, ...link(context),
  };
  return { ...failureIndexKey(endedAt, indexed.operationId), entityType: "FAILURE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(endedAt), ...indexed };
}

async function usageItem(store: IndexStore, event: Record<string, unknown>): Promise<Record<string, unknown> | "unreadable"> {
  const telemetry = TaskUsageTelemetrySchema.safeParse(event.payload);
  if (!telemetry.success) return "unreadable";
  const workspaceId = String(event.workspaceId);
  const operationId = String(event.operationId);
  const at = new Date(text(event.timestamp) ?? Date.now()).toISOString();
  const [context, operation] = await Promise.all([contextOf(store, workspaceId), store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` })]);
  const created = Date.parse(text(operation?.createdAt) ?? at);
  const indexed: UsageIndexRecord = {
    operationId, workspaceId, project: context.project, origin: context.origin,
    requester: requesterOf(operation?.requestedBy, context.developerName), ...link(context),
    at, durationMs: Math.max(0, Date.parse(at) - (Number.isFinite(created) ? created : Date.parse(at))),
    inputTokens: telemetry.data.tokens.input, outputTokens: telemetry.data.tokens.output, costUsd: telemetry.data.costUsd,
  };
  return { ...usageIndexKey(at, operationId), entityType: "USAGE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at), ...indexed };
}

export async function indexActivity(records: readonly StreamRecord[], store: IndexStore, log: (entry: Record<string, unknown>) => void): Promise<{ failures: number; usage: number; failed: number }> {
  const result = { failures: 0, usage: 0, failed: 0 };
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    let next: Record<string, unknown>;
    let previous: Record<string, unknown> | undefined;
    try {
      next = unmarshall(image) as Record<string, unknown>;
      previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
    } catch {
      continue;
    }
    const failure = next.entityType === "OPERATION" && FAILED.has(String(next.status)) && !TERMINAL.has(String(previous?.status));
    const usage = next.entityType === "EVENT" && next.type === "usage" && entry.eventName === "INSERT";
    if (!failure && !usage) continue;
    const operationId = String(failure ? next.id : next.operationId);
    try {
      if (failure) {
        await store.put(await failureItem(store, next));
        result.failures += 1;
      } else {
        const item = await usageItem(store, next);
        if (item === "unreadable") {
          log({ event: "activity_index.usage_unreadable", operationId });
          result.failed += 1;
          continue;
        }
        await store.put(item);
        result.usage += 1;
      }
    } catch (error) {
      log({ event: "activity_index.write_failed", operationId, error: errorName(error) });
      result.failed += 1;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the index after dispatch**

In `packages/broker/src/aws/outbox-publisher.ts`:
- widen `DynamoStreamRecord` to `StreamRecord` from `../developer/notifications.js` (it adds
  `eventID` and `OldImage`; the existing loop reads only `eventName` and `NewImage`);
- add `index?: (records: readonly StreamRecord[]) => Promise<unknown>` to the handler's
  dependencies, and after the existing loop:

```ts
    if (dependencies.index !== undefined) {
      try {
        await dependencies.index(event.Records ?? []);
      } catch (error) {
        // A4: dispatch never waits on, or repeats for, the index; the error's name only.
        console.log(JSON.stringify({ component: "outbox-publisher", event: "activity_index.write_failed", error: error instanceof Error ? error.name : "unknown" }));
      }
    }
```

- in the module's own `handler`, pass:

```ts
  index: (records) => indexActivity(records, {
    get: async (key) => ((await documentClient.send(new GetCommand({ TableName: required(tableName, "STATE_TABLE_NAME"), Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item,
    put: async (item) => {
      try {
        await documentClient.send(new PutCommand({ TableName: required(tableName, "STATE_TABLE_NAME"), Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      }
    },
  }, (entry) => console.log(JSON.stringify({ component: "outbox-publisher", ...entry }))),
```

  with `GetCommand` and `PutCommand` imported from `@aws-sdk/lib-dynamodb`. The publisher already
  holds `grantReadWriteData` on the State table (control-plane.ts), so no grant changes.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/activity-index.test.ts tests/contract/outbox-publisher-index.test.ts tests/contract/outbox*.test.ts && npm run typecheck`
Expected: PASS. The existing outbox publisher tests pass unchanged: they pass no `index`.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/activity-index.ts packages/broker/src/aws/outbox-publisher.ts tests/contract/activity-index.test.ts tests/contract/outbox-publisher-index.test.ts
git commit -m "feat(broker): failure and usage indexes from the state table's stream (spec 025 phase 25d)"
```

---
### Task 5: Index days expire after 30 days in the legacy deployment

A6. **Depends on Q5** (owner answer 2026-09-30: TTL in named environments, Task 13; this sweep only
where the State table has no TTL, the legacy deployment).

**Files:**
- Create: `packages/broker/src/aws/index-expiry.ts`
- Modify: `packages/broker/src/aws/session-reconciler.ts`
- Test: `tests/contract/index-expiry.test.ts`; modify `tests/contract/session-reconciler.test.ts`

**Interfaces:**
- Consumes: `ADMIN_INDEX_RETENTION_DAYS` (Task 1); `FakeDynamoDb` (Task 2's `queryPage`).
- Produces: `export const INDEX_EXPIRY_DELETES_PER_RUN = 500;`,
  `export const INDEX_EXPIRY_LOOKBACK_DAYS = 15;`,
  `export function indexSweepWanted(env: NodeJS.ProcessEnv): boolean` (false when `INDEX_EXPIRY=ttl`),
  `export async function expireIndexDays(client: { send(command: unknown): Promise<unknown> }, tableName: string, now: Date, log?: (entry: Record<string, unknown>) => void): Promise<{ deleted: number }>`;
  `ReconcilerDependencies.expireIndexDays?: (now: Date) => Promise<{ deleted: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/index-expiry.test.ts
// Spec 025 A6 (Q5): where the State table has no TTL (the legacy deployment), the reconciler deletes
// failure and usage index items older than 30 days.
import { describe, expect, it, vi } from "vitest";
import { expireIndexDays, indexSweepWanted, INDEX_EXPIRY_DELETES_PER_RUN } from "../../packages/broker/src/aws/index-expiry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-10-31T06:00:00.000Z");
const item = (prefix: string, day: string, n: number) => ({ pk: `${prefix}${day}`, sk: `${day}T08:00:00.${String(n).padStart(3, "0")}Z#op${n}`, entityType: `${prefix.slice(0, -1)}_INDEX` });

describe("index expiry (A6)", () => {
  it("deletes failure and usage items of days 31 to 45 back, and keeps day 30", async () => {
    const db = new FakeDynamoDb();
    for (const entry of [item("FAILURE#", "2026-09-30", 1), item("USAGE#", "2026-09-30", 2), item("FAILURE#", "2026-10-01", 3), item("FAILURE#", "2026-09-16", 4), item("FAILURE#", "2026-09-15", 5)]) db.set(entry);
    const log = vi.fn();
    expect(await expireIndexDays(db, "state", NOW, log)).toEqual({ deleted: 3 });
    expect(db.find((entry) => String(entry.pk).startsWith("FAILURE#") || String(entry.pk).startsWith("USAGE#")).map((entry) => entry.pk).sort()).toEqual(["FAILURE#2026-09-15", "FAILURE#2026-10-01"]);
    expect(log).toHaveBeenCalledWith({ event: "index_expiry.deleted", deleted: 3 });
  });

  it("stops at 500 deletes a run, so one run stays short, and the next run goes on", async () => {
    const db = new FakeDynamoDb();
    for (let n = 0; n < 520; n += 1) db.set(item("FAILURE#", "2026-09-29", n));
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: INDEX_EXPIRY_DELETES_PER_RUN });
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: 20 });
  });

  it("runs only where the State table has no TTL (INDEX_EXPIRY=ttl is set in named environments)", () => {
    expect(indexSweepWanted({})).toBe(true);
    expect(indexSweepWanted({ INDEX_EXPIRY: "ttl" })).toBe(false);
  });

  it("touches nothing else in those partitions' neighbourhood", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "SETUP_WATCH", sk: "2026-09-20T00:00:00.000Z#w", entityType: "SETUP_WATCH" });
    await expireIndexDays(db, "state", NOW);
    expect(db.get("SETUP_WATCH", "2026-09-20T00:00:00.000Z#w")).toBeDefined();
  });
});
```

In `tests/contract/session-reconciler.test.ts`, add `expireIndexDays?: ReconcilerDependencies["expireIndexDays"]`
to `setup()`'s options, spread it into the dependencies the same way as `sweepStuckSetups`
(`...(options.expireIndexDays === undefined ? {} : { expireIndexDays: options.expireIndexDays })`),
and add, beside the sweep's tests:

```ts
  it("runs the index expiry, and a failed expiry is logged and does not fail the run (A6)", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const expireIndexDays = vi.fn(async () => { throw Object.assign(new Error("PLANTED-EXPIRY-MESSAGE"), { name: "ThrottlingException" }); });
    const { reconcile, emit } = setup({ expireIndexDays, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(expireIndexDays).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(logs).toContainEqual({ event: "reconciler.index_expiry_failed", errorName: "ThrottlingException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-EXPIRY-MESSAGE");
    // A6: the metrics are the same set as before; the expiry adds none.
    expect(Object.keys(emit.mock.calls[0]![0])).not.toContain("ReconcilerIndexExpiry");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/index-expiry.test.ts`
Expected: FAIL: `index-expiry.js` does not exist.

- [ ] **Step 3: Write the expiry**

```ts
// packages/broker/src/aws/index-expiry.ts
// Spec 025 A6 (Q5, owner answer 2026-09-30): the failure and usage index days are kept 30 days
// (FR-038). Named environments' State table expires them by TTL on indexExpiresAt; the legacy
// deployment's has no TTL (its template does not change), so there the reconciler deletes old days.
// It looks 15 days back past the retention, so a run that failed or was skipped is caught up.
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ADMIN_INDEX_RETENTION_DAYS } from "@agentx/contracts";

type Client = { send(command: unknown): Promise<unknown> };
export const INDEX_EXPIRY_DELETES_PER_RUN = 500;
export const INDEX_EXPIRY_LOOKBACK_DAYS = 15;
const DAY_MS = 86_400_000;

/** The sweep runs only where the State table has no TTL: Task 13 sets INDEX_EXPIRY=ttl in named environments. */
export function indexSweepWanted(env: NodeJS.ProcessEnv): boolean {
  return env.INDEX_EXPIRY !== "ttl";
}
const PREFIXES = ["FAILURE#", "USAGE#"] as const;

export async function expireIndexDays(client: Client, tableName: string, now: Date, log: (entry: Record<string, unknown>) => void = () => undefined): Promise<{ deleted: number }> {
  let deleted = 0;
  for (let back = ADMIN_INDEX_RETENTION_DAYS + 1; back <= ADMIN_INDEX_RETENTION_DAYS + INDEX_EXPIRY_LOOKBACK_DAYS; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS).toISOString().slice(0, 10);
    for (const prefix of PREFIXES) {
      if (deleted >= INDEX_EXPIRY_DELETES_PER_RUN) break;
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :day)",
        ExpressionAttributeValues: { ":pk": `${prefix}${day}`, ":day": day },
        Limit: INDEX_EXPIRY_DELETES_PER_RUN - deleted,
      })) as { Items?: Array<{ pk: string; sk: string }> };
      for (const entry of response.Items ?? []) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: entry.pk, sk: entry.sk } }));
        deleted += 1;
      }
    }
  }
  // A count only: the items hold errors and names.
  if (deleted > 0) log({ event: "index_expiry.deleted", deleted });
  return { deleted };
}
```

- [ ] **Step 4: Run it in the reconciler**

In `packages/broker/src/aws/session-reconciler.ts`:
- add to `ReconcilerDependencies`, after `sweepStuckSetups`:
  `/** Spec 025 A6: deletes failure and usage index days older than 30 days; absent in tests that do not need it. */ expireIndexDays?: (now: Date) => Promise<{ deleted: number }>;`
- after the stuck-setup sweep's block, before `dependencies.emit(...)`:

```ts
    // Spec 025 A6: housekeeping. A failure is logged by its error name and the run goes on; the
    // next run's 15-day look-back catches the day up, so no metric or report field changes.
    if (dependencies.expireIndexDays !== undefined) {
      try {
        await dependencies.expireIndexDays(new Date(now));
      } catch (error) {
        log({ event: "reconciler.index_expiry_failed", errorName: error instanceof Error ? error.name : "unknown" });
      }
    }
```

- in the module's AWS dependencies, beside `sweepStuckSetups`, only where it is wanted:
  `...(indexSweepWanted(process.env) ? { expireIndexDays: (now: Date) => expireIndexDays(documentClient, tableName, now, (entry) => console.log(JSON.stringify({ component: "session-reconciler", ...entry }))) } : {}),`

The reconciler's role already has `grantReadWriteData` on the State table (session-lifecycle.ts),
which includes `Query` and `DeleteItem`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/index-expiry.test.ts tests/contract/session-reconciler.test.ts tests/contract/stuck-setup.test.ts && npm run typecheck`
Expected: PASS; the reconciler's metrics and report are unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/index-expiry.ts packages/broker/src/aws/session-reconciler.ts tests/contract/index-expiry.test.ts tests/contract/session-reconciler.test.ts
git commit -m "feat(broker): the legacy reconciler deletes index days older than 30 days (spec 025 phase 25d)"
```

---

### Task 6: `GET /v1/admin/failures`

A7, US5 scenario 3.

**Files:**
- Modify: `packages/broker/src/aws/admin-reads.ts`
- Test: `tests/contract/admin-read-failures.test.ts`

**Interfaces:**
- Consumes: `FailureIndexRecordSchema`, `failureIndexKey`, `ADMIN_FAILURES_DEFAULT_LIMIT`,
  `ADMIN_FAILURES_DEFAULT_HOURS`, `ADMIN_INDEX_RETENTION_DAYS`, `ADMIN_LIST_MAX` (Task 1);
  `AgentXNameSchema` (contracts).
- Produces: `export function timeWindow(url: URL, now: number, defaultHours: number): { since: string; until: string }`
  (Tasks 8 reuses it), `export function listLimit(url: URL, fallback: number): number`,
  `export async function readFailures(deps: AdminReadDependencies, window: { since: string; until: string }, options: { limit: number; project?: string; category?: string }): Promise<{ failures: FailureIndexRecord[]; skipped: number }>`
  (Task 12 reuses it for the latest dispatch failure); the route.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-read-failures.test.ts
// Spec 025 A7, US5 scenario 3: failures in a window, newest first, from the failure index.
import { describe, expect, it } from "vitest";
import { failureIndexKey } from "../../packages/contracts/src/index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";

const failure = (endedAt: string, n: number, extra: Record<string, unknown> = {}) => {
  const operationId = `1111111${n}-1111-4111-8111-111111111111`;
  return {
    ...failureIndexKey(endedAt, operationId), entityType: "FAILURE_INDEX", operationId, workspaceId: "22222222-2222-4222-8222-222222222222",
    project: "payments", origin: "slack", requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, kind: "task",
    status: "FAILED", category: "task_failed", error: "npm test exited 1", endedAt, thread: "T0BSHLLUGBD/C0123456789/1695500000.000100", ...extra,
  };
};

describe("GET /v1/admin/failures (FR-038, A7)", () => {
  it("answers the last 24 hours by default, newest first, across two days, with each field US5 names", async () => {
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const { db, admin } = await createAdminReadBroker();
    for (const entry of [failure(at(1), 1), failure(at(20), 2, { origin: "ai_tool", category: "setup_failed", kind: "prepare", taskId: "33333333-3333-4333-8333-333333333333" }), failure(at(30), 3)]) db.set(entry);
    const answer = await admin("GET", "/v1/admin/failures");
    expect(answer.status).toBe(200);
    const failures = answer.body.failures as Array<Record<string, unknown>>;
    expect(failures.map((entry) => entry.endedAt)).toEqual([at(1), at(20)]);
    expect(failures[1]).toEqual({
      operationId: "11111112-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", project: "payments",
      origin: "ai_tool", requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, kind: "prepare", status: "FAILED",
      category: "setup_failed", error: "npm test exited 1", endedAt: at(20), thread: "T0BSHLLUGBD/C0123456789/1695500000.000100",
      taskId: "33333333-3333-4333-8333-333333333333",
    });
    expect(failures[0]).not.toHaveProperty("pk");
  });

  it("filters by project and window, and honours limit", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set(failure("2026-09-30T08:00:00.000Z", 1));
    db.set(failure("2026-09-30T09:00:00.000Z", 2, { project: "ledger" }));
    db.set(failure("2026-09-30T10:00:00.000Z", 3));
    const window = "since=2026-09-30T00:00:00.000Z&until=2026-09-30T23:00:00.000Z";
    expect((await admin("GET", `/v1/admin/failures?${window}&project=payments`)).body.failures).toHaveLength(2);
    expect(((await admin("GET", `/v1/admin/failures?${window}&limit=1`)).body.failures as Array<{ endedAt: string }>)[0]?.endedAt).toBe("2026-09-30T10:00:00.000Z");
  });

  it("refuses a window over 30 days, since after until, a bad limit and a bad project", async () => {
    const { admin } = await createAdminReadBroker();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    for (const query of [`since=${old}`, "since=2026-09-30T10:00:00.000Z&until=2026-09-30T09:00:00.000Z", "limit=0", "limit=101", "project=%3Cscript%3E", "since=yesterday"]) {
      expect((await admin("GET", `/v1/admin/failures?${query}`)).body.error, query).toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("never shows an item past its indexExpiresAt, which TTL deletes up to 48 hours late (A6)", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...failure(at, 1), indexExpiresAt: Math.floor(Date.now() / 1000) - 1 });
    expect((await admin("GET", "/v1/admin/failures")).body.failures).toEqual([]);
  });

  it("leaves out an item that no longer parses, and counts it", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...failure(at, 1), category: "cosmic_rays" });
    expect((await admin("GET", "/v1/admin/failures")).body).toMatchObject({ failures: [], skipped: 1 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-read-failures.test.ts`
Expected: FAIL: the route answers the catch-all `FORBIDDEN`.

- [ ] **Step 3: Add the route**

In `packages/broker/src/aws/admin-reads.ts`, import `INDEX_EXPIRY_ATTRIBUTE`,
`ADMIN_FAILURES_DEFAULT_HOURS`, `ADMIN_FAILURES_DEFAULT_LIMIT`, `ADMIN_INDEX_RETENTION_DAYS`, `ADMIN_LIST_MAX`, `AgentXNameSchema`,
`FailureIndexRecordSchema`, `type AdminFailuresResponse` and `type FailureIndexRecord`, and add:

```ts
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const STORAGE_KEYS = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);
/** A6: DynamoDB's TTL deletes up to 48 hours late; an item past its expiry is never shown. */
const expired = (deps: AdminReadDependencies, item: Record<string, unknown>) => typeof item[INDEX_EXPIRY_ATTRIBUTE] === "number" && (item[INDEX_EXPIRY_ATTRIBUTE] as number) <= Math.floor(deps.now() / 1000);
const withoutKeys = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key)));

function timeParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) throw agentXError("CONFIG_INVALID", `${name} must be an ISO 8601 time such as 2026-09-30T00:00:00.000Z`);
  return Date.parse(value);
}

/** A window within the index's 30 days: `since` defaults to `defaultHours` before `until`. */
export function timeWindow(url: URL, now: number, defaultHours: number): { since: string; until: string } {
  const until = timeParam(url, "until", now);
  const since = timeParam(url, "since", until - defaultHours * HOUR_MS);
  if (since > until) throw agentXError("CONFIG_INVALID", "since must be before until");
  if (since < now - ADMIN_INDEX_RETENTION_DAYS * DAY_MS) throw agentXError("CONFIG_INVALID", "AgentX keeps these records 30 days; ask for at most the last 30 days");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function listLimit(url: URL, fallback: number): number {
  const value = url.searchParams.get("limit");
  if (value === null) return fallback;
  if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > ADMIN_LIST_MAX) throw agentXError("CONFIG_INVALID", "limit must be a whole number from 1 to 100");
  return Number(value);
}

function projectParam(url: URL): string | undefined {
  const value = url.searchParams.get("project");
  if (value === null) return undefined;
  // Never echoed: a name that is not a project name could be long or carry markup.
  if (!AgentXNameSchema.safeParse(value).success) throw agentXError("CONFIG_INVALID", "project must be an AgentX project name");
  return value;
}

/** A7: day partition by day, newest first, until `limit`; an unreadable item is counted, not shown. */
export async function readFailures(deps: AdminReadDependencies, window: { since: string; until: string }, options: { limit: number; project?: string; category?: string }): Promise<{ failures: FailureIndexRecord[]; skipped: number }> {
  const failures: FailureIndexRecord[] = [];
  let skipped = 0;
  for (let day = Date.parse(window.until.slice(0, 10)); day >= Date.parse(window.since.slice(0, 10)) && failures.length < options.limit; day -= DAY_MS) {
    const pk = `FAILURE#${new Date(day).toISOString().slice(0, 10)}`;
    let start: Record<string, unknown> | undefined;
    do {
      const filters = [...(options.project === undefined ? [] : ["#project = :project"]), ...(options.category === undefined ? [] : ["category = :category"])];
      const page = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
        ExpressionAttributeValues: {
          ":pk": pk, ":low": window.since, ":high": `${window.until}\uffff`,
          ...(options.project === undefined ? {} : { ":project": options.project }),
          ...(options.category === undefined ? {} : { ":category": options.category }),
        },
        ...(options.project === undefined ? {} : { ExpressionAttributeNames: { "#project": "project" } }),
        ...(filters.length === 0 ? {} : { FilterExpression: filters.join(" AND ") }),
        ScanIndexForward: false,
        Limit: ADMIN_LIST_MAX,
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (expired(deps, item)) continue;
        const parsed = FailureIndexRecordSchema.safeParse(withoutKeys(item));
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        if (failures.length < options.limit) failures.push(parsed.data);
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined && failures.length < options.limit);
  }
  if (skipped > 0) deps.log({ event: "admin.failure_index_unreadable", count: skipped });
  return { failures, skipped };
}

async function listFailures(deps: AdminReadDependencies, url: URL): Promise<AdminFailuresResponse> {
  const window = timeWindow(url, deps.now(), ADMIN_FAILURES_DEFAULT_HOURS);
  const project = projectParam(url);
  const { failures, skipped } = await readFailures(deps, window, { limit: listLimit(url, ADMIN_FAILURES_DEFAULT_LIMIT), ...(project === undefined ? {} : { project }) });
  return { failures, ...window, ...(skipped > 0 ? { skipped } : {}) };
}
```

and add `"/v1/admin/failures": (deps, _identity, url) => listFailures(deps, url),` to `ADMIN_READS`.
The window's default `since` is 24 hours before `until`, so the refusal "at most the last 30 days"
only fires when a caller asks for older records.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-read-failures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-reads.ts tests/contract/admin-read-failures.test.ts
git commit -m "feat(broker): GET /v1/admin/failures from the failure index (spec 025 phase 25d)"
```

---

### Task 7: Filters on `GET /v1/admin/turns`

A8, and 25c's carry-over (the `task_id` filter lists the task's channel turns too).

**Files:**
- Modify: `packages/broker/src/aws/turns.ts`
- Test: `tests/contract/turn-export-filters.test.ts`

**Interfaces:**
- Consumes: `ADMIN_TURN_FILTER_PAGES`, `ADMIN_LIST_MAX` (Task 1); `AgentXNameSchema`,
  `parseSlackThreadSubject` (contracts).
- Produces:
  - `export interface TurnFilter { origin?: "slack" | "ai_tool"; thread?: string; task?: string }`;
  - `TurnRecordSource.page`'s input gains optional `until?: string` and `filter?: TurnFilter`,
    sent only when the caller asked for them;
  - `TurnRecordExport.page` accepts `until`, `origin`, `project`, `thread`, `task` and `limit`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/turn-export-filters.test.ts
// Spec 025 A8: GET /v1/admin/turns filters by time, origin, project, thread and task.
import { describe, expect, it, vi } from "vitest";
import { EMPTY_TURN_OBSERVATION } from "../../packages/contracts/src/turns.js";
import { TurnRecordExport, dynamoTurnRecordSource, type TurnRecordSource } from "../../packages/broker/src/aws/turns.js";

const now = Date.parse("2026-09-30T12:00:00.000Z");
const TASK = "33333333-3333-4333-8333-333333333333";
const SUBJECT = "T0BSHLLUGBD/C0123456789/1695500000.000100";
const slack = (eventId: string, receivedAt: string, extra: Record<string, unknown> = {}) => ({
  ...EMPTY_TURN_OBSERVATION, pk: `THREAD#${SUBJECT}`, sk: `TURN#${receivedAt}#${eventId}`, exportPk: "TURNS", exportSk: `${receivedAt}#${eventId}`,
  expiresAt: Math.floor(now / 1000) + 86_400, eventId, subject: SUBJECT, receivedAt, requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" },
  disposition: "answered", startedAt: receivedAt, finishedAt: receivedAt, durationMs: 0, requestText: "run the linter", responseText: "done", ...extra,
});

describe("the admin turn filters (A8)", () => {
  it("sends the export's own query unchanged when no filter is asked for", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    await new TurnRecordExport({ source: { page }, projectOf: async () => "payments", now: () => now }).page(new URLSearchParams({ since: "2026-09-29T00:00:00Z" }));
    expect(page).toHaveBeenCalledWith({ since: "2026-09-29T00:00:00.000Z", limit: 100, nowSeconds: now / 1000 });
  });

  it("passes until, origin, thread and task to the source, and a smaller limit", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    const turns = new TurnRecordExport({ source: { page }, projectOf: async () => "payments", now: () => now });
    await turns.page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", until: "2026-09-30T00:00:00Z", origin: "ai_tool", task: TASK, limit: "5" }));
    expect(page).toHaveBeenCalledWith({ since: "2026-09-29T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z", limit: 5, nowSeconds: now / 1000, filter: { origin: "ai_tool", task: TASK } });
  });

  it("matches a task's AI-tool records and its channel turns, and stops after ten pages", async () => {
    const channelTurn = slack("EvCHAN000001", "2026-09-30T10:00:00.000Z", { taskId: TASK });
    let calls = 0;
    const page = vi.fn<TurnRecordSource["page"]>(async () => {
      calls += 1;
      return { items: calls === 2 ? [channelTurn] : [], lastEvaluatedKey: { pk: channelTurn.pk, sk: channelTurn.sk, exportPk: "TURNS", exportSk: channelTurn.exportSk } };
    });
    const answer = await new TurnRecordExport({ source: { page }, projectOf: async () => "payments", now: () => now }).page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", task: TASK, limit: "3" }));
    expect(page).toHaveBeenCalledTimes(10);
    expect(answer.turns).toHaveLength(1);
    expect(answer.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("filters by project after the workspace lookup", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [slack("EvONE0000001", "2026-09-30T10:00:00.000Z", { workspaceId }), slack("EvTWO0000002", "2026-09-30T09:00:00.000Z")] }));
    const answer = await new TurnRecordExport({ source: { page }, projectOf: async () => "ledger", now: () => now }).page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", project: "ledger" }));
    expect(answer.turns.map((turn) => (turn as { eventId?: string }).eventId)).toEqual(["EvONE0000001"]);
  });

  it("refuses a malformed filter, and a cursor past until", async () => {
    const turns = new TurnRecordExport({ source: { page: async () => ({ items: [] }) }, projectOf: async () => undefined, now: () => now });
    for (const query of [{ origin: "email" }, { task: "nope" }, { thread: "C0123/nope" }, { limit: "0" }, { project: "<b>" }, { until: "2026-09-28T00:00:00Z" }]) {
      await expect(turns.page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", ...query })), JSON.stringify(query)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    const late = Buffer.from(JSON.stringify({ pk: `THREAD#${SUBJECT}`, sk: "TURN#2026-09-30T11:00:00.000Z#EvX", exportPk: "TURNS", exportSk: "2026-09-30T11:00:00.000Z#EvX" })).toString("base64url");
    await expect(turns.page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", until: "2026-09-30T10:00:00Z", cursor: late }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("builds the byTime query with BETWEEN and filter expressions", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    await dynamoTurnRecordSource({ send } as never, "turns").page({ since: "2026-09-29T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z", limit: 50, nowSeconds: 5, filter: { origin: "slack", thread: SUBJECT, task: TASK } });
    expect((send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input).toMatchObject({
      IndexName: "byTime",
      KeyConditionExpression: "exportPk = :partition AND exportSk BETWEEN :since AND :until",
      FilterExpression: "expiresAt > :now AND (attribute_not_exists(origin) OR origin = :origin) AND subject = :subject AND taskId = :task",
      ExpressionAttributeValues: { ":partition": "TURNS", ":since": "2026-09-29T00:00:00.000Z", ":until": "2026-09-30T00:00:00.000Z\uffff", ":now": 5, ":origin": "slack", ":subject": SUBJECT, ":task": TASK },
      Limit: 50,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/turn-export-filters.test.ts`
Expected: FAIL: the filters are ignored, and the second test's `page` is called without them.

- [ ] **Step 3: Extend the source**

In `packages/broker/src/aws/turns.ts`:

```ts
/** Spec 025 A8: the filters an admin read may ask for. */
export interface TurnFilter { origin?: "slack" | "ai_tool"; thread?: string; task?: string }
```

and in `TurnRecordSource.page`'s input add `until?: string; filter?: TurnFilter;`. In
`dynamoTurnRecordSource`, build the query from them:

```ts
    async page(input) {
      const filters = ["expiresAt > :now"];
      const values: Record<string, unknown> = { ":partition": TURN_EXPORT_PARTITION, ":since": input.since, ":now": input.nowSeconds };
      if (input.until !== undefined) values[":until"] = `${input.until}\uffff`;
      if (input.filter?.origin !== undefined) {
        // A Slack record written before spec 025 has no origin at all.
        filters.push(input.filter.origin === "slack" ? "(attribute_not_exists(origin) OR origin = :origin)" : "origin = :origin");
        values[":origin"] = input.filter.origin;
      }
      if (input.filter?.thread !== undefined) { filters.push("subject = :subject"); values[":subject"] = input.filter.thread; }
      // FR-037 and 25c's C13: AI-tool records and teammates' channel turns both carry taskId.
      if (input.filter?.task !== undefined) { filters.push("taskId = :task"); values[":task"] = input.filter.task; }
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: "byTime",
        KeyConditionExpression: input.until === undefined ? "exportPk = :partition AND exportSk >= :since" : "exportPk = :partition AND exportSk BETWEEN :since AND :until",
        // DynamoDB deletes expired items up to 48 hours late; never return one.
        FilterExpression: filters.join(" AND "),
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: input.limit,
        ...(input.exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: input.exclusiveStartKey }),
      }));
      // (the LastEvaluatedKey handling below is unchanged)
```

With no `until` and no filter this builds exactly today's query (the existing
`tests/contract/turn-export.test.ts` cases that inspect it still pass).

- [ ] **Step 4: Parse and apply the filters in the export**

In `TurnRecordExport.page`, after `since` is parsed, read the new parameters:

```ts
    const untilText = query.get("until");
    if (untilText !== null && !validTime(untilText)) throw agentXError("CONFIG_INVALID", "until must be an ISO 8601 time such as 2026-09-30T00:00:00.000Z");
    const until = untilText === null ? undefined : new Date(untilText).toISOString();
    if (until !== undefined && until < since) throw agentXError("CONFIG_INVALID", "until must be after since");
    const filter = turnFilter(query);
    const project = query.get("project");
    if (project !== null && !AgentXNameSchema.safeParse(project).success) throw agentXError("CONFIG_INVALID", "project must be an AgentX project name");
    const limitText = query.get("limit");
    if (limitText !== null && (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > ADMIN_LIST_MAX)) throw agentXError("CONFIG_INVALID", "limit must be a whole number from 1 to 100");
    const limit = limitText === null ? TURN_EXPORT_PAGE : Number(limitText);
    const filtered = filter !== undefined || project !== null;
```

with, at module level:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function turnFilter(query: URLSearchParams): TurnFilter | undefined {
  const origin = query.get("origin");
  const thread = query.get("thread");
  const task = query.get("task");
  if (origin !== null && origin !== "slack" && origin !== "ai_tool") throw agentXError("CONFIG_INVALID", "origin must be slack or ai_tool");
  if (thread !== null) {
    try { parseSlackThreadSubject(thread); } catch { throw agentXError("CONFIG_INVALID", "thread must be a thread subject such as T0123456789/C0123456789/1695500000.000100"); }
  }
  if (task !== null && !UUID.test(task)) throw agentXError("CONFIG_INVALID", "task must be a task ID");
  const filter: TurnFilter = { ...(origin === null ? {} : { origin }), ...(thread === null ? {} : { thread }), ...(task === null ? {} : { task }) };
  return Object.keys(filter).length === 0 ? undefined : filter;
}
```

Then replace the single `source.page(...)` call with a bounded loop: without a filter it runs once,
exactly as today; with one it reads on while fewer than `limit` records matched, a
`lastEvaluatedKey` remains, and fewer than `ADMIN_TURN_FILTER_PAGES` pages were read:

```ts
    const items: Record<string, unknown>[] = [];
    let lastEvaluatedKey: TurnRecordStartKey | undefined = exclusiveStartKey;
    let reads = 0;
    do {
      page = await this.options.source.page({
        since, ...(until === undefined ? {} : { until }), limit, nowSeconds,
        ...(lastEvaluatedKey === undefined ? {} : { exclusiveStartKey: lastEvaluatedKey }),
        ...(filter === undefined ? {} : { filter }),
      });
      items.push(...page.items);
      lastEvaluatedKey = page.lastEvaluatedKey;
      reads += 1;
    } while (filtered && lastEvaluatedKey !== undefined && items.length < limit && reads < ADMIN_TURN_FILTER_PAGES);
```

(keep the existing `try` around it, with its `turn_record.read_failed` log and refusal), and use
`items` and `lastEvaluatedKey` where the code read `page.items` and `page.lastEvaluatedKey`. After
the project lookup, drop a record whose looked-up project differs from `project` when one was
asked for (a record with no workspace has no project and is dropped too); when more than `limit`
records remain, keep the first `limit` and hand out the cursor of the last one kept, as the
existing size cut does. The key order of the call to `source.page` puts `until` before `limit`,
matching the second test's `toHaveBeenCalledWith` (object key order does not matter to `toEqual`,
but keep it readable).

Finally, pass `until` to the cursor check: `decodeCursor(cursor, since, until)` and
`acceptableCursor(next, since, until)`, and in `parseCursor` add, after the `since` check:
`if (until !== undefined && key.exportSk > \`${until}\uffff\`) return undefined;`.

Import `ADMIN_LIST_MAX`, `ADMIN_TURN_FILTER_PAGES`, `AgentXNameSchema` and
`parseSlackThreadSubject` from `@agentx/contracts`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/turn-export-filters.test.ts tests/contract/turn-export.test.ts tests/contract/turns-cli.test.ts`
Expected: PASS. `turn-export.test.ts` and `turns-cli.test.ts` are unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/turns.ts tests/contract/turn-export-filters.test.ts
git commit -m "feat(broker): time, origin, project, thread and task filters on the admin turn export (spec 025 phase 25d)"
```

---

### Task 8: `GET /v1/admin/usage`

A9. **Depends on Q6** (what counts as usage).

**Files:**
- Modify: `packages/broker/src/aws/admin-reads.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`adminReadDependencies` passes the turn source)
- Test: `tests/contract/admin-read-usage.test.ts`

**Interfaces:**
- Consumes: `timeWindow` (Task 6); `UsageIndexRecordSchema`, `AdminUsageGroupBySchema`,
  `ADMIN_USAGE_READ_MAX` (Task 1); `TurnRecordSource`, `dynamoTurnRecordSource` (turns.ts, Task 7);
  `TaskUsageTelemetrySchema` (contracts).
- Produces: `AdminReadDependencies.turns?: TurnRecordSource` (add the field); the route.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-read-usage.test.ts
// Spec 025 A9: usage per project, requester, origin or day, from worker usage items and Slack turn records.
import { describe, expect, it } from "vitest";
import { EMPTY_TURN_OBSERVATION, usageIndexKey } from "../../packages/contracts/src/index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const usage = (at: string, n: number, extra: Record<string, unknown> = {}) => {
  const operationId = `1111111${n}-1111-4111-8111-111111111111`;
  return {
    ...usageIndexKey(at, operationId), entityType: "USAGE_INDEX", operationId, workspaceId: WORKSPACE, project: "payments", origin: "slack",
    requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, at, durationMs: 60_000, inputTokens: 1_000, outputTokens: 100, costUsd: 0.5, ...extra,
  };
};
const turn = (receivedAt: string, eventId: string, withUsage: boolean) => ({
  ...EMPTY_TURN_OBSERVATION, pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000100", sk: `TURN#${receivedAt}#${eventId}`, exportPk: "TURNS", exportSk: `${receivedAt}#${eventId}`,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400, eventId, subject: "T0BSHLLUGBD/C0123456789/1695500000.000100", receivedAt,
  requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, workspaceId: WORKSPACE, disposition: "answered", startedAt: receivedAt, finishedAt: receivedAt,
  durationMs: 10, requestText: "hi", responseText: "hello",
  ...(withUsage ? { usage: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "bedrock", modelId: "m", cacheRetention: "short", tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55 }, cacheReadRatio: 0, costUsd: 0.01 } } : {}),
});

describe("GET /v1/admin/usage (FR-030, A9)", () => {
  it("adds up worker tasks and Slack turns per project", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    // The Slack turns name this workspace; its record gives them their project.
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments" });
    db.set(usage(at(1), 1));
    db.set(usage(at(2), 2, { costUsd: null }));
    db.set(usage(at(3), 3, { project: "ledger", origin: "ai_tool", requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" } }));
    db.set(turn(at(1), "EvTURN000001", true));
    db.set(turn(at(2), "EvTURN000002", false));
    const answer = await admin("GET", `/v1/admin/usage?group_by=project&since=${encodeURIComponent(at(24))}`);
    expect(answer.body.groups).toEqual([
      { key: "payments", turns: 2, tasks: 2, taskDurationMs: 120_000, inputTokens: 2_050, outputTokens: 205, costUsd: 0.51, costUnknown: 1 },
      { key: "ledger", turns: 0, tasks: 1, taskDurationMs: 60_000, inputTokens: 1_000, outputTokens: 100, costUsd: 0.5, costUnknown: 0 },
    ]);
    expect(answer.body.truncated).toBe(false);
  });

  it("groups by requester, origin and day", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set(usage(at, 1));
    db.set(usage(at, 2, { origin: "ai_tool", requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" } }));
    const keys = async (groupBy: string) => ((await admin("GET", `/v1/admin/usage?group_by=${groupBy}`)).body.groups as Array<{ key: string }>).map((group) => group.key).sort();
    expect(await keys("requester")).toEqual(["developer:Maya Chen", "slack:U0PRIYA001"]);
    expect(await keys("origin")).toEqual(["ai_tool", "slack"]);
    expect(await keys("day")).toEqual([at.slice(0, 10)]);
  });

  it("needs group_by, and refuses an unknown one", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("GET", "/v1/admin/usage")).body.error).toEqual({ code: "CONFIG_INVALID", message: "group_by must be project, requester, origin or day" });
    expect((await admin("GET", "/v1/admin/usage?group_by=model")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
```

The turn records sit in the same fake table as the State table (the fake ignores `TableName`), so
the broker's `dynamoTurnRecordSource` reads them through Task 2's index range support.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-read-usage.test.ts`
Expected: FAIL: the route answers the catch-all `FORBIDDEN`.

- [ ] **Step 3: Add the route**

In `packages/broker/src/aws/admin-reads.ts`, add `turns?: TurnRecordSource;` to
`AdminReadDependencies` (import the type from `./turns.js`), import `ADMIN_USAGE_READ_MAX`,
`AdminUsageGroupBySchema`, `UsageIndexRecordSchema`, `TaskUsageTelemetrySchema` and
`type AdminUsageResponse`, `type AdminUsageGroupBy`, and add:

```ts
interface UsageEntry { project: string; origin: string; requester: string; day: string; turn: boolean; task: boolean; durationMs: number; input: number; output: number; cost: number | null }

const requesterKey = (value: unknown): string => {
  const requester = value as { kind?: string; userId?: string; developerId?: string; name?: string } | undefined;
  if (requester?.kind === "slack" || (requester?.kind === undefined && typeof requester?.userId === "string")) return `slack:${requester.userId}`;
  if (requester?.kind === "developer") return `developer:${requester.name ?? requester.developerId?.slice(0, 12) ?? "unknown"}`;
  return "none";
};

async function usageEntries(deps: AdminReadDependencies, window: { since: string; until: string }): Promise<{ entries: UsageEntry[]; truncated: boolean }> {
  const entries: UsageEntry[] = [];
  let truncated = false;
  let tasks = 0;
  for (let day = Date.parse(window.since.slice(0, 10)); day <= Date.parse(window.until.slice(0, 10)); day += DAY_MS) {
    let start: Record<string, unknown> | undefined;
    do {
      const page = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
        ExpressionAttributeValues: { ":pk": `USAGE#${new Date(day).toISOString().slice(0, 10)}`, ":low": window.since, ":high": `${window.until}\uffff` },
        Limit: ADMIN_LIST_MAX, ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (expired(deps, item)) continue;
        const parsed = UsageIndexRecordSchema.safeParse(withoutKeys(item));
        if (!parsed.success) continue;
        const usage = parsed.data;
        entries.push({ project: usage.project, origin: usage.origin, requester: requesterKey(usage.requester), day: usage.at.slice(0, 10), turn: false, task: true, durationMs: usage.durationMs, input: usage.inputTokens, output: usage.outputTokens, cost: usage.costUsd });
        tasks += 1;
      }
      start = page.LastEvaluatedKey;
      if (tasks >= ADMIN_USAGE_READ_MAX) { truncated = start !== undefined; start = undefined; }
    } while (start !== undefined);
  }
  if (deps.turns !== undefined) {
    const projects = new Map<string, string | undefined>();
    let key: Parameters<TurnRecordSource["page"]>[0]["exclusiveStartKey"];
    let turns = 0;
    do {
      const page = await deps.turns.page({ since: window.since, until: window.until, limit: ADMIN_LIST_MAX, nowSeconds: Math.floor(deps.now() / 1000), ...(key === undefined ? {} : { exclusiveStartKey: key }), filter: { origin: "slack" } });
      for (const item of page.items) {
        const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId : undefined;
        if (workspaceId !== undefined && !projects.has(workspaceId)) {
          const workspace = await getStateItem(deps, { pk: `WORKSPACE#${workspaceId}`, sk: "META" });
          projects.set(workspaceId, typeof workspace?.projectName === "string" ? workspace.projectName : undefined);
        }
        const telemetry = TaskUsageTelemetrySchema.safeParse(item.usage);
        entries.push({
          project: (workspaceId === undefined ? undefined : projects.get(workspaceId)) ?? "unknown", origin: "slack", requester: requesterKey(item.requestedBy),
          day: String(item.receivedAt).slice(0, 10), turn: true, task: false, durationMs: 0,
          input: telemetry.success ? telemetry.data.tokens.input : 0, output: telemetry.success ? telemetry.data.tokens.output : 0,
          cost: telemetry.success ? telemetry.data.costUsd : 0,
        });
        turns += 1;
      }
      key = page.lastEvaluatedKey;
      if (turns >= ADMIN_USAGE_READ_MAX) { truncated = truncated || key !== undefined; key = undefined; }
    } while (key !== undefined);
  }
  return { entries, truncated };
}

async function usageSummary(deps: AdminReadDependencies, url: URL): Promise<AdminUsageResponse> {
  const groupBy = AdminUsageGroupBySchema.safeParse(url.searchParams.get("group_by"));
  if (!groupBy.success) throw agentXError("CONFIG_INVALID", "group_by must be project, requester, origin or day");
  const window = timeWindow(url, deps.now(), 24 * 7);
  const { entries, truncated } = await usageEntries(deps, window);
  const groups = new Map<string, AdminUsageResponse["groups"][number]>();
  for (const entry of entries) {
    const key = entry[groupBy.data as AdminUsageGroupBy];
    const group = groups.get(key) ?? { key, turns: 0, tasks: 0, taskDurationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: 0 };
    group.turns += entry.turn ? 1 : 0;
    group.tasks += entry.task ? 1 : 0;
    group.taskDurationMs += entry.durationMs;
    group.inputTokens += entry.input;
    group.outputTokens += entry.output;
    if (entry.cost === null) group.costUnknown += 1;
    else group.costUsd = Math.round((group.costUsd + entry.cost) * 1e6) / 1e6;
    groups.set(key, group);
  }
  // The costliest first, then by key, so the answer reads the same each time.
  const sorted = [...groups.values()].sort((left, right) => right.costUsd - left.costUsd || left.key.localeCompare(right.key));
  return { groupBy: groupBy.data, ...window, groups: sorted, truncated };
}
```

Add `"/v1/admin/usage": (deps, _identity, url) => usageSummary(deps, url),` to `ADMIN_READS`. The
default window for usage is the last 7 days (`since` defaults to 7 days before `until`), within the
30-day limit.

In `adminReadDependencies` (broker.ts) add
`...(dependencies.turnRecordsTableName === undefined ? {} : { turns: dynamoTurnRecordSource(dependencies.documentClient, dependencies.turnRecordsTableName) }),`.
The broker already may `Query` the TurnRecords table and its `byTime` index (control-plane.ts).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-read-usage.test.ts`
Expected: PASS. In the first test, payments has two worker items (0.5 and an unknown cost) and two
Slack turns (one with 0.01 of orchestrator cost), so `costUsd` is 0.51 and `costUnknown` 1.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-reads.ts packages/broker/src/aws/broker.ts tests/contract/admin-read-usage.test.ts
git commit -m "feat(broker): GET /v1/admin/usage from worker usage items and Slack turn records (spec 025 phase 25d)"
```

---

### Task 9: `GET /v1/admin/workspaces`

A10, and the limits of FR-053 as the broker reads them.

**Files:**
- Modify: `packages/broker/src/aws/admin-reads.ts`
- Test: `tests/contract/admin-read-workspaces.test.ts`

**Interfaces:**
- Consumes: `adminProjectNames`, `listLimit`, `getStateItem` (Tasks 2, 6); `readWorkspaceLimits`
  (`packages/broker/src/developer/limits.ts`); `WORKSPACE_PROJECT_INDEX`, `workspaceRecordFields`,
  `WorkspaceInstanceSchema`, `WorkspaceStatusSchema`, `parseSlackThreadSubject`, `slackThreadUrl`,
  `ADMIN_WORKSPACES_DEFAULT_LIMIT` (contracts); `taskPointerKey`, `taskKey` (task-records.ts).
- Produces: `export async function projectWorkspaceRows(deps: AdminReadDependencies, project: string, cap: number): Promise<{ rows: WorkspaceInstance[]; truncated: boolean }>`
  (Task 12 counts statuses with it); `export async function workspaceOwner(deps: AdminReadDependencies, workspace: WorkspaceInstance): Promise<{ origin: "slack" | "ai_tool"; owner: { threadUrl?: string; taskId?: string; developerName?: string } }>`
  (25e's stop plan reuses it); the route.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-read-workspaces.test.ts
// Spec 025 A10: workspaces by project and status, with their owners, the limits and the counts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

describe("GET /v1/admin/workspaces (FR-030, A10)", () => {
  it("lists a Slack thread's and a developer task's workspaces with their owners, and the limits", async () => {
    const harness = await createAdminReadBroker();
    await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000200`, "U0PRIYA001");
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const answer = await harness.admin("GET", "/v1/admin/workspaces");
    const rows = answer.body.workspaces as Array<{ origin: string; owner: Record<string, unknown>; status: string; busy: boolean }>;
    expect(rows.map((row) => row.origin).sort()).toEqual(["ai_tool", "slack"]);
    expect(rows.find((row) => row.origin === "ai_tool")?.owner).toEqual({ taskId, developerName: "Maya Chen" });
    expect(rows.find((row) => row.origin === "slack")?.owner).toEqual({ threadUrl: `https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000200` });
    expect(answer.body.limits).toEqual({ perPerson: 3, perOrganization: 20, source: "parameters" });
    expect(answer.body.counts).toMatchObject({ organization: 2 });
    expect(answer.body.truncated).toBe(false);
    // D22's privacy holds for admins' tool results too: no task title here.
    expect(JSON.stringify(answer.body)).not.toContain("Fix it");
  });

  it("reads the admin's limits setting when there is one (FR-053)", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 5, perOrganization: 40 });
    expect((await admin("GET", "/v1/admin/workspaces")).body.limits).toEqual({ perPerson: 5, perOrganization: 40, source: "setting" });
  });

  it("filters by project and status, leaves closed ones out by default, and honours limit", async () => {
    const harness = await createAdminReadBroker();
    for (const ts of ["1695500000.000301", "1695500000.000302", "1695500000.000303"]) await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`, "U0PRIYA001");
    const [first] = harness.db.find((item) => item.entityType === "WORKSPACE");
    harness.db.set({ ...first!, status: "CLOSED" });
    expect((await harness.admin("GET", "/v1/admin/workspaces")).body.workspaces).toHaveLength(2);
    expect((await harness.admin("GET", "/v1/admin/workspaces?status=CLOSED")).body.workspaces).toHaveLength(1);
    expect((await harness.admin("GET", "/v1/admin/workspaces?project=ledger")).body.workspaces).toEqual([]);
    expect((await harness.admin("GET", "/v1/admin/workspaces?limit=1")).body).toMatchObject({ truncated: true });
    expect((await harness.admin("GET", "/v1/admin/workspaces?status=ASLEEP")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
```

`ensureWorkspace` is the Slack harness's thread workspace call (`tests/support/slack-broker.ts`); it
charges the organization counter, as does the developer task start, hence `organization: 2`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-read-workspaces.test.ts`
Expected: FAIL: the route answers the catch-all `FORBIDDEN`.

- [ ] **Step 3: Add the route**

In `packages/broker/src/aws/admin-reads.ts`, import the names the Interfaces list, and add:

```ts
export async function projectWorkspaceRows(deps: AdminReadDependencies, project: string, cap: number): Promise<{ rows: WorkspaceInstance[]; truncated: boolean }> {
  const rows: WorkspaceInstance[] = [];
  let start: Record<string, unknown> | undefined;
  let truncated = false;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": project },
      ScanIndexForward: false,
      Limit: ADMIN_LIST_MAX,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
      if (parsed.success) rows.push(parsed.data);
      else deps.log({ event: "admin.workspace_unreadable", project });
    }
    start = page.LastEvaluatedKey;
    if (rows.length >= cap) { truncated = start !== undefined || rows.length > cap; start = undefined; }
  } while (start !== undefined);
  return { rows: rows.slice(0, cap), truncated };
}

/** A10: a task's ID and developer name, or a Slack thread's link; never a task's title (D22). */
export async function workspaceOwner(deps: AdminReadDependencies, workspace: WorkspaceInstance): Promise<{ origin: "slack" | "ai_tool"; owner: { threadUrl?: string; taskId?: string; developerName?: string } }> {
  const pointer = await getStateItem(deps, taskPointerKey(workspace.id));
  if (typeof pointer?.taskId === "string") {
    const task = await getStateItem(deps, taskKey(pointer.taskId));
    return { origin: "ai_tool", owner: { taskId: pointer.taskId, ...(typeof task?.developerName === "string" ? { developerName: task.developerName } : {}) } };
  }
  const thread = await getStateItem(deps, { pk: `SLACK_THREAD#${workspace.ownerKey}`, sk: "META" });
  if (typeof thread?.thread === "string") {
    try {
      return { origin: "slack", owner: { threadUrl: slackThreadUrl(parseSlackThreadSubject(thread.thread)) } };
    } catch {
      // An unreadable subject is shown as no owner, never echoed.
    }
  }
  return { origin: "slack", owner: {} };
}

const counterCount = async (deps: AdminReadDependencies, key: { pk: string; sk: string }): Promise<number> => {
  const count = (await getStateItem(deps, key))?.count;
  return typeof count === "number" && count >= 0 ? count : 0;
};

async function listWorkspaces(deps: AdminReadDependencies, identity: AuthenticatedIdentity, url: URL): Promise<AdminWorkspacesResponse> {
  const project = projectParam(url);
  const statusText = url.searchParams.get("status");
  const status = statusText === null ? undefined : WorkspaceStatusSchema.safeParse(statusText);
  if (status !== undefined && !status.success) throw agentXError("CONFIG_INVALID", `status must be one of ${WorkspaceStatusSchema.options.join(", ")}`);
  const limit = listLimit(url, ADMIN_WORKSPACES_DEFAULT_LIMIT);
  const projects = project === undefined ? await adminProjectNames(deps, identity) : [project];
  const found: WorkspaceInstance[] = [];
  let truncated = false;
  for (const name of projects) {
    const { rows, truncated: more } = await projectWorkspaceRows(deps, name, 1_000);
    truncated = truncated || more;
    found.push(...rows.filter((row) => (status === undefined ? row.status !== "CLOSED" : row.status === status.data)));
  }
  found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (found.length > limit) truncated = true;
  const workspaces: AdminWorkspacesResponse["workspaces"] = [];
  for (const workspace of found.slice(0, limit)) {
    const { origin, owner } = await workspaceOwner(deps, workspace);
    workspaces.push({ id: workspace.id, project: workspace.projectName, origin, owner, status: workspace.status, busy: workspace.activeOperationId !== null, lastActivityAt: workspace.updatedAt });
  }
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.limitDefaults, deps.log);
  const organization = deps.slackTeamId === undefined ? 0 : await counterCount(deps, { pk: `SLACK_LIMIT#${deps.slackTeamId}`, sk: "ORGANIZATION" });
  const developerOrganization = await counterCount(deps, { pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" });
  return {
    workspaces,
    limits: { perPerson: limits.member, perOrganization: limits.organization, source: limits.source },
    counts: { organization, ...(developerOrganization > 0 ? { developerOrganization } : {}) },
    truncated,
  };
}
```

and add `"/v1/admin/workspaces": (deps, identity, url) => listWorkspaces(deps, identity, url),` to
`ADMIN_READS`. The admin project names (A3) bound which projects are read; a caller can still name
any project with `project=`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-read-workspaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-reads.ts tests/contract/admin-read-workspaces.test.ts
git commit -m "feat(broker): GET /v1/admin/workspaces with owners, limits and counts (spec 025 phase 25d)"
```

---
### Task 10: DeveloperIdentity looks up a Slack user by email and checks its token

A11 to A13's Slack side, and A1's `adminApiVersion` in the environment's configuration. The broker
still never reads the Slack secret (D11): it invokes DeveloperIdentity, as for channel members.

**Files:**
- Modify: `packages/broker/src/developer/slack-directory.ts` (`authTest`)
- Modify: `packages/broker/src/developer/server.ts` (two invoke kinds; `adminApiVersion`)
- Modify: `packages/broker/src/aws/developer-identity.ts` (the handler's event type)
- Modify: `packages/broker/src/aws/developer-routes.ts` (two through-lambda helpers; two optional
  configuration fields)
- Modify: `packages/broker/src/aws/broker.ts` (`developerConfiguration()` wires them)
- Modify: `tests/support/slack-broker.ts`, `tests/support/developer-task-broker.ts` (pass-through
  options)
- Test: `tests/contract/developer-identity-admin-invokes.test.ts`
- Modify (expected constant): `tests/contract/developer-identity-server.test.ts` (the
  configuration's expected object gains `adminApiVersion: "1.0"`)

**Interfaces:**
- Consumes: `SlackUserByEmailRequestSchema`, `SlackAuthCheckRequestSchema` and their response types,
  `ADMIN_API_VERSION` (Task 1); `identityInvoke` (developer-routes.ts, module-private today).
- Produces:
  - `SlackDirectory.authTest(): Promise<SlackAuthCheckResponse>`;
  - `export function slackUserByEmailThroughLambda(invoke): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>`;
  - `export function slackAuthCheckThroughLambda(invoke): () => Promise<SlackAuthCheckResponse>`;
  - `DeveloperApiConfiguration.slackUserByEmail?` and `.slackAuthCheck?` with those types;
  - test support: `createBroker({ extra })` spreads `extra` into the broker input last;
    `createDeveloperTaskBroker({ developerExtra, brokerExtra })` spreads `developerExtra` into its
    `DeveloperApiConfiguration` and passes `brokerExtra` as `createBroker`'s `extra`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-identity-admin-invokes.test.ts
// Spec 025 A11 to A13: the broker asks DeveloperIdentity who owns an email, and whether the bot token works.
import { describe, expect, it, vi } from "vitest";
import { slackAuthCheckThroughLambda, slackUserByEmailThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { BOT_TOKEN, TEAM, fakeSlack, httpEvent, identityHarness, routeFetch } from "../support/developer-fakes.js";

const reply = (value: unknown) => ({ Payload: Buffer.from(JSON.stringify(value)) });

describe("DeveloperIdentity's email lookup and auth check (A12, A13)", () => {
  it("answers the Slack user of a verified email, nothing for an unknown one, and refuses a malformed request", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "ada@example.com" }] });
    expect(await harness.handler({ kind: "slack-user-by-email", email: "ada@example.com" } as never)).toEqual({ ok: true, userId: "U0ADA00001" });
    expect(await harness.handler({ kind: "slack-user-by-email", email: "nobody@example.com" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "slack-user-by-email", email: "not an email" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });

  it("checks the bot token with auth.test, and says when Slack refuses it, never naming the token", async () => {
    const slack = fakeSlack({ users: [] });
    const directory = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch: routeFetch(slack.handler), now: Date.now });
    expect(await directory.authTest()).toEqual({ ok: true, teamId: TEAM });
    const refused = slackDirectory({ teamId: TEAM, botToken: async () => "xoxb-revoked", fetch: routeFetch(slack.handler), now: Date.now });
    const answer = await refused.authTest();
    expect(answer).toEqual({ ok: false, error: "invalid_auth" });
    expect(JSON.stringify(answer)).not.toContain("xoxb-");
  });

  it("reports the environment's admin API version beside the developer one (A1)", async () => {
    const harness = identityHarness({});
    const answer = await harness.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"));
    expect(JSON.parse(answer.body)).toMatchObject({ apiVersion: "1.2", adminApiVersion: "1.0" });
  });

  it("goes through the broker's invoke helpers, failing closed as slack_unavailable", async () => {
    const byEmail = slackUserByEmailThroughLambda(vi.fn(async () => reply({ ok: true, userId: "U0ADA00001" })));
    expect(await byEmail({ kind: "slack-user-by-email", email: "ada@example.com" })).toEqual({ ok: true, userId: "U0ADA00001" });
    const broken = slackUserByEmailThroughLambda(vi.fn(async () => ({ FunctionError: "Unhandled" })));
    expect(await broken({ kind: "slack-user-by-email", email: "ada@example.com" })).toEqual({ ok: false, error: "slack_unavailable" });
    const check = slackAuthCheckThroughLambda(vi.fn(async () => reply({ ok: false, error: "token_revoked" })));
    expect(await check()).toEqual({ ok: false, error: "token_revoked" });
  });
});
```

`identityHarness`, `fakeSlack`, `httpEvent` and `routeFetch` are 25a's fakes
(`tests/support/developer-fakes.ts`); `fakeSlack` already answers `auth.test` with `team_id: TEAM`
for `BOT_TOKEN` and `invalid_auth` for any other token.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-identity-admin-invokes.test.ts`
Expected: FAIL: the invoke kinds are refused as `invalid_request` (they parse as channel-members
requests), `authTest` is not a function, and the configuration has no `adminApiVersion`.

- [ ] **Step 3: Add `authTest`**

In `slack-directory.ts`, add to the `SlackDirectory` interface
`/** A13: whether the bot token works, with the team Slack says it belongs to. Never the token. */ authTest(): Promise<SlackAuthCheckResponse>;`
and to the returned object:

```ts
    async authTest() {
      const reply = await get("auth.test", {});
      if (reply === undefined) return { ok: false, error: "slack_unavailable" };
      if (reply.body.ok !== true || typeof reply.body.team_id !== "string") {
        refused("auth.test", reply);
        return { ok: false, error: errorCode(reply.body.error) ?? "no_error_code" };
      }
      return { ok: true, teamId: reply.body.team_id };
    },
```

- [ ] **Step 4: Serve the two invoke kinds, and the admin version**

In `packages/broker/src/developer/server.ts`, in the handler's `if ("kind" in event)` block, before
the `channel-info` branch:

```ts
      if (event.kind === "slack-user-by-email") {
        const parsed = SlackUserByEmailRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const found = await deps.directory.lookupByEmail(parsed.data.email);
        if (found === "unavailable") return { ok: false, error: "slack_unavailable" };
        return found === "none" ? { ok: true } : { ok: true, userId: found.userId };
      }
      if (event.kind === "slack-auth-check") {
        if (!SlackAuthCheckRequestSchema.safeParse(event).success) return { ok: false, error: "invalid_request" };
        return deps.directory.authTest();
      }
```

widen the handler's event and result types with `SlackUserByEmailRequest | SlackAuthCheckRequest`
and `SlackUserByEmailResponse | SlackAuthCheckResponse` (and the same in
`packages/broker/src/aws/developer-identity.ts`'s `handler`), and add
`adminApiVersion: ADMIN_API_VERSION,` to `configuration()` after `apiVersion`.

In `tests/contract/developer-identity-server.test.ts`, the expected configuration object gains
`adminApiVersion: "1.0"` beside `apiVersion: "1.2"`: an additive expected constant (SC-008).

- [ ] **Step 5: The broker's invoke helpers**

In `packages/broker/src/aws/developer-routes.ts`, widen `identityInvoke`'s `request` parameter to
`ChannelMembersRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest`, and
add:

```ts
/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email");
}

/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<SlackAuthCheckResponse> {
  return async () => {
    let refusal: string | undefined;
    const answer = await identityInvoke(invoke, { kind: "slack-auth-check" }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && /^[a-z_]{1,64}$/.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check");
    if (answer.ok) return answer;
    return { ok: false, error: refusal ?? answer.error };
  };
}
```

and add to `DeveloperApiConfiguration`:

```ts
  /** Spec 025 A12: FR-012's email lookup, for an admin's Slack link. */
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  /** Spec 025 A13: the health route's Slack token check. */
  slackAuthCheck?: () => Promise<SlackAuthCheckResponse>;
```

In `developerConfiguration()` (broker.ts), add both, built on the same `InvokeCommand` as
`channelMembers`.

- [ ] **Step 6: The test support's pass-through options**

In `tests/support/slack-broker.ts`, add `extra?: Record<string, unknown>` to `createBroker`'s
options and spread `...options.extra` last in `brokerInput`. In
`tests/support/developer-task-broker.ts`, add `developerExtra?: Partial<DeveloperApiConfiguration>`
and `brokerExtra?: Record<string, unknown>` to `createDeveloperTaskBroker`'s options; spread
`...options.developerExtra` last in `developer`, and pass `extra: options.brokerExtra` to
`createBroker`. Every existing caller passes neither, so nothing else changes.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/developer-identity-admin-invokes.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-routes*.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/broker/src/developer packages/broker/src/aws/developer-identity.ts packages/broker/src/aws/developer-routes.ts packages/broker/src/aws/broker.ts tests/support tests/contract/developer-identity-admin-invokes.test.ts tests/contract/developer-identity-server.test.ts
git commit -m "feat(broker): DeveloperIdentity email lookup and Slack auth check invokes; admin API version (spec 025 phase 25d)"
```

---

### Task 11: `GET /v1/admin/me`

A12, and A11's private channel names for a member admin. **Depends on Q3** (how AgentX learns the
admin's email) and **Q7** (owner answer 2026-09-30: a private channel's name for an admin whose
linked Slack user is a member of it).

**Files:**
- Create: `packages/broker/src/aws/admin-me.ts`
- Modify: `packages/broker/src/aws/admin-reads.ts` (the `me` field's type; the route; `channelLabels`
  reveals a private name to a member admin)
- Modify: `packages/broker/src/aws/broker.ts` (the production `me` and `channelMembers` dependencies)
- Test: `tests/contract/admin-me.test.ts`; modify `tests/contract/admin-read-bindings.test.ts`

**Interfaces:**
- Consumes: `AdminMeResponse` (Task 1); `SlackUserByEmailRequest`, `SlackUserByEmailResponse`
  (Task 1); `AdminReadDependencies` (Task 2).
- Produces:
  - `export interface AdminMeDependencies { issuer: string; fetch: typeof fetch; slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>; cacheMs?: number; timeoutMs?: number }`
    (`AdminReadDependencies.me` takes this type);
  - `export function adminIdentityReader(deps: AdminMeDependencies & { now(): number; log(entry: Record<string, unknown>): void }): { profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<{ name?: string; email?: string }>; me(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<AdminMeResponse> }`
    (25e reads `profile` for the audit name and `me` for the Slack link);
  - `AdminReadDependencies.channelMembers?: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>`;
  - `channelLabels(deps, channelIds, options?: { reveal?: (privateIds: string[]) => Promise<ReadonlySet<string>> })`:
    a private channel's name is kept only for the IDs `reveal` answers.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-me.test.ts
// Spec 025 A12 (Q3): who the admin is, and whether their verified email matches a Slack user.
import { describe, expect, it, vi } from "vitest";
import { adminIdentityReader } from "../../packages/broker/src/aws/admin-me.js";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool";
const identity = (claims: Record<string, unknown> = {}) => ({ issuer: ISSUER, subject: "admin-subject", ownerKey: "o".repeat(64), isAdministrator: true, claims: { iss: ISSUER, sub: "admin-subject", ...claims } });

function idp(userinfo: Record<string, unknown> | "missing" | "slow") {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json(userinfo === "missing" ? { issuer: ISSUER } : { issuer: ISSUER, userinfo_endpoint: "https://agentx.auth.us-east-1.amazoncognito.com/oauth2/userInfo" });
    }
    if (userinfo === "slow") await new Promise((resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))); });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
    return Response.json(userinfo);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("GET /v1/admin/me (A12)", () => {
  it("reads a verified email from userinfo (Cognito's string \"true\") and links the Slack user", async () => {
    const { fetch } = idp({ sub: "admin-subject", email: "ada@example.com", email_verified: "true", name: "Ada" });
    const slackUserByEmail = vi.fn(async () => ({ ok: true as const, userId: "U0ADA00001" }));
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail, now: Date.now, log: vi.fn() });
    expect(await reader.me(identity(), "Bearer admin-token")).toEqual({
      issuer: ISSUER, subject: "admin-subject", name: "Ada", email: "ada@example.com", slack: { linked: true, userId: "U0ADA00001" },
    });
    expect(slackUserByEmail).toHaveBeenCalledWith({ kind: "slack-user-by-email", email: "ada@example.com" });
  });

  it("uses the token's own claims when it carries a verified email, without calling userinfo", async () => {
    const { fetch, calls } = idp({});
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail: async () => ({ ok: true }), now: Date.now, log: vi.fn() });
    expect(await reader.me(identity({ email: "ada@example.com", email_verified: true }), "Bearer admin-token")).toMatchObject({ email: "ada@example.com", slack: { linked: false, reason: "no_match" } });
    expect(calls).toEqual([]);
  });

  it("ignores an unverified email, and says so", async () => {
    const { fetch } = idp({ sub: "admin-subject", email: "ada@example.com", email_verified: false });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail: vi.fn(), now: Date.now, log: vi.fn() });
    const answer = await reader.me(identity(), "Bearer admin-token");
    expect(answer).not.toHaveProperty("email");
    expect(answer.slack).toEqual({ linked: false, reason: "no_email" });
  });

  it("answers without an email when userinfo is missing or slow", async () => {
    for (const shape of ["missing", "slow"] as const) {
      const { fetch } = idp(shape);
      const log = vi.fn();
      const started = Date.now();
      const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail: vi.fn(), now: Date.now, log, timeoutMs: 50 });
      expect(await reader.me(identity(), "Bearer admin-token")).toEqual({ issuer: ISSUER, subject: "admin-subject", slack: { linked: false, reason: "no_email" } });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(JSON.stringify(log.mock.calls)).not.toContain("admin-token");
    }
  });

  it("says not_set_up without the Slack lookup, and slack_unavailable when it fails", async () => {
    const verified = identity({ email: "ada@example.com", email_verified: true });
    const unset = adminIdentityReader({ issuer: ISSUER, fetch: idp({}).fetch, now: Date.now, log: vi.fn() });
    expect((await unset.me(verified, "Bearer admin-token")).slack).toEqual({ linked: false, reason: "not_set_up" });
    const down = adminIdentityReader({ issuer: ISSUER, fetch: idp({}).fetch, slackUserByEmail: async () => ({ ok: false, error: "slack_unavailable" }), now: Date.now, log: vi.fn() });
    expect((await down.me(verified, "Bearer admin-token")).slack).toEqual({ linked: false, reason: "slack_unavailable" });
  });

  it("keeps a profile for five minutes per token, and never keeps a failure", async () => {
    let now = 0;
    const { fetch, calls } = idp({ sub: "admin-subject", email: "ada@example.com", email_verified: true });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, now: () => now, log: vi.fn() });
    await reader.profile(identity(), "Bearer admin-token");
    await reader.profile(identity(), "Bearer admin-token");
    expect(calls.filter((url) => url.includes("userInfo"))).toHaveLength(1);
    now += 300_001;
    await reader.profile(identity(), "Bearer admin-token");
    expect(calls.filter((url) => url.includes("userInfo"))).toHaveLength(2);
  });
});
```

Add one route test to `tests/contract/admin-read-projects.test.ts`'s neighbour file
`tests/contract/admin-me.test.ts` (the same file) that goes through the broker:

```ts
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { issuer } from "../support/slack-broker.js";

describe("the route", () => {
  it("answers through GET /v1/admin/me, and refuses a non-admin", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => (String(input).endsWith("openid-configuration") ? Response.json({ issuer }) : Response.json({}))) as unknown as typeof globalThis.fetch;
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { me: { issuer, fetch } } } });
    expect((await admin("GET", "/v1/admin/me")).body).toEqual({ issuer, subject: "admin-subject", slack: { linked: false, reason: "no_email" } });
    expect((await admin("GET", "/v1/admin/me", { admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-me.test.ts`
Expected: FAIL: `admin-me.js` does not exist.

- [ ] **Step 3: Write the reader**

```ts
// packages/broker/src/aws/admin-me.ts
// Spec 025 A12 (Q3): who the signed-in admin is. The admin's access token (Cognito's in particular)
// often carries no email, so the issuer's userinfo endpoint is asked, with the admin's own token.
// Only a verified email counts. The token is never logged, and only a hash of it is kept as a key.
import { createHash } from "node:crypto";
import type { AdminMeResponse, SlackUserByEmailRequest, SlackUserByEmailResponse } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

export interface AdminMeDependencies {
  issuer: string;
  fetch: typeof fetch;
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  cacheMs?: number;
  timeoutMs?: number;
}
type Profile = { name?: string; email?: string };

const verified = (value: unknown) => value === true || value === "true";
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined);
const profileOf = (claims: Record<string, unknown>): Profile => {
  const email = verified(claims.email_verified) ? text(claims.email, 254) : undefined;
  const name = text(claims.name, 200) ?? email;
  return { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) };
};

export function adminIdentityReader(deps: AdminMeDependencies & { now(): number; log(entry: Record<string, unknown>): void }) {
  const cacheMs = deps.cacheMs ?? 300_000;
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const profiles = new Map<string, { at: number; profile: Profile }>();
  let userinfoEndpoint: Promise<string | undefined> | undefined;

  const getJson = async (url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
    } catch (error) {
      deps.log({ event: "admin.userinfo_failed", error: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  };
  const endpoint = (): Promise<string | undefined> => {
    userinfoEndpoint ??= getJson(`${deps.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).then((document) => {
      const value = document?.userinfo_endpoint;
      const found = typeof value === "string" && value.startsWith("https://") ? value : undefined;
      // A failed discovery is tried again next time; a document without the endpoint is kept.
      if (document === undefined) userinfoEndpoint = undefined;
      return found;
    });
    return userinfoEndpoint;
  };

  async function profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<Profile> {
    const own = profileOf(identity.claims as Record<string, unknown>);
    if (own.email !== undefined || authorization === undefined || !/^Bearer \S+$/.test(authorization)) return own;
    const key = createHash("sha256").update(authorization).digest("hex");
    const cached = profiles.get(key);
    if (cached !== undefined && deps.now() - cached.at < cacheMs) return cached.profile;
    const url = await endpoint();
    if (url === undefined) return own;
    const claims = await getJson(url, { authorization });
    // userinfo's sub must be the token's own; a mismatch is ignored rather than trusted.
    if (claims === undefined || claims.sub !== identity.subject) return own;
    const found = { ...own, ...profileOf(claims) };
    if (profiles.size >= 500) profiles.delete(profiles.keys().next().value as string);
    profiles.set(key, { at: deps.now(), profile: found });
    return found;
  }

  async function me(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<AdminMeResponse> {
    const found = await profile(identity, authorization);
    const base = { issuer: identity.issuer, subject: identity.subject, ...found };
    if (found.email === undefined) return { ...base, slack: { linked: false, reason: "no_email" } };
    if (deps.slackUserByEmail === undefined) return { ...base, slack: { linked: false, reason: "not_set_up" } };
    const answer = await deps.slackUserByEmail({ kind: "slack-user-by-email", email: found.email });
    if (!answer.ok) return { ...base, slack: { linked: false, reason: "slack_unavailable" } };
    return { ...base, slack: answer.userId === undefined ? { linked: false, reason: "no_match" } : { linked: true, userId: answer.userId } };
  }

  return { profile, me };
}
```

The "keeps a profile" test counts the claims-first path too: its identity carries no email, so
the first call reads userinfo and caches; the token claims path (second test) never reaches the
cache.

- [ ] **Step 4: Add the route**

In `admin-reads.ts`, change `me?: unknown` to `me?: AdminMeDependencies` (import the type), keep a
reader per dependencies object, and add the route:

```ts
const readers = new WeakMap<AdminMeDependencies, ReturnType<typeof adminIdentityReader>>();
export function adminReader(deps: AdminReadDependencies): ReturnType<typeof adminIdentityReader> | undefined {
  if (deps.me === undefined) return undefined;
  let reader = readers.get(deps.me);
  if (reader === undefined) {
    reader = adminIdentityReader({ ...deps.me, now: deps.now, log: deps.log });
    readers.set(deps.me, reader);
  }
  return reader;
}
```

and in `ADMIN_READS`:

```ts
  "/v1/admin/me": async (deps, identity, _url, request) => {
    const reader = adminReader(deps);
    // Without the reader (a test that sets none), only the token's own claims speak.
    return reader === undefined
      ? { issuer: identity.issuer, subject: identity.subject, slack: { linked: false, reason: "no_email" } }
      : reader.me(identity, request.headers.authorization);
  },
```

In broker.ts's bootstrap (the module-level `createAwsBrokerHandler({...})` call), pass
`adminReads: { me: { issuer: requiredEnvironment("OIDC_ISSUER"), fetch, ...(developer?.slackUserByEmail === undefined ? {} : { slackUserByEmail: developer.slackUserByEmail }) } }`
(Task 13 adds `health` to the same object). It is set only there, never as a default inside
`adminReadDependencies`, so a test harness without its own `me` has no reader and never reaches
the network. `adminReadDependencies` is built once per handler (Task 2), so the reader's caches live
for the Lambda's life.

- [ ] **Step 4b: A private channel's name for an admin who is a member of it (A11, Q7)**

Add to `tests/contract/admin-read-bindings.test.ts`:

```ts
import { issuer } from "../support/slack-broker.js";

describe("private channel names for a member admin (A11, Q7 as answered)", () => {
  const userinfo = (async (input: string | URL | Request) => (String(input).endsWith("/.well-known/openid-configuration")
    ? Response.json({ issuer, userinfo_endpoint: "https://identity.example.test/userinfo" })
    : Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true }))) as unknown as typeof globalThis.fetch;
  const channelInfo = async (request: { channelIds: string[] }) => ({ ok: true as const, channels: request.channelIds.map((channelId) => (channelId === "C0PRIVATE01" ? { channelId, name: "secret-launch", isPrivate: true } : { channelId, name: "payments-dev", isPrivate: false })) });
  async function broker(options: { linked: boolean; member: boolean; membersFail?: boolean }) {
    const harness = await createAdminReadBroker({
      channelInfo,
      channelMembers: async (request) => (options.membersFail ? { ok: false, error: "slack_unavailable" } : { ok: true, memberOf: options.member && request.slackUserId === "U0ADA00001" ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] }),
      brokerExtra: { adminReads: { me: { issuer, fetch: userinfo, slackUserByEmail: async () => (options.linked ? { ok: true, userId: "U0ADA00001" } : { ok: true }) } } },
    });
    await bindChannel(harness.handler, "C0PRIVATE01");
    return harness;
  }
  const privateRow = async (options: { linked: boolean; member: boolean; membersFail?: boolean }) =>
    ((await (await broker(options)).admin("GET", "/v1/admin/slack/bindings")).body.bindings as Array<Record<string, unknown>>).find((row) => row.channelId === "C0PRIVATE01");

  it("shows a private channel's name when the admin's linked Slack user is a member of it", async () => {
    expect(await privateRow({ linked: true, member: true })).toMatchObject({ channelName: "secret-launch", private: true });
  });

  it("lists it by ID only when the admin is not a member, has no Slack link, or the check fails", async () => {
    for (const options of [{ linked: true, member: false }, { linked: false, member: true }, { linked: true, member: true, membersFail: true }]) {
      const row = await privateRow(options);
      expect(row, JSON.stringify(options)).toMatchObject({ private: true });
      expect(row, JSON.stringify(options)).not.toHaveProperty("channelName");
    }
  });
});
```

Task 3's first test (no Slack link in that harness) keeps its expectation: the private channel by
ID only. Then, in `admin-reads.ts`:
- add `channelMembers?` to `AdminReadDependencies`, and in `adminReadDependencies` (broker.ts)
  `...(developer?.channelMembers === undefined ? {} : { channelMembers: developer.channelMembers })`;
- change `channelLabels` to collect the channel-info answers first, then decide names:

```ts
export async function channelLabels(deps: AdminReadDependencies, channelIds: readonly string[], options: { reveal?: (privateIds: string[]) => Promise<ReadonlySet<string>> } = {}): Promise<{ labels: Map<string, { name?: string; private: boolean }>; available: boolean }> {
  const labels = new Map<string, { name?: string; private: boolean }>();
  const unique = [...new Set(channelIds)].sort();
  if (deps.channelInfo === undefined) return { labels, available: unique.length === 0 };
  const found = new Map<string, { name: string; isPrivate: boolean }>();
  let available = true;
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const answer = await deps.channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
      if (!answer.ok) { available = false; break; }
      for (const channel of answer.channels) found.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
  } catch (error) {
    deps.log({ event: "admin.channel_info_failed", error: error instanceof Error ? error.name : "unknown" });
    available = false;
  }
  const privateIds = [...found].filter(([, channel]) => channel.isPrivate).map(([channelId]) => channelId);
  // Q7 as answered: a private channel's name only for an admin who is a member; any failure keeps the ID only.
  const revealed = privateIds.length === 0 || options.reveal === undefined ? new Set<string>() : await options.reveal(privateIds).catch(() => new Set<string>());
  for (const [channelId, channel] of found) {
    labels.set(channelId, !channel.isPrivate ? { name: channel.name, private: false } : revealed.has(channelId) ? { name: channel.name, private: true } : { private: true });
  }
  return { labels, available };
}
```

- give `listBindings` the identity and the request, and build `reveal` from the admin's Slack link
  (A12) and the channel-members check (the same DeveloperIdentity lookup, with its 10-minute cache,
  that developer access uses):

```ts
function memberReveal(deps: AdminReadDependencies, identity: AuthenticatedIdentity, authorization: string | undefined): ((privateIds: string[]) => Promise<ReadonlySet<string>>) | undefined {
  const reader = adminReader(deps);
  const members = deps.channelMembers;
  if (reader === undefined || members === undefined) return undefined;
  // Asked only when a private channel is bound, so a list of public channels needs no userinfo call.
  return async (privateIds) => {
    const slackUserId = (await reader.me(identity, authorization)).slack.userId;
    if (slackUserId === undefined) return new Set();
    const memberOf = new Set<string>();
    for (let start = 0; start < privateIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const answer = await members({ kind: "channel-members", slackUserId, channelIds: privateIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
      if (!answer.ok) return new Set();
      for (const channelId of answer.memberOf) memberOf.add(channelId);
    }
    return memberOf;
  };
}
```

  In `listBindings`, pass `{ reveal }` (when defined) to `channelLabels`, and in `ADMIN_READS` call
  it as `(deps, identity, url, request) => listBindings(deps, identity, url, request.headers.authorization)`.
  25e's change plans call `channelLabels` without `reveal`, so a change's effect names a private
  channel by ID only.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/admin-me.test.ts tests/contract/admin-read-bindings.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/admin-me.ts packages/broker/src/aws/admin-reads.ts packages/broker/src/aws/broker.ts tests/contract/admin-me.test.ts tests/contract/admin-read-bindings.test.ts
git commit -m "feat(broker): GET /v1/admin/me, and private channel names for a member admin (spec 025 phase 25d)"
```

---

### Task 12: `GET /v1/admin/health`

A13. The probes are injected, so the route is tested without AWS; Task 13 wires the real ones.

**Files:**
- Create: `packages/broker/src/aws/admin-health.ts`
- Modify: `packages/broker/src/aws/admin-reads.ts` (the `health` field's type; the route)
- Modify: `packages/broker/src/github-app.ts` (`installationCount()`)
- Test: `tests/contract/admin-health.test.ts`

**Interfaces:**
- Consumes: `AdminHealthResponse`, `AdminHealthCheck`, `ADMIN_API_VERSION` (Task 1);
  `DEVELOPER_API_VERSION` (contracts); `adminProjectNames`, `latestProjectRecord`,
  `projectWorkspaceRows`, `readFailures` (Tasks 2, 6, 9).
- Produces:
  - `export interface AdminHealthProbes { release?: string; alarms?(): Promise<Array<{ name: string; state: string }>>; queueDepths?(): Promise<Array<{ name: string; depth: number | null }>>; slackAuthCheck?(): Promise<SlackAuthCheckResponse>; githubInstallations?(): Promise<number>; timeoutMs?: number }`;
  - `export async function adminHealth(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<AdminHealthResponse>`;
  - `GitHubAppCredentialProvider.installationCount(): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-health.test.ts
// Spec 025 A13: health from injected probes; a probe that is missing or fails never fails the route.
import { describe, expect, it, vi } from "vitest";
import { failureIndexKey } from "../../packages/contracts/src/index.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";

const probes = {
  release: "0.0.6",
  alarms: async () => [{ name: "agentx-live25d-SlackDeadLetters", state: "OK" }, { name: "agentx-live25d-ConnectorBroken", state: "ALARM" }],
  queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
  slackAuthCheck: async () => ({ ok: true as const, teamId: "T0BSHLLUGBD" }),
  githubInstallations: async () => 1,
};

describe("GET /v1/admin/health (FR-030, A13)", () => {
  it("answers every section from the probes and the state table", async () => {
    const { db, admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: probes } } });
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...failureIndexKey(at, "11111111-1111-4111-8111-111111111111"), operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
      project: "payments", origin: "slack", requester: { kind: "none" }, kind: "task", status: "FAILED", category: "worker_unavailable", error: "RUNTIME_UNAVAILABLE: no capacity", endedAt: at });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.body).toEqual({
      version: { developerApi: "1.2", adminApi: "1.0", release: "0.0.6" },
      alarms: [{ name: "agentx-live25d-ConnectorBroken", state: "ALARM" }, { name: "agentx-live25d-SlackDeadLetters", state: "OK" }],
      alarmsCheck: { status: "warn", detail: "1 alarm in ALARM" },
      deadLetterQueues: [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
      slack: { status: "ok", detail: "the bot token works for team T0BSHLLUGBD" },
      github: { status: "ok", detail: "installed on 1 account" },
      workerModes: [{ mode: "ec2-ebs", configured: true, latestDispatchFailure: { at, operationId: "11111111-1111-4111-8111-111111111111", error: "RUNTIME_UNAVAILABLE: no capacity" } }],
      workspaces: {}, workspacesTruncated: false,
    });
  });

  it("says unknown, with a reason, for a probe that is not set up or fails, and still answers", async () => {
    const failing = { alarms: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); }, slackAuthCheck: async () => ({ ok: false as const, error: "token_revoked" }) };
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: failing } } });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      version: { developerApi: "1.2", adminApi: "1.0" },
      alarms: [], alarmsCheck: { status: "unknown", detail: "could not read the alarms (AccessDenied)" },
      deadLetterQueues: [], slack: { status: "failed", detail: "Slack refused the bot token (token_revoked)" },
      github: { status: "unknown", detail: "not set up in this deployment" },
    });
    expect(answer.body.version).not.toHaveProperty("release");
  });

  it("gives up on a slow probe after its time limit", async () => {
    const slow = { githubInstallations: () => new Promise<number>(() => undefined), timeoutMs: 20 };
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: slow } } });
    expect((await admin("GET", "/v1/admin/health")).body.github).toEqual({ status: "unknown", detail: "did not answer within 0.02 seconds" });
  });

  it("counts GitHub App installations with the App's own token", async () => {
    const fetch = vi.fn(async () => Response.json([{ id: 1 }, { id: 2 }]));
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => TEST_PRIVATE_KEY, fetchImplementation: fetch as never });
    expect(await provider.installationCount()).toBe(2);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe("https://api.github.com/app/installations?per_page=100");
  });
});
```

with, at the top of the file,
`import { generateKeyPairSync } from "node:crypto";` and
`const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();`
(the App's JWT is signed with `createSign`, which takes a PKCS#8 PEM).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-health.test.ts`
Expected: FAIL: `admin-health.js` does not exist.

- [ ] **Step 3: Count the App's installations**

In `packages/broker/src/github-app.ts`, add to `GitHubAppCredentialProvider`:

```ts
  /** Spec 025 A13: how many accounts the App is installed on (the first 100), for the health route. */
  async installationCount(): Promise<number> {
    const response = await this.fetchImplementation("https://api.github.com/app/installations?per_page=100", {
      headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installations lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installations response");
    return body.length;
  }
```

- [ ] **Step 4: Write the health route**

```ts
// packages/broker/src/aws/admin-health.ts
// Spec 025 A13: the health answer. Every probe has a time limit and answers `unknown` with a reason
// when it is not set up or fails, so the route itself never fails for a probe. Details carry
// counts, names and error classes only.
import { ADMIN_API_VERSION, DEVELOPER_API_VERSION, type AdminHealthCheck, type AdminHealthResponse, type SlackAuthCheckResponse } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { adminProjectNames, latestProjectRecord, projectWorkspaceRows, readFailures, type AdminReadDependencies } from "./admin-reads.js";

export interface AdminHealthProbes {
  release?: string;
  alarms?(): Promise<Array<{ name: string; state: string }>>;
  queueDepths?(): Promise<Array<{ name: string; depth: number | null }>>;
  slackAuthCheck?(): Promise<SlackAuthCheckResponse>;
  githubInstallations?(): Promise<number>;
  timeoutMs?: number;
}

class ProbeTimeout extends Error {}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
const NOT_SET_UP: AdminHealthCheck = { status: "unknown", detail: "not set up in this deployment" };

async function within<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeout()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
const failed = (what: string, ms: number, error: unknown): AdminHealthCheck => (error instanceof ProbeTimeout
  ? { status: "unknown", detail: `did not answer within ${ms / 1000} seconds` }
  : { status: "unknown", detail: `could not read ${what} (${errorName(error)})` });

export async function adminHealth(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<AdminHealthResponse> {
  const probes = (deps.health ?? {}) as AdminHealthProbes;
  const ms = probes.timeoutMs ?? 3_000;
  const now = deps.now();

  const alarmsPart = async (): Promise<Pick<AdminHealthResponse, "alarms" | "alarmsCheck">> => {
    if (probes.alarms === undefined) return { alarms: [], alarmsCheck: NOT_SET_UP };
    try {
      const alarms = (await within(ms, probes.alarms)).sort((left, right) => left.name.localeCompare(right.name));
      const firing = alarms.filter((alarm) => alarm.state === "ALARM").length;
      return { alarms, alarmsCheck: firing === 0 ? { status: "ok", detail: `${alarms.length} alarms, none in ALARM` } : { status: "warn", detail: `${firing} alarm${firing === 1 ? "" : "s"} in ALARM` } };
    } catch (error) {
      return { alarms: [], alarmsCheck: failed("the alarms", ms, error) };
    }
  };
  const queuesPart = async (): Promise<AdminHealthResponse["deadLetterQueues"]> => {
    if (probes.queueDepths === undefined) return [];
    try {
      return await within(ms, probes.queueDepths);
    } catch (error) {
      deps.log({ event: "admin.health_queues_failed", error: errorName(error) });
      return [];
    }
  };
  const slackPart = async (): Promise<AdminHealthCheck> => {
    if (probes.slackAuthCheck === undefined) return NOT_SET_UP;
    try {
      const answer = await within(ms, probes.slackAuthCheck);
      if (answer.ok) return { status: "ok", detail: `the bot token works for team ${answer.teamId}` };
      return answer.error === "slack_unavailable" ? { status: "unknown", detail: "Slack could not be reached" } : { status: "failed", detail: `Slack refused the bot token (${answer.error})` };
    } catch (error) {
      return failed("Slack", ms, error);
    }
  };
  const githubPart = async (): Promise<AdminHealthCheck> => {
    if (probes.githubInstallations === undefined) return NOT_SET_UP;
    try {
      const count = await within(ms, probes.githubInstallations);
      return count === 0 ? { status: "failed", detail: "the GitHub App is installed on no account" } : { status: "ok", detail: `installed on ${count} account${count === 1 ? "" : "s"}` };
    } catch (error) {
      return failed("the GitHub App", ms, error);
    }
  };
  const statePart = async (): Promise<Pick<AdminHealthResponse, "workerModes" | "workspaces" | "workspacesTruncated">> => {
    const names = await adminProjectNames(deps, identity);
    const modes = new Set<string>();
    const workspaces: Record<string, number> = {};
    let workspacesTruncated = false;
    for (const name of names) {
      const latest = await latestProjectRecord(deps, name);
      if (latest !== undefined) modes.add(latest.runtimeBinding.deploymentMode);
      const { rows, truncated } = await projectWorkspaceRows(deps, name, 1_000);
      workspacesTruncated = workspacesTruncated || truncated;
      for (const row of rows) if (row.status !== "CLOSED") workspaces[row.status] = (workspaces[row.status] ?? 0) + 1;
    }
    const window = { since: new Date(now - 86_400_000).toISOString(), until: new Date(now).toISOString() };
    const [latest] = (await readFailures(deps, window, { limit: 1, category: "worker_unavailable" })).failures;
    // FR-024: ec2-ebs is the only worker mode; it is configured when a project's latest revision binds it.
    return {
      workerModes: [{ mode: "ec2-ebs", configured: modes.has("ec2-ebs"), ...(latest === undefined ? {} : { latestDispatchFailure: { at: latest.endedAt, operationId: latest.operationId, error: latest.error } }) }],
      workspaces, workspacesTruncated,
    };
  };

  const [alarms, deadLetterQueues, slack, github, state] = await Promise.all([alarmsPart(), queuesPart(), slackPart(), githubPart(), statePart()]);
  return {
    version: { developerApi: DEVELOPER_API_VERSION, adminApi: ADMIN_API_VERSION, ...(probes.release === undefined ? {} : { release: probes.release }) },
    ...alarms, deadLetterQueues, slack, github, ...state,
  };
}
```

In `admin-reads.ts`, change `health?: unknown` to `health?: AdminHealthProbes` (type import from
`./admin-health.js`; the two modules import each other only for types and functions called at
request time, which ES modules allow), and add `"/v1/admin/health": (deps, identity) => adminHealth(deps, identity),`
to `ADMIN_READS`.

The first test's workspace counts are `{}`: `createAdminReadBroker` registers the project but
creates no workspace. `readFailures` gains nothing: its `category` option already exists (Task 6).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/admin-health.test.ts tests/contract/github-app*.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/admin-health.ts packages/broker/src/aws/admin-reads.ts packages/broker/src/github-app.ts tests/contract/admin-health.test.ts
git commit -m "feat(broker): GET /v1/admin/health from bounded probes (spec 025 phase 25d)"
```

---

### Task 13: The health probes' grants, the index TTL, and their wiring, named environments only

A13's production probes, and A6's TTL (Q5, owner answer 2026-09-30). Infrastructure, so a fresh
reviewer checks least privilege and the legacy templates.

**Files:**
- Modify: `infra/lib/control-plane.ts`
- Modify: `infra/lib/developer-task-notifier.ts` (expose the two queues)
- Modify: `packages/broker/src/aws/broker.ts` (the production `health` probes)
- Test: `tests/contract/admin-health-infrastructure.test.ts`

**Interfaces:**
- Consumes: `AdminHealthProbes` (Task 12); `slackAuthCheckThroughLambda` (Task 10);
  `githubCredentials.installationCount()` (Task 12).
- Produces: broker environment variables, named environments only: `AGENTX_ALARM_PREFIX`
  (`agentx-<env>-`), `HEALTH_DEAD_LETTER_QUEUES` (JSON `{ "<name>": "<queue URL>" }`); IAM:
  `cloudwatch:DescribeAlarms` and `sqs:GetQueueAttributes`, each on exact resources.
  `DeveloperTaskNotifier` gains `readonly deadLetters: sqs.Queue; readonly streamFailures: sqs.Queue`.
  A6: the named environment's State table gets `TimeToLiveSpecification` on `indexExpiresAt`
  (`INDEX_EXPIRY_ATTRIBUTE`), and the reconciler gets `INDEX_EXPIRY=ttl`; the legacy template has
  neither.

- [ ] **Step 1: Confirm the IAM resource types (read-only)**

Read the Service Authorization Reference for CloudWatch and SQS (the AWS documentation pages
"Actions, resources, and condition keys for Amazon CloudWatch" and "... for Amazon SQS") and note,
in the commit message, whether `DescribeAlarms` accepts `alarm` ARNs and `GetQueueAttributes`
accepts `queue` ARNs. The expected answer: both do. If `DescribeAlarms` does not, grant it on `*`
with a comment quoting the reference's words, and keep the alarm name prefix as the only reader of
names (the probe asks with `AlarmNamePrefix`).

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/admin-health-infrastructure.test.ts
// Spec 025 A13 and A6: the broker's health grants are exact, the index TTL is on, and both exist
// only in named environments.
import { execFileSync } from "node:child_process";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";

type Statement = { Action: string | string[]; Resource: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Environment?: { Variables?: Record<string, unknown> } } };

function brokerStatements(template: Template): Statement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith("BrokerServiceRole")))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}
function brokerEnvironment(template: Template): Record<string, unknown> {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
  const broker = functions.find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return broker?.[1].Properties.Environment?.Variables ?? {};
}

describe("the health route's grants (A13)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "HealthControlPlane", { naming: environmentNaming("live25d") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "HealthLegacyControlPlane"));

  it("lets the broker describe the environment's alarms, by their name prefix only", () => {
    const describe = brokerStatements(named).filter((statement) => statement.Action === "cloudwatch:DescribeAlarms");
    expect(describe).toHaveLength(1);
    expect(JSON.stringify(describe[0]?.Resource)).toContain(":alarm:agentx-live25d-*");
    expect(brokerEnvironment(named).AGENTX_ALARM_PREFIX).toBe("agentx-live25d-");
  });

  it("lets the broker read the attributes of exactly the four dead-letter queues", () => {
    const queues = brokerStatements(named).filter((statement) => statement.Action === "sqs:GetQueueAttributes");
    expect(queues).toHaveLength(1);
    expect(queues[0]?.Resource).toHaveLength(4);
    const listed = JSON.stringify(brokerEnvironment(named).HEALTH_DEAD_LETTER_QUEUES);
    for (const queue of ["DispatchDeadLetterQueue", "SlackRequestDeadLetterQueue", "NoticeDeadLetterQueue", "StreamFailureQueue"]) expect(listed).toContain(queue);
  });

  it("expires index items by TTL on indexExpiresAt in a named environment, and tells the reconciler so (A6, Q5)", () => {
    const tables = Object.values(named.findResources("AWS::DynamoDB::Table") as Record<string, { Properties: { StreamSpecification?: unknown; TimeToLiveSpecification?: unknown } }>);
    const state = tables.filter((table) => table.Properties.StreamSpecification !== undefined);
    expect(state).toHaveLength(1);
    expect(state[0]?.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "indexExpiresAt", Enabled: true });
    const functions = Object.entries(named.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
    const reconciler = functions.find(([id]) => /Reconciler[0-9A-F]{8}$/.test(id));
    expect(reconciler?.[1].Properties.Environment?.Variables).toMatchObject({ INDEX_EXPIRY: "ttl" });
  });

  it("names indexExpiresAt only where index items are written or read, so the TTL deletes nothing else", () => {
    const allowed = new Set(["packages/contracts/src/admin.ts", "packages/broker/src/aws/activity-index.ts", "packages/broker/src/aws/admin-reads.ts", "infra/lib/control-plane.ts"]);
    const found = execFileSync("grep", ["-rl", "indexExpiresAt\\|INDEX_EXPIRY_ATTRIBUTE", "packages", "infra/lib", "--include=*.ts"], { encoding: "utf8" }).trim().split("\n").filter((file) => file !== "");
    expect(found.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("adds nothing to the legacy template", () => {
    expect(brokerStatements(legacy).some((statement) => statement.Action === "cloudwatch:DescribeAlarms" || statement.Action === "sqs:GetQueueAttributes")).toBe(false);
    const legacyTables = Object.values(legacy.findResources("AWS::DynamoDB::Table") as Record<string, { Properties: { StreamSpecification?: unknown; TimeToLiveSpecification?: unknown } }>);
    expect(legacyTables.find((table) => table.Properties.StreamSpecification !== undefined)?.Properties.TimeToLiveSpecification).toBeUndefined();
    expect(brokerEnvironment(legacy)).not.toHaveProperty("AGENTX_ALARM_PREFIX");
    expect(brokerEnvironment(legacy)).not.toHaveProperty("HEALTH_DEAD_LETTER_QUEUES");
  });
});
```

The broker's role is `BrokerServiceRole...` and its function `Broker` plus an eight-character hash,
as `tests/contract/turn-records-infrastructure.test.ts` already relies on; the notifier's queues
sit under `DeveloperTaskNotifier`, so their logical IDs contain `NoticeDeadLetterQueue` and
`StreamFailureQueue`. `legacy-templates.test.ts` stays the byte-identical check.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-health-infrastructure.test.ts`
Expected: FAIL: the broker has neither statement.

- [ ] **Step 4: Add the grants and variables**

In `infra/lib/developer-task-notifier.ts`, keep the two queues on the construct:
`readonly deadLetters: sqs.Queue;` and `readonly streamFailures: sqs.Queue;`, assigned where they
are created (`this.deadLetters = new sqs.Queue(...)`), nothing else changed.

In `infra/lib/control-plane.ts`, inside `if (naming.env !== undefined && signInParameters !== undefined)`,
keep the notifier in a constant (`const notifier = new DeveloperTaskNotifier(...)`) and add:

```ts
      // Spec 025 A13: the admin health route reads the environment's alarms, by name prefix, and
      // the depths of its dead-letter queues. Read-only, and on exactly these resources.
      const alarmPrefix = naming.alarmName("");
      broker.addEnvironment("AGENTX_ALARM_PREFIX", alarmPrefix);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["cloudwatch:DescribeAlarms"],
        resources: [`arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarmPrefix}*`],
      }));
      const deadLetterQueues = { dispatch: deadLetterQueue, "slack-requests": slackDeadLetterQueue, "developer-notices": notifier.deadLetters, "developer-notice-stream": notifier.streamFailures };
      broker.addEnvironment("HEALTH_DEAD_LETTER_QUEUES", this.toJsonString(Object.fromEntries(Object.entries(deadLetterQueues).map(([name, queue]) => [name, queue.queueUrl]))));
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["sqs:GetQueueAttributes"],
        resources: Object.values(deadLetterQueues).map((queue) => queue.queueArn),
      }));
```

`naming.alarmName("")` is `agentx-<env>-` for a named environment (infra/lib/naming.ts line 118).

For A6, in the State table's props (control-plane.ts), add the TTL for named environments only,
and after `const sessions = new SessionLifecycle(...)` tell the reconciler:

```ts
      // Spec 025 A6 (Q5, owner answer 2026-09-30): failure and usage index items expire by TTL in
      // named environments. Adding a TTL to an existing table is an in-place update, and no other
      // State item carries indexExpiresAt (a test pins it). The legacy table stays as it is.
      ...(naming.env === undefined ? {} : { timeToLiveAttribute: INDEX_EXPIRY_ATTRIBUTE }),
```

```ts
    // A6: where the State table expires index items itself, the reconciler's legacy sweep is off.
    if (naming.env !== undefined) sessions.reconciler.addEnvironment("INDEX_EXPIRY", "ttl");
```

(import `INDEX_EXPIRY_ATTRIBUTE` from `@agentx/contracts`).

- [ ] **Step 5: Wire the production probes**

In `packages/broker/src/aws/broker.ts`'s bootstrap, build the probes only from what the environment
provides, and pass them as `adminReads: { health }` in `createAwsBrokerHandler`'s input:

```ts
const cloudWatch = new CloudWatchClient(awsClientConfiguration);
const sqs = new SQSClient(awsClientConfiguration);
function healthProbes(): AdminHealthProbes {
  const prefix = process.env.AGENTX_ALARM_PREFIX;
  const queues = process.env.HEALTH_DEAD_LETTER_QUEUES;
  return {
    ...(process.env.AGENTX_RELEASE_VERSION ? { release: process.env.AGENTX_RELEASE_VERSION } : {}),
    ...(prefix ? {
      alarms: async () => {
        const found: Array<{ name: string; state: string }> = [];
        let NextToken: string | undefined;
        do {
          const page = await cloudWatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix, MaxRecords: 100, ...(NextToken === undefined ? {} : { NextToken }) }));
          for (const alarm of [...(page.MetricAlarms ?? []), ...(page.CompositeAlarms ?? [])]) found.push({ name: alarm.AlarmName ?? "", state: alarm.StateValue ?? "INSUFFICIENT_DATA" });
          NextToken = page.NextToken;
        } while (NextToken !== undefined);
        return found;
      },
    } : {}),
    ...(queues ? {
      queueDepths: async () => Promise.all(Object.entries(JSON.parse(queues) as Record<string, string>).map(async ([name, url]) => {
        try {
          const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }));
          return { name, depth: Number(attributes.Attributes?.ApproximateNumberOfMessages ?? "0") };
        } catch {
          return { name, depth: null };
        }
      })),
    } : {}),
    ...(developer?.slackAuthCheck === undefined ? {} : { slackAuthCheck: developer.slackAuthCheck }),
    githubInstallations: () => githubCredentials.installationCount(),
  };
}
```

and add `health: healthProbes()` to the bootstrap's `adminReads` object (beside Task 11's `me`). Import `CloudWatchClient`,
`DescribeAlarmsCommand` (`@aws-sdk/client-cloudwatch`) and `SQSClient`, `GetQueueAttributesCommand`
(`@aws-sdk/client-sqs`); add `@aws-sdk/client-cloudwatch` to `packages/broker/package.json` at the
same pinned version as the repository's other `@aws-sdk/*` packages if it is not already there. In
the legacy deployment neither variable is set, so alarms and queues answer "not set up" and nothing
is called.

- [ ] **Step 6: Run the tests and synth**

Run: `npx vitest run tests/contract/admin-health-infrastructure.test.ts tests/contract/legacy-templates.test.ts && npm run infra:synth && npm run typecheck`
Expected: PASS; the legacy templates are byte-identical.

- [ ] **Step 7: Commit**

```bash
git add infra/lib/control-plane.ts infra/lib/developer-task-notifier.ts packages/broker/src/aws/broker.ts packages/broker/package.json package-lock.json tests/contract/admin-health-infrastructure.test.ts
git commit -m "feat(infra): the admin health route's read-only grants and the index TTL, named environments only (spec 025 phase 25d)"
```

---
### Task 14: The MCP server's admin client, the tool offer and the guard

A1, A14's error mapping, A15. No tool yet: Task 15 adds the eight tools this machinery offers.
**Depends on Q1** (the admin version check).

**Files:**
- Create: `packages/mcp/src/admin-client.ts`
- Create: `packages/mcp/src/offer.ts`
- Modify: `packages/mcp/src/client.ts` (`configuration()` reads `adminApiVersion`)
- Modify: `packages/mcp/src/compatibility.ts` (`Compatibility.adminApiVersion`, `adminApiFits`)
- Modify: `packages/mcp/src/server.ts` (register admin tools disabled; the offer; the guard)
- Modify: `packages/mcp/src/tools.ts` (`ToolContext.admin`)
- Modify: `packages/mcp/src/index.ts` (export the two new modules)
- Test: `tests/contract/mcp-admin-client.test.ts`, `tests/contract/mcp-admin-offer.test.ts`

**Interfaces:**
- Consumes: the admin wire schemas and types (Task 1); `ToolError`, `NEXT_STEPS`,
  `UPGRADE_AGENTX_STEP`, `plainText` (errors.ts); `ToolDefinition` (tools.ts).
- Produces:
  - `export interface AdminSession { baseUrl: string; accessToken: string }`;
  - `export interface AdminControlPlaneClient { me(): Promise<AdminMeResponse>; health(): Promise<AdminHealthResponse>; failures(query: AdminFailuresQuery): Promise<AdminFailuresResponse>; turns(query: AdminTurnsQuery): Promise<AdminTurnsPage>; usage(query: AdminUsageQuery): Promise<AdminUsageResponse>; projects(): Promise<AdminProjectsResponse>; bindings(): Promise<AdminBindingsResponse>; credentials(): Promise<AdminCredentialsResponse>; workspaces(query: AdminWorkspacesQuery): Promise<AdminWorkspacesResponse> }`
    with `AdminFailuresQuery = { since?: string; until?: string; project?: string; limit?: number }`,
    `AdminTurnsQuery = { since: string; until?: string; project?: string; origin?: "slack" | "ai_tool"; thread?: string; task?: string; limit?: number; cursor?: string }`,
    `AdminTurnsPage = { turns: Array<Record<string, unknown>>; cursor?: string; skipped?: number }`,
    `AdminUsageQuery = { since?: string; until?: string; groupBy: AdminUsageGroupBy }`,
    `AdminWorkspacesQuery = { project?: string; status?: string; limit?: number }`,
    `AdminCredentialsResponse = { credentials: Array<{ ref: string; type: string; secretName: string; registeredAt?: string; builtIn?: boolean }> }`;
  - `export function httpAdminClient(options: { session(): Promise<AdminSession>; fetch: typeof fetch; traceId?(): string; tries?: number; sleep?(ms: number): Promise<void> }): AdminControlPlaneClient`;
  - `export const ADMIN_SIGN_IN_STEP = "run npx @charterarc/agentx login --admin";`
  - `export const REQUIRED_ADMIN_MINOR = 0;` and
    `export function adminApiFits(version: string | undefined): "fits" | "missing" | "too_old" | "incompatible"` (compatibility.ts);
  - `Compatibility` gains `adminApiVersion?: string`; `ControlPlaneClient.configuration()` answers
    `adminApiVersion?: string`;
  - `export interface AdminOffer { admin: ToolError | undefined }` (undefined: offered);
  - `export class ToolOffer { constructor(options: { tools: Map<string, { enable(): void; disable(): void; enabled: boolean }>; read(): Promise<AdminOffer>; log?(entry: Record<string, unknown>): void }); refresh(): Promise<void>; refusal(name: string): ToolError | undefined; start(intervalMs: number): void; stop(): void }`;
  - `export function guardTransport(inner: Transport, refusal: (name: string) => ToolError | undefined, answer: (error: ToolError) => Record<string, unknown>): Transport`;
  - `createAgentXMcpServer`'s options gain `adminTools?: readonly ToolDefinition[]` (Task 15 passes
    `ADMIN_READ_TOOLS`) and `adminOffer?: () => Promise<AdminOffer>` (absent: never offered), and
    `recheckMs?: number` (default 30,000);
  - `ToolContext.admin?: AdminControlPlaneClient`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/mcp-admin-client.test.ts
// Spec 025 A14: the admin client reads /v1/admin/* with the admin sign-in, and maps refusals to FR-049's codes.
import { describe, expect, it, vi } from "vitest";
import { ADMIN_SIGN_IN_STEP, ToolError, adminApiFits, httpAdminClient } from "../../packages/mcp/src/index.js";

const session = async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-access-token" });
const answering = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("the admin client (A14)", () => {
  it("sends the admin token and a trace ID, and reads the answer", async () => {
    const fetch = answering(200, { projects: [] });
    const client = httpAdminClient({ session, fetch: fetch as never, traceId: () => "trace-1" });
    expect(await client.projects()).toEqual({ projects: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/projects");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer admin-access-token");
    expect(new Headers(init.headers).get("x-agentx-trace-id")).toBe("trace-1");
  });

  it("builds each read's query string", async () => {
    const fetch = answering(200, { turns: [] });
    const client = httpAdminClient({ session, fetch: fetch as never });
    await client.turns({ since: "2026-09-29T00:00:00.000Z", task: "33333333-3333-4333-8333-333333333333", limit: 5 });
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/turns?since=2026-09-29T00%3A00%3A00.000Z&task=33333333-3333-4333-8333-333333333333&limit=5");
  });

  it("answers ADMIN_REQUIRED for a 401 and for a missing admin claim, never repeating the token", async () => {
    for (const [status, body] of [[401, { message: "Unauthorized" }], [403, { error: { code: "FORBIDDEN", message: "administrator claim is required" } }]] as const) {
      const client = httpAdminClient({ session, fetch: answering(status, body) as never });
      const failure = await client.health().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect(failure).toMatchObject({ code: "ADMIN_REQUIRED", nextStep: ADMIN_SIGN_IN_STEP });
      expect(JSON.stringify(failure)).not.toContain("admin-access-token");
    }
  });

  it("answers INVALID_REQUEST for CONFIG_INVALID, UPGRADE_REQUIRED for an unknown route, and retries an outage", async () => {
    const invalid = httpAdminClient({ session, fetch: answering(400, { error: { code: "CONFIG_INVALID", message: "limit must be a whole number from 1 to 100" } }) as never });
    await expect(invalid.failures({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "limit must be a whole number from 1 to 100" });
    const old = httpAdminClient({ session, fetch: answering(403, { error: { code: "FORBIDDEN", message: "AgentX developer workflows run in the project's Slack channel; this endpoint serves administration only" } }) as never });
    await expect(old.health()).rejects.toMatchObject({ code: "UPGRADE_REQUIRED" });
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
    expect(await httpAdminClient({ session, fetch: flaky as never, sleep: async () => undefined }).projects()).toEqual({ projects: [] });
  });

  it("says ADMIN_REQUIRED when there is no admin sign-in at all", async () => {
    const client = httpAdminClient({ session: async () => { throw new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP); }, fetch: vi.fn() as never });
    await expect(client.projects()).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
  });
});

describe("the admin API version (A1)", () => {
  it("fits 1.x from 1.0, and says why otherwise", () => {
    expect(adminApiFits("1.0")).toBe("fits");
    expect(adminApiFits("1.3")).toBe("fits");
    expect(adminApiFits(undefined)).toBe("missing");
    expect(adminApiFits("2.0")).toBe("incompatible");
    expect(adminApiFits("banana")).toBe("incompatible");
  });
});
```

```ts
// tests/contract/mcp-admin-offer.test.ts
// Spec 025 FR-028, A15: admin tools appear and disappear with the admin sign-in, with list_changed,
// and a direct call to a hidden one answers ADMIN_REQUIRED.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEVELOPER_TOOLS, ToolError, createAgentXMcpServer, type AdminOffer, type ToolContext, type ToolDefinition } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const probe: ToolDefinition = {
  name: "agentx_admin_probe", title: "Probe", description: "A test admin tool.", inputSchema: {}, outputSchema: { ok: z.boolean() },
  handler: async () => ({ structured: { ok: true }, text: "ok" }),
};

async function connect(offer: { current: AdminOffer }) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => offer.current.admin === undefined,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
  });
  const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: [probe], adminOffer: async () => offer.current, recheckMs: 60_000 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changes += 1; });
  await client.connect(clientSide);
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return { client, names, changes: () => changes, server };
}
const signedOut = { admin: new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", "run npx @charterarc/agentx login --admin") };

describe("the admin tool offer (FR-028, A15)", () => {
  it("offers only the developer tools without an admin sign-in", async () => {
    const { names } = await connect({ current: signedOut });
    expect(await names()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
  });

  it("offers the admin tools once the admin signs in, and sends list_changed each way", async () => {
    const offer = { current: signedOut as AdminOffer };
    const { client, names, changes } = await connect(offer);
    offer.current = { admin: undefined };
    // A15: any tool call rechecks, so the change shows at once.
    await client.callTool({ name: "agentx_whoami", arguments: {} }).catch(() => undefined);
    await expect.poll(async () => (await names()).includes("agentx_admin_probe")).toBe(true);
    expect(changes()).toBeGreaterThanOrEqual(1);
    offer.current = signedOut;
    await client.callTool({ name: "agentx_admin_probe", arguments: {} });
    await expect.poll(async () => (await names()).includes("agentx_admin_probe")).toBe(false);
    expect(changes()).toBeGreaterThanOrEqual(2);
  });

  it("answers a direct call to a hidden admin tool with ADMIN_REQUIRED, not the SDK's own refusal", async () => {
    const { client } = await connect({ current: signedOut });
    const result = await client.callTool({ name: "agentx_admin_probe", arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolError(result)).toEqual({ code: "ADMIN_REQUIRED", message: "this computer holds no unexpired admin sign-in for AgentX", next_step: "run npx @charterarc/agentx login --admin" });
  });

  it("says UPGRADE_REQUIRED when AgentX is too old for the admin tools", async () => {
    const tooOld = { admin: new ToolError("UPGRADE_REQUIRED", "AgentX at https://x has no admin API", "ask your AgentX admin to upgrade AgentX, or use an older CLI") };
    const { client, names } = await connect({ current: tooOld });
    expect(await names()).not.toContain("agentx_admin_probe");
    expect(toolError(await client.callTool({ name: "agentx_admin_probe", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
  });

  it("keeps offering what it last knew when the check itself fails", async () => {
    const offer = { current: { admin: undefined } as AdminOffer };
    const flaky = { get current(): AdminOffer { if (failing) throw new Error("keychain locked"); return offer.current; } };
    let failing = false;
    const { names, client } = await connect(flaky as never);
    await expect.poll(async () => (await names()).includes("agentx_admin_probe")).toBe(true);
    failing = true;
    await client.callTool({ name: "agentx_whoami", arguments: {} }).catch(() => undefined);
    expect(await names()).toContain("agentx_admin_probe");
  });
});
```

`toolError` parses the `CODE: message. Next step: step.` text that `errorResult` writes
(`tests/support/mcp-tool-error.ts`). In the last test, the offer's getter throws inside
`adminOffer`, which `ToolOffer.refresh` catches and logs.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/mcp-admin-client.test.ts tests/contract/mcp-admin-offer.test.ts`
Expected: FAIL: `httpAdminClient`, `adminApiFits` and the new server options do not exist.

- [ ] **Step 3: The admin client**

```ts
// packages/mcp/src/admin-client.ts
// Spec 025 A14: the admin tools' view of the control plane, with the admin sign-in `agentx login
// --admin` stored. Every answer is parsed with the contracts' schemas; every refusal becomes one of
// FR-049's codes. The token is never part of an error, a log line or a result.
import { randomUUID } from "node:crypto";
import {
  AdminBindingsResponseSchema, AdminFailuresResponseSchema, AdminHealthResponseSchema, AdminMeResponseSchema, AdminProjectsResponseSchema,
  AdminUsageResponseSchema, AdminWorkspacesResponseSchema,
  type AdminBindingsResponse, type AdminFailuresResponse, type AdminHealthResponse, type AdminMeResponse, type AdminProjectsResponse,
  type AdminUsageGroupBy, type AdminUsageResponse, type AdminWorkspacesResponse,
} from "@agentx/contracts";
import { z } from "zod";
import { NEXT_STEPS, ToolError, UPGRADE_AGENTX_STEP, plainText } from "./errors.js";

export const ADMIN_SIGN_IN_STEP = "run npx @charterarc/agentx login --admin";
export interface AdminSession { baseUrl: string; accessToken: string }
export type AdminFailuresQuery = { since?: string; until?: string; project?: string; limit?: number };
export type AdminTurnsQuery = { since: string; until?: string; project?: string; origin?: "slack" | "ai_tool"; thread?: string; task?: string; limit?: number; cursor?: string };
export type AdminTurnsPage = { turns: Array<Record<string, unknown>>; cursor?: string; skipped?: number };
export type AdminUsageQuery = { since?: string; until?: string; groupBy: AdminUsageGroupBy };
export type AdminWorkspacesQuery = { project?: string; status?: string; limit?: number };
const AdminCredentialsResponseSchema = z.object({ credentials: z.array(z.object({ ref: z.string(), type: z.string(), secretName: z.string(), registeredAt: z.string().optional(), builtIn: z.boolean().optional() })) });
export type AdminCredentialsResponse = z.infer<typeof AdminCredentialsResponseSchema>;
const AdminTurnsPageSchema = z.object({ turns: z.array(z.record(z.string(), z.unknown())), cursor: z.string().optional(), skipped: z.number().int().nonnegative().optional() });

export interface AdminControlPlaneClient {
  me(): Promise<AdminMeResponse>;
  health(): Promise<AdminHealthResponse>;
  failures(query: AdminFailuresQuery): Promise<AdminFailuresResponse>;
  turns(query: AdminTurnsQuery): Promise<AdminTurnsPage>;
  usage(query: AdminUsageQuery): Promise<AdminUsageResponse>;
  projects(): Promise<AdminProjectsResponse>;
  bindings(): Promise<AdminBindingsResponse>;
  credentials(): Promise<AdminCredentialsResponse>;
  workspaces(query: AdminWorkspacesQuery): Promise<AdminWorkspacesResponse>;
}

/** The broker's catch-all refusal for a path it does not serve: a control plane from before 25d. */
const NOT_AN_ADMIN_ROUTE = "this endpoint serves administration only";
const REQUEST_TIMEOUT_MS = 30_000;

function refusal(status: number, value: unknown, secret: string): ToolError {
  const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = plainText(error?.message, `AgentX answered HTTP ${status}`, [secret]);
  if (status === 401 || code === "AUTH_REQUIRED") return new ToolError("ADMIN_REQUIRED", "AgentX refused this computer's admin sign-in, or it has expired", ADMIN_SIGN_IN_STEP);
  if (code === "FORBIDDEN" && message.includes(NOT_AN_ADMIN_ROUTE)) return new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin read routes yet", UPGRADE_AGENTX_STEP);
  if (code === "FORBIDDEN") return new ToolError("ADMIN_REQUIRED", `AgentX refused: ${message}`, ADMIN_SIGN_IN_STEP);
  if (code === "CONFIG_INVALID") return new ToolError("INVALID_REQUEST", message);
  return new ToolError("CONTROL_PLANE_UNAVAILABLE", message, status >= 500 ? NEXT_STEPS.CONTROL_PLANE_UNAVAILABLE : "ask your AgentX admin, or try again later");
}

const search = (values: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

export function httpAdminClient(options: { session(): Promise<AdminSession>; fetch: typeof fetch; traceId?(): string; tries?: number; sleep?(ms: number): Promise<void> }): AdminControlPlaneClient {
  const tries = Math.max(1, options.tries ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    const session = await options.session();
    const where = plainText(session.baseUrl, "its URL");
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await options.fetch(`${session.baseUrl}${path}`, {
          method: "GET",
          headers: { authorization: `Bearer ${session.accessToken}`, "x-agentx-trace-id": options.traceId?.() ?? randomUUID() },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < tries) { await sleep(250 * attempt); continue; }
        throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `could not reach AgentX at ${where} after ${attempt} tries`);
      }
      const text = await response.text().catch(() => "");
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { value = undefined; }
      if (response.status >= 500 && attempt < tries) { await sleep(250 * attempt); continue; }
      if (!response.ok) throw refusal(response.status, value, session.accessToken);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ToolError("CONTROL_PLANE_UNAVAILABLE", "AgentX answered with something this version of the CLI cannot read; upgrade it", NEXT_STEPS.UPGRADE_REQUIRED);
      return parsed.data;
    }
  }
  return {
    me: () => get(AdminMeResponseSchema, "/v1/admin/me"),
    health: () => get(AdminHealthResponseSchema, "/v1/admin/health"),
    failures: (query) => get(AdminFailuresResponseSchema, `/v1/admin/failures${search({ since: query.since, until: query.until, project: query.project, limit: query.limit })}`),
    turns: (query) => get(AdminTurnsPageSchema, `/v1/admin/turns${search({ since: query.since, until: query.until, project: query.project, origin: query.origin, thread: query.thread, task: query.task, limit: query.limit, cursor: query.cursor })}`),
    usage: (query) => get(AdminUsageResponseSchema, `/v1/admin/usage${search({ since: query.since, until: query.until, group_by: query.groupBy })}`),
    projects: () => get(AdminProjectsResponseSchema, "/v1/admin/projects"),
    bindings: () => get(AdminBindingsResponseSchema, "/v1/admin/slack/bindings"),
    credentials: () => get(AdminCredentialsResponseSchema, "/v1/admin/credentials"),
    workspaces: (query) => get(AdminWorkspacesResponseSchema, `/v1/admin/workspaces${search({ project: query.project, status: query.status, limit: query.limit })}`),
  };
}
```

The session callback may itself throw a `ToolError` (`ADMIN_REQUIRED` when no admin sign-in is
held, Task 16); it passes through unchanged.

- [ ] **Step 4: The admin version**

In `packages/mcp/src/client.ts`, make `ConfigurationSchema`
`z.object({ env: z.string(), apiVersion: z.string(), adminApiVersion: z.string().optional() })` and
return `adminApiVersion` from `configuration()` when present. In `compatibility.ts`:

```ts
/** Spec 025 A1: the admin read tools arrived in admin API 1.0. */
export const REQUIRED_ADMIN_MINOR = 0;

export function adminApiFits(version: string | undefined): "fits" | "missing" | "too_old" | "incompatible" {
  if (version === undefined) return "missing";
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (match === null || match[1] !== "1") return "incompatible";
  return Number(match[2]) >= REQUIRED_ADMIN_MINOR ? "fits" : "too_old";
}
```

and `Compatibility` gains `adminApiVersion?: string`, set from the configuration in the checker's
cached value.

- [ ] **Step 5: The offer and the guard**

```ts
// packages/mcp/src/offer.ts
// Spec 025 FR-028, A15: which admin tools the server offers, and a guard that answers a direct call
// to a hidden one with FR-049's code. The SDK sends notifications/tools/list_changed itself when a
// registered tool is enabled or disabled while connected.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ADMIN_SIGN_IN_STEP } from "./admin-client.js";
import { ToolError } from "./errors.js";

export interface AdminOffer { admin: ToolError | undefined }
interface Switchable { enable(): void; disable(): void; enabled: boolean }

const NOT_OFFERED = new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);

export class ToolOffer {
  private current: AdminOffer = { admin: NOT_OFFERED };
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: { tools: Map<string, Switchable>; read(): Promise<AdminOffer>; log?(entry: Record<string, unknown>): void }) {}

  /** Reads the offer and switches the tools; one read at a time, and a failed read changes nothing. */
  refresh(): Promise<void> {
    this.running ??= (async () => {
      try {
        this.current = await this.options.read();
      } catch (error) {
        this.options.log?.({ event: "offer.check_failed", error: error instanceof Error ? error.name : "unknown" });
        return;
      }
      const offered = this.current.admin === undefined;
      for (const tool of this.options.tools.values()) {
        if (offered && !tool.enabled) tool.enable();
        if (!offered && tool.enabled) tool.disable();
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Why a hidden admin tool is refused, or undefined for any other tool. */
  refusal(name: string): ToolError | undefined {
    const tool = this.options.tools.get(name);
    if (tool === undefined || tool.enabled) return undefined;
    // A refused call is also a good moment to look again.
    void this.refresh();
    return this.current.admin ?? NOT_OFFERED;
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

type CallRequest = { jsonrpc: "2.0"; id: string | number; method: "tools/call"; params: { name?: unknown } };
const isToolCall = (message: JSONRPCMessage): message is CallRequest & JSONRPCMessage =>
  "method" in message && message.method === "tools/call" && "id" in message && typeof (message as { params?: { name?: unknown } }).params?.name === "string";

/**
 * A15: answers a tools/call for a hidden admin tool before the SDK sees it, since the SDK's own
 * answer ("Tool ... disabled") carries no code. Everything else passes through unchanged and in
 * order. Callbacks set on `inner` before (runMcpServer's onclose) are kept and still called.
 */
export function guardTransport(inner: Transport, refusal: (name: string) => ToolError | undefined, answer: (error: ToolError) => Record<string, unknown>): Transport {
  const guarded: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    ...(inner.setProtocolVersion === undefined ? {} : { setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version) }),
  };
  Object.defineProperty(guarded, "sessionId", { get: () => inner.sessionId });
  const closed = inner.onclose;
  inner.onclose = () => { closed?.(); guarded.onclose?.(); };
  const failed = inner.onerror;
  inner.onerror = (error) => { failed?.(error); guarded.onerror?.(error); };
  inner.onmessage = (message, extra) => {
    if (isToolCall(message)) {
      const refused = refusal(String(message.params.name));
      if (refused !== undefined) {
        void inner.send({ jsonrpc: "2.0", id: message.id, result: answer(refused) } as JSONRPCMessage).catch((error: unknown) => guarded.onerror?.(error instanceof Error ? error : new Error("send failed")));
        return;
      }
    }
    guarded.onmessage?.(message, extra);
  };
  return guarded;
}
```

- [ ] **Step 6: Register, offer and guard in the server**

In `packages/mcp/src/server.ts`:
- options gain `adminTools?: readonly ToolDefinition[]`, `adminOffer?: () => Promise<AdminOffer>`
  and `recheckMs?: number`;
- move the body of today's `for (const tool of DEVELOPER_TOOLS)` loop into one function, so the
  admin tools are registered the same way, and keep each admin tool's `RegisteredTool` (disabled
  at once; not connected yet, so nothing is sent):

```ts
  let offer: ToolOffer | undefined;
  const register = (tool: ToolDefinition): RegisteredTool => server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
    async (input: Record<string, unknown>, extra) => {
      try {
        // ...today's handler body, unchanged: context, call, compatibility, handler, errorResult...
      } finally {
        // A15: a sign-in, or its expiry, shows after any call.
        void offer?.refresh();
      }
    },
  );
  for (const tool of DEVELOPER_TOOLS) register(tool);
  const adminRegistered = new Map((options.adminTools ?? []).map((tool) => {
    const registered = register(tool);
    registered.disable();
    return [tool.name, registered] as const;
  }));
```

  (`RegisteredTool` is a type import from `@modelcontextprotocol/sdk/server/mcp.js`);
- build the offer; without `adminOffer`, the admin tools stay hidden:

```ts
  const hidden = new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);
  offer = new ToolOffer({
    tools: adminRegistered,
    read: options.adminOffer ?? (async () => ({ admin: hidden })),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
```

- `const live = offer; server.server.oninitialized = () => { void live.refresh(); live.start(options.recheckMs ?? 30_000); };`
  and chain the server's close: `const closeServer = server.close.bind(server); server.close = async () => { live.stop(); await closeServer(); };`
- guard every transport the server connects:

```ts
  // A15: the guard answers a direct call to a hidden admin tool; see offer.ts.
  const connect = server.connect.bind(server);
  server.connect = (transport) => connect(guardTransport(transport, (name) => live.refusal(name), errorResult));
```

  `errorResult` is the existing function that turns a `ToolError` into `{ isError, content }`.

In `packages/mcp/src/tools.ts`, add to `ToolContext`:
`/** Spec 025 A14: the admin sign-in's client; absent when the server has none. */ admin?: AdminControlPlaneClient;`

Export `admin-client.js` and `offer.js` from `packages/mcp/src/index.ts`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/mcp-admin-client.test.ts tests/contract/mcp-admin-offer.test.ts tests/contract/mcp-tools.test.ts tests/contract/mcp-stdio.test.ts tests/contract/mcp-share-tool.test.ts && npm run typecheck`
Expected: PASS. The existing MCP tests pass unchanged: they pass no admin tools, so the list is the
eleven developer tools, and `mcp-stdio.test.ts`'s `toHaveLength(11)` holds.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src tests/contract/mcp-admin-client.test.ts tests/contract/mcp-admin-offer.test.ts
git commit -m "feat(mcp): the admin client, the admin tool offer with list_changed, and the hidden-tool guard (spec 025 phase 25d)"
```

---

### Task 15: The eight admin read tools

FR-030's admin read tools, A16. Each tool's description says when to use it and what to do next.

**Files:**
- Create: `packages/mcp/src/admin-tools.ts`
- Modify: `packages/mcp/src/index.ts` (export it)
- Test: `tests/contract/mcp-admin-tools.test.ts`

**Interfaces:**
- Consumes: `AdminControlPlaneClient` and its query types (Task 14); `ToolDefinition`,
  `ToolContext` (tools.ts); `ADMIN_LIST_MAX`, `ADMIN_FAILURES_DEFAULT_LIMIT`,
  `ADMIN_WORKSPACES_DEFAULT_LIMIT`, `AdminUsageGroupBySchema`, `WorkspaceStatusSchema`, `inertName`
  (contracts).
- Produces: `export const ADMIN_READ_TOOLS: readonly ToolDefinition[]` with, in this order,
  `agentx_admin_health`, `agentx_admin_failed_tasks`, `agentx_admin_turns`, `agentx_admin_usage`,
  `agentx_admin_list_projects`, `agentx_admin_list_channels`, `agentx_admin_list_credentials`,
  `agentx_admin_list_workspaces`; `export function adminOf(context: ToolContext): AdminControlPlaneClient`
  (25e's change tools reuse it).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/mcp-admin-tools.test.ts
// Spec 025 FR-030: the admin read tools, their inputs, outputs and text, against a fake admin client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_READ_TOOLS, DEVELOPER_TOOLS, ToolError, createAgentXMcpServer, type AdminControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const PLANTED = `xoxb-${"1".repeat(10)}-planted-bot-token`;

async function connect(admin: Partial<AdminControlPlaneClient> | undefined) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => true,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" }), now: () => 0, sleep: async () => undefined,
    newRequestId: () => "33333333-3333-4333-8333-333333333333", ...(admin === undefined ? {} : { admin: admin as AdminControlPlaneClient }),
  });
  const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: ADMIN_READ_TOOLS, adminOffer: async () => ({ admin: undefined }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(clientSide);
  await expect.poll(async () => (await client.listTools()).tools.length).toBe(DEVELOPER_TOOLS.length + ADMIN_READ_TOOLS.length);
  return client;
}

describe("the admin read tools (FR-030)", () => {
  it("are exactly FR-030's eight, each with an output schema and no em dash", async () => {
    expect(ADMIN_READ_TOOLS.map((tool) => tool.name)).toEqual([
      "agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage",
      "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces",
    ]);
    const tools = (await (await connect({})).listTools()).tools.filter((tool) => tool.name.startsWith("agentx_admin_"));
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
    expect(JSON.stringify(tools)).not.toContain("\u2014");
  });

  it("shows failed tasks with FR-030's fields, and the turn record link", async () => {
    const failures = vi.fn(async () => ({
      since: "2026-09-29T08:00:00.000Z", until: "2026-09-30T08:00:00.000Z",
      failures: [{ operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", project: "payments", origin: "ai_tool" as const,
        requester: { kind: "developer" as const, developerId: "d".repeat(64), provider: "slack" as const, name: "Maya Chen" }, kind: "prepare", status: "FAILED" as const,
        category: "setup_failed" as const, error: "npm ci exited 1", endedAt: "2026-09-30T07:00:00.000Z", taskId: "33333333-3333-4333-8333-333333333333" }],
    }));
    const client = await connect({ failures });
    const result = await client.callTool({ name: "agentx_admin_failed_tasks", arguments: { project: "payments", limit: 10 } });
    expect(failures).toHaveBeenCalledWith({ project: "payments", limit: 10 });
    expect(result.structuredContent).toEqual({
      failures: [{ time: "2026-09-30T07:00:00.000Z", project: "payments", origin: "ai_tool", requester: "`Maya Chen` (developer)", workspace_id: "22222222-2222-4222-8222-222222222222",
        operation_id: "11111111-1111-4111-8111-111111111111", operation_kind: "prepare", category: "setup_failed", error: "npm ci exited 1", turn_record: { task_id: "33333333-3333-4333-8333-333333333333" } }],
      since: "2026-09-29T08:00:00.000Z", until: "2026-09-30T08:00:00.000Z",
    });
    expect(JSON.stringify(result.content)).toContain("1 failure");
  });

  it("passes the turn filters through, with task_id as task, and hands back the next cursor", async () => {
    const turns = vi.fn(async () => ({ turns: [{ origin: "ai_tool", taskId: "33333333-3333-4333-8333-333333333333", requestText: `echo ${PLANTED}` }], cursor: "next-page" }));
    const client = await connect({ turns });
    const result = await client.callTool({ name: "agentx_admin_turns", arguments: { since: "2026-09-29T00:00:00.000Z", task_id: "33333333-3333-4333-8333-333333333333", limit: 5 } });
    expect(turns).toHaveBeenCalledWith({ since: "2026-09-29T00:00:00.000Z", task: "33333333-3333-4333-8333-333333333333", limit: 5 });
    expect(result.structuredContent).toMatchObject({ next_cursor: "next-page" });
    // FR-029: every result is redacted, whatever the control plane sent.
    expect(JSON.stringify(result)).not.toContain(PLANTED);
  });

  it("refuses thread and task_id together, and a time that is not ISO", async () => {
    const client = await connect({ turns: vi.fn() });
    expect(toolError(await client.callTool({ name: "agentx_admin_turns", arguments: { since: "2026-09-29T00:00:00.000Z", thread: "T0/C0/1.1", task_id: "33333333-3333-4333-8333-333333333333" } }))).toMatchObject({ code: "INVALID_REQUEST" });
    expect((await client.callTool({ name: "agentx_admin_turns", arguments: { since: "yesterday" } })).isError).toBe(true);
  });

  it("shows usage, projects, channels, credentials and workspaces in snake_case", async () => {
    const client = await connect({
      usage: async () => ({ groupBy: "project" as const, since: "s", until: "u", truncated: false, groups: [{ key: "payments", turns: 2, tasks: 1, taskDurationMs: 60_000, inputTokens: 10, outputTokens: 2, costUsd: 0.5, costUnknown: 0 }] }),
      projects: async () => ({ projects: [{ name: "payments", latestRevision: 2, registeredAt: "r", repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }], runtimeMode: "ec2-ebs", connectors: [], developerTasks: { enabled: true, share: "optional" as const, shareMode: { default: "view" as const, allowContinue: true }, channelMembersMayUse: true } }] }),
      bindings: async () => ({ notices: [], bindings: [{ teamId: "T0BSHLLUGBD", channelId: "C0123456789", channelName: "payments-dev", private: false, projectName: "payments", updatedAt: "t" }] }),
      credentials: async () => ({ credentials: [{ ref: "github-app", type: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:gh", builtIn: true }] }),
      workspaces: async () => ({ workspaces: [], limits: { perPerson: 3, perOrganization: 20, source: "parameters" as const }, counts: { organization: 0 }, truncated: false }),
    });
    expect((await client.callTool({ name: "agentx_admin_usage", arguments: { group_by: "project" } })).structuredContent).toMatchObject({ groups: [{ key: "payments", turns: 2, tasks: 1, task_duration_ms: 60_000, input_tokens: 10, output_tokens: 2, cost_usd: 0.5, cost_unknown: 0 }] });
    expect((await client.callTool({ name: "agentx_admin_list_projects", arguments: {} })).structuredContent).toMatchObject({ projects: [{ name: "payments", latest_revision: 2, runtime_mode: "ec2-ebs", developer_tasks: { share: "optional" } }] });
    expect((await client.callTool({ name: "agentx_admin_list_channels", arguments: {} })).structuredContent).toMatchObject({ bindings: [{ channel_id: "C0123456789", channel_name: "payments-dev", project: "payments" }] });
    expect((await client.callTool({ name: "agentx_admin_list_credentials", arguments: {} })).structuredContent).toMatchObject({ credentials: [{ ref: "github-app", type: "github-app", built_in: true }] });
    expect((await client.callTool({ name: "agentx_admin_list_workspaces", arguments: {} })).structuredContent).toMatchObject({ limits: { per_person: 3, per_organization: 20, source: "parameters" } });
  });

  it("answers ADMIN_REQUIRED when the server holds no admin client", async () => {
    const client = await connect(undefined);
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED", next_step: "run npx @charterarc/agentx login --admin" });
  });

  it("passes a refusal through as its tool error", async () => {
    const client = await connect({ health: async () => { throw new ToolError("ADMIN_REQUIRED", "AgentX refused this computer's admin sign-in, or it has expired", "run npx @charterarc/agentx login --admin"); } });
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-admin-tools.test.ts`
Expected: FAIL: `ADMIN_READ_TOOLS` is not exported.

- [ ] **Step 3: Write the tools**

```ts
// packages/mcp/src/admin-tools.ts
// Spec 025 FR-030: the admin read tools. They change nothing and need no confirmation (US5); the
// server offers them only while an admin sign-in is held (FR-028, A15). Every result goes through
// the server's redaction and caps (FR-029, A16).
import {
  ADMIN_FAILURES_DEFAULT_LIMIT, ADMIN_LIST_MAX, ADMIN_WORKSPACES_DEFAULT_LIMIT, AdminUsageGroupBySchema, WorkspaceStatusSchema, inertName,
  type AdminRequester,
} from "@agentx/contracts";
import { z } from "zod";
import { ADMIN_SIGN_IN_STEP, type AdminControlPlaneClient } from "./admin-client.js";
import { ToolError } from "./errors.js";
import type { ToolContext, ToolDefinition } from "./tools.js";

export function adminOf(context: ToolContext): AdminControlPlaneClient {
  if (context.admin === undefined) throw new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);
  return context.admin;
}

const time = z.string().datetime({ offset: true });
const limitInput = (fallback: number) => z.number().int().min(1).max(ADMIN_LIST_MAX).optional().describe(`how many to show, 1 to 100; ${fallback} by default`);
const projectInput = z.string().min(1).max(63).optional().describe("only this project, by its exact name");
const given = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };

function requesterText(requester: AdminRequester): string {
  if (requester.kind === "slack") return `Slack member ${requester.userId}`;
  if (requester.kind === "developer") return `${requester.name === undefined ? requester.developerId.slice(0, 12) : inertName(requester.name)} (developer)`;
  return "nobody recorded";
}

export const ADMIN_READ_TOOLS: readonly ToolDefinition[] = [
  {
    name: "agentx_admin_health",
    title: "Check AgentX health",
    description: "Shows whether AgentX is healthy: the API versions, the environment's alarms and their states, dead-letter queue depths, whether the Slack bot token and the GitHub App work, the worker mode and its latest dispatch failure, and open workspaces by status. Use it first when something seems wrong; then look at agentx_admin_failed_tasks for what failed.",
    inputSchema: {},
    outputSchema: {
      version: z.object({ developer_api: z.string(), admin_api: z.string(), release: z.string().optional() }),
      alarms: z.array(z.object({ name: z.string(), state: z.string() })), alarms_check: z.object({ status: z.string(), detail: z.string().optional() }),
      dead_letter_queues: z.array(z.object({ name: z.string(), depth: z.number().nullable() })),
      slack: z.object({ status: z.string(), detail: z.string().optional() }), github: z.object({ status: z.string(), detail: z.string().optional() }),
      worker_modes: z.array(z.object({ mode: z.string(), configured: z.boolean(), latest_dispatch_failure: z.object({ at: z.string(), operation_id: z.string(), error: z.string() }).optional() })),
      workspaces: z.record(z.string(), z.number()), workspaces_truncated: z.boolean(),
    },
    async handler(context) {
      const health = await adminOf(context).health();
      const firing = health.alarms.filter((alarm) => alarm.state === "ALARM").map((alarm) => alarm.name);
      return {
        structured: {
          version: given({ developer_api: health.version.developerApi, admin_api: health.version.adminApi, release: health.version.release }),
          alarms: health.alarms, alarms_check: health.alarmsCheck, dead_letter_queues: health.deadLetterQueues, slack: health.slack, github: health.github,
          worker_modes: health.workerModes.map((mode) => given({ mode: mode.mode, configured: mode.configured, latest_dispatch_failure: mode.latestDispatchFailure === undefined ? undefined : { at: mode.latestDispatchFailure.at, operation_id: mode.latestDispatchFailure.operationId, error: mode.latestDispatchFailure.error } })),
          workspaces: health.workspaces, workspaces_truncated: health.workspacesTruncated,
        },
        text: `AgentX API ${health.version.developerApi}, admin API ${health.version.adminApi}. Alarms: ${firing.length === 0 ? "none firing" : `in ALARM: ${firing.join(", ")}`}. Slack: ${health.slack.status}. GitHub App: ${health.github.status}. Open workspaces: ${Object.entries(health.workspaces).map(([status, count]) => `${status} ${count}`).join(", ") || "none"}.`,
      };
    },
  },
  {
    name: "agentx_admin_failed_tasks",
    title: "List failed AgentX tasks",
    description: "Lists operations that ended FAILED or INTERRUPTED, newest first: when, the project, where it came from (slack or ai_tool), who asked, the workspace, the operation kind, the failure category and the redacted error. since defaults to 24 hours ago; AgentX keeps 30 days. To see what happened around a failure, pass its turn_record's thread or task_id to agentx_admin_turns.",
    inputSchema: {
      since: time.optional().describe("ISO time to start from; 24 hours ago by default"),
      until: time.optional().describe("ISO time to stop at; now by default"),
      project: projectInput,
      limit: limitInput(ADMIN_FAILURES_DEFAULT_LIMIT),
    },
    outputSchema: {
      failures: z.array(z.object({
        time: z.string(), project: z.string(), origin: z.string(), requester: z.string(), workspace_id: z.string(), operation_id: z.string(),
        operation_kind: z.string(), category: z.string(), error: z.string(), turn_record: z.object({ thread: z.string().optional(), task_id: z.string().optional() }),
      })),
      since: z.string(), until: z.string(),
    },
    async handler(context, input) {
      const answer = await adminOf(context).failures(given({ since: input.since as string | undefined, until: input.until as string | undefined, project: input.project as string | undefined, limit: input.limit as number | undefined }));
      const failures = answer.failures.map((failure) => ({
        time: failure.endedAt, project: failure.project, origin: failure.origin, requester: requesterText(failure.requester), workspace_id: failure.workspaceId, operation_id: failure.operationId,
        operation_kind: failure.kind, category: failure.category, error: failure.error, turn_record: given({ thread: failure.thread, task_id: failure.taskId }),
      }));
      const byCategory = new Map<string, number>();
      for (const failure of failures) byCategory.set(failure.category, (byCategory.get(failure.category) ?? 0) + 1);
      return {
        structured: { failures, since: answer.since, until: answer.until },
        text: failures.length === 0 ? `No failures from ${answer.since} to ${answer.until}.` : `${failures.length} failure${failures.length === 1 ? "" : "s"} from ${answer.since} to ${answer.until}: ${[...byCategory].map(([category, count]) => `${category} ${count}`).join(", ")}.`,
      };
    },
  },
  {
    name: "agentx_admin_turns",
    title: "Read AgentX turn records",
    description: "Reads turn records, newest first: what each Slack turn was asked, offered, chose and answered, and each action from an AI tool. They hold request and response text, already redacted. Narrow them with until, project, origin (slack or ai_tool), thread (a Slack thread subject) or task_id (a task's own records and its channel turns); send next_cursor back as cursor for more. since is required; AgentX keeps 30 days.",
    inputSchema: {
      since: time.describe("ISO time to start from, within the last 30 days"),
      until: time.optional().describe("ISO time to stop at"),
      project: projectInput,
      origin: z.enum(["slack", "ai_tool"]).optional().describe("only Slack turns, or only actions from AI tools"),
      thread: z.string().min(1).max(128).optional().describe("a Slack thread subject such as T0123456789/C0123456789/1695500000.000100"),
      task_id: z.string().uuid().optional().describe("a task's ID: its own records and its channel turns"),
      limit: limitInput(ADMIN_LIST_MAX),
      cursor: z.string().min(1).max(2_048).optional().describe("next_cursor from the previous call"),
    },
    outputSchema: { turns: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().optional(), skipped: z.number().optional() },
    async handler(context, input) {
      if (input.thread !== undefined && input.task_id !== undefined) throw new ToolError("INVALID_REQUEST", "send thread or task_id, not both");
      const page = await adminOf(context).turns(given({
        since: input.since as string, until: input.until as string | undefined, project: input.project as string | undefined, origin: input.origin as "slack" | "ai_tool" | undefined,
        thread: input.thread as string | undefined, task: input.task_id as string | undefined, limit: input.limit as number | undefined, cursor: input.cursor as string | undefined,
      }));
      return {
        structured: given({ turns: page.turns, next_cursor: page.cursor, skipped: page.skipped }),
        text: `${page.turns.length} turn record${page.turns.length === 1 ? "" : "s"}.${page.cursor === undefined ? "" : " More remain: call again with cursor set to next_cursor."}`,
      };
    },
  },
  {
    name: "agentx_admin_usage",
    title: "Show AgentX usage",
    description: "Adds up AgentX usage per project, requester, origin or day: Slack turns, worker tasks, total task time, model input and output tokens, and cost in US dollars as the usage records carry it (a cost the provider did not give is counted in cost_unknown). since defaults to 7 days ago; AgentX keeps 30 days.",
    inputSchema: {
      group_by: AdminUsageGroupBySchema.describe("project, requester, origin or day"),
      since: time.optional().describe("ISO time to start from; 7 days ago by default"),
      until: time.optional().describe("ISO time to stop at; now by default"),
    },
    outputSchema: {
      group_by: z.string(), since: z.string(), until: z.string(), truncated: z.boolean(),
      groups: z.array(z.object({ key: z.string(), turns: z.number(), tasks: z.number(), task_duration_ms: z.number(), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number(), cost_unknown: z.number() })),
    },
    async handler(context, input) {
      const usage = await adminOf(context).usage(given({ groupBy: input.group_by as "project", since: input.since as string | undefined, until: input.until as string | undefined }));
      const groups = usage.groups.map((group) => ({ key: group.key, turns: group.turns, tasks: group.tasks, task_duration_ms: group.taskDurationMs, input_tokens: group.inputTokens, output_tokens: group.outputTokens, cost_usd: group.costUsd, cost_unknown: group.costUnknown }));
      const total = groups.reduce((sum, group) => sum + group.cost_usd, 0);
      return {
        structured: { group_by: usage.groupBy, since: usage.since, until: usage.until, truncated: usage.truncated, groups },
        text: `${groups.length} group${groups.length === 1 ? "" : "s"} by ${usage.groupBy}, about $${total.toFixed(2)} in all${usage.truncated ? ", from the first 5,000 records of each kind" : ""}.`,
      };
    },
  },
  {
    name: "agentx_admin_list_projects",
    title: "List AgentX projects (admin)",
    description: "Lists every registered project an admin can see: its latest revision, when it was registered, its repositories, worker mode, connectors, and its policy for tasks from AI tools. Use it before changing a project, or to find why a developer cannot use one.",
    inputSchema: {},
    outputSchema: {
      projects: z.array(z.object({
        name: z.string(), latest_revision: z.number(), registered_at: z.string(), repositories: z.array(z.object({ name: z.string(), url: z.string() })),
        runtime_mode: z.string(), connectors: z.array(z.object({ name: z.string(), type: z.string() })),
        developer_tasks: z.object({ enabled: z.boolean(), share: z.string(), share_mode: z.object({ default: z.string(), allow_continue: z.boolean() }), channel_members_may_use: z.boolean() }),
      })),
    },
    async handler(context) {
      const { projects } = await adminOf(context).projects();
      return {
        structured: { projects: projects.map((project) => ({
          name: project.name, latest_revision: project.latestRevision, registered_at: project.registeredAt, repositories: project.repositories, runtime_mode: project.runtimeMode, connectors: project.connectors,
          developer_tasks: { enabled: project.developerTasks.enabled, share: project.developerTasks.share, share_mode: { default: project.developerTasks.shareMode.default, allow_continue: project.developerTasks.shareMode.allowContinue }, channel_members_may_use: project.developerTasks.channelMembersMayUse },
        })) },
        text: projects.length === 0 ? "No registered projects." : projects.map((project) => `${project.name} revision ${project.latestRevision}`).join(", "),
      };
    },
  },
  {
    name: "agentx_admin_list_channels",
    title: "List AgentX channel bindings",
    description: "Lists the Slack channels bound to projects: the channel's ID, its name when it is public or when your linked Slack user is a member of the private channel (otherwise a private channel is shown by ID only), the project, and when the binding last changed.",
    inputSchema: {},
    outputSchema: { bindings: z.array(z.object({ channel_id: z.string(), channel_name: z.string().optional(), private: z.boolean().optional(), project: z.string(), updated_at: z.string() })), notices: z.array(z.string()) },
    async handler(context) {
      const answer = await adminOf(context).bindings();
      const bindings = answer.bindings.map((binding) => given({ channel_id: binding.channelId, channel_name: binding.channelName, private: binding.private, project: binding.projectName, updated_at: binding.updatedAt }));
      const note = answer.notices.includes("channel_names_unavailable") ? " Channel names could not be read, so channels are listed by ID." : "";
      return { structured: { bindings, notices: answer.notices }, text: `${bindings.length} bound channel${bindings.length === 1 ? "" : "s"}.${note}` };
    },
  },
  {
    name: "agentx_admin_list_credentials",
    title: "List AgentX connector credentials",
    description: "Lists connector credentials by reference, type and secret name, and when each was registered. It never shows a secret's value.",
    inputSchema: {},
    outputSchema: { credentials: z.array(z.object({ ref: z.string(), type: z.string(), secret_name: z.string(), registered_at: z.string().optional(), built_in: z.boolean().optional() })) },
    async handler(context) {
      const { credentials } = await adminOf(context).credentials();
      return {
        structured: { credentials: credentials.map((entry) => given({ ref: entry.ref, type: entry.type, secret_name: entry.secretName, registered_at: entry.registeredAt, built_in: entry.builtIn })) },
        text: `${credentials.length} credential${credentials.length === 1 ? "" : "s"}: ${credentials.map((entry) => `${entry.ref} (${entry.type})`).join(", ")}.`,
      };
    },
  },
  {
    name: "agentx_admin_list_workspaces",
    title: "List AgentX workspaces",
    description: "Lists workspaces, newest activity first: the ID, project, origin, owner (a Slack thread link, or the developer who started the task), status and last activity, with the current workspace limits and counts. Closed workspaces are left out unless status is CLOSED. A task's title and results stay private to its developer.",
    inputSchema: {
      project: projectInput,
      status: WorkspaceStatusSchema.optional().describe("only workspaces with this status"),
      limit: limitInput(ADMIN_WORKSPACES_DEFAULT_LIMIT),
    },
    outputSchema: {
      workspaces: z.array(z.object({ id: z.string(), project: z.string(), origin: z.string(), owner: z.object({ thread_url: z.string().optional(), task_id: z.string().optional(), developer: z.string().optional() }), status: z.string(), busy: z.boolean(), last_activity_at: z.string() })),
      limits: z.object({ per_person: z.number(), per_organization: z.number(), source: z.string() }),
      counts: z.object({ organization: z.number(), developer_organization: z.number().optional() }),
      truncated: z.boolean(),
    },
    async handler(context, input) {
      const answer = await adminOf(context).workspaces(given({ project: input.project as string | undefined, status: input.status as string | undefined, limit: input.limit as number | undefined }));
      return {
        structured: {
          workspaces: answer.workspaces.map((workspace) => ({
            id: workspace.id, project: workspace.project, origin: workspace.origin,
            owner: given({ thread_url: workspace.owner.threadUrl, task_id: workspace.owner.taskId, developer: workspace.owner.developerName === undefined ? undefined : inertName(workspace.owner.developerName) }),
            status: workspace.status, busy: workspace.busy, last_activity_at: workspace.lastActivityAt,
          })),
          limits: { per_person: answer.limits.perPerson, per_organization: answer.limits.perOrganization, source: answer.limits.source },
          counts: given({ organization: answer.counts.organization, developer_organization: answer.counts.developerOrganization }),
          truncated: answer.truncated,
        },
        text: `${answer.workspaces.length} workspace${answer.workspaces.length === 1 ? "" : "s"}${answer.truncated ? " shown; more exist" : ""}. Limits: ${answer.limits.perPerson} per person, ${answer.limits.perOrganization} for the organization (${answer.limits.source === "setting" ? "set by an admin" : "install defaults"}).`,
      };
    },
  },
];
```

Export it from `packages/mcp/src/index.ts`. `inertName` marks a developer's display name as data,
as 25c's `channel_turns` do, so a name cannot read as an instruction to the model.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/mcp-admin-tools.test.ts tests/contract/mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/admin-tools.ts packages/mcp/src/index.ts tests/contract/mcp-admin-tools.test.ts
git commit -m "feat(mcp): the eight admin read tools (spec 025 phase 25d)"
```

---

### Task 16: `agentx mcp` uses this computer's admin sign-in

A14, and A1's `agentx_whoami` notice. **Depends on Q4** (no refresh of the admin sign-in).

**Files:**
- Modify: `packages/cli/src/mcp/serve.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/mcp/src/tools.ts` (`agentx_whoami`'s notice)
- Test: `tests/contract/mcp-admin-session.test.ts`

**Interfaces:**
- Consumes: `httpAdminClient`, `ADMIN_SIGN_IN_STEP`, `adminApiFits`, `AdminOffer`, `ToolError`,
  `UPGRADE_AGENTX_STEP`, `ADMIN_READ_TOOLS` (Tasks 14, 15); `resolveDeveloperEnvironment`
  (developer/config.ts); the CLI's `deploymentSettings` and `tokenStoreKey`.
- Produces: `McpServeDeps.adminSession(env: string | undefined): Promise<AdminSession | undefined>`
  (undefined: no unexpired admin sign-in); `adminSignedIn` is kept and now answers
  `(await adminSession(env)) !== undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/mcp-admin-session.test.ts
// Spec 025 A14: agentx mcp offers the admin tools with this computer's unexpired admin sign-in, and
// hides them once it expires.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { saveDeveloperEnvironment, developerTokenKey } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { toolError } from "../support/mcp-tool-error.js";

const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_BASE}/v1/auth`;
const ADMIN_TOKEN = "admin-access-token-planted-4f2a";

async function server(options: { admin?: { expiresAt: number }; adminApiVersion?: string }) {
  const home = await mkdtemp(join(tmpdir(), "agentx-admin-mcp-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.2", ...(options.adminApiVersion === undefined ? {} : { adminApiVersion: options.adminApiVersion }) });
    if (url.pathname === "/v1/admin/projects") return Response.json({ projects: [] });
    return Response.json({ developer: { id: "d".repeat(64), name: "Ada", provider: "slack" }, projects: [], notices: [] });
  });
  const stderr: string[] = [];
  const mcp = agentxMcpServer({
    home, tokenStore, fetch: fetch as never, stderr: { write: (text: string) => stderr.push(text) },
    adminSignedIn: async () => options.admin !== undefined && options.admin.expiresAt > Date.now(),
    adminSession: async () => (options.admin !== undefined && options.admin.expiresAt > Date.now() ? { baseUrl: URL_BASE, accessToken: ADMIN_TOKEN } : undefined),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  return { client, fetch, stderr };
}

describe("agentx mcp and the admin sign-in (A14)", () => {
  it("offers the admin tools with an unexpired admin sign-in, and calls /v1/admin/* with it", async () => {
    const admin = { expiresAt: Date.now() + 600_000 };
    const { client, fetch, stderr } = await server({ admin, adminApiVersion: "1.0" });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_list_projects")).toBe(true);
    const result = await client.callTool({ name: "agentx_admin_list_projects", arguments: {} });
    expect(result.structuredContent).toEqual({ projects: [] });
    const call = fetch.mock.calls.find((entry) => String(entry[0]).endsWith("/v1/admin/projects")) as unknown as [string, RequestInit];
    expect(new Headers(call[1].headers).get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(stderr.join("")).not.toContain(ADMIN_TOKEN);
  });

  it("hides them, and answers ADMIN_REQUIRED, once the admin sign-in has expired", async () => {
    const admin = { expiresAt: Date.now() + 600_000 };
    const { client } = await server({ admin, adminApiVersion: "1.0" });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(19);
    admin.expiresAt = Date.now() - 1;
    await client.callTool({ name: "agentx_whoami", arguments: {} });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(11);
    expect(toolError(await client.callTool({ name: "agentx_admin_list_projects", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED", next_step: "run npx @charterarc/agentx login --admin" });
  });

  it("offers no admin tool against a control plane without the admin API, and whoami says why", async () => {
    const { client } = await server({ admin: { expiresAt: Date.now() + 600_000 } });
    expect((await client.listTools()).tools).toHaveLength(11);
    const whoami = await client.callTool({ name: "agentx_whoami", arguments: {} });
    expect(JSON.stringify(whoami.content)).toContain("AgentX has no admin tools yet; ask your AgentX admin to upgrade AgentX");
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
  });
});
```

Nineteen tools is the eleven developer tools and the eight admin read tools.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-admin-session.test.ts`
Expected: FAIL: `adminSession` is not read, and no admin tool is ever offered.

- [ ] **Step 3: Serve the admin tools**

In `packages/cli/src/mcp/serve.ts`, add to `McpServeDeps`:

```ts
  /** Spec 025 A14: this computer's unexpired admin sign-in for the environment, or undefined. Never refreshed (Q4). */
  adminSession(env: string | undefined): Promise<AdminSession | undefined>;
```

and in `agentxMcpServer`:

```ts
  const admin = httpAdminClient({
    fetch: deps.fetch,
    session: async () => {
      const session = await deps.adminSession(deps.env);
      if (session === undefined) throw new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);
      return session;
    },
  });
  const adminOffer = async (): Promise<AdminOffer> => {
    if ((await deps.adminSession(deps.env)) === undefined) return { admin: new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP) };
    const fit = adminApiFits((await compatibility()).adminApiVersion);
    if (fit !== "fits") return { admin: new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin tools for this CLI yet", fit === "incompatible" ? NEXT_STEPS.UPGRADE_REQUIRED : UPGRADE_AGENTX_STEP) };
    return { admin: undefined };
  };
```

pass `adminTools: ADMIN_READ_TOOLS, adminOffer` to `createAgentXMcpServer`, and `admin` in the
context object. `compatibility` is the server's existing checker (its 10-minute cache holds, so
the 30-second offer check does not read the configuration each time).

In `packages/cli/src/main.ts`, replace `adminSignedIn` with:

```ts
  /** R24 and spec 025 A14: this computer's unexpired admin sign-in for the developer's environment. */
  const adminSession = async (env: string | undefined): Promise<AdminSession | undefined> => {
    try {
      const name = (await resolveDeveloperEnvironment(home, env)).env;
      const settings = await deploymentSettings({ ...globalOptions(program), env: name });
      const tokens = await services.tokenStore.get(tokenStoreKey(settings.auth));
      return tokens !== undefined && tokens.expiresAt > Date.now() ? { baseUrl: settings.controlPlaneUrl.replace(/\/$/, ""), accessToken: tokens.accessToken } : undefined;
    } catch {
      return undefined;
    }
  };
  const adminSignedIn = async (env: string | undefined): Promise<boolean> => (await adminSession(env)) !== undefined;
```

and pass `adminSession` to `runMcpServer` beside `adminSignedIn`.

- [ ] **Step 4: `agentx_whoami`'s notice**

In `packages/mcp/src/tools.ts`, in `agentx_whoami`'s handler, after the existing text, add
`" AgentX has no admin tools yet; ask your AgentX admin to upgrade AgentX."` when `admin` is true
and `adminApiFits(compatibility.adminApiVersion)` is not `"fits"`. The structured output is
unchanged.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/mcp-admin-session.test.ts tests/contract/mcp-stdio.test.ts tests/contract/mcp-developer-flow.test.ts tests/contract/mcp-tools.test.ts && npm run typecheck`
Expected: PASS. `tests/support/mcp-broker-client.ts` passes `adminSignedIn: async () => false`;
give it `adminSession: async () => undefined` too, so its developer flow sees the same eleven
tools.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/mcp/serve.ts packages/cli/src/main.ts packages/mcp/src/tools.ts tests/support/mcp-broker-client.ts tests/contract/mcp-admin-session.test.ts
git commit -m "feat(cli): agentx mcp offers the admin read tools with this computer's admin sign-in (spec 025 phase 25d)"
```

---
### Task 17: Admin reads end to end, and SC-004's sweep

User Story 5's Independent Test: the MCP SDK's client drives `agentx mcp`'s server against the
broker in process, as an admin and as a developer, with every read tool compared against its
committed expected result; SC-004 plants secrets in every source the tools read.

**Files:**
- Modify: `tests/support/mcp-broker-client.ts` (`adminSignedInClient`)
- Test: `tests/contract/mcp-admin-flow.test.ts`

**Interfaces:**
- Consumes: everything above; `createAdminReadBroker` (Task 2), `recordStream`, `MAYA`
  (developer-task-broker.ts), `indexActivity` (Task 4).
- Produces: `export const ADMIN_TOKEN = "admin-token-for-mcp-tests-7d1c";`,
  `export const NON_ADMIN_TOKEN = "cognito-user-without-admin-group-2b9e";` and
  `export async function adminSignedInClient(harness, options: { adminToken?: string; who?: Developer }): Promise<{ tool(name, args?): Promise<ToolAnswer>; names(): Promise<string[]>; stderr: string[]; answers: string[] }>`.

- [ ] **Step 1: The admin-signed-in client**

In `tests/support/mcp-broker-client.ts`, widen `mcpBrokerFetch` so `/v1/admin/*` requests act as API
Gateway's JWT authorizer does: `Bearer ADMIN_TOKEN` reaches the broker with the claims
`{ iss: issuer, sub: "admin-subject", groups: ["admins"] }`, `Bearer NON_ADMIN_TOKEN` with the same
claims but `groups: []`, and any other bearer (a developer token) is answered `401
{"message":"Unauthorized"}` without reaching the broker. The configuration answer gains
`adminApiVersion: "1.0"`. Then add:

```ts
export const ADMIN_TOKEN = "admin-token-for-mcp-tests-7d1c";
export const NON_ADMIN_TOKEN = "cognito-user-without-admin-group-2b9e";

/** Spec 025 phase 25d: `agentx mcp` with a developer sign-in and, unless `adminToken` is null, an admin sign-in. */
export async function adminSignedInClient(harness: Harness, options: { adminToken?: string | null; who?: Developer } = {}) {
  const home = await mkdtemp(join(tmpdir(), "agentx-mcp-admin-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: DEV_ISSUER, tokenEndpoint: `${DEV_ISSUER}/token`, revocationEndpoint: `${DEV_ISSUER}/revoke` });
  const developerToken = (await bearerFor(options.who ?? MAYA)).slice("Bearer ".length);
  await tokenStore.set(developerTokenKey(DEV_ISSUER), { accessToken: developerToken, refreshToken: REFRESH_TOKEN, expiresAt: Date.now() + 3_600_000 });
  const adminToken = options.adminToken === null ? undefined : options.adminToken ?? ADMIN_TOKEN;
  const stderr: string[] = [];
  const server = agentxMcpServer({
    home, tokenStore, fetch: mcpBrokerFetch(harness), stderr: { write: (text: string) => stderr.push(text) },
    adminSignedIn: async () => adminToken !== undefined,
    adminSession: async () => (adminToken === undefined ? undefined : { baseUrl: URL_BASE, accessToken: adminToken }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  const answers: string[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const result = await client.callTool({ name, arguments: args });
    answers.push(JSON.stringify(result));
    return result.isError === true ? { isError: true, value: {}, error: toolError(result) } : { isError: false, value: result.structuredContent as Record<string, unknown> };
  };
  const names = async () => (await client.listTools()).tools.map((entry) => entry.name);
  return { tool, names, stderr, answers, developerToken };
}
```

- [ ] **Step 2: Write the test**

```ts
// tests/contract/mcp-admin-flow.test.ts
// Spec 025 User Story 5 and SC-004, end to end: agentx mcp's server, the broker in process, an admin
// sign-in and a developer sign-in. Each read tool's result is compared with the expected result
// committed here (US5's "committed snapshot"; never regenerated, never vitest -u).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA, recordStream } from "../support/developer-task-broker.js";
import { ADMIN_TOKEN, NON_ADMIN_TOKEN, adminSignedInClient } from "../support/mcp-broker-client.js";

const PLANTED = [`ghp_${"Q".repeat(36)}`, `xoxb-${"2".repeat(12)}-planted`, `agxr_${"z".repeat(43)}`];
const ADMIN_TOOLS = ["agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage", "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces"];
/** Times and IDs change each run; everything else is compared as committed. */
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")) as unknown;

async function failedTask() {
  const harness = await createAdminReadBroker();
  const stream = recordStream(harness.db);
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(task.workspaceId, prepareId, "FAILED", { error: `npm ci exited 1 (token ${PLANTED[0]})` });
  // What the outbox publisher does with the same stream records (A4).
  await indexActivity(stream.take(), { get: async (key) => harness.db.get(key.pk, key.sk), put: async (item) => harness.db.set(item) }, () => undefined);
  return { harness, taskId };
}

describe("an admin looks at AgentX from an AI tool (US5)", () => {
  it("lists the admin read tools for an admin, answers each with no confirmation, and matches the committed results", async () => {
    const { harness, taskId } = await failedTask();
    const mcp = await adminSignedInClient(harness);
    await expect.poll(async () => (await mcp.names()).filter((name) => name.startsWith("agentx_admin_"))).toEqual(ADMIN_TOOLS);

    const failed = await mcp.tool("agentx_admin_failed_tasks");
    expect(normalized(failed.value)).toEqual({
      failures: [{
        time: "<time>", project: "payments", origin: "ai_tool", requester: "`Maya Chen` (developer)", workspace_id: "<uuid>", operation_id: "<uuid>",
        operation_kind: "prepare", category: "setup_failed", error: "npm ci exited 1 (token [REDACTED])", turn_record: { task_id: "<uuid>" },
      }],
      since: "<time>", until: "<time>",
    });
    expect((failed.value.failures as Array<{ turn_record: { task_id: string } }>)[0]?.turn_record.task_id).toBe(taskId);

    const turns = await mcp.tool("agentx_admin_turns", { since: new Date(Date.now() - 3_600_000).toISOString(), task_id: taskId });
    expect((turns.value.turns as Array<{ action: string; phase: string }>).map((turn) => `${turn.action}:${turn.phase}`)).toContain("start:accepted");

    expect(normalized((await mcp.tool("agentx_admin_list_projects")).value)).toEqual({ projects: [{
      name: "payments", latest_revision: 1, registered_at: "<time>", repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }], runtime_mode: "ec2-ebs", connectors: [],
      developer_tasks: { enabled: true, share: "optional", share_mode: { default: "view", allow_continue: true }, channel_members_may_use: true },
    }] });
    expect(normalized((await mcp.tool("agentx_admin_list_channels")).value)).toEqual({ bindings: [{ channel_id: "C0123456789", channel_name: "payments-dev", private: false, project: "payments", updated_at: "<time>" }], notices: [] });
    expect(normalized((await mcp.tool("agentx_admin_list_workspaces")).value)).toEqual({
      workspaces: [{ id: "<uuid>", project: "payments", origin: "ai_tool", owner: { task_id: "<uuid>", developer: "`Maya Chen`" }, status: "PREPARATION_FAILED", busy: false, last_activity_at: "<time>" }],
      limits: { per_person: 3, per_organization: 20, source: "parameters" }, counts: { organization: 1 }, truncated: false,
    });
    expect((await mcp.tool("agentx_admin_usage", { group_by: "origin" })).value).toMatchObject({ group_by: "origin", truncated: false });
    expect((await mcp.tool("agentx_admin_health")).value).toMatchObject({ version: { developer_api: "1.2", admin_api: "1.0" }, worker_modes: [{ mode: "ec2-ebs", configured: true }] });
    expect((await mcp.tool("agentx_admin_list_credentials")).value).toMatchObject({ credentials: expect.any(Array) as unknown });
  });

  it("offers no admin tool to a developer without an admin sign-in, and refuses a direct call with ADMIN_REQUIRED", async () => {
    const { harness } = await failedTask();
    const mcp = await adminSignedInClient(harness, { adminToken: null });
    expect((await mcp.names()).filter((name) => name.startsWith("agentx_admin_"))).toEqual([]);
    for (const name of ADMIN_TOOLS) expect((await mcp.tool(name, name === "agentx_admin_turns" ? { since: new Date().toISOString() } : name === "agentx_admin_usage" ? { group_by: "day" } : {})).error, name).toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("answers ADMIN_REQUIRED for a sign-in without the admin claim, and for a developer token sent as one", async () => {
    const { harness } = await failedTask();
    const notAdmin = await adminSignedInClient(harness, { adminToken: NON_ADMIN_TOKEN });
    await expect.poll(async () => (await notAdmin.names()).includes("agentx_admin_health")).toBe(true);
    expect((await notAdmin.tool("agentx_admin_health")).error).toMatchObject({ code: "ADMIN_REQUIRED" });
    const confused = await adminSignedInClient(harness, { adminToken: (await adminSignedInClient(harness)).developerToken });
    await expect.poll(async () => (await confused.names()).includes("agentx_admin_health")).toBe(true);
    expect((await confused.tool("agentx_admin_list_projects")).error).toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("carries no planted secret in any admin result or log line (SC-004)", async () => {
    const { harness } = await failedTask();
    // A turn record written by an older release, before its text was redacted.
    const at = new Date(Date.now() - 60_000).toISOString();
    harness.db.set({
      pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000100", sk: `TURN#${at}#EvPLANT00001`, exportPk: "TURNS", exportSk: `${at}#EvPLANT00001`, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], eventId: "EvPLANT00001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000100", receivedAt: at,
      requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered", startedAt: at, finishedAt: at, durationMs: 1,
      requestText: `use ${PLANTED[1]} and ${PLANTED[2]}`, responseText: `done with ${PLANTED[0]}`,
    });
    const mcp = await adminSignedInClient(harness);
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_turns")).toBe(true);
    for (const name of ADMIN_TOOLS) await mcp.tool(name, name === "agentx_admin_turns" ? { since: new Date(Date.now() - 3_600_000).toISOString() } : name === "agentx_admin_usage" ? { group_by: "project" } : {});
    for (const secret of [...PLANTED, ADMIN_TOKEN]) {
      expect(mcp.answers.join("\n")).not.toContain(secret);
      expect(mcp.stderr.join("")).not.toContain(secret);
    }
  });
});
```

The first test's task never ran (its prepare failed), so the failure is `setup_failed` on
`prepare`, and the workspace is `PREPARATION_FAILED` with the organization counter still charged
(FR-020: only a close releases it). The bound channel's name, `payments-dev`, is
`createDeveloperTaskBroker`'s channel-info fake's. A developer's name comes back marked inert
(`inertName`: in backticks), as 25c's channel turns do.

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/contract/mcp-admin-flow.test.ts tests/contract/mcp-developer-flow.test.ts tests/contract/shared-task-flow.test.ts`
Expected: PASS. A failure here is a defect in the task that owns the code: fix it there, with its
own failing test first, never by loosening this file's expectations.

- [ ] **Step 4: Commit**

```bash
git add tests/support/mcp-broker-client.ts tests/contract/mcp-admin-flow.test.ts
git commit -m "test(spec-025): admin reads end to end, and SC-004's sweep over every admin source"
```

---

### Task 18: Record the rulings and the owner's answers in the spec

This task changes no code. It writes this plan's rulings, and the owner's answers to
[phase-25d-questions.md](phase-25d-questions.md) as given (not as recommended, where the owner
chose otherwise), into the spec, so the spec and the code agree. If an answer differs from the
recommendation this plan followed, stop: the owning task changes first (with its test), then this
task records it.

**Files:**
- Modify: `specs/025-mcp-server/spec.md`
- Modify: `specs/025-mcp-server/plans/README.md`

- [ ] **Step 1: Amend the spec**
  - FR-028: "The admin tools are offered only while the control plane also reports a fitting admin
    API version (`adminApiVersion` in `/v1/auth/.well-known/agentx-configuration`, `1.0` from phase
    25d); against a control plane without one, the developer tools keep working and
    `agentx_whoami` says an AgentX upgrade adds the admin tools. A direct call to a hidden admin
    tool answers `ADMIN_REQUIRED`, or `UPGRADE_REQUIRED` when AgentX is the older side." (Q1, A1, A15.)
  - FR-030: `agentx_admin_turns`: "`thread` or `task_id`; `task_id` matches the task's own records
    and the channel turns that carry its ID"; `agentx_admin_failed_tasks`: "turn record link: the
    thread subject or the task ID to pass to `agentx_admin_turns`"; `agentx_admin_list_channels`:
    "a private channel's name only when the admin's linked Slack user is a member of it, else its ID" (Q7 as answered); `agentx_admin_usage`: what `turns`, `tasks` and
    `cost_unknown` count (Q6, A9).
  - FR-038: "The failure index, and a usage index of workers' usage events, are written by the
    outbox publisher from the state table's stream, best effort (a failed index write never delays
    dispatch), and expire 30 days on: by the State table's TTL on `indexExpiresAt` in installed
    environments, and by the session reconciler in the legacy deployment (Q5 as answered, A4, A6). The admin project list
    is a project catalog written at each registration, together with the environment team's bound
    projects and the caller's own memberships; no route scans the table (Q2, A3).
    `GET /v1/admin/me` names the admin's verified email from the token, or from the admin issuer's
    `userinfo` endpoint, and whether it matches one Slack user (Q3, A12)."
  - FR-048: "`/v1/auth/.well-known/agentx-configuration` also reports `adminApiVersion`."
  - Decisions: add **D28** (A1: the admin API's own version, and why not `DEVELOPER_API_VERSION`
    1.3), **D29** (A4, A6: the stream-derived indexes in the outbox publisher, and why not a third
    stream reader or a write in every operation path; their TTL in named environments and the
    reconciler's sweep in the legacy deployment), **D30** (A3: the project catalog and why no
    scan), and **D31** (A12: the admin's email from `userinfo`), each one paragraph, marked with the
    owner's decision date.
- [ ] **Step 2: Update the phase README.** The 25c row starts "Merged as PR #159."; the 25d row
  says "Built, see PR #<n>." with the questions link beside its plan.
- [ ] **Step 3: Check the copy** with `grep -c "$(printf '\342\200\224')" specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md` (prints 0 for each), then commit:

```bash
git add specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md
git commit -m "docs(spec-025): record the phase 25d rulings and the owner's answers"
```

---

### Task 19 (deferred): Live check in a throwaway environment (owner present)

**Deferred to the combined final live check (owner, 2026-09-30).** No live testing runs until 25d,
25e and spec 040 phases 2 to 4 are all built. This task is not part of this phase's build or PR:
its steps below are this phase's checklist for that combined final check, run then in one
throwaway environment (instead of a separate `live25d`), with the owner present.


This task changes no code unless it finds a defect. A defect is fixed with a failing test first, in
the task that owns the code, then reviewed. It tests the real flow: Claude Code, `agentx mcp`, an
admin sign-in appearing and expiring, each admin read tool against real AWS, and a real failure
reaching the failure index. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for account 944937319445 (`aws login --profile agentx-admin`, driven from
  this session, the owner's preference; or CloudShell), because the access stack creates IAM roles;
- **no other throwaway environment in the account**: only one fits at a time because of the Elastic
  IP quota. Confirm `live25c` (and any other `live*`) is torn down before Step 3;
- a Slack workspace with one test user, a GitHub organization or account, and a test repository the
  owner names. Never production's Slack app, GitHub App, stacks, secrets or `/agentx/production/*`;
- Claude Code on the owner's machine.

It uses a new environment, `live25d`, in `us-east-1`.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release and pack the CLI from this branch:
    `npm run release:build -- --version 0.0.6 --out <scratch>/rel` and
    `npm run release:pack-cli -- --version 0.0.6 --out <scratch>/cli`.
  - Read production's image digests, read-only, exactly as 25b's live check did.
  - Confirm `aws ssm get-parameters-by-path --path /agentx/live25d --recursive --region us-east-1`
    returns nothing, that no `agentx-live*` stack exists, and that no EC2 instance, volume or Elastic
    IP is tagged for a `live*` environment.
- [ ] **Step 2: Owner approval.** Tell the owner:
  - what it creates: the environment's stacks (with the broker's two new read-only grants), a
    GitHub App and a Slack app in their test organization and workspace, a KMS RSA key, the sign-in
    table, a Cognito admin user, and EC2 worker instances and volumes while tasks run;
  - the cost while it exists: about $3 a day for the stacks, the KMS key prorated, and the EC2 time
    of each task;
  - that everything is torn down in Step 11.
- [ ] **Step 3: Install.** `node packages/cli/dist/main.js --env live25d init --region us-east-1 --release <scratch>/rel --worker-image <worker digest ref> --slack-image <slack digest ref>`,
  with Cognito as the admin identity and Slack at the `developer-signin` step. As admin, register a
  test project on the owner's test repository with an `ec2-ebs` binding and bind a test channel;
  invite the AgentX bot to it.
- [ ] **Step 4: Developer only.** `login <ApiEndpoint>` as the test Slack user;
  `claude mcp add --scope user agentx-live25d -- node <scratch>/cli/package/bin/agentx.mjs mcp`;
  `/mcp` lists the eleven developer tools and no admin tool. Ask Claude Code to call
  `agentx_admin_health`: it has no such tool (US5 scenario 2).
- [ ] **Step 5: Admin sign-in appears (FR-028).** With Claude Code still open, run
  `agentx --env live25d login --admin` in another terminal. Within about 30 seconds, `/mcp` (or the
  next tool call) shows the eight admin tools; note whether Claude Code refreshed its list by itself
  (it should, on `list_changed`) and record it.
- [ ] **Step 6: Each read tool (US5 scenarios 1 and 4).** Ask Claude Code: "is AgentX healthy?"
  (`agentx_admin_health`: versions, the environment's alarms, the dead-letter queues' depths, Slack
  `ok`, GitHub `ok`); "list the AgentX projects, channels, credentials and workspaces"; "show last
  week's usage by project". No tool asks for a confirmation. Compare the channel list with Slack: a
  public channel by name, a private one (bind a private test channel) by ID only.
- [ ] **Step 7: A real failure (US5 scenario 3).** Register a revision whose setup fails at once
  (a setup command `{ "cwd": "repo/<name>", "executable": "sh", "args": ["-c", "echo npm ci failed; exit 1"], "timeoutSeconds": 60 }`),
  hand a task off from Claude Code, and when it ends ask "what failed in the last hour?":
  `agentx_admin_failed_tasks` shows the project, `ai_tool`, the developer, `prepare`,
  `setup_failed` and the error; `agentx_admin_turns` with its `task_id` shows the task's records.
  Register a revision without the failing step afterwards, and close the task.
- [ ] **Step 8: The admin's identity (A12, Q3).** No 25d tool calls `GET /v1/admin/me` (25e's
  Slack Confirm button will), so call it once from the repository root with the admin sign-in this
  computer holds. The script prints only the status and the answer, never the token:

```bash
node --input-type=module <<'JS'
import { homedir } from "node:os";
import { SystemCredentialTokenStore } from "./packages/cli/dist/token-store.js";
import { tokenStoreKey } from "./packages/cli/dist/auth.js";
import { loadDeploymentSettings } from "./packages/cli/dist/deployment.js";
import { resolveDeploymentFile } from "./packages/cli/dist/environments/cache.js";
const path = await resolveDeploymentFile({ home: homedir(), env: "live25d" });
const settings = await loadDeploymentSettings({ path, allowLoopback: false, expectedEnv: "live25d" });
const tokens = await new SystemCredentialTokenStore().get(tokenStoreKey(settings.auth));
const response = await fetch(`${settings.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/me`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
console.log(response.status, JSON.stringify(await response.json()));
JS
```

  Expected: `200` with the Cognito admin's issuer and subject, their verified email (from Cognito's
  `userinfo`), and `slack.linked` true when that email is the test Slack user's (make it so for the
  test admin user), else `reason: "no_match"`. If the email is missing, the broker log names
  `admin.userinfo_failed` with an error class; raise it with the owner before merge, since Q3's
  answer and 25e's Slack Confirm button rest on it.
- [ ] **Step 9: Admin sign-in expires.** Run `agentx --env live25d logout --admin`. Within about 30
  seconds the admin tools disappear; asking for one gets `ADMIN_REQUIRED` with "run npx
  @charterarc/agentx login --admin" if Claude Code still calls it.
- [ ] **Step 10: No secret leaked (SC-004).** `aws logs filter-log-events` over the broker, outbox
  publisher, reconciler and DeveloperIdentity log groups for `agxr_`, `xoxb-`, `Bearer ` and the
  Cognito access token's first 20 characters: no events. Local files as 25b's Step 11.
- [ ] **Step 11: Tear down**, exactly as 25b's Step 12 for `live25d` (the MCP entry, the local
  sign-ins, every tagged instance and volume, the stacks and what they retain, the secrets and
  parameters, the GitHub App and the Slack app), then confirm no `agentx-live25d-*` stack, no
  `/agentx/live25d` parameter and no `live25d` instance, volume or Elastic IP remains, so the next
  phase's live check has room.
- [ ] **Step 12: Record the evidence** in the PR description: the commands, outcomes and timings
  (how long the admin tools took to appear and to disappear), each defect fixed, and any finding
  that changes a ruling above. Raise those with the owner before the combined release.

## Not in this phase

- **Phase 25e:** pending changes and confirmations; the admin change tools; `GET /v1/admin/changes`
  and `agentx_admin_changes`; the Slack Confirm button (which uses `GET /v1/admin/me`'s Slack link,
  A12); `agentx admin changes`; `agentx config set limits.*` through the change path; 25c's C22
  (a close's `completed` audit record).
- **Later, or by owner decision:** a one-time backfill of the project catalog for unbound projects
  registered before 25d (Q2's other option); refreshing the admin sign-in in the MCP server (Q4's
  other option); the control plane's release version in `agentx_admin_health` (A13 leaves
  `AGENTX_RELEASE_VERSION` unset: no deploy parameter carries the release yet); the hosted MCP
  endpoint; admin reads in the legacy production deployment beyond what its broker already serves
  (the routes answer there, but alarms, queues, Slack and the Slack link answer "not set up").

## Self-review

- **Spec coverage.** FR-028: Tasks 14 (offer, `list_changed`, guard), 16 (the admin sign-in),
  17 (end to end). FR-030's eight admin read tools: Task 15, their routes Tasks 2, 3, 6, 7, 8, 9, 12,
  and `GET /v1/admin/credentials` (already served). FR-038: the failure index (Task 4, expiry
  Task 5), each route (Tasks 2, 3, 6, 8, 9, 11, 12), the same admin check (A2, every route's test).
  FR-029 and SC-004: A16, Tasks 4 (redacted at write), 15 (the server's redaction), 17 (sweep). FR-049's
  `ADMIN_REQUIRED`: Tasks 14, 15, 16, 17. US5 scenarios 1 to 4: Task 17; its Independent Test's
  committed results: Task 17's expected objects. 25c's carry-over (`task_id` with channel turns):
  Task 7, and Task 17's turns call.
- **Placeholder scan.** Every code step shows its code. Two steps read a fact first and say what to
  do with the answer: Task 13 Step 1 (the IAM resource types) and the deferred Task 19 Step 8 (whether Cognito's
  `userinfo` answered). Task 14 Step 6 keeps today's tool handler body as it is and says so.
- **Type consistency.** `AdminReadDependencies` is Task 2's, with `me` typed in Task 11, `health` in
  Task 12 and `turns` added in Task 8, each by the task that owns it. `FailureIndexRecord` and
  `UsageIndexRecord` (Task 1) are what Task 4 writes and Tasks 6, 8 and 12 read.
  `AdminControlPlaneClient` (Task 14) is what Task 15's tools call and Task 16 builds; `AdminOffer`
  and `ToolOffer` (Task 14) are what Task 16 feeds. `readFailures`, `timeWindow`, `listLimit`,
  `projectWorkspaceRows`, `workspaceOwner`, `channelLabels` and `adminProjectNames` are exported
  for the tasks named in their Interfaces.
- **Review Focus.** Each line has its test in the owning task: 1 in Task 14, 2 in Tasks 4 and 17,
  3 in Task 4, 4 in Task 7, 5 in Task 11.
- **Owner answers (2026-09-30).** Q5 changed: A6 and Tasks 1 (the TTL attribute), 4 (written on
  each item), 5 (the sweep, legacy only), 6 and 8 (reads skip an expired item) and 13 (the named
  table's TTL, the reconciler's switch, the test that nothing else names the attribute). Q7 changed:
  A11 and Tasks 3 (unchanged: public names, private by ID), 11 (the member check) and 15 (the tool's
  description). The live check is deferred (Task 19).
- **Owner questions.** Q1 to Q7 each name the tasks that depend on them; Task 18 records the
  answers, and stops for any answer that differs from the recommendation.
