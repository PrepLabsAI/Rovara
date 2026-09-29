# Phase 25c: Sharing a Task to Its Slack Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer's AI tool can share a task to the project's Slack channel, view only or open
to the channel. AgentX posts a start message and a reply at each status change in that thread. A
view-only thread answers a mention with one fixed notice an hour. In a continue thread, teammates
steer the task with ordinary Slack turns that run on the task's own workspace, one at a time and
each attributed to its author. Projects can require sharing and forbid continue. The phase also
ends stuck task setups with a sweep (FR-055) so a temporary AWS error while queuing the first
instructions is retried, and makes the Slack limit reply count the member's AI-tool tasks.

**Architecture:**
- **Sharing is state on the task.** The start (FR-031) or the new `POST /v1/dev/tasks/{taskId}/share`
  route decides the channel and mode and writes a `share` map on the task record. Nothing in the
  broker talks to Slack (D11).
- **A new `DeveloperTaskNotifier` function posts to Slack** (FR-034). It reads the state table's
  stream (filtered to task, pointer and developer-operation changes), turns each change into a
  notice on its own SQS queue, and posts each notice with the Slack bot token. A failed post is
  retried for one hour, then counted in `SlackDeliveryFailed`. After the start message it writes
  the shared thread record `SHARED_TASK#<team>/<channel>/<threadTs>` (FR-035).
- **The Slack ingress reads that record for every mention** (FR-035): view only (or closed) gets a
  fixed notice at most once an hour, and nothing is queued; continue is queued exactly as today.
- **Continue-mode turns reuse the Slack thread machinery** (D3, FR-054). The broker's service
  identity resolves a continue thread to the task's owner key, so every existing service route acts
  on the task's workspace, with the teammate as requester. The Slack service waits (up to 30
  minutes) for the task's workspace to be idle before a turn, names the teammate in its reply, and
  records the task ID on the turn record.
- **The stuck-setup sweep (FR-055, D21)** lives in the session reconciler and reads a small
  `SETUP_WATCH` partition the start writes. After it exists, a temporary AWS error while queuing the
  first instructions answers the worker's callback with a 503, so the worker tries again.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4
(4.6.5), Vitest, `@modelcontextprotocol/sdk` 1.30.1, AWS SDK v3 3.1134.0 (`lib-dynamodb`,
`client-sqs`, `client-secrets-manager`, `util-dynamodb`), AWS CDK (Lambda event source mappings with
filter criteria, SQS).

**Spec:** [../spec.md](../spec.md), the binding authority. Phase 25c delivers the phase README's row:
- FR-031 (sharing, required sharing, `shareMode`, `CHANNEL_REQUIRED` and `CHANNEL_AMBIGUOUS`);
- FR-032 (the shared thread's messages), FR-033's client name in them;
- FR-034 (the `DeveloperTaskNotifier`, retries for one hour, `SlackDeliveryFailed`);
- FR-035 (the shared thread record, the ingress notice, continue messages queued as today);
- FR-054 (continue-mode turns on the task's workspace, one at a time, attributed);
- FR-055 and D21 (the stuck-setup sweep, then retrying temporary AWS errors);
- `agentx_share_task` and the share fields of FR-030; User Story 3; SC-006 and SC-012;
- 25b's owner decision 10: the Slack limit reply counts the member's open AI-tool tasks.

The phase map is in [README.md](README.md). What 25b left for this phase is its plan's "Not in this
phase" list. Open product questions are in [phase-25c-questions.md](phase-25c-questions.md): this
plan follows each recommendation, and every task that depends on one says "Depends on Q<n>".

**Branch:** `feat/025c-sharing`, cut from mainline `dd61839` (25b merged as PR #149). One PR,
against `mainline`. No stacked PRs.

## Decisions recorded by this plan

Each ruling is written into the code by the task named. Rulings marked **(Q<n>)** follow the
recommendation of an open owner question.

- **C1. Share state lives on the task.** `DeveloperTaskRecord.shared` becomes `boolean`, and a
  shared task carries `share`:

  | Field | Meaning |
  |---|---|
  | `teamId`, `channelId`, `channelName?` | where the thread is; the name only for a public channel (R10) |
  | `mode` | `view` or `continue` |
  | `sharedReason` | `requested`, or `required` when the project's `share` forced it (FR-031) |
  | `modeReason?` | `continue_not_allowed` when `allowContinue: false` turned continue into view (D5) |
  | `sharedAt` | when it was shared; notices about earlier changes are not posted |
  | `threadTs?` | set by the notifier once the start message is posted |
  | `postFailedAt?` | set when the start message could not be posted within one hour |

  The task also gets `shareVersion` (a number). Every write of `share` replaces the whole map and
  is conditioned on `shareVersion`, so the share route and the notifier never lose each other's
  change (no nested update paths). The index row's `shared` becomes `true`. Tasks 1, 3.
- **C2. The shared thread record.** `SHARED_TASK#<team>/<channel>/<threadTs>` / `META`: task ID,
  workspace ID, owner key, developer ID and name, project, `mode`, `sharedAt`, `closedAt?`. The
  notifier writes it with `threadTs` in one transaction; the share route changes its `mode` with the
  task's; a close sets `closedAt`. The ingress and the broker read only this record. Tasks 1, 4, 7.
- **C3. The share decision (FR-031, D5, D6).** Shared when `share_to_channel` is true or the
  project's `share` is `required`. The channel is the named `channel` (a bound channel's ID, or a
  public channel's name with or without `#`), else the only bound channel. No bound channel, or a
  named channel that is not bound: `CHANNEL_REQUIRED`. Several and none named: `CHANNEL_AMBIGUOUS`.
  Both are refused before anything is written, with a `refused` audit record, and name the bound
  channels (public names; a private channel by ID only, R10). The mode is `share_mode`, else the
  policy's `shareMode.default` (`view` unless the admin chose otherwise, D6); continue becomes view
  when `allowContinue` is false. A `channel` or `share_mode` without `share_to_channel` does not
  share on its own. Task 2.
- **C4. The start keeps 25b's order (R8)** with sharing decided instead of refused: token,
  idempotency, project checks, share decision, workspace limit, one transaction. The 25b refusals
  ("not available yet") are removed; their tests are replaced deliberately (Task 3 lists them).
- **C5. `POST /v1/dev/tasks/{taskId}/share`** (FR-016, FR-030). Body `{ requestId, shareMode?,
  channel? }`. A private task is shared with C3's rules (the request counts as asking to share); the
  start message then shows the current status (US3 scenario 9). A shared task changes mode within
  the latest revision's policy (continue on a project that forbids it stays view, and the answer
  says why); a different `channel` is refused (`INVALID_REQUEST`: "already shared in #x"). Only the
  developer who owns the task may call it **(Q2)**. A repeated `requestId` answers with the task as
  it is and writes nothing. A closed task answers `INVALID_REQUEST`. Each share or mode change
  writes an `accepted` AI-tool turn record with the new action `share` **(Q9)**. Task 4.
- **C6. The start and share answers do not wait for the thread link (Q6).** The view says
  `share.posting` until the notifier has posted; `agentx_get_task` shows `thread_url` a few seconds
  later. So SC-002's 5-second start holds. Tasks 3, 5, 15.
- **C7. The notifier is triggered by the state table's stream** (FR-034's "triggered by the task's
  status changes"). A second event source mapping on the existing stream, with filter criteria,
  sends each relevant change to the notifier; the notifier puts one notice per change on its own
  SQS queue; the same function, triggered by that queue, posts it. Why the stream and not a send
  from the broker: every post is tied to a committed change, including changes that the reconciler
  (the sweep) and worker callbacks make, and a crash between a commit and a send cannot lose a post.
  The stream then has two readers (the outbox publisher and the notifier), the per-shard maximum
  AWS recommends; phase 25e's pending-change DMs must reuse this mapping (another filter), never add
  a third reader. Tasks 6, 7, 8.
- **C8. What the thread shows (FR-032).**

  | Change | Posted |
  |---|---|
  | the task gains `share` | the start message: the developer (a mention when linked, else the display name as plain text), the client, the title, the project, the current status, and the mode's sentence |
  | the developer's prepare succeeds | "The workspace is ready, and the task is running." |
  | the developer's prepare fails | the setup failure, redacted, at most 300 characters |
  | the developer's task operation ends | its status, the failure category and message if any, and the summary (the worker's last message) at most 1,500 characters, redacted |
  | the developer's publish succeeds | the pull request's URL |
  | the developer's publish fails | its status and failure |
  | `share.mode` changes | the new mode's sentence |
  | the instructions are cancelled before they ran | "The task was cancelled before it ran." |
  | the task closes | "The task is closed, and its workspace is released. This thread no longer drives it." |

  Operations teammates start are not posted by the notifier: the Slack service replies to them. The
  instructions beyond the title, events, diffs and artifacts are never posted. A setup failure is
  not in FR-032's list, but it is the task's status change and the channel would otherwise never
  learn the task did not run. Tasks 2, 6, 7.
- **C9. Notice delivery.** Each notice has a fixed ID (`<taskId>:start`, `<operationId>:ended`,
  and so on) and a delivered marker `DEVTASK#<taskId>` / `NOTICE#<id>`, so a repeated stream or
  queue delivery posts once. A reply waits (is retried) until the start message has its `threadTs`.
  A failed post is retried with backoff (30 seconds doubling, at most 15 minutes) until one hour
  after the change, then logged as `developer_notifier.delivery_failed` and counted as
  `SlackDeliveryFailed` (the metric spec 015 FR-045's alarm already sums). A start message that
  never posted marks `share.postFailedAt`, and later replies for that task are dropped rather than
  posted outside a thread. Task 7.
- **C10. The ingress (FR-035).** For each mention in a bound channel, after the event is claimed and
  before the turn limit, it reads the shared thread record. View only, or a closed task: it posts the
  fixed notice when it wins the hourly marker `THREAD#<subject>` / `SHARED_NOTICE` in the Slack
  threads table, and returns; nothing is queued, counted or created. Continue: unchanged. A failed
  read answers 500 (Slack retries), never a new thread workspace. Only named environments read the
  record (`SHARED_TASKS=enabled`); the legacy template does not change. Task 9. **(Q1, Q3)**
- **C11. The broker's service identity (FR-054).** When the shared thread record says continue and
  the task is open and the channel is still bound to the task's project, the service identity is
  the task's owner key, with the Slack context kept (so `requestedBy` is the teammate) and
  `sharedTask` set. Otherwise (view, closed, rebound) the identity keeps the thread's own key and
  `sharedTask` says so, and `POST /v1/threads/workspace` answers `VIEW_ONLY` and never creates a
  workspace. For a continue thread it answers the task's workspace as it is: never created, never
  prepared again, never charged, with no `recoverableOperations` (the running operation may be the
  developer's). "close this workspace" in a shared thread is refused (`REFUSED`); only the
  developer closes the task. A teammate's "stop" in a continue thread cancels the running task
  operation, whoever started it **(Q8)**. Task 10.
- **C12. One channel turn at a time (FR-054, SC-012).** The Slack request FIFO queue already runs a
  thread's messages one at a time. Before a continue-mode turn, the Slack service waits until the
  task's workspace has no active operation (the developer's run, or the operation the previous
  channel turn started), up to 30 minutes, then answers that the task is still busy. The consumer's
  heartbeat keeps the message invisible while it waits. Task 11.
- **C13. Attribution (US3 scenario 5).** A continue-mode reply starts with a mention of the
  teammate. The operation's `requestedBy` is the teammate (the Slack context of C11). The Slack turn
  record gains `taskId` and `requesterName`. The broker writes `DEVTASK#<taskId>` /
  `CHANNEL_OPERATION#<operationId>` (the teammate's ID and name) with each operation a channel turn
  starts. Tasks 1, 10, 11.
- **C14. `TASK_BUSY` names the driver (D4, FR-049).** When the developer's continue or pull request
  meets an operation a channel turn started, the answer names the teammate (from C13's record) and
  how many channel messages wait (the Slack threads table's `pendingRequests` for the thread, less
  the running one). The broker gets `GetItem` on the Slack threads table for `THREAD#*` keys, in
  named environments only. Task 10.
- **C15. Channel turns in `agentx_get_task` (FR-030).** From the Slack turn records of the shared
  thread that carry this task's ID (the broker already may query TurnRecords): author, time, request
  (at most 300 characters, already redacted) and outcome, newest first, at most 20. Task 5.
- **C16. The limit reply (25b owner decision 10).** The Slack `LIMIT_REACHED` answer gains
  `openTaskCount` (the size of the member counter's `tasks` set), sent only to a Slack service that
  asks (`includeOpenTaskCount`), and the reply names the AI-tool tasks and how to close one. A
  member with no AI-tool tasks gets exactly today's text. Task 12.
- **C17. The stuck-setup sweep (FR-055, D21).** The start transaction writes `SETUP_WATCH` /
  `<prepare createdAt>#<workspaceId>` (with the prepare's operation ID and the task ID, one-day
  TTL). Each reconciler run (every 10 minutes) queries the watches older than 15 minutes. For each,
  a prepare still live on a workspace still `PREPARING` is failed in one transaction, whatever the
  instance's health: the operation `FAILED` with the fixed message "setup did not finish within 15
  minutes; close this task and start a new one", the workspace `PREPARATION_FAILED` (so the task
  reads `setup_failed`), the pending instructions cleared, the watch deleted. Any other watch is
  just deleted. The slot is freed as for any failed setup: by closing the task (FR-020). Only
  developer-task prepares are watched **(Q4)**, and the 15 minutes run from the prepare's creation,
  the start itself **(Q5)**. The reconciler fits better than the reaper: it
  already repairs drift and fails operations (`failActiveOperation`), while the reaper's contract is
  that it never changes a workspace's status. The cost is up to 10 more minutes: a stuck setup is
  failed between 15 and 25 minutes after it started. Task 13.
- **C18. A late result after the sweep is answered, not refused.** The worker's `SUCCEEDED` result
  for a prepare the sweep failed answers 200 and changes nothing, like the "first task could not be
  queued" case in 25b. Task 13.
- **C19. Temporary AWS errors while queuing the first instructions are retried (FR-055).** When
  building or writing the queued first task meets throttling or a 5xx (`isTemporaryAwsError`), the
  result callback answers `503 RUNTIME_UNAVAILABLE` and records nothing, so the worker's next try
  queues the task. If every try fails, the sweep ends the prepare. Any other error still records the
  prepare `FAILED` at once (25b's final review I1). The 25b test that pinned "fail at once even for
  a retryable error" is changed deliberately. Task 14.
- **C20. API version 1.2 (Q7).** `DEVELOPER_API_VERSION` becomes `"1.2"`: the share route is new,
  so an MCP server from this release refuses a control plane still on 1.1 with `UPGRADE_REQUIRED`
  (FR-048's rule), rather than failing only `agentx_share_task`. Tasks 1, 15.
- **C21. The MCP tools (FR-030, FR-049).** `agentx_share_task` is added (the eleventh developer
  tool). The task output gains `share_mode`, `share_reason` (`required by project`),
  `share_mode_reason` (`continue not allowed by project`), `channel`, `thread_url` or
  `share_posting`, and `channel_turns`. `CHANNEL_AMBIGUOUS` passes through. The next steps now fit
  what remains: `CHANNEL_REQUIRED` means the project has no usable bound channel, so "ask an AgentX
  admin to bind a Slack channel to the project"; `CHANNEL_AMBIGUOUS` means "send channel with one of
  the channels the message names". Task 15.
- **C22. A refused close still writes only its `accepted` record.** Recording a `completed` record
  for close outcomes does not fit the notifier naturally: the notifier has no TurnRecords write
  (widening it would give a second function audit writes), and the natural home is the broker's
  `completedTurnItems`, which phase 25e's audit work already touches. Left to 25e.
- **C23. No change to the Slack orchestrator's `agentx_*` tools.** Continue mode changes who the
  broker says owns the workspace, not the tools. If any task finds it must change one of Pratik's
  `agentx_*` orchestrator tools (`packages/orchestrator/src/orchestration-tools.ts`), it stops and
  first adds characterization tests, then 1:1 mapping tests, with no weakened assertion.
- **C24. What a closed shared thread does (Q3).** The notifier posts the closed reply; the shared
  record gets `closedAt`; later mentions get the closed notice (at most once an hour) and nothing
  runs. Tasks 4, 7, 9, 10.

## Owner questions

[phase-25c-questions.md](phase-25c-questions.md) lists nine questions the spec leaves open, each
with options, a recommendation and the cost if wrong. This plan follows every recommendation; the
tasks that depend on one say so. The owner's answers are recorded in the spec by Task 17.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Legacy snapshots never change. Never run vitest with
  `-u`. No test and no step of the live check touches production's stacks, `/agentx/production/*`,
  production's Slack app or its secrets. Every resource, grant, parameter and environment variable
  this phase adds exists only in named environments (D14), and code that needs one checks for it.
- **The 25a and 25b live checks' lessons hold:** no resource that CloudFormation validates at create
  time against our own API; every retained resource in a named environment uses
  `RetainExceptOnCreate` (this phase adds none); the live check runs in a throwaway named
  environment with the owner present, and only one throwaway environment fits in the account at a
  time (the Elastic IP quota).
- **No test reaches AWS, Slack, GitHub or a company IdP.** Every client is injected. The only real
  network use in tests is `127.0.0.1`.
- **Never printed, logged, stored in local files, or put in a tool result, error message or Slack
  post:** access tokens, refresh tokens, the Slack bot token, secret values, and the developer's raw
  instructions. Logs carry event names, IDs, reasons and error names only (never an error's
  message, which could quote the task). Every task that handles one plants a known value and
  asserts it appears nowhere it must not.
- **The developer's instructions reach the worker unchanged** (FR-019), and no AgentX model reads
  them. Only teammates' Slack messages go through the orchestrator model (D3).
- **Only the notifier is a new reader of the Slack secret** (FR-034). The broker still cannot read
  it.
- **No developer task code reads the deployment mode** (FR-024).
- **Pratik's `agentx_*` orchestrator tools** need characterization tests before any change, 1:1
  mapping tests, and no weakened assertions (C23).
- **Exact names and values:**
  - route `POST /v1/dev/tasks/{taskId}/share`; tool `agentx_share_task`;
  - items `SHARED_TASK#<team>/<channel>/<threadTs>`/`META`, `DEVTASK#<taskId>`/`NOTICE#<noticeId>`,
    `DEVTASK#<taskId>`/`CHANNEL_OPERATION#<operationId>`, `SETUP_WATCH`/`<createdAt>#<workspaceId>`,
    Slack threads table `THREAD#<subject>`/`SHARED_NOTICE`;
  - one notice per thread per 3,600 seconds; summary at most 1,500 characters; a channel turn waits
    at most 30 minutes; notices retried for 3,600 seconds; channel turns listed at most 20, request
    text at most 300 characters; a stuck setup is 15 minutes old;
  - reasons `required by project` and `continue not allowed by project`;
  - `DEVELOPER_API_VERSION = "1.2"` (Q7);
  - error codes gain `CHANNEL_AMBIGUOUS`; the turn record action list gains `share` (Q9).
- **Copy:**
  - plain words;
  - every error says what to do next;
  - no em dashes in any user-facing text, Slack message, tool description, AWS resource name or
    description.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Existing suites:** no assertion is removed or weakened (SC-008). Lists of commands, error codes,
  tools, readers and constants gain the new entries by appending. Where a 25b test pinned behaviour
  this phase deliberately changes, the task names the test, the old assertion and its replacement.
- **Build process:** the owner approves this plan before building. Building uses
  superpowers:subagent-driven-development, with a fresh implementer and a fresh reviewer per task.
  PRs target mainline.

## Review Focus

1. **A teammate mentions AgentX while the developer's own run is going (continue mode).** Expected:
   the channel turn waits for the run to end, then runs; the two never hold the workspace at once,
   and the developer's `agentx_continue_task` meanwhile answers `TASK_BUSY` only if the channel turn
   has started an operation. Pinned in Task 11 (`shared-task-turns.test.ts`, "waits for the
   developer's running operation before the turn starts") and Task 16 (SC-012).
2. **The developer switches a continue thread to view only while channel messages are queued.**
   Expected: each queued message gets the view-only notice (at most once an hour), nothing runs, and
   no thread workspace is created for the thread. Pinned in Task 10 (`shared-task-identity.test.ts`,
   "answers VIEW_ONLY and creates nothing once the thread is view only") and Task 11 ("posts the
   notice for a message queued before the switch").
3. **Slack is down when the start message is due.** Expected: the task runs normally; the notice is
   retried for one hour, then counted as `SlackDeliveryFailed`; later replies for that task are
   dropped, never posted at the channel's top level. Pinned in Task 7
   (`developer-task-notifier.test.ts`, "gives up on the start message after an hour and drops the
   task's later replies").
4. **The worker's `SUCCEEDED` result arrives after the sweep failed the prepare.** Expected: the
   callback answers 200, the prepare stays `FAILED`, nothing is queued, the task reads
   `setup_failed`. Pinned in Task 13 (`stuck-setup.test.ts`, "answers a late SUCCEEDED result for a
   swept prepare and queues nothing").
5. **A project requires sharing and has two bound channels, and the start names none.** Expected:
   `CHANNEL_AMBIGUOUS` naming both (a private one by ID only), a `refused` record, and nothing else
   written. Pinned in Task 3 (`developer-task-share-start.test.ts`, "refuses CHANNEL_AMBIGUOUS
   before anything is written when a required share has two channels").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/developer-tasks.ts` (modify) | share constants, view fields, share request, shared record schema and key, notices' fixed texts | 1 |
| `packages/contracts/src/errors.ts` (modify) | `CHANNEL_AMBIGUOUS` | 1 |
| `packages/contracts/src/slack.ts` (modify) | `sharedTask` on WORKSPACE, `VIEW_ONLY`, `openTaskCount`, close `REFUSED`, `sharedNoticeKey` | 1 |
| `packages/contracts/src/turns.ts` (modify) | Slack record `taskId`, `requesterName`; AI-tool action `share` | 1 |
| `packages/contracts/src/developer.ts` (modify) | API version 1.2 | 1 |
| `packages/broker/src/developer/share.ts` | the share decision (C3), channel labels | 2 |
| `packages/broker/src/developer/share-messages.ts` | the thread's texts (C8) | 2 |
| `packages/broker/src/developer/task-records.ts` (modify) | `TaskShare`, `shareVersion`, `shareView`, `sharedSubject` | 3 |
| `packages/broker/src/aws/developer-routes.ts` (modify) | bound channel IDs from the access check; `boundChannels` | 3 |
| `packages/broker/src/aws/developer-tasks.ts` (modify) | sharing at start, the share route, the view's share and channel turns, `TASK_BUSY` naming the driver, the setup watch | 3, 4, 5, 10, 13 |
| `packages/broker/src/aws/developer-task-actions.ts` (modify) | `channelTurns`, `channelActivity` | 5, 10 |
| `packages/broker/src/developer/notifications.ts` | notices from stream images (C7) | 6 |
| `packages/broker/src/aws/slack-web.ts` | `chat.postMessage` that returns `ts` | 7 |
| `packages/broker/src/aws/developer-task-notifier.ts` | the notifier: stream to queue, queue to Slack, the thread record | 7 |
| `infra/lib/developer-task-notifier.ts` | the notifier's function, queues, mappings and grants | 8 |
| `infra/lib/control-plane.ts` (modify) | wire the notifier; ingress and broker grants (named only) | 8 |
| `packages/broker/src/aws/slack-ingress.ts` (modify) | the view-only notice | 9 |
| `packages/broker/src/auth.ts` (modify) | `AuthenticatedIdentity.sharedTask` | 10 |
| `packages/broker/src/aws/broker.ts` (modify) | shared identity, shared thread workspace, close refusal, stop, channel operation records, channel actions, limit count, sweep-aware result, temporary-error retry | 10, 12, 13, 14 |
| `packages/broker/src/aws/broker-shared.ts` (modify) | `isTemporaryAwsError` | 14 |
| `packages/slack-service/src/shared-task.ts` | wait for an idle task workspace | 11 |
| `packages/slack-service/src/processor.ts`, `turn-records.ts`, `lazy-worker.ts`, `thread-api.ts`, `thread-workspace-request.ts`, `messages.ts`, `main.ts` (modify) | continue-mode turns, notices, attribution, limit reply | 11, 12 |
| `packages/broker/src/aws/stuck-setup.ts` | the sweep (C17) | 13 |
| `packages/broker/src/aws/session-reconciler.ts` (modify) | run the sweep | 13 |
| `packages/mcp/src/client.ts`, `tools.ts`, `errors.ts` (modify) | `agentx_share_task`, share fields, next steps | 15 |
| `tests/support/fake-dynamodb.ts` (modify) | a write listener; `sk < :value` key conditions | 6, 13 |
| `tests/support/developer-task-broker.ts` (modify) | bind channels, register policies, stream records, teammate calls, Slack threads table | 3, 6, 10 |
| `tests/support/slack-broker.ts` (modify) | `createBroker` passes `slackThreadsTableName` | 10 |
| `tests/support/mcp-broker-client.ts` | the signed-in MCP client against the broker, moved from `mcp-developer-flow.test.ts` | 16 |
| `specs/025-mcp-server/spec.md`, `plans/README.md` (modify) | record the rulings and answers | 17 |

---
### Task 1: The contracts for sharing

C1, C2, C6, C13, C16, C20 and the shapes every later task uses. **Depends on Q7** (the API
version) and **Q9** (the `share` action).

**Files:**
- Modify: `packages/contracts/src/developer-tasks.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/slack.ts`
- Modify: `packages/contracts/src/turns.ts`
- Modify: `packages/contracts/src/developer.ts:9`
- Test: `tests/contract/developer-share-contracts.test.ts`
- Modify (expected constants): `tests/contract/developer-contracts.test.ts:28`, `tests/contract/developer-task-shapes.test.ts:114`, `tests/contract/developer-identity-server.test.ts:39`, `tests/contract/developer-task-contracts.test.ts:92`

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `@agentx/contracts`):
  - `DEVELOPER_SHARE_SUMMARY_MAX = 1_500`, `SHARED_THREAD_NOTICE_INTERVAL_SECONDS = 3_600`,
    `CHANNEL_TURN_WAIT_MS = 1_800_000`, `SHARE_DELIVERY_WINDOW_MS = 3_600_000`,
    `CHANNEL_TURNS_MAX = 20`, `CHANNEL_TURN_REQUEST_MAX = 300`,
    `SHARED_BY_POLICY = "required by project"`, `VIEW_ONLY_BY_POLICY = "continue not allowed by project"`,
    `VIEW_ONLY_NOTICE`, `CLOSED_SHARED_NOTICE`;
  - `DeveloperTaskShareSchema` / `DeveloperTaskShare`, `ChannelTurnSchema` / `ChannelTurn`;
    `DeveloperTaskViewSchema` gains `share?` and `channelTurns?`;
  - `ShareDeveloperTaskRequestSchema` / `ShareDeveloperTaskRequest`;
  - `sharedTaskKey(thread)`, `SharedTaskRecordSchema` / `SharedTaskRecord`;
  - `sharedNoticeKey(subject)`;
  - `SlackThreadWorkspaceResultSchema`: WORKSPACE gains `sharedTask?: { taskId, developerName }`;
    new branch `{ outcome: "VIEW_ONLY", taskId, closed }`; LIMIT_REACHED gains `openTaskCount?`
    (also on `SlackThreadPrepareResultSchema`); `SlackWorkspaceCloseStartResultSchema` gains
    `{ outcome: "REFUSED", reason: "shared_task" }`;
  - `TurnRecordSchema` gains `taskId?` and `requesterName?`; `AiToolTurnRecordSchema.action` gains
    `"share"`;
  - `AgentXErrorCodeSchema` gains `CHANNEL_AMBIGUOUS` (HTTP 409);
  - `DEVELOPER_API_VERSION = "1.2"`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-share-contracts.test.ts
// Spec 025 phase 25c, Task 1: the shapes sharing adds. Every addition is optional, so a record or
// answer written before 25c still parses.
import { describe, expect, it } from "vitest";
import {
  AiToolTurnRecordSchema,
  CLOSED_SHARED_NOTICE,
  DEVELOPER_API_VERSION,
  DeveloperTaskViewSchema,
  SHARED_BY_POLICY,
  ShareDeveloperTaskRequestSchema,
  SharedTaskRecordSchema,
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseStartResultSchema,
  TurnRecordSchema,
  VIEW_ONLY_BY_POLICY,
  VIEW_ONLY_NOTICE,
  agentXError,
  sharedNoticeKey,
  sharedTaskKey,
} from "../../packages/contracts/src/index.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const view = {
  taskId: TASK, title: "Fix the flaky retry test", project: "payments", status: "RUNNING", startingRevision: 1, client: "Claude Code",
  shared: true, createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:00.000Z", events: [],
};

describe("share shapes (C1, C2, C6)", () => {
  it("reads a shared view with its thread link, and a 25b view without any share field", () => {
    const shared = DeveloperTaskViewSchema.parse({
      ...view,
      share: { mode: "view", channelId: "C0123456789", channelName: "payments-dev", sharedReason: "required", threadUrl: "https://slack.com/archives/C0123456789/p1695500000000001" },
      channelTurns: [{ author: { slackUserId: "U0PRIYA001", name: "Priya" }, at: "2026-09-29T10:05:00.000Z", request: "also run the linter", outcome: "answered" }],
    });
    expect(shared.share).toMatchObject({ mode: "view", sharedReason: "required" });
    expect(DeveloperTaskViewSchema.parse({ ...view, shared: false }).share).toBeUndefined();
  });

  it("takes a share request with an optional mode and channel, and nothing else", () => {
    expect(ShareDeveloperTaskRequestSchema.parse({ requestId: TASK, shareMode: "continue", channel: "#payments-dev" })).toMatchObject({ shareMode: "continue" });
    expect(ShareDeveloperTaskRequestSchema.safeParse({ requestId: TASK, force: true }).success).toBe(false);
    expect(ShareDeveloperTaskRequestSchema.safeParse({ requestId: TASK, shareMode: "edit" }).success).toBe(false);
  });

  it("keys the shared thread record by team, channel and thread, and parses it with its storage keys", () => {
    const key = sharedTaskKey({ teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" });
    expect(key).toEqual({ pk: "SHARED_TASK#T0BSHLLUGBD/C0123456789/1695500000.000001", sk: "META" });
    const record = SharedTaskRecordSchema.parse({
      ...key, entityType: "SHARED_TASK", taskId: TASK, workspaceId: WORKSPACE, ownerKey: "a".repeat(64), developerId: "d".repeat(64),
      developerName: "Maya Chen", project: "payments", mode: "continue", sharedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(record).toMatchObject({ mode: "continue" });
    expect(sharedNoticeKey("T0BSHLLUGBD/C0123456789/1695500000.000001")).toEqual({ pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000001", sk: "SHARED_NOTICE" });
  });

  it("uses the spec's exact reasons, and notices with no em dash", () => {
    expect([SHARED_BY_POLICY, VIEW_ONLY_BY_POLICY]).toEqual(["required by project", "continue not allowed by project"]);
    for (const text of [VIEW_ONLY_NOTICE, CLOSED_SHARED_NOTICE]) {
      expect(text).not.toContain("\u2014");
      expect(text).toContain("new message in the channel");
    }
  });
});

describe("the Slack service's shapes (C11, C16)", () => {
  it("adds VIEW_ONLY and an optional sharedTask, and keeps the WORKSPACE branch strict", () => {
    expect(SlackThreadWorkspaceResultSchema.parse({ outcome: "VIEW_ONLY", taskId: TASK, closed: false })).toMatchObject({ outcome: "VIEW_ONLY" });
    const workspace = { outcome: "WORKSPACE", workspaceId: WORKSPACE, status: "BUSY", operationId: null, created: false, orchestratorInstructions: "Delegate work." };
    expect(SlackThreadWorkspaceResultSchema.parse({ ...workspace, sharedTask: { taskId: TASK, developerName: "Maya Chen" } })).toMatchObject({ sharedTask: { taskId: TASK } });
    expect(SlackThreadWorkspaceResultSchema.safeParse({ ...workspace, unexpected: true }).success).toBe(false);
  });

  it("adds an optional open task count to both limit answers, and REFUSED to the close answer", () => {
    const limit = { outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [] };
    expect(SlackThreadWorkspaceResultSchema.parse({ ...limit, openTaskCount: 3 })).toMatchObject({ openTaskCount: 3 });
    expect(SlackThreadPrepareResultSchema.parse({ ...limit, openTaskCount: 1 })).toMatchObject({ openTaskCount: 1 });
    expect(SlackThreadWorkspaceResultSchema.parse(limit)).not.toHaveProperty("openTaskCount");
    expect(SlackWorkspaceCloseStartResultSchema.parse({ outcome: "REFUSED", reason: "shared_task" })).toMatchObject({ outcome: "REFUSED" });
  });
});

describe("records and codes", () => {
  it("lets a Slack turn record carry the task and the teammate's name, and still reads one without", () => {
    const base = {
      offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], eventId: "Ev0000000001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
      receivedAt: "2026-09-29T10:00:00.000Z", requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered",
      startedAt: "2026-09-29T10:00:00.000Z", finishedAt: "2026-09-29T10:00:01.000Z", durationMs: 1000, requestText: "run the linter", responseText: "done",
    };
    expect(TurnRecordSchema.parse({ ...base, taskId: TASK, requesterName: "Priya" })).toMatchObject({ taskId: TASK, requesterName: "Priya" });
    expect(TurnRecordSchema.parse(base)).not.toHaveProperty("taskId");
  });

  it("adds the share action to AI-tool records (Q9)", () => {
    expect(AiToolTurnRecordSchema.shape.action.options).toEqual(["start", "continue", "pull_request", "cancel", "close", "share"]);
  });

  it("adds CHANNEL_AMBIGUOUS as a 409, and moves the API to 1.2 (Q7)", () => {
    expect(agentXError("CHANNEL_AMBIGUOUS", "name one").statusCode).toBe(409);
    expect(DEVELOPER_API_VERSION).toBe("1.2");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-share-contracts.test.ts`
Expected: FAIL, `sharedTaskKey` and the other new exports are not defined.

- [ ] **Step 3: Add the contracts**

In `packages/contracts/src/developer-tasks.ts`, after `UNKNOWN_CLIENT_NAME`, add:

```ts
/** Spec 025 phase 25c: sharing a task to its Slack channel (FR-031 to FR-035, FR-054). */
export const DEVELOPER_SHARE_SUMMARY_MAX = 1_500;
export const SHARED_THREAD_NOTICE_INTERVAL_SECONDS = 3_600;
export const CHANNEL_TURN_WAIT_MS = 30 * 60_000;
export const SHARE_DELIVERY_WINDOW_MS = 60 * 60_000;
export const CHANNEL_TURNS_MAX = 20;
export const CHANNEL_TURN_REQUEST_MAX = 300;
/** FR-031: the reasons a result gives when the project's policy changed what was asked. */
export const SHARED_BY_POLICY = "required by project";
export const VIEW_ONLY_BY_POLICY = "continue not allowed by project";
/** FR-035 and US3 scenario 4: the fixed notices in a shared thread (Q1, Q3). */
export const VIEW_ONLY_NOTICE =
  "This thread follows a task that a developer is driving from their AI tool, so I don't act on messages here. To ask AgentX for something, post a new message in the channel; it starts its own thread workspace.";
export const CLOSED_SHARED_NOTICE =
  "The task this thread followed is closed, so I don't act on messages here. To ask AgentX for something, post a new message in the channel; it starts its own thread workspace.";

export const DeveloperTaskShareSchema = z.object({
  mode: DeveloperShareModeSchema,
  channelId: z.string(),
  /** A public channel's name only (R10). */
  channelName: z.string().optional(),
  sharedReason: z.enum(["requested", "required"]),
  modeReason: z.literal("continue_not_allowed").optional(),
  /** Absent while the notifier has not posted the start message yet (C6). */
  threadUrl: z.string().url().optional(),
  /** The start message could not be posted within an hour (C9). */
  postFailed: z.boolean().optional(),
});
export type DeveloperTaskShare = z.infer<typeof DeveloperTaskShareSchema>;

/** C15: one Slack turn a teammate ran on the task in its shared thread. */
export const ChannelTurnSchema = z.object({
  author: z.object({ slackUserId: z.string(), name: z.string().optional() }),
  at: z.string(),
  request: z.string().max(CHANNEL_TURN_REQUEST_MAX),
  outcome: z.string(),
});
export type ChannelTurn = z.infer<typeof ChannelTurnSchema>;

export const ShareDeveloperTaskRequestSchema = z
  .object({ requestId: z.string().uuid(), shareMode: DeveloperShareModeSchema.optional(), channel: z.string().min(1).max(80).optional() })
  .strict();
export type ShareDeveloperTaskRequest = z.infer<typeof ShareDeveloperTaskRequestSchema>;

/** C2: the shared thread record, read by the Slack ingress and the broker's service identity. */
export function sharedTaskKey(thread: { teamId: string; channelId: string; threadTs: string }): { pk: string; sk: "META" } {
  return { pk: `SHARED_TASK#${thread.teamId}/${thread.channelId}/${thread.threadTs}`, sk: "META" };
}
export const SharedTaskRecordSchema = z.object({
  taskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  developerId: z.string().regex(/^[a-f0-9]{64}$/),
  developerName: z.string().min(1).max(200),
  project: z.string().min(1).max(63),
  mode: DeveloperShareModeSchema,
  sharedAt: z.string(),
  closedAt: z.string().optional(),
});
export type SharedTaskRecord = z.infer<typeof SharedTaskRecordSchema>;
```

Change the `StartDeveloperTaskRequestSchema` comment above `shareToChannel` to
`// FR-031: sharing. share_to_channel, or a project whose share is required, shares the task.`

In `DeveloperTaskViewSchema`, after `unpublished`, add:

```ts
  /** C1: how the task is shared; absent for a private task. */
  share: DeveloperTaskShareSchema.optional(),
  /** C15: the shared thread's channel turns on this task, newest first. */
  channelTurns: z.array(ChannelTurnSchema).max(CHANNEL_TURNS_MAX).optional(),
```

In `packages/contracts/src/errors.ts`, append `"CHANNEL_AMBIGUOUS",` after `"SLACK_UNAVAILABLE",` in
`AgentXErrorCodeSchema` (it falls to `errorStatus`'s 409).

In `packages/contracts/src/slack.ts`:
- add to the WORKSPACE branch of `SlackThreadWorkspaceResultSchema`, after `actionPolicy`:

```ts
      // Spec 025 C11: a continue thread's task, sent only to a service that sends includeSharedTask: true.
      sharedTask: z.object({ taskId: z.string().uuid(), developerName: z.string().min(1).max(200) }).strict().optional(),
```

- add `openTaskCount: z.number().int().nonnegative().optional(),` after `starterThreads` in both
  LIMIT_REACHED branches, with the comment `// C16: sent only to a service that sends includeOpenTaskCount: true.`;
- add a fourth branch to `SlackThreadWorkspaceResultSchema`:

```ts
  z
    .object({
      // Spec 025 C11: a view-only or closed shared thread; sent only to a service that sends includeSharedTask: true.
      outcome: z.literal("VIEW_ONLY"),
      taskId: z.string().uuid(),
      closed: z.boolean(),
    })
    .strict(),
```

- add to `SlackWorkspaceCloseStartResultSchema`:
  `z.object({ outcome: z.literal("REFUSED"), reason: z.literal("shared_task") }).strict(),`
- after `slackThreadUrl`, add:

```ts
/** C10: the hourly marker for a shared thread's fixed notice, in the Slack threads table. */
export function sharedNoticeKey(subject: string): { pk: string; sk: "SHARED_NOTICE" } {
  return { pk: `THREAD#${subject}`, sk: "SHARED_NOTICE" };
}
```

In `packages/contracts/src/turns.ts`, add to `TurnRecordSchema` after `conversationId`:

```ts
  /** Spec 025 FR-037: a teammate's continue-mode turn names the task it ran on. */
  taskId: z.string().uuid().optional(),
  /** C13: the teammate's display name, on continue-mode turns only. */
  requesterName: z.string().min(1).max(80).optional(),
```

and change `AiToolTurnRecordSchema`'s action to
`action: z.enum(["start", "continue", "pull_request", "cancel", "close", "share"]),`.

In `packages/contracts/src/developer.ts:9`: `export const DEVELOPER_API_VERSION = "1.2";`.

- [ ] **Step 4: Move the constants the existing tests expect (additive, SC-008)**
  - `tests/contract/developer-contracts.test.ts:28`: `"1.1"` becomes `"1.2"`.
  - `tests/contract/developer-task-shapes.test.ts:114`: `toBe("1.1")` becomes `toBe("1.2")`.
  - `tests/contract/developer-identity-server.test.ts:39`: `apiVersion: "1.1"` becomes `"1.2"`.
  - `tests/contract/developer-task-contracts.test.ts:92`: append `["CHANNEL_AMBIGUOUS", 409]` to the
    list of codes and statuses.

  Each is an expected constant moving with Q7 or a list gaining an entry, as 25b's SC-008 ruling
  allows; nothing is removed or loosened.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-share-contracts.test.ts tests/contract/developer-contracts.test.ts tests/contract/developer-task-shapes.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-task-contracts.test.ts tests/contract/slack-contracts.test.ts tests/contract/turn-record-contract.test.ts && npm run typecheck`
Expected: PASS. `typecheck` fails where code switches over `SlackThreadWorkspaceResult` or
`SlackWorkspaceCloseStartResult` without the new branches: `packages/slack-service/src/processor.ts`
(`VIEW_ONLY`, `REFUSED`). Add the smallest handling there now, which Task 11 replaces:
after the `LIMIT_REACHED` branch, `if (workspace.outcome === "VIEW_ONLY") { draft.disposition = "workspace_unavailable"; finished = true; return; }`,
and after `if (started.outcome === "NOT_FOUND") {...}`,
`if (started.outcome === "REFUSED") { await post("Only the developer who started this task can close it, from their AI tool."); finished = true; return; }`.
The broker never sends either branch before Task 10, so no behaviour changes. Rerun typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src packages/slack-service/src/processor.ts tests/contract/developer-share-contracts.test.ts tests/contract/developer-contracts.test.ts tests/contract/developer-task-shapes.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-task-contracts.test.ts
git commit -m "feat(contracts): sharing shapes, CHANNEL_AMBIGUOUS and API 1.2 (spec 025 phase 25c)"
```

---

### Task 2: The share decision and the thread's texts

C3 and C8, as pure functions. **Depends on Q1** (the start message's mode sentences share its
tone).

**Files:**
- Create: `packages/broker/src/developer/share.ts`
- Create: `packages/broker/src/developer/share-messages.ts`
- Test: `tests/contract/developer-share-rules.test.ts`

**Interfaces:**
- Consumes: `DeveloperTaskPolicy`, `agentXError`, `redactAndCap`, `DEVELOPER_SHARE_SUMMARY_MAX`
  (Task 1); `escapeSlack` from `packages/broker/src/aws/slack-details-view.ts`.
- Produces:
  - `interface BoundChannel { channelId: string; name?: string; isPrivate?: boolean }`
  - `interface ShareDecision { channelId: string; channelName?: string; mode: "view" | "continue"; sharedReason: "requested" | "required"; modeReason?: "continue_not_allowed" }`
  - `decideShare(input: { project: string; policy: DeveloperTaskPolicy; shareToChannel: boolean; shareMode?: "view" | "continue"; channel?: string; bound: readonly BoundChannel[] }): ShareDecision | undefined`
  - `decideMode(policy: DeveloperTaskPolicy, wanted: "view" | "continue"): { mode: "view" | "continue"; modeReason?: "continue_not_allowed" }`
  - `channelLabel(channel: BoundChannel): string`
  - `startMessage(input: StartMessageInput): string`, `READY_REPLY`, `setupFailedReply(error: string | undefined): string`,
    `endedReply(input: { status: string; failure?: { category: string; message: string }; summary?: string }): string`,
    `pullRequestReply(url: string): string`, `modeReply(mode: "view" | "continue"): string`, `CANCELLED_REPLY`, `CLOSED_REPLY`
  - `interface StartMessageInput { developerName: string; slackUserId?: string; client: string; title: string; project: string; mode: "view" | "continue"; status: string; sharedReason: "requested" | "required" }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-share-rules.test.ts
// Spec 025 FR-031, FR-032, D5, D6: who shares where, in which mode, and what the thread says.
import { describe, expect, it } from "vitest";
import { AgentXError, DEFAULT_DEVELOPER_TASK_POLICY, type DeveloperTaskPolicy } from "../../packages/contracts/src/index.js";
import { decideShare, decideMode, channelLabel } from "../../packages/broker/src/developer/share.js";
import { CLOSED_REPLY, endedReply, modeReply, pullRequestReply, setupFailedReply, startMessage } from "../../packages/broker/src/developer/share-messages.js";

const policy = (overrides: Partial<DeveloperTaskPolicy> = {}): DeveloperTaskPolicy => ({ ...DEFAULT_DEVELOPER_TASK_POLICY, ...overrides });
const ONE = [{ channelId: "C0123456789", name: "payments-dev", isPrivate: false }];
const TWO = [...ONE, { channelId: "G0PRIVATE01", name: "payments-secret", isPrivate: true }];
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentXError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("decideShare (FR-031)", () => {
  it("shares nothing unless asked or required, even when a channel or mode is named (C3)", () => {
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: false, channel: "#payments-dev", shareMode: "continue", bound: ONE })).toBeUndefined();
  });

  it("uses the only bound channel and the project's default mode, view (D6)", () => {
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, bound: ONE })).toEqual({ channelId: "C0123456789", channelName: "payments-dev", mode: "view", sharedReason: "requested" });
  });

  it("shares a start that did not ask when the project requires it, and says so (US3 scenario 2)", () => {
    expect(decideShare({ project: "payments", policy: policy({ share: "required" }), shareToChannel: false, bound: ONE })).toMatchObject({ sharedReason: "required", mode: "view" });
  });

  it("turns continue into view when the project does not allow continue, and says why (D5, US3 scenario 8)", () => {
    const ledger = policy({ share: "required", shareMode: { default: "view", allowContinue: false } });
    expect(decideShare({ project: "ledger", policy: ledger, shareToChannel: false, shareMode: "continue", bound: ONE })).toEqual({
      channelId: "C0123456789", channelName: "payments-dev", mode: "view", sharedReason: "required", modeReason: "continue_not_allowed",
    });
    expect(decideMode(ledger, "view")).toEqual({ mode: "view" });
  });

  it("finds a named channel by ID or by public name, with or without #, in any case", () => {
    for (const channel of ["C0123456789", "payments-dev", "#Payments-Dev"]) {
      expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel, bound: TWO })?.channelId).toBe("C0123456789");
    }
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "G0PRIVATE01", bound: TWO })).toMatchObject({ channelId: "G0PRIVATE01" });
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "G0PRIVATE01", bound: TWO })).not.toHaveProperty("channelName");
  });

  it("never matches a private channel by name, and never shows its name (R10)", () => {
    const answer = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "payments-secret", bound: TWO }));
    expect(answer.code).toBe("CHANNEL_REQUIRED");
    // The input is the caller's own words; the list of channels never shows a private name.
    expect(answer.message).toContain("its channels are #payments-dev, G0PRIVATE01");
  });

  it("refuses CHANNEL_REQUIRED with no bound channel, and CHANNEL_AMBIGUOUS with several and none named", () => {
    expect(refusal(() => decideShare({ project: "payments", policy: policy({ share: "required" }), shareToChannel: false, bound: [] }))).toMatchObject({ code: "CHANNEL_REQUIRED" });
    const ambiguous = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, bound: TWO }));
    expect(ambiguous.code).toBe("CHANNEL_AMBIGUOUS");
    expect(ambiguous.message).toContain("#payments-dev");
  });

  it("never echoes a channel input that could carry markup", () => {
    const answer = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "<!here> hi", bound: ONE }));
    expect(answer.message).not.toContain("<!here>");
    expect(answer.message).toContain("that channel");
  });

  it("labels a channel by its public name, else by ID", () => {
    expect(TWO.map(channelLabel)).toEqual(["#payments-dev", "G0PRIVATE01"]);
    expect(channelLabel({ channelId: "C0UNKNOWN01" })).toBe("C0UNKNOWN01");
  });
});

describe("the thread's texts (FR-032, C8)", () => {
  const input = { developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code", title: "Fix the flaky retry test", project: "payments", status: "STARTING", sharedReason: "requested" as const };

  it("names the developer, the client, the title, the project, the status and the mode", () => {
    const view = startMessage({ ...input, mode: "view" });
    expect(view).toContain("<@U0MAYA001> started a task from Claude Code: *Fix the flaky retry test*");
    expect(view).toContain("`payments`");
    expect(view).toContain("STARTING");
    expect(view).toContain("follow-ups happen in");
    expect(startMessage({ ...input, mode: "continue" })).toContain("may mention AgentX in this thread to steer the task");
  });

  it("writes an unlinked developer's name as plain, escaped text, and says when the project required sharing", () => {
    const text = startMessage({ ...input, slackUserId: undefined, developerName: "Omar <!channel>", mode: "view", sharedReason: "required" });
    expect(text).toContain("Omar &lt;!channel&gt; started a task");
    expect(text).toContain("This project shares every task started from an AI tool.");
  });

  it("escapes the title, so a title cannot notify the channel", () => {
    expect(startMessage({ ...input, title: "<!here> fix", mode: "view" })).toContain("*&lt;!here&gt; fix*");
  });

  it("gives the status, failure and summary, redacted and cut to 1,500 characters", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = endedReply({ status: "SUCCEEDED", summary: `Done with ${secret} ${"x".repeat(3_000)}` });
    expect(text).toContain("The task ended SUCCEEDED.");
    expect(text).not.toContain(secret);
    expect(text.length).toBeLessThan(1_700);
    expect(endedReply({ status: "FAILED", failure: { category: "task_failed", message: "tests failed" } })).toContain("FAILED (task_failed): tests failed");
    expect(setupFailedReply("npm ci exited 1")).toContain("npm ci exited 1");
  });

  it("links a pull request, says the mode, and says a close ended the thread", () => {
    expect(pullRequestReply("https://github.com/example/demo/pull/7")).toBe("Pull request opened: https://github.com/example/demo/pull/7");
    expect(modeReply("view")).toContain("view only");
    expect(modeReply("continue")).toContain("open to the channel");
    expect(CLOSED_REPLY).toContain("no longer drives it");
  });

  it("uses no em dash in any text", () => {
    const texts = [startMessage({ ...input, mode: "view" }), startMessage({ ...input, mode: "continue" }), endedReply({ status: "CANCELLED" }), modeReply("view"), modeReply("continue"), CLOSED_REPLY, setupFailedReply(undefined)];
    for (const text of texts) expect(text).not.toContain("\u2014");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-share-rules.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Write `share.ts`**

```ts
// packages/broker/src/developer/share.ts
// Spec 025 FR-031, D5, D6: whether a task is shared, where, and in which mode. No I/O.
import { agentXError, type DeveloperTaskPolicy } from "@agentx/contracts";

export interface BoundChannel { channelId: string; name?: string; isPrivate?: boolean }
export interface ShareDecision {
  channelId: string;
  channelName?: string;
  mode: "view" | "continue";
  sharedReason: "requested" | "required";
  modeReason?: "continue_not_allowed";
}

/** A channel as a refusal names it: `#name` when public and known, else its ID only (R10). */
export function channelLabel(channel: BoundChannel): string {
  return channel.name !== undefined && channel.isPrivate === false ? `#${channel.name}` : channel.channelId;
}

const SAFE_ECHO = /^#?[A-Za-z0-9._-]{1,80}$/;
const byId = (left: BoundChannel, right: BoundChannel) => (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0);

/** D5: continue on a project that does not allow it becomes view, with the reason. */
export function decideMode(policy: DeveloperTaskPolicy, wanted: "view" | "continue"): { mode: "view" | "continue"; modeReason?: "continue_not_allowed" } {
  return wanted === "continue" && !policy.shareMode.allowContinue ? { mode: "view", modeReason: "continue_not_allowed" } : { mode: wanted };
}

function pickChannel(project: string, bound: readonly BoundChannel[], wanted: string | undefined): BoundChannel {
  const channels = [...bound].sort(byId);
  const list = channels.map(channelLabel).join(", ");
  if (channels.length === 0) {
    throw agentXError("CHANNEL_REQUIRED", `project \`${project}\` has no Slack channel bound to it, so the task cannot be shared`);
  }
  if (wanted !== undefined) {
    const name = wanted.replace(/^#/, "").toLowerCase();
    const found = channels.find((channel) => channel.channelId === wanted || (channel.isPrivate === false && channel.name?.toLowerCase() === name));
    if (found === undefined) {
      const echo = SAFE_ECHO.test(wanted) ? `\`${wanted}\`` : "that channel";
      throw agentXError("CHANNEL_REQUIRED", `${echo} is not a channel of \`${project}\`; its channels are ${list}`);
    }
    return found;
  }
  if (channels.length > 1) throw agentXError("CHANNEL_AMBIGUOUS", `project \`${project}\` has several Slack channels: ${list}`);
  return channels[0]!;
}

/** C3: undefined when the task stays private; otherwise where and how it is shared, or a refusal. */
export function decideShare(input: {
  project: string;
  policy: DeveloperTaskPolicy;
  shareToChannel: boolean;
  shareMode?: "view" | "continue";
  channel?: string;
  bound: readonly BoundChannel[];
}): ShareDecision | undefined {
  const required = input.policy.share === "required";
  if (!input.shareToChannel && !required) return undefined;
  const channel = pickChannel(input.project, input.bound, input.channel);
  const mode = decideMode(input.policy, input.shareMode ?? input.policy.shareMode.default);
  return {
    channelId: channel.channelId,
    ...(channel.name !== undefined && channel.isPrivate === false ? { channelName: channel.name } : {}),
    ...mode,
    sharedReason: input.shareToChannel ? "requested" : "required",
  };
}
```

Note the `ShareDecision` field order in the test's `toEqual` does not matter; the object is
compared by keys.

- [ ] **Step 4: Write `share-messages.ts`**

```ts
// packages/broker/src/developer/share-messages.ts
// Spec 025 FR-032, C8: what the notifier posts in a shared thread. Every value from a record is
// escaped; free text from the worker is redacted and capped first. No em dashes.
import { DEVELOPER_SHARE_SUMMARY_MAX, redactAndCap } from "@agentx/contracts";
import { escapeSlack } from "../aws/slack-details-view.js";

export interface StartMessageInput {
  developerName: string;
  slackUserId?: string | undefined;
  client: string;
  title: string;
  project: string;
  mode: "view" | "continue";
  status: string;
  sharedReason: "requested" | "required";
}

const who = (input: Pick<StartMessageInput, "developerName" | "slackUserId">) =>
  input.slackUserId !== undefined ? `<@${input.slackUserId}>` : escapeSlack(input.developerName);

const MODE_SENTENCE = {
  view: (name: string) => `View only: follow-ups happen in ${name}'s AI tool, and I post each update here.`,
  continue: () => "Open to the channel: members of this channel may mention AgentX in this thread to steer the task.",
} as const;

export function startMessage(input: StartMessageInput): string {
  const name = who(input);
  return [
    // The client is one of four fixed names (R25), so it needs no escaping.
    `${name} started a task from ${input.client}: *${escapeSlack(input.title)}*`,
    `Project: \`${escapeSlack(input.project)}\`. Status: ${input.status}.`,
    input.mode === "view" ? MODE_SENTENCE.view(name) : MODE_SENTENCE.continue(),
    ...(input.sharedReason === "required" ? ["This project shares every task started from an AI tool."] : []),
  ].join("\n");
}

const clean = (text: string, limit: number) => escapeSlack(redactAndCap(text.replace(/\s+/g, " ").trim(), limit).text);

export const READY_REPLY = "The workspace is ready, and the task is running.";

export function setupFailedReply(error: string | undefined): string {
  return `The workspace could not be set up, so the task did not run: ${clean(error ?? "setup failed", 300)}`;
}

export function endedReply(input: { status: string; failure?: { category: string; message: string } | undefined; summary?: string | undefined }): string {
  const head = input.failure === undefined
    ? `The task ended ${input.status}.`
    : `The task ended ${input.status} (${input.failure.category}): ${clean(input.failure.message, 300)}`;
  if (input.summary === undefined || input.summary.trim() === "") return head;
  // Summary lines are quoted, so the worker's text reads as the worker's.
  const summary = escapeSlack(redactAndCap(input.summary.trim(), DEVELOPER_SHARE_SUMMARY_MAX).text).split("\n").map((line) => `>${line}`).join("\n");
  return `${head}\n${summary}`;
}

export function pullRequestReply(url: string): string {
  return `Pull request opened: ${escapeSlack(url)}`;
}

export function modeReply(mode: "view" | "continue"): string {
  return mode === "view"
    ? "This thread is now view only: follow-ups happen in the developer's AI tool."
    : "This thread is now open to the channel: members of this channel may mention AgentX here to steer the task.";
}

export const CANCELLED_REPLY = "The task was cancelled before it ran.";
export const CLOSED_REPLY = "The task is closed, and its workspace is released. This thread no longer drives it.";
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-share-rules.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/developer/share.ts packages/broker/src/developer/share-messages.ts tests/contract/developer-share-rules.test.ts
git commit -m "feat(broker): the share decision and the shared thread's texts (spec 025 FR-031, FR-032)"
```

---

### Task 3: Sharing at the start

C1, C3, C4, C6: FR-031 at `POST /v1/dev/tasks`, replacing 25b's R9 refusals.

**Files:**
- Modify: `packages/broker/src/developer/task-records.ts` (`TaskShare`, `DeveloperTaskRecord`, `taskShare`, `shareView`, `sharedSubject`)
- Modify: `packages/broker/src/aws/developer-routes.ts` (`checkProjectAccess`, `routeDeveloperRequest`)
- Modify: `packages/broker/src/aws/developer-tasks.ts` (`DeveloperTaskRouteDependencies`, `startTask`, `taskView`)
- Modify: `tests/support/developer-task-broker.ts` (helpers)
- Test: `tests/contract/developer-task-share-start.test.ts`
- Modify (deliberate): `tests/contract/developer-task-start.test.ts` (three tests, Step 5)

**Interfaces:**
- Consumes: `decideShare`, `ShareDecision`, `BoundChannel` (Task 2); `DeveloperTaskShare`,
  `slackThreadUrl` (Task 1 and existing contracts).
- Produces:
  - `interface TaskShare { teamId: string; channelId: string; channelName?: string; mode: "view" | "continue"; sharedReason: "requested" | "required"; modeReason?: "continue_not_allowed"; sharedAt: string; threadTs?: string; postFailedAt?: string }`
  - `DeveloperTaskRecord.shared: boolean`, `DeveloperTaskRecord.share?: TaskShare`, `DeveloperTaskRecord.shareVersion?: number`
  - `taskShare(decision: ShareDecision, teamId: string, sharedAt: string): TaskShare`
  - `shareView(share: TaskShare): DeveloperTaskShare`
  - `sharedSubject(share: TaskShare & { threadTs: string }): string` (`<team>/<channel>/<threadTs>`)
  - `DeveloperTaskRouteDependencies.checkAccess` returns `{ revision, policy, access, channelIds: string[] }`
  - `DeveloperTaskRouteDependencies.boundChannels?(channelIds: readonly string[]): Promise<BoundChannel[]>`
  - `shareFor(deps, caller, project, access, wanted): Promise<ShareDecision | undefined>` (module-private; Task 4 reuses it)
  - test helpers `bindChannel(handler, channelId, project?)`, `unbindChannel(handler, channelId)`,
    `registerPolicy(handler, revision, developerTasks)`, `grantProject(db, who, project?)`

- [ ] **Step 1: Add the test helpers**

In `tests/support/developer-task-broker.ts`, add (import `type Handler` from `./slack-broker.js`, and
`type FakeDynamoDb` from `./fake-dynamodb.js`):

```ts
const ADMIN = { subject: "admin-subject", admin: true };

/** Binds another Slack channel of the test team to a project, as `agentx admin slack bind` does. */
export async function bindChannel(handler: Handler, channelId: string, projectName = "payments"): Promise<void> {
  const response = await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${channelId}`, user: ADMIN, body: { projectName } });
  if (response.status !== 200) throw new Error(`binding failed: ${JSON.stringify(response.body)}`);
}

export async function unbindChannel(handler: Handler, channelId: string): Promise<void> {
  const response = await call(handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${channelId}`, user: ADMIN });
  if (response.status !== 200) throw new Error(`unbinding failed: ${JSON.stringify(response.body)}`);
}

/** Registers a new revision of payments with these developerTasks settings (FR-014). */
export async function registerPolicy(handler: Handler, revision: number, developerTasks: Record<string, unknown>): Promise<void> {
  const response = await call(handler, {
    method: "POST", path: "/v1/admin/projects", user: ADMIN,
    body: {
      definition: {
        name: "payments", revision,
        repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate work.", developerTasks,
      },
      runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
    },
  });
  if (response.status !== 201) throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
}

/** An admin grant (FR-013), so access does not depend on a bound channel. */
export function grantProject(db: FakeDynamoDb, who: Developer, projectName = "payments"): void {
  db.set({ pk: `MEMBER#${who.developerId}`, sk: `PROJECT#${projectName}`, entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName, role: "developer" });
}
```

If `DELETE /v1/admin/slack/bindings/...` answers another status than 200 today, match the status
`deleteSlackBinding` returns (read it in `broker.ts`) rather than changing the broker.

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/developer-task-share-start.test.ts
// Spec 025 FR-031, D5, D6, C3, C4: sharing decided at POST /v1/dev/tasks.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChannelInfoRequest, ChannelInfoResponse } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR, bindChannel, createDeveloperTaskBroker, grantProject, registerPolicy, unbindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const SECOND = "C0SECOND001";
const PRIVATE = "G0PRIVATE01";
const names = async (request: ChannelInfoRequest): Promise<ChannelInfoResponse> => ({
  ok: true,
  channels: request.channelIds.map((channelId) => (channelId === PRIVATE
    ? { channelId, name: "payments-secret", isPrivate: true }
    : { channelId, name: channelId === SECOND ? "payments-ops" : "payments-dev", isPrivate: false })),
});
type Db = Awaited<ReturnType<typeof createDeveloperTaskBroker>>["db"];
const workspaces = (db: Db) => db.find((item) => item.entityType === "WORKSPACE");
const refusals = (db: Db) => db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused");
const taskOf = (body: Record<string, unknown>) => body.task as { taskId: string; shared: boolean; share?: Record<string, unknown> };

describe("sharing at the start (FR-031)", () => {
  it("shares a start that asks to, in the project's default mode, with the channel's name (D6)", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true }));
    expect(response.status).toBe(200);
    const task = taskOf(response.body);
    expect(task).toMatchObject({ shared: true, share: { mode: "view", channelId: SLACK_CHANNEL, channelName: "payments-dev", sharedReason: "requested" } });
    // C6: the answer does not wait for the notifier's post.
    expect(task.share).not.toHaveProperty("threadUrl");
    expect(db.get(`DEVTASK#${task.taskId}`, "META")).toMatchObject({
      shared: true, shareVersion: 1,
      share: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, channelName: "payments-dev", mode: "view", sharedReason: "requested", sharedAt: expect.any(String) },
    });
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK_INDEX" && item.taskId === task.taskId)).toEqual([expect.objectContaining({ shared: true })]);
  });

  it("shares every start on a project that requires it, and says why (US3 scenario 2)", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await registerPolicy(handler, 2, { share: "required" });
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    expect(task).toMatchObject({ shared: true, share: { sharedReason: "required", mode: "view" } });
  });

  it("keeps continue where the project allows it, and makes it view with the reason where it does not (US3 scenario 8)", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "continue" }))).body).share).toMatchObject({ mode: "continue" });
    await registerPolicy(handler, 2, { shareMode: { default: "view", allowContinue: false } });
    const forced = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "continue" }))).body);
    expect(forced.share).toMatchObject({ mode: "view", modeReason: "continue_not_allowed" });
  });

  it("shares ledger's tasks view only whatever the developer asks (US3's independent test)", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await registerPolicy(handler, 2, { share: "required", shareMode: { default: "view", allowContinue: false } });
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: false, shareMode: "continue" }))).body);
    expect(task).toMatchObject({ shared: true, share: { mode: "view", sharedReason: "required", modeReason: "continue_not_allowed" } });
  });

  it("refuses CHANNEL_AMBIGUOUS before anything is written when a required share has two channels (Review Focus 5)", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await bindChannel(handler, PRIVATE);
    await registerPolicy(handler, 2, { share: "required" });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(409);
    const error = response.body.error as { code: string; message: string };
    expect(error.code).toBe("CHANNEL_AMBIGUOUS");
    expect(error.message).toContain("#payments-dev");
    expect(error.message).toContain(PRIVATE);
    expect(error.message).not.toContain("payments-secret");
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "CHANNEL_AMBIGUOUS" } })]);
  });

  it("uses a named channel, by name or by ID", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await bindChannel(handler, SECOND);
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: "#payments-ops" }))).body).share).toMatchObject({ channelId: SECOND });
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: SLACK_CHANNEL }))).body).share).toMatchObject({ channelId: SLACK_CHANNEL });
  });

  it("refuses CHANNEL_REQUIRED when no channel is bound, or the named one is not bound", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    const unknown = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: "#elsewhere" }));
    expect(unknown.body.error).toMatchObject({ code: "CHANNEL_REQUIRED", message: "`#elsewhere` is not a channel of `payments`; its channels are #payments-dev" });
    grantProject(db, MAYA);
    await unbindChannel(handler, SLACK_CHANNEL);
    const none = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true }));
    expect(none.body.error).toMatchObject({ code: "CHANNEL_REQUIRED", message: "project `payments` has no Slack channel bound to it, so the task cannot be shared" });
    expect(workspaces(db)).toHaveLength(0);
  });

  it("gives a developer with no Slack link channel IDs only, and reads no names for them (R10)", async () => {
    const { db, dev, channelInfo } = await createDeveloperTaskBroker({ channelInfo: names });
    grantProject(db, OMAR);
    const task = taskOf((await dev(OMAR, "POST", "/v1/dev/tasks", start({ shareToChannel: true }))).body);
    expect(task.share).toMatchObject({ channelId: SLACK_CHANNEL });
    expect(task.share).not.toHaveProperty("channelName");
    expect(channelInfo).not.toHaveBeenCalled();
  });

  it("keeps a private start private, and reads no channel names for it", async () => {
    const { db, dev, channelInfo } = await createDeveloperTaskBroker({ channelInfo: names });
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    expect(task.shared).toBe(false);
    expect(task).not.toHaveProperty("share");
    expect(db.get(`DEVTASK#${task.taskId}`, "META")).not.toHaveProperty("share");
    expect(channelInfo).not.toHaveBeenCalled();
  });

  it("answers a retried shared start with the first task (R8)", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    const body = start({ shareToChannel: true, shareMode: "continue" });
    const first = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", body)).body);
    const again = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", body)).body);
    expect(again.taskId).toBe(first.taskId);
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-share-start.test.ts`
Expected: FAIL, `CHANNEL_REQUIRED` "sharing tasks to Slack is not available yet".

- [ ] **Step 4: Implement**

In `packages/broker/src/developer/task-records.ts`, import `slackThreadUrl` and
`type DeveloperTaskShare` from `@agentx/contracts` and `type ShareDecision` from `./share.js`; replace
the `shared: false` field and its comment in `DeveloperTaskRecord` with:

```ts
  /** C1: whether the task is shared to its channel, and how. */
  shared: boolean;
  share?: TaskShare;
  /** C1: every write of `share` replaces the whole map, conditioned on this number. */
  shareVersion?: number;
```

and add:

```ts
/** C1: a shared task's thread, as the task record keeps it. */
export interface TaskShare {
  teamId: string;
  channelId: string;
  channelName?: string;
  mode: "view" | "continue";
  sharedReason: "requested" | "required";
  modeReason?: "continue_not_allowed";
  sharedAt: string;
  threadTs?: string;
  postFailedAt?: string;
}

export function taskShare(decision: ShareDecision, teamId: string, sharedAt: string): TaskShare {
  return {
    teamId, channelId: decision.channelId,
    ...(decision.channelName === undefined ? {} : { channelName: decision.channelName }),
    mode: decision.mode, sharedReason: decision.sharedReason,
    ...(decision.modeReason === undefined ? {} : { modeReason: decision.modeReason }),
    sharedAt,
  };
}

/** The wire view of a share: a thread link only once the notifier has posted (C6). */
export function shareView(share: TaskShare): DeveloperTaskShare {
  return {
    mode: share.mode, channelId: share.channelId,
    ...(share.channelName === undefined ? {} : { channelName: share.channelName }),
    sharedReason: share.sharedReason,
    ...(share.modeReason === undefined ? {} : { modeReason: share.modeReason }),
    ...(share.threadTs === undefined ? {} : { threadUrl: slackThreadUrl({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }) }),
    ...(share.postFailedAt === undefined ? {} : { postFailed: true }),
  };
}

/** The shared thread's Slack subject, the key of its Slack-side records. */
export const sharedSubject = (share: TaskShare & { threadTs: string }): string => `${share.teamId}/${share.channelId}/${share.threadTs}`;
```

In `packages/broker/src/aws/developer-routes.ts`, `checkProjectAccess` returns the bound channel
IDs it already has, and `routeDeveloperRequest` passes the name lookup:

```ts
export async function checkProjectAccess(deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[] }> {
  // ... unchanged up to the last line, which becomes:
  return { revision: known.revision, policy: known.policy, access: entry.access, channelIds: bindings.map((binding) => binding.channelId).sort() };
}
```

and in `routeDeveloperRequest`'s `routeDeveloperTaskRequest` call add:

```ts
      boundChannels: async (channelIds) => {
        const known = await channelNames(deps, channelIds);
        return channelIds.map((channelId) => {
          const channel = known.get(channelId);
          return channel === undefined ? { channelId } : { channelId, name: channel.name, isPrivate: channel.isPrivate };
        });
      },
```

In `packages/broker/src/aws/developer-tasks.ts`:
- import `decideShare`, `type BoundChannel`, `type ShareDecision` from `"../developer/share.js"`, and
  `shareView`, `taskShare` from `"../developer/task-records.js"`;
- in `DeveloperTaskRouteDependencies`, change `checkAccess`'s return type to add
  `channelIds: string[]`, and add
  `/** C3: bound channels' names and privacy, best effort (R10). */ boundChannels?(channelIds: readonly string[]): Promise<BoundChannel[]>;`
- add:

```ts
type ProjectAccess = Awaited<ReturnType<DeveloperTaskRouteDependencies["checkAccess"]>>;

/**
 * C3: where and how a task is shared, or undefined for a private one. Names are read only when a
 * share needs them, and only for a caller with a Slack link, as GET /v1/dev/projects does (R10).
 */
async function shareFor(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  project: string,
  access: ProjectAccess,
  wanted: { shareToChannel: boolean; shareMode?: "view" | "continue" | undefined; channel?: string | undefined },
): Promise<ShareDecision | undefined> {
  if (!wanted.shareToChannel && access.policy.share !== "required") return undefined;
  const bound: BoundChannel[] = caller.slackUserId === undefined || deps.boundChannels === undefined
    ? access.channelIds.map((channelId) => ({ channelId }))
    : await deps.boundChannels(access.channelIds);
  return decideShare({
    project, policy: access.policy, bound, shareToChannel: wanted.shareToChannel,
    ...(wanted.shareMode === undefined ? {} : { shareMode: wanted.shareMode }),
    ...(wanted.channel === undefined ? {} : { channel: wanted.channel }),
  });
}
```

- in `startTask`, replace the two R9 refusals (`if (access.policy.share === "required") {...}` and
  `if (request.shareToChannel === true) {...}`) with:

```ts
  // FR-031, C4: decided here, in R8's place for sharing; a refusal is audited and writes nothing else.
  let share: ShareDecision | undefined;
  try {
    share = await shareFor(deps, caller, request.project, access, { shareToChannel: request.shareToChannel === true, shareMode: request.shareMode, channel: request.channel });
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  const teamId = deps.slackTeamId;
  // Bindings exist only under a team ID, so this cannot happen; refuse rather than write a half share.
  if (share !== undefined && teamId === undefined) return refused(agentXError("CHANNEL_REQUIRED", "this AgentX has no Slack workspace set, so tasks cannot be shared"));
```

- in the `task` literal, replace `shared: false,` with
  `shared: share !== undefined, ...(share === undefined ? {} : { share: taskShare(share, teamId!, receivedAt), shareVersion: 1 }),`
  and in the `index` literal replace `shared: false,` with `shared: share !== undefined,`;
- in `taskView`'s returned object, after `shared: task.shared,` add
  `...(task.share === undefined ? {} : { share: shareView(task.share) }),`.

- [ ] **Step 5: Replace the three 25b tests that pinned "not available yet" (deliberate, C4)**

In `tests/contract/developer-task-start.test.ts`:
1. Replace the test "CHANNEL_REQUIRED, not yet available, for a start that asks to share or a
   project that requires it (R9)" with this one, which keeps its three kinds of assertion (the code,
   the message, nothing written):

```ts
  it("CHANNEL_REQUIRED when a share has no bound channel, for a start that asks or a project that requires it (C4)", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    grantProject(db, MAYA);
    await unbindChannel(handler, SLACK_CHANNEL);
    const asked = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "view" }));
    expect(asked.body.error).toMatchObject({ code: "CHANNEL_REQUIRED" });
    expect(String((asked.body.error as { message: string }).message)).toContain("has no Slack channel bound");
    await registerRevision(handler, 2, { share: "required" });
    const required = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(required.body.error).toMatchObject({ code: "CHANNEL_REQUIRED" });
    expect(String((required.body.error as { message: string }).message)).toContain("has no Slack channel bound");
    expect(workspaces(db)).toHaveLength(0);
  });
```

2. In "names what is wrong in the refusal's message and leaves the next step to the MCP server, so
   it is said once": keep the `PROJECT_NOT_FOUND` assertion exactly; before the first share call add
   `grantProject(db, MAYA); await unbindChannel(handler, SLACK_CHANNEL);` (take `db` from the
   harness), and change the two share messages to
   `"project \`payments\` has no Slack channel bound to it, so the task cannot be shared"`.
3. In "writes the refused record for a refusal after the checks, with its error code and no
   workspace": add `grantProject(db, MAYA); await unbindChannel(handler, SLACK_CHANNEL);` before
   `registerRevision`; every assertion stays as it is.

Import `grantProject` and `unbindChannel` from `../support/developer-task-broker.js`. Each change
keeps the behaviour the test was pinning (a share that cannot happen is refused with its code,
audited, and writes nothing); only the reason it cannot happen changes, because sharing now exists.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/developer-task-share-start.test.ts tests/contract/developer-task-start.test.ts tests/contract/developer-task-reads.test.ts tests/contract/developer-routes.test.ts tests/contract/developer-access.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src tests/support/developer-task-broker.ts tests/contract/developer-task-share-start.test.ts tests/contract/developer-task-start.test.ts
git commit -m "feat(broker): share a task at its start (spec 025 FR-031)"
```

---

### Task 4: The share route, mode changes, and a closed shared thread

C5, C24: `POST /v1/dev/tasks/{taskId}/share` (FR-016, FR-030's `agentx_share_task`, US3 scenarios 7
and 9), and the close marking the shared thread record. **Depends on Q2** (only the developer
switches), **Q3** (what a close does to the thread) and **Q9** (the `share` audit record).

**Files:**
- Modify: `packages/broker/src/aws/developer-tasks.ts` (`shareTask`, `routeDeveloperTaskRequest`, `finishTaskClose`)
- Modify: `packages/broker/src/aws/developer-routes.ts` (`projectChannelIds`)
- Modify: `tests/support/developer-task-broker.ts` (`markThreadPosted`)
- Test: `tests/contract/developer-task-share-route.test.ts`

**Interfaces:**
- Consumes: `shareFor` (Task 3), `decideMode`, `channelLabel` (Task 2), `taskShare`, `TaskShare`
  (Task 3), `ShareDeveloperTaskRequestSchema`, `sharedTaskKey` (Task 1).
- Produces:
  - route `POST /v1/dev/tasks/{taskId}/share` answering `{ task: DeveloperTaskView }`;
  - `DeveloperTaskRouteDependencies.projectChannelIds(project: string): Promise<string[]>`;
  - `finishTaskClose` also sets `closedAt` on the task's `SHARED_TASK` record when it has a thread;
  - test helper `markThreadPosted(db, taskId, threadTs?)`: sets `share.threadTs` and writes the
    `SHARED_TASK` record exactly as the notifier does (Task 7), returning the thread's subject.

- [ ] **Step 1: Add the test helper**

In `tests/support/developer-task-broker.ts` (import `sharedTaskKey` from `@agentx/contracts`):

```ts
/** What the notifier's start message leaves behind (Task 7): the thread on the task, and its record. */
export function markThreadPosted(db: FakeDynamoDb, taskId: string, threadTs = "1695500000.000100"): string {
  const task = db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { share: Record<string, unknown>; shareVersion: number; workspaceId: string; ownerKey: string; developerId: string; developerName: string; project: string };
  const share = { ...task.share, threadTs };
  db.set({ ...task, share, shareVersion: task.shareVersion + 1 });
  const thread = { teamId: String(share.teamId), channelId: String(share.channelId), threadTs };
  db.set({
    ...sharedTaskKey(thread), entityType: "SHARED_TASK", taskId, workspaceId: task.workspaceId, ownerKey: task.ownerKey,
    developerId: task.developerId, developerName: task.developerName, project: task.project, mode: share.mode, sharedAt: share.sharedAt,
  });
  return `${thread.teamId}/${thread.channelId}/${threadTs}`;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/developer-task-share-route.test.ts
// Spec 025 C5, C24: POST /v1/dev/tasks/{taskId}/share, and a close ending the shared thread.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker, markThreadPosted, registerPolicy } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

async function privateTask(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const harness = await createDeveloperTaskBroker(options);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const share = (body: Record<string, unknown> = {}, who = MAYA) => harness.dev(who, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), ...body });
  const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { share?: Record<string, unknown>; shareVersion?: number };
  const shareRecords = () => harness.db.find((item) => item.pk === `TASK#${taskId}` && item.action === "share");
  return { ...harness, taskId, share, record, shareRecords };
}

describe("POST /v1/dev/tasks/{taskId}/share (C5)", () => {
  it("shares a private task in the default mode, and audits it (US3 scenario 9, Q9)", async () => {
    const { share, record, shareRecords } = await privateTask();
    const response = await share();
    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({ shared: true, share: { mode: "view", channelId: SLACK_CHANNEL, sharedReason: "requested" } });
    expect(record()).toMatchObject({ shared: true, shareVersion: 1, share: { teamId: SLACK_TEAM, mode: "view" } });
    expect(shareRecords()).toEqual([expect.objectContaining({ origin: "ai_tool", action: "share", phase: "accepted", outcome: "accepted" })]);
  });

  it("switches a shared thread's mode, on the task and on the thread's record (US3 scenario 7)", async () => {
    const { db, share, record, taskId } = await privateTask();
    await share({ shareMode: "continue" });
    markThreadPosted(db, taskId);
    const switched = await share({ shareMode: "view" });
    expect(switched.body.task).toMatchObject({ share: { mode: "view", threadUrl: `https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000100` } });
    expect(record().share).toMatchObject({ mode: "view", threadTs: "1695500000.000100" });
    expect(db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000100`, "META")).toMatchObject({ mode: "view" });
  });

  it("keeps view, and says why, when the latest revision does not allow continue (D5)", async () => {
    const { handler, share } = await privateTask();
    await share();
    await registerPolicy(handler, 2, { shareMode: { default: "view", allowContinue: false } });
    const answer = await share({ shareMode: "continue" });
    expect(answer.body.task).toMatchObject({ share: { mode: "view", modeReason: "continue_not_allowed" } });
  });

  it("refuses to move a shared task to another channel", async () => {
    const { share } = await privateTask();
    await share();
    const moved = await share({ channel: "C0SECOND001" });
    expect(moved.body.error).toMatchObject({ code: "CONFIG_INVALID", message: `this task is already shared in #payments-dev; its channel cannot change` });
  });

  it("answers a repeated request_id with the task as it is and writes nothing; another use conflicts", async () => {
    const { share, shareRecords, dev, taskId } = await privateTask();
    const requestId = randomUUID();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "continue" });
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "continue" });
    expect(shareRecords()).toHaveLength(1);
    const other = await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "view" });
    expect(other.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await share({ shareMode: "continue" })).status).toBe(200);
    expect(shareRecords()).toHaveLength(1);
  });

  it("is the task owner's alone (FR-036, Q2)", async () => {
    const { share } = await privateTask();
    expect((await share({}, OMAR)).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("wins a race with the notifier's write by reading the task again (C1)", async () => {
    const { db, share, taskId, record } = await privateTask();
    await share({ shareMode: "continue" });
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("shareVersion = :current")) {
        raced = true;
        markThreadPosted(db, taskId);
      }
      return original(command);
    };
    const answer = await share({ shareMode: "view" });
    expect(raced).toBe(true);
    expect(answer.status).toBe(200);
    expect(record().share).toMatchObject({ mode: "view", threadTs: "1695500000.000100" });
    expect(db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000100`, "META")).toMatchObject({ mode: "view" });
  });

  it("refuses a closed task, and a close marks its thread's record closed (C24)", async () => {
    const { db, share, finish, taskId, dev } = await privateTask();
    await share();
    markThreadPosted(db, taskId);
    const task = db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const prepareId = String((db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await finish(task.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000100`, "META")).toMatchObject({ closedAt: expect.any(String) });
    expect((await share({ shareMode: "continue" })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-share-route.test.ts`
Expected: FAIL, `NOT_FOUND` "route not found" for `/share`.

- [ ] **Step 4: Implement the route**

In `packages/broker/src/aws/developer-routes.ts`'s `routeDeveloperTaskRequest` call, add:

```ts
      projectChannelIds: async (project) => (await bindingsOf(deps)).filter((binding) => binding.projectName === project).map((binding) => binding.channelId).sort(),
```

In `packages/broker/src/aws/developer-tasks.ts`:
- import `ShareDeveloperTaskRequestSchema`, `developerTaskPolicy`, `sharedTaskKey` from
  `@agentx/contracts`, `decideMode`, `channelLabel` from `"../developer/share.js"`, and
  `type TaskShare` from `"../developer/task-records.js"`;
- add `projectChannelIds(project: string): Promise<string[]>;` to `DeveloperTaskRouteDependencies`;
- add:

```ts
const SHARE_ATTEMPTS = 3;

/** C5: the share the request asks for, from the task's current one, or "unchanged". */
async function nextShare(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  task: DeveloperTaskRecord,
  request: { shareMode?: "view" | "continue" | undefined; channel?: string | undefined },
  now: string,
): Promise<TaskShare | "unchanged"> {
  const project = await deps.actions.latestProject(task.project);
  if (project === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; ask an admin");
  const policy = developerTaskPolicy(project.definition);
  if (task.share === undefined) {
    // R11: sharing an existing task does not recheck project access; it uses the latest policy.
    const decision = await shareFor(deps, caller, task.project, { revision: project.definition.revision, policy, access: "granted", channelIds: await deps.projectChannelIds(task.project) }, { shareToChannel: true, shareMode: request.shareMode, channel: request.channel });
    if (decision === undefined || deps.slackTeamId === undefined) throw agentXError("CHANNEL_REQUIRED", "this AgentX has no Slack workspace set, so tasks cannot be shared");
    return taskShare(decision, deps.slackTeamId, now);
  }
  const current = task.share;
  if (request.channel !== undefined) {
    const named = request.channel.replace(/^#/, "").toLowerCase();
    if (request.channel !== current.channelId && current.channelName?.toLowerCase() !== named) {
      throw agentXError("CONFIG_INVALID", `this task is already shared in ${channelLabel({ channelId: current.channelId, ...(current.channelName === undefined ? {} : { name: current.channelName, isPrivate: false }) })}; its channel cannot change`);
    }
  }
  const mode = decideMode(policy, request.shareMode ?? current.mode);
  if (mode.mode === current.mode && mode.modeReason === current.modeReason) return "unchanged";
  // Built field by field, so a modeReason that no longer applies is dropped.
  return {
    teamId: current.teamId, channelId: current.channelId,
    ...(current.channelName === undefined ? {} : { channelName: current.channelName }),
    sharedReason: current.sharedReason, sharedAt: current.sharedAt,
    ...(current.threadTs === undefined ? {} : { threadTs: current.threadTs }),
    ...(current.postFailedAt === undefined ? {} : { postFailedAt: current.postFailedAt }),
    mode: mode.mode,
    ...(mode.modeReason === undefined ? {} : { modeReason: mode.modeReason }),
  };
}

/**
 * C5. Answers at once; the notifier posts the start message or the mode change (C6). Only the task's
 * developer may call it (Q2). Every write of `share` replaces the map, conditioned on shareVersion,
 * so a notifier write between this read and this write is read again, never lost (C1).
 */
async function shareTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ShareDeveloperTaskRequestSchema, value, deps, "share");
  let task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const idempotencyKey = { pk: `IDEMPOTENCY#${task.ownerKey}#${task.workspaceId}`, sk: `REQUEST#${request.requestId}` };
  const payloadHash = hashJson({ action: "share", shareMode: request.shareMode ?? null, channel: request.channel ?? null });
  const answer = async () => {
    const view = await taskView(deps, task, { events: 0, details: false });
    await syncIndex(deps, task, view.status, view.updatedAt);
    return { task: view };
  };
  const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another action on this task; use a new request_id");
    return answer();
  }
  for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt += 1) {
    if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    const receivedAt = iso(deps);
    const share = await nextShare(deps, caller, task, request, receivedAt);
    if (share === "unchanged") return answer();
    const version = task.shareVersion ?? 0;
    const label = channelLabel({ channelId: share.channelId, ...(share.channelName === undefined ? {} : { name: share.channelName, isPrivate: false }) });
    const items: TransactItems = [
      { Update: {
        TableName: deps.tableName, Key: taskKey(task.taskId),
        UpdateExpression: "SET #share = :share, #shared = :true, shareVersion = :next, updatedAt = :now",
        ConditionExpression: version === 0
          ? "attribute_exists(pk) AND attribute_not_exists(shareVersion) AND attribute_not_exists(closedAt)"
          : "shareVersion = :current AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#share": "share", "#shared": "shared" },
        ExpressionAttributeValues: { ":share": share, ":true": true, ":next": version + 1, ":now": receivedAt, ...(version === 0 ? {} : { ":current": version }) },
      } },
      // Unconditional, as the close's: the start wrote this row with the task.
      { Update: {
        TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
        UpdateExpression: "SET #shared = :true", ExpressionAttributeNames: { "#shared": "shared" }, ExpressionAttributeValues: { ":true": true },
      } },
      ...(share.threadTs === undefined ? [] : [{ Update: {
        TableName: deps.tableName, Key: sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }),
        UpdateExpression: "SET #mode = :mode", ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#mode": "mode" }, ExpressionAttributeValues: { ":mode": share.mode },
      } }]),
      putNew(deps.tableName, { ...idempotencyKey, entityType: "IDEMPOTENCY", action: "share", payloadHash }),
      // Q9: a share or mode change is audited like the task's other actions.
      putNew(turns, aiToolTurn({
        party: partyOfTask(task), turnId: randomUUID(), action: "share", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: `share ${request.shareMode ?? "default mode"}${request.channel === undefined ? "" : ` in ${request.channel}`}`,
        response: `Shared in ${label}, ${share.mode === "view" ? "view only" : "open to the channel"}.`,
      })),
    ];
    try {
      await deps.actions.transact(items);
      task = await loadOwnedTask(deps, caller, taskId);
      return answer();
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The same share, sent again, committed first.
      const concurrent = await get<{ payloadHash: string }>(deps, idempotencyKey);
      if (concurrent !== undefined) return shareTask(deps, caller, taskId, value);
      // The notifier (or a close) changed the task meanwhile: decide again from a fresh read.
      task = await loadOwnedTask(deps, caller, taskId);
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while sharing; try agentx_share_task again");
}
```

- if a test builds `DeveloperTaskRouteDependencies` by hand (`grep -rn "checkAccess:" tests`), add
  `projectChannelIds: async () => []` to it;
- in `routeDeveloperTaskRequest`, add `share` to the route pattern's alternatives
  (`(events|continue|cancel|close|pull-requests|share)`) and
  `if (taskId !== undefined && request.method === "POST" && route?.[2] === "share") return shareTask(deps, caller, taskId, body(request));`.
- in `finishTaskClose`, after the index row's update in `closing`, add:

```ts
    // C24: the shared thread's record says the task closed, so its mentions get the closed notice.
    ...(task.share?.threadTs === undefined ? [] : [{ Update: {
      TableName: deps.tableName,
      Key: sharedTaskKey({ teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs }),
      UpdateExpression: "SET closedAt = :now", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": now },
    } }]),
```

`finishTaskClose`'s callers pass the task they loaded; the worker callback path
(`finishDeveloperClose`) reads it fresh. If a start message is posted after a close read the task,
the notifier writes the record with `closedAt` itself (Task 7), so the thread ends either way.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-task-share-route.test.ts tests/contract/developer-task-close.test.ts tests/contract/developer-task-actions-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/developer-tasks.ts packages/broker/src/aws/developer-routes.ts tests/support/developer-task-broker.ts tests/contract/developer-task-share-route.test.ts
git commit -m "feat(broker): share a running task and change its mode (spec 025 FR-030, FR-031)"
```

---

### Task 5: Channel turns in the task view

C15: `agentx_get_task` shows the shared thread's turns on the task (FR-030, US3 scenario 7). The
share fields themselves came with Task 3's `shareView`.

**Files:**
- Modify: `packages/broker/src/aws/developer-task-actions.ts` (`channelTurns`)
- Modify: `packages/broker/src/aws/broker.ts` (`developerTaskActions`)
- Modify: `packages/broker/src/aws/developer-tasks.ts` (`taskView`)
- Test: `tests/contract/developer-task-channel-turns.test.ts`

**Interfaces:**
- Consumes: `sharedSubject` (Task 3), `markThreadPosted` (Task 4), `ChannelTurn`,
  `CHANNEL_TURNS_MAX`, `CHANNEL_TURN_REQUEST_MAX` (Task 1).
- Produces: `DeveloperTaskActions.channelTurns(threadSubject: string, taskId: string, limit: number): Promise<ChannelTurn[]>`;
  `taskView(..., { details: true })` adds `channelTurns` for a task whose thread is posted.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-channel-turns.test.ts
// Spec 025 C15: the channel's turns on a shared task, from the thread's Slack turn records.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker, markThreadPosted } from "../support/developer-task-broker.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

async function sharedTask() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true, shareMode: "continue" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const subject = markThreadPosted(harness.db, taskId);
  const turn = (at: string, fields: Record<string, unknown>) => harness.db.set({
    pk: `THREAD#${subject}`, sk: `TURN#${at}#Ev${at.replace(/\D/g, "").slice(0, 12)}`, origin: "slack", subject, receivedAt: at,
    requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered", requestText: "run the linter", responseText: "done", ...fields,
  });
  return { ...harness, taskId, turn };
}

describe("channel turns (C15)", () => {
  it("lists this task's turns newest first, with author, time, request and outcome", async () => {
    const { dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId, requesterName: "Priya" });
    turn("2026-09-29T10:02:00.000Z", { taskId, requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0LEO00001" }, disposition: "failed", requestText: "also bump the version" });
    turn("2026-09-29T10:03:00.000Z", {});
    turn("2026-09-29T10:04:00.000Z", { taskId: randomUUID() });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: unknown[] };
    expect(view.channelTurns).toEqual([
      { author: { slackUserId: "U0LEO00001" }, at: "2026-09-29T10:02:00.000Z", request: "also bump the version", outcome: "failed" },
      { author: { slackUserId: "U0PRIYA001", name: "Priya" }, at: "2026-09-29T10:01:00.000Z", request: "run the linter", outcome: "answered" },
    ]);
  });

  it("cuts a request to 300 characters and redacts it again on the way out", async () => {
    const { dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId, requestText: `use ${SECRET} ${"y".repeat(500)}` });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: Array<{ request: string }> };
    expect(view.channelTurns[0]!.request.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it("shows at most 20, and none for a task whose thread is not posted", async () => {
    const { dev, taskId, turn } = await sharedTask();
    for (let index = 0; index < 25; index += 1) turn(`2026-09-29T10:${String(10 + index).padStart(2, "0")}:00.000Z`, { taskId });
    expect(((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: unknown[] }).channelTurns).toHaveLength(20);
    const fresh = await createDeveloperTaskBroker();
    const other = await fresh.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true });
    const otherId = (other.body.task as { taskId: string }).taskId;
    expect((await fresh.dev(MAYA, "GET", `/v1/dev/tasks/${otherId}`)).body.task).not.toHaveProperty("channelTurns");
  });

  it("still answers the read when the turn records cannot be read", async () => {
    const { db, dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId });
    const original = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("THREAD#")) throw Object.assign(new Error("nope"), { name: "InternalServerError" });
      return original(command);
    };
    const read = await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect(read.body.task).not.toHaveProperty("channelTurns");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-channel-turns.test.ts`
Expected: FAIL, `channelTurns` is undefined.

- [ ] **Step 3: Implement**

In `packages/broker/src/aws/developer-task-actions.ts`, add to `DeveloperTaskActions`
(import `type ChannelTurn` from `@agentx/contracts`):

```ts
  /** C15: the shared thread's Slack turn records that name this task, newest first, at most `limit`. */
  channelTurns(threadSubject: string, taskId: string, limit: number): Promise<ChannelTurn[]>;
```

In `packages/broker/src/aws/broker.ts`'s `developerTaskActions`, add (import
`CHANNEL_TURN_REQUEST_MAX`, `type ChannelTurn`, `redactAndCap` from `@agentx/contracts`):

```ts
    channelTurns: async (threadSubject, taskId, limit) => {
      const table = dependencies.turnRecordsTableName;
      if (table === undefined) return [];
      const found: Array<Record<string, unknown>> = [];
      let startKey: Record<string, unknown> | undefined;
      // A thread's records are few (the thread's rate limit caps them); five pages bound the read anyway.
      for (let page = 0; page < 5; page += 1) {
        const response = await dependencies.documentClient.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `THREAD#${threadSubject}`, ":prefix": "TURN#" },
          ScanIndexForward: false,
          Limit: 100,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }));
        found.push(...(response.Items ?? []).filter((item) => item.taskId === taskId));
        startKey = response.LastEvaluatedKey;
        if (startKey === undefined || found.length >= limit) break;
      }
      return found.slice(0, limit).map((item): ChannelTurn => {
        const requester = item.requestedBy as { userId?: unknown } | undefined;
        return {
          author: { slackUserId: String(requester?.userId ?? "unknown"), ...(typeof item.requesterName === "string" ? { name: item.requesterName } : {}) },
          at: String(item.receivedAt),
          // Stored redacted; redacted again here, so a record from an older writer cannot leak.
          request: redactAndCap(String(item.requestText ?? ""), CHANNEL_TURN_REQUEST_MAX).text,
          outcome: String(item.disposition ?? "unknown"),
        };
      });
    },
```

In `packages/broker/src/aws/developer-tasks.ts`, import `CHANNEL_TURNS_MAX` and `sharedSubject`, and in
`taskView` add, after `details` is computed:

```ts
  // C15: only the full read shows channel turns, and a storage problem never breaks it.
  let channelTurns: DeveloperTaskView["channelTurns"];
  if (options.details && task.share?.threadTs !== undefined) {
    try {
      const turns = await deps.actions.channelTurns(sharedSubject({ ...task.share, threadTs: task.share.threadTs }), task.taskId, CHANNEL_TURNS_MAX);
      if (turns.length > 0) channelTurns = turns;
    } catch (error) {
      log(deps, { event: "developer.channel_turns_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
```

and in the returned object, after `...details,`: `...(channelTurns === undefined ? {} : { channelTurns }),`.

Also add `channelTurns: async () => []` to every hand-written `DeveloperTaskActions` fake in the
tests (`grep -rn "DeveloperTaskActions = {" tests` lists them), so the interface still type-checks.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/developer-task-channel-turns.test.ts tests/contract/developer-task-reads.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src tests/contract
git commit -m "feat(broker): list the shared thread's channel turns in the task view (spec 025 FR-030)"
```

---

### Task 6: Notices from the state table's stream

C7, C8: which committed changes the thread hears about, as a pure function of the stream's old and
new images. Also the test support that turns the fake table's writes into stream records.

**Files:**
- Modify: `tests/support/fake-dynamodb.ts` (`onWrite`)
- Modify: `tests/support/developer-task-broker.ts` (`recordStream`)
- Create: `packages/broker/src/developer/notifications.ts`
- Test: `tests/contract/developer-task-notices.test.ts`

**Interfaces:**
- Consumes: the task, pointer and operation records as 25b and Tasks 3 and 4 write them.
- Produces:
  - `interface StreamRecord { eventID?: string; eventName?: string; dynamodb?: { ApproximateCreationDateTime?: number; NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> } }`
  - `type NoticeKind = "start" | "mode" | "closed" | "cancelled" | "ready" | "setup_failed" | "ended" | "pull_request"`
  - `interface Notice { id: string; kind: NoticeKind; at: string; taskId?: string; workspaceId?: string; operationId?: string; mode?: "view" | "continue" }`
  - `noticesFromStream(records: readonly StreamRecord[]): Notice[]`
  - `noticesOf(previous: Record<string, unknown> | undefined, next: Record<string, unknown>, at: string, eventId: string): Notice[]`
  - `FakeDynamoDb.onWrite(listener: (change: { before?: Item; after?: Item }) => void): () => void`
  - `recordStream(db: FakeDynamoDb): { take(): StreamRecord[] }` (every committed write since the last `take`, as stream records)

- [ ] **Step 1: Add the write listener and the stream recorder**

In `tests/support/fake-dynamodb.ts`, in `FakeDynamoDb`:

```ts
  private readonly listeners = new Set<(change: { before?: Item; after?: Item }) => void>();

  /** Each committed write's item before and after, as a DynamoDB stream record carries them. `set` (seeding) is not reported. */
  onWrite(listener: (change: { before?: Item; after?: Item }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
```

and in `commit`'s apply loop, replace the body with:

```ts
    for (const action of actions) {
      if (action.kind === "ConditionCheck") continue;
      const before = this.items.get(action.key);
      const next = action.apply(before);
      if (next === undefined) this.items.delete(action.key);
      else this.items.set(action.key, next);
      for (const listener of this.listeners) {
        listener({ ...(before === undefined ? {} : { before: structuredClone(before) }), ...(next === undefined ? {} : { after: structuredClone(next) }) });
      }
    }
```

In `tests/support/developer-task-broker.ts` (import `marshall` from `@aws-sdk/util-dynamodb` and
`type StreamRecord` from the notifications module):

```ts
/** Every committed write since the last take(), as the state table's stream would deliver it. */
export function recordStream(db: FakeDynamoDb): { take(): StreamRecord[] } {
  let records: StreamRecord[] = [];
  let sequence = 0;
  const image = (item: Record<string, unknown>) => marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true });
  db.onWrite(({ before, after }) => {
    sequence += 1;
    records.push({
      eventID: `event-${sequence}`,
      eventName: before === undefined ? "INSERT" : after === undefined ? "REMOVE" : "MODIFY",
      dynamodb: {
        ApproximateCreationDateTime: Math.floor(Date.now() / 1000),
        ...(after === undefined ? {} : { NewImage: image(after) }),
        ...(before === undefined ? {} : { OldImage: image(before) }),
      },
    });
  });
  return { take: () => { const taken = records; records = []; return taken; } };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/developer-task-notices.test.ts
// Spec 025 C7, C8: the notices the notifier derives from committed changes.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { noticesFromStream, noticesOf } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

async function started(body: Record<string, unknown> = { shareToChannel: true }) {
  const harness = await createDeveloperTaskBroker();
  const stream = recordStream(harness.db);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", ...body });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return { ...harness, stream, taskId, workspaceId: task.workspaceId, prepareId, active };
}
const kinds = (records: Parameters<typeof noticesFromStream>[0]) => noticesFromStream(records).map((notice) => notice.kind);

describe("notices from the stream (C7, C8)", () => {
  it("announces a shared start, then the workspace, then the task's end", async () => {
    const { stream, finish, workspaceId, prepareId, active, taskId } = await started();
    const start = noticesFromStream(stream.take());
    expect(start).toEqual([expect.objectContaining({ id: `${taskId}:start`, kind: "start", taskId })]);
    await finish(workspaceId, prepareId, "SUCCEEDED");
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ id: `${prepareId}:ready`, kind: "ready", workspaceId, operationId: prepareId })]);
    const taskOperation = active();
    await finish(workspaceId, taskOperation, "SUCCEEDED");
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ id: `${taskOperation}:ended`, kind: "ended" })]);
  });

  it("gives a failed setup its own notice", async () => {
    const { stream, finish, workspaceId, prepareId } = await started();
    stream.take();
    await finish(workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(kinds(stream.take())).toEqual(["setup_failed"]);
  });

  it("announces a cancel before the instructions ran, a mode change and a close", async () => {
    const { stream, dev, taskId, finish, workspaceId, prepareId } = await started();
    stream.take();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(kinds(stream.take())).toEqual(["cancelled"]);
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ kind: "mode", mode: "continue", taskId })]);
    await finish(workspaceId, prepareId, "FAILED", { error: "stopped" });
    stream.take();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(kinds(stream.take())).toContain("closed");
  });

  it("derives the same notices for a private task, which the notifier then drops, and none for a Slack thread", async () => {
    const { stream, finish, workspaceId, prepareId, handler } = await started({});
    expect(kinds(stream.take())).toEqual([]);
    await finish(workspaceId, prepareId, "SUCCEEDED");
    expect(kinds(stream.take())).toEqual(["ready"]);
    const thread = await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009`, "U0PRATIK01");
    await finish(String(thread.body.workspaceId), String(thread.body.operationId), "SUCCEEDED");
    expect(kinds(stream.take())).toEqual([]);
  });

  it("ignores a change to an operation that had already ended, and a teammate's operation", () => {
    const ended = { entityType: "OPERATION", id: randomUUID(), workspaceId: randomUUID(), kind: "task", status: "SUCCEEDED", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } };
    expect(noticesOf({ ...ended, updatedAt: "a" }, { ...ended, updatedAt: "b" }, "2026-09-29T10:00:00.000Z", "e1")).toEqual([]);
    const teammate = { ...ended, status: "SUCCEEDED", requestedBy: { teamId: SLACK_TEAM, userId: "U0PRIYA001" } };
    expect(noticesOf({ ...teammate, status: "RUNNING" }, teammate, "2026-09-29T10:00:00.000Z", "e2")).toEqual([]);
  });

  it("links a successful publish, and reports a failed one as an ended operation", () => {
    const publish = { entityType: "OPERATION", id: randomUUID(), workspaceId: randomUUID(), kind: "publish", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } };
    expect(noticesOf({ ...publish, status: "RUNNING" }, { ...publish, status: "SUCCEEDED" }, "t", "e3").map((notice) => notice.kind)).toEqual(["pull_request"]);
    expect(noticesOf({ ...publish, status: "RUNNING" }, { ...publish, status: "FAILED" }, "t", "e4").map((notice) => notice.kind)).toEqual(["ended"]);
  });

  it("names each mode change by its stream event, so two changes are two notices", () => {
    const task = { entityType: "DEVELOPER_TASK", taskId: randomUUID() };
    const view = { ...task, share: { mode: "view" } };
    const open = { ...task, share: { mode: "continue" } };
    const first = noticesOf(view, open, "t", "e5");
    const second = noticesOf(open, view, "t", "e6");
    expect([first[0]!.id, second[0]!.id]).toEqual([`${task.taskId}:mode:e5`, `${task.taskId}:mode:e6`]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-notices.test.ts`
Expected: FAIL, the notifications module does not exist.

- [ ] **Step 4: Write `notifications.ts`**

```ts
// packages/broker/src/developer/notifications.ts
// Spec 025 C7, C8: the notices a shared task's thread hears about, from the state table's stream.
// Pure: whether the task is shared is decided when a notice is delivered (Task 7).
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

export interface StreamRecord {
  eventID?: string;
  eventName?: string;
  dynamodb?: { ApproximateCreationDateTime?: number; NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> };
}
export type NoticeKind = "start" | "mode" | "closed" | "cancelled" | "ready" | "setup_failed" | "ended" | "pull_request";
export interface Notice {
  /** Fixed per change, so a repeated delivery posts once (C9). */
  id: string;
  kind: NoticeKind;
  /** When the change committed; changes before a task was shared are not posted. */
  at: string;
  taskId?: string;
  workspaceId?: string;
  operationId?: string;
  mode?: "view" | "continue";
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);

export function noticesOf(previous: Record<string, unknown> | undefined, next: Record<string, unknown>, at: string, eventId: string): Notice[] {
  switch (next.entityType) {
    case "DEVELOPER_TASK": {
      const taskId = text(next.taskId);
      const before = record(previous?.share);
      const after = record(next.share);
      const notices: Notice[] = [];
      if (after !== undefined && before === undefined) notices.push({ id: `${taskId}:start`, kind: "start", taskId, at });
      else if (after !== undefined && before !== undefined && after.mode !== before.mode) {
        notices.push({ id: `${taskId}:mode:${eventId}`, kind: "mode", taskId, at, mode: after.mode === "continue" ? "continue" : "view" });
      }
      if (next.closedAt !== undefined && previous?.closedAt === undefined) notices.push({ id: `${taskId}:closed`, kind: "closed", taskId, at });
      return notices;
    }
    case "DEVELOPER_TASK_POINTER":
      return next.cancelledAt !== undefined && previous?.cancelledAt === undefined
        ? [{ id: `${text(next.taskId)}:cancelled`, kind: "cancelled", taskId: text(next.taskId), at }]
        : [];
    case "OPERATION": {
      // Only the developer's own operations: the Slack service answers a teammate's (C8).
      if (record(next.requestedBy)?.kind !== "developer") return [];
      if (!TERMINAL.has(text(next.status)) || TERMINAL.has(text(previous?.status))) return [];
      const base = { workspaceId: text(next.workspaceId), operationId: text(next.id), at };
      if (next.kind === "prepare") {
        const kind = next.status === "SUCCEEDED" ? "ready" : "setup_failed";
        return [{ ...base, id: `${base.operationId}:${kind}`, kind }];
      }
      if (next.kind === "publish" && next.status === "SUCCEEDED") return [{ ...base, id: `${base.operationId}:pull_request`, kind: "pull_request" }];
      if (next.kind === "task" || next.kind === "publish") return [{ ...base, id: `${base.operationId}:ended`, kind: "ended" }];
      return [];
    }
    default:
      return [];
  }
}

export function noticesFromStream(records: readonly StreamRecord[]): Notice[] {
  const notices: Notice[] = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    const next = unmarshall(image) as Record<string, unknown>;
    const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
    const seconds = entry.dynamodb?.ApproximateCreationDateTime ?? Date.now() / 1000;
    notices.push(...noticesOf(previous, next, new Date(seconds * 1000).toISOString(), entry.eventID ?? ""));
  }
  return notices;
}
```

Check `@aws-sdk/util-dynamodb` is already a dependency of `@agentx/broker` (the outbox publisher
imports it); if not, add it at the version the lockfile already has.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-task-notices.test.ts tests/contract/idempotency.test.ts tests/contract/slack-control-plane.test.ts`
Expected: PASS (the last two show the fake's listener changes nothing else).

- [ ] **Step 6: Commit**

```bash
git add tests/support/fake-dynamodb.ts tests/support/developer-task-broker.ts packages/broker/src/developer/notifications.ts tests/contract/developer-task-notices.test.ts
git commit -m "feat(broker): derive a shared thread's notices from committed changes (spec 025 FR-034)"
```

---

### Task 7: The notifier posts the thread

C6, C8, C9, C24: the `DeveloperTaskNotifier` handler (FR-032, FR-034, US3 scenarios 1, 3 and 9,
SC-004 in Slack posts). **Depends on Q3** (the closed reply and record).

**Files:**
- Create: `packages/broker/src/aws/slack-web.ts`
- Create: `packages/broker/src/aws/developer-task-notifier.ts`
- Test: `tests/contract/developer-task-notifier.test.ts`

**Interfaces:**
- Consumes: `noticesFromStream`, `Notice`, `StreamRecord` (Task 6); the texts of Task 2;
  `deriveTaskStatus`, `failureCategory`, `taskKey`, `taskPointerKey` (25b); `sharedTaskKey`,
  `SHARE_DELIVERY_WINDOW_MS` (Task 1); `recordStream`, `markThreadPosted` (Tasks 4, 6).
- Produces:
  - `chatPostMessage(botToken: string, input: { channel: string; threadTs?: string; text: string }, fetchImplementation?: typeof fetch): Promise<{ ts: string }>`; `class SlackPostError { slackError: string }`
  - `interface NotifierDependencies { documentClient; tableName: string; enqueue(notices: readonly Notice[]): Promise<void>; retryLater(receiptHandle: string, seconds: number): Promise<void>; post(input: { channel: string; threadTs?: string; text: string }): Promise<{ ts: string }>; now(): number; log(entry: Record<string, unknown>): void; deliveryFailed(): void }`
  - `createNotifierHandler(deps: NotifierDependencies): (event: { Records?: unknown[] }) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>`
  - `retryDelaySeconds(attempt: number): number` (30, 60, 120, 240, 480, then 900)
  - `handler` (the Lambda entry; reads `STATE_TABLE_NAME`, `NOTICE_QUEUE_URL`, `SLACK_SECRET_ARN`,
    `AGENTX_METRICS_NAMESPACE` only when first used)

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-notifier.test.ts
// Spec 025 FR-032, FR-034, C7 to C9: the notifier, fed from the fake table's writes, posting to a
// fake Slack. The queue is an array; a failed notice stays in it with its attempt count.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";
import { createNotifierHandler, retryDelaySeconds } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const BOT_TOKEN = "xoxb-1111-2222-plantedbottoken";
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

async function notifierHarness(body: Record<string, unknown> = { shareToChannel: true }) {
  const harness = await createDeveloperTaskBroker();
  const stream = recordStream(harness.db);
  const posts: Array<{ channel: string; threadTs?: string; text: string }> = [];
  const queue: Array<{ notice: Notice; attempt: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let clock = Date.now();
  let failing: string | undefined;
  let ts = 1_695_500_000_000_100;
  const deliveryFailed = vi.fn();
  const retryLater = vi.fn(async () => undefined);
  const handle = createNotifierHandler({
    documentClient: harness.db, tableName: "state",
    enqueue: async (notices) => { for (const notice of notices) queue.push({ notice, attempt: 0 }); },
    retryLater,
    post: async (input) => {
      if (failing !== undefined) throw new SlackPostError(failing);
      posts.push(input);
      ts += 1;
      const text = String(ts);
      return { ts: `${text.slice(0, 10)}.${text.slice(10)}` };
    },
    now: () => clock, log: (entry) => logs.push(entry), deliveryFailed,
  });
  /** Stream to queue, then every queued notice once; failed ones stay queued. */
  const pump = async () => {
    await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const batch = queue.splice(0, queue.length);
    const answer = await handle({ Records: batch.map((entry, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(entry.notice), attributes: { ApproximateReceiveCount: String(entry.attempt + 1) } })) });
    const failed = new Set(answer.batchItemFailures.map((failure) => failure.itemIdentifier));
    batch.forEach((entry, index) => { if (failed.has(`m${index}`)) queue.push({ notice: entry.notice, attempt: entry.attempt + 1 }); });
  };
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...body });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return {
    ...harness, stream, posts, queue, logs, pump, taskId, workspaceId, active, deliveryFailed, retryLater,
    advance: (ms: number) => { clock += ms; }, fail: (code: string | undefined) => { failing = code; },
  };
}

describe("the shared thread (FR-032, US3 scenario 1)", () => {
  it("posts the start message in the channel and records the thread", async () => {
    const { db, posts, pump, taskId } = await notifierHarness({ shareToChannel: true, shareMode: "continue" });
    await pump();
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toHaveProperty("threadTs");
    expect(posts[0]!.channel).toBe(SLACK_CHANNEL);
    expect(posts[0]!.text).toContain(`<@${MAYA.slackUserId}> started a task from Claude Code: *Fix the flaky retry test*`);
    expect(posts[0]!.text).toContain("Status: STARTING");
    expect(posts[0]!.text).toContain("may mention AgentX in this thread");
    const task = db.get(`DEVTASK#${taskId}`, "META") as { share: { threadTs: string } };
    expect(task.share.threadTs).toMatch(/^\d{10}\.\d{6}$/);
    expect(db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${task.share.threadTs}`, "META")).toMatchObject({ taskId, mode: "continue", ownerKey: expect.any(String) });
  });

  it("replies in the thread as the task runs, ends and opens a pull request, then closes; the summary is redacted", async () => {
    const h = await notifierHarness();
    await h.pump();
    const prepareId = h.active();
    await h.finish(h.workspaceId, prepareId, "SUCCEEDED");
    await h.pump();
    const taskOperation = h.active();
    await h.events(h.workspaceId, taskOperation, [say(`All green. Token was ${SECRET}.`)]);
    await h.finish(h.workspaceId, taskOperation, "SUCCEEDED");
    await h.pump();
    const opened = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/pull-requests`, { requestId: randomUUID(), title: "Fix the flaky retry test" });
    const operationId = String(opened.body.operationId);
    const publish = h.db.find((item) => item.entityType === "OPERATION" && item.id === operationId)[0] as { publication: { headBranch: string } };
    const url = "https://github.com/example/demo/pull/7";
    await h.finish(h.workspaceId, operationId, "SUCCEEDED", { result: { repository: "demo", number: 7, url, headBranch: publish.publication.headBranch, baseBranch: "main", commit: "a".repeat(40), checks: [], reconciled: false } });
    await h.pump();
    const thread = h.posts[0]!;
    const replies = h.posts.slice(1);
    expect(replies.every((reply) => reply.threadTs !== undefined && reply.channel === thread.channel)).toBe(true);
    expect(replies.map((reply) => reply.text.split("\n")[0])).toEqual([
      "The workspace is ready, and the task is running.",
      "The task ended SUCCEEDED.",
      `Pull request opened: ${url}`,
    ]);
    expect(replies[1]!.text).toContain(">All green.");
    expect(JSON.stringify(h.posts)).not.toContain(SECRET);
  });

  it("posts nothing for a private task (US3 scenario 3)", async () => {
    const h = await notifierHarness({});
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(h.posts).toEqual([]);
    expect(h.queue).toEqual([]);
  });

  it("shares a running task with its current status, and leaves out what happened before (US3 scenario 9)", async () => {
    const h = await notifierHarness({});
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID() });
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.text).toContain("Status: RUNNING");
  });

  it("holds a reply until the start message has its thread, then posts it there", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(h.posts).toEqual([]);
    expect(h.queue.map((entry) => entry.notice.kind).sort()).toEqual(["ready", "start"]);
    h.fail(undefined);
    await h.pump();
    await h.pump();
    expect(h.posts.map((post) => post.threadTs === undefined ? "start" : "reply")).toEqual(["start", "reply"]);
  });

  it("posts each notice once, however often it is delivered (C9)", async () => {
    const h = await notifierHarness();
    await h.pump();
    const [start] = h.posts;
    const again = { notice: { id: `${h.taskId}:start`, kind: "start" as const, taskId: h.taskId, at: new Date().toISOString() }, attempt: 0 };
    h.queue.push(again, again);
    await h.pump();
    expect(h.posts).toEqual([start]);
  });

  it("says a mode change, and skips a change that a later one replaced", async () => {
    const h = await notifierHarness();
    await h.pump();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID(), shareMode: "view" });
    await h.pump();
    expect(h.posts.slice(1).map((post) => post.text)).toEqual(["This thread is now view only: follow-ups happen in the developer's AI tool."]);
  });
});

describe("retries (C9, Review Focus 3)", () => {
  it("retries with a growing delay within the hour", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    await h.pump();
    expect(h.retryLater.mock.calls.map(([, seconds]) => seconds)).toEqual([30, 60]);
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 900, 900]);
    expect(h.deliveryFailed).not.toHaveBeenCalled();
  });

  it("gives up on the start message after an hour and drops the task's later replies", async () => {
    const h = await notifierHarness();
    h.fail("channel_not_found");
    await h.pump();
    h.advance(3_600_001);
    await h.pump();
    expect(h.deliveryFailed).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.delivery_failed", kind: "start", reason: "channel_not_found" }));
    expect((h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: Record<string, unknown> }).share).toHaveProperty("postFailedAt");
    h.fail(undefined);
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(h.posts).toEqual([]);
    expect(h.deliveryFailed).toHaveBeenCalledTimes(1);
    expect((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.taskId}`)).body.task).toMatchObject({ share: { postFailed: true } });
  });

  it("never logs the bot token or a post's text", async () => {
    const h = await notifierHarness();
    h.fail("invalid_auth");
    await h.pump();
    expect(JSON.stringify(h.logs)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain("Fix the flaky retry test");
  });
});

describe("a closed task (C24, Q3)", () => {
  it("records the thread closed when the start message is posted after the close", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "npm ci exited 1" });
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/close`, { requestId: randomUUID() });
    h.fail(undefined);
    await h.pump();
    await h.pump();
    const threadTs = (h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { threadTs: string } }).share.threadTs;
    expect(h.db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`, "META")).toMatchObject({ closedAt: expect.any(String) });
    expect(h.posts.map((post) => post.text.split("\n")[0])).toContain("The task is closed, and its workspace is released. This thread no longer drives it.");
  });
});

describe("chat.postMessage", () => {
  it("returns the message's ts, and reports Slack's error code without the token", async () => {
    const { chatPostMessage } = await import("../../packages/broker/src/aws/slack-web.js");
    const ok = vi.fn(async () => Response.json({ ok: true, ts: "1695500000.000200" }));
    expect(await chatPostMessage(BOT_TOKEN, { channel: SLACK_CHANNEL, threadTs: "1695500000.000100", text: "hi" }, ok as unknown as typeof fetch)).toEqual({ ts: "1695500000.000200" });
    expect(JSON.parse(String((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ channel: SLACK_CHANNEL, thread_ts: "1695500000.000100", unfurl_links: false });
    const refused = vi.fn(async () => Response.json({ ok: false, error: "not_in_channel" }));
    await expect(chatPostMessage(BOT_TOKEN, { channel: SLACK_CHANNEL, text: "hi" }, refused as unknown as typeof fetch)).rejects.toMatchObject({ slackError: "not_in_channel" });
    const error = await chatPostMessage(BOT_TOKEN, { channel: SLACK_CHANNEL, text: "hi" }, refused as unknown as typeof fetch).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(BOT_TOKEN);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-notifier.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Write `slack-web.ts`**

```ts
// packages/broker/src/aws/slack-web.ts
// Spec 025 FR-034: the one Slack Web API call the notifier makes. The token goes only in the
// Authorization header; an error carries Slack's error code (lowercase letters and _) or the HTTP
// status, never the token or the request body.
export class SlackPostError extends Error {
  constructor(readonly slackError: string) {
    super(`Slack chat.postMessage failed: ${slackError}`);
    this.name = "SlackPostError";
  }
}

export async function chatPostMessage(
  botToken: string,
  input: { channel: string; threadTs?: string | undefined; text: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ ts: string }> {
  const response = await fetchImplementation("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: input.channel, text: input.text, unfurl_links: false, unfurl_media: false, ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }) }),
    signal: AbortSignal.timeout(10_000),
  });
  let result: Record<string, unknown> = {};
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    // An unreadable answer is reported by its HTTP status below.
  }
  if (!response.ok || result.ok !== true || typeof result.ts !== "string") {
    const code = typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : `http_${response.status}`;
    throw new SlackPostError(code);
  }
  return { ts: result.ts };
}
```

- [ ] **Step 4: Write `developer-task-notifier.ts`**

```ts
// packages/broker/src/aws/developer-task-notifier.ts
// Spec 025 FR-032, FR-034, C7 to C9: the DeveloperTaskNotifier, the only new reader of the Slack
// secret. The state table's stream (filtered in infra) brings changes, which become notices on the
// notifier's own queue; the queue brings each notice back, and it is posted once. Logs carry event
// names, IDs, notice kinds and Slack error codes only: never a token, a post's text or a task's text.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ChangeMessageVisibilityCommand, SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { PullRequestResultSchema, SHARE_DELIVERY_WINDOW_MS, lastAssistantResponse, sharedTaskKey } from "@agentx/contracts";
import { noticesFromStream, type Notice, type StreamRecord } from "../developer/notifications.js";
import { CANCELLED_REPLY, CLOSED_REPLY, READY_REPLY, endedReply, modeReply, pullRequestReply, setupFailedReply, startMessage } from "../developer/share-messages.js";
import { deriveTaskStatus, failureCategory, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type OperationFacts } from "../developer/task-records.js";
import { isConditional } from "./broker-shared.js";
import { requiredEnvironment } from "./lambda.js";
import { parseSlackSecrets } from "./slack-ingress.js";
import { SlackPostError, chatPostMessage } from "./slack-web.js";

type Client = { send(command: unknown): Promise<unknown> };
interface QueueRecord { eventSource: "aws:sqs"; messageId: string; receiptHandle: string; body: string; attributes?: { ApproximateReceiveCount?: string } }

export interface NotifierDependencies {
  documentClient: Client;
  tableName: string;
  enqueue(notices: readonly Notice[]): Promise<void>;
  retryLater(receiptHandle: string, seconds: number): Promise<void>;
  post(input: { channel: string; threadTs?: string; text: string }): Promise<{ ts: string }>;
  now(): number;
  log(entry: Record<string, unknown>): void;
  /** One `SlackDeliveryFailed` count (spec 015 FR-045's alarm sums it). */
  deliveryFailed(): void;
}

/** The start message is still being posted: a reply waits for its thread (C9). */
class StartPending extends Error {
  constructor() {
    super("the start message is not posted yet");
    this.name = "StartPending";
  }
}

export const retryDelaySeconds = (attempt: number): number => Math.min(900, 30 * 2 ** Math.max(0, Math.min(attempt - 1, 5)));

const NOTICE_KINDS = new Set(["start", "mode", "closed", "cancelled", "ready", "setup_failed", "ended", "pull_request"]);
function parseNotice(body: string): Notice | undefined {
  try {
    const value = JSON.parse(body) as Partial<Notice>;
    return typeof value.id === "string" && typeof value.at === "string" && typeof value.kind === "string" && NOTICE_KINDS.has(value.kind) ? value as Notice : undefined;
  } catch {
    return undefined;
  }
}

async function getItem<T>(deps: NotifierDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
}

async function putMarker(deps: NotifierDependencies, marker: { pk: string; sk: string }): Promise<void> {
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...marker, entityType: "NOTICE", deliveredAt: new Date(deps.now()).toISOString() }, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

async function noticeTask(deps: NotifierDependencies, notice: Notice): Promise<DeveloperTaskRecord | undefined> {
  let taskId = notice.taskId;
  if (taskId === undefined && notice.workspaceId !== undefined) taskId = (await getItem<DeveloperTaskPointerRecord>(deps, taskPointerKey(notice.workspaceId)))?.taskId;
  return taskId === undefined ? undefined : getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
}

async function operationsOf(deps: NotifierDependencies, workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `WORKSPACE#${workspaceId}`, ":prefix": "OPERATION#" }, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).filter((item) => item.entityType === "OPERATION");
}

/** The status the start message shows: R4's rule, on the task's current records. */
async function currentStatus(deps: NotifierDependencies, task: DeveloperTaskRecord): Promise<string> {
  const [workspace, pointer, operations] = await Promise.all([
    getItem<{ status: string }>(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }),
    getItem<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId)),
    operationsOf(deps, task.workspaceId),
  ]);
  return deriveTaskStatus({ closedAt: task.closedAt, workspaceStatus: workspace?.status ?? "PREPARING", pointer, operations: operations as unknown as OperationFacts[] }).status;
}

/** C1, C2: the thread on the task and its record, in one transaction, retried on a share change. */
async function recordThread(deps: NotifierDependencies, taskId: string, threadTs: string, marker: { pk: string; sk: string }): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = await getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (task?.share === undefined) return;
    if (task.share.threadTs !== undefined) {
      // Only a delivery that posted but could not record gets here; the first thread stays the thread.
      deps.log({ event: "developer_notifier.start_posted_twice", taskId });
      await putMarker(deps, marker);
      return;
    }
    const share = { ...task.share, threadTs };
    const version = task.shareVersion ?? 0;
    const now = new Date(deps.now()).toISOString();
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: "SET #share = :share, shareVersion = :next, updatedAt = :now",
          ConditionExpression: "shareVersion = :current",
          ExpressionAttributeNames: { "#share": "share" },
          ExpressionAttributeValues: { ":share": share, ":next": version + 1, ":current": version, ":now": now },
        } },
        { Put: {
          TableName: deps.tableName,
          Item: {
            ...sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs }), entityType: "SHARED_TASK",
            taskId, workspaceId: task.workspaceId, ownerKey: task.ownerKey, developerId: task.developerId, developerName: task.developerName,
            project: task.project, mode: share.mode, sharedAt: share.sharedAt,
            // C24: a task closed before its start message posted gets a closed thread at once.
            ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { Put: { TableName: deps.tableName, Item: { ...marker, entityType: "NOTICE", deliveredAt: now }, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  deps.log({ event: "developer_notifier.thread_record_failed", taskId });
  throw new Error("the shared thread could not be recorded");
}

async function markPostFailed(deps: NotifierDependencies, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = await getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (task?.share === undefined || task.share.threadTs !== undefined) return;
    const version = task.shareVersion ?? 0;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
        TableName: deps.tableName, Key: taskKey(taskId),
        UpdateExpression: "SET #share = :share, shareVersion = :next", ConditionExpression: "shareVersion = :current",
        ExpressionAttributeNames: { "#share": "share" },
        ExpressionAttributeValues: { ":share": { ...task.share, postFailedAt: new Date(deps.now()).toISOString() }, ":next": version + 1, ":current": version },
      } }] }));
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
}

async function replyText(deps: NotifierDependencies, task: DeveloperTaskRecord & { share: NonNullable<DeveloperTaskRecord["share"]> }, notice: Notice): Promise<string | undefined> {
  const operation = async () => (notice.workspaceId === undefined || notice.operationId === undefined
    ? undefined
    : getItem<{ id: string; kind: string; status: string; error?: string; result?: unknown }>(deps, { pk: `WORKSPACE#${notice.workspaceId}`, sk: `OPERATION#${notice.operationId}` }));
  switch (notice.kind) {
    case "ready": return READY_REPLY;
    case "cancelled": return CANCELLED_REPLY;
    case "closed": return CLOSED_REPLY;
    // A change a later one replaced is not said: the later notice says the current mode.
    case "mode": return notice.mode === task.share.mode ? modeReply(task.share.mode) : undefined;
    case "setup_failed": return setupFailedReply((await operation())?.error);
    case "pull_request": {
      const published = PullRequestResultSchema.safeParse((await operation())?.result);
      return published.success ? pullRequestReply(published.data.url) : undefined;
    }
    case "ended": {
      const ended = await operation();
      if (ended === undefined) return undefined;
      const failed = ended.status === "FAILED" || ended.status === "INTERRUPTED";
      let summary: string | undefined;
      if (ended.kind === "task") {
        const events = await deps.documentClient.send(new QueryCommand({
          TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `OPERATION#${ended.id}`, ":prefix": "EVENT#" }, ScanIndexForward: false, Limit: 500, ConsistentRead: true,
        })) as { Items?: Array<{ entityType?: string; payload?: unknown }> };
        summary = lastAssistantResponse((events.Items ?? []).filter((item) => item.entityType === "EVENT").reverse());
      }
      return endedReply({
        status: ended.status,
        ...(failed ? { failure: { category: failureCategory(ended.kind, ended.status, ended.error), message: ended.error ?? `the ${ended.kind} operation ended ${ended.status}` } } : {}),
        ...(summary === undefined ? {} : { summary }),
      });
    }
    default: return undefined;
  }
}

type Outcome = "posted" | "not_shared" | "before_share" | "delivered" | "no_thread" | "stale";

async function deliver(deps: NotifierDependencies, notice: Notice): Promise<Outcome> {
  const task = await noticeTask(deps, notice);
  if (task?.share === undefined) return "not_shared";
  const share = task.share;
  // The stream's time has whole seconds, so the share's time is compared at that grain.
  if (notice.kind !== "start" && Date.parse(notice.at) < Math.floor(Date.parse(share.sharedAt) / 1000) * 1000) return "before_share";
  const marker = { pk: `DEVTASK#${task.taskId}`, sk: `NOTICE#${notice.id}` };
  if (await getItem(deps, marker) !== undefined) return "delivered";
  if (notice.kind === "start") {
    if (share.threadTs !== undefined) {
      await putMarker(deps, marker);
      return "delivered";
    }
    const status = await currentStatus(deps, task);
    const { ts } = await deps.post({
      channel: share.channelId,
      text: startMessage({ developerName: task.developerName, slackUserId: task.slackUserId, client: task.client, title: task.title, project: task.project, mode: share.mode, status, sharedReason: share.sharedReason }),
    });
    await recordThread(deps, task.taskId, ts, marker);
    return "posted";
  }
  if (share.threadTs === undefined) {
    // C9: the start message gave up; nothing is posted outside a thread.
    if (share.postFailedAt !== undefined) return "no_thread";
    throw new StartPending();
  }
  const text = await replyText(deps, { ...task, share }, notice);
  if (text === undefined) return "stale";
  await deps.post({ channel: share.channelId, threadTs: share.threadTs, text });
  await putMarker(deps, marker);
  return "posted";
}

export function createNotifierHandler(deps: NotifierDependencies) {
  return async (event: { Records?: unknown[] }): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    const records = event.Records ?? [];
    const queued = records.filter((record): record is QueueRecord => (record as { eventSource?: unknown }).eventSource === "aws:sqs");
    if (queued.length === 0) {
      const notices = noticesFromStream(records as StreamRecord[]);
      if (notices.length > 0) await deps.enqueue(notices);
      return { batchItemFailures: [] };
    }
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const record of queued) {
      const notice = parseNotice(record.body);
      if (notice === undefined) {
        deps.log({ event: "developer_notifier.notice_unreadable", messageId: record.messageId });
        continue;
      }
      try {
        deps.log({ event: "developer_notifier.notice", kind: notice.kind, noticeId: notice.id, outcome: await deliver(deps, notice) });
      } catch (error) {
        const reason = error instanceof SlackPostError ? error.slackError : error instanceof Error ? error.name : "unknown";
        if (deps.now() - Date.parse(notice.at) < SHARE_DELIVERY_WINDOW_MS) {
          const attempt = Number(record.attributes?.ApproximateReceiveCount ?? "1");
          try {
            await deps.retryLater(record.receiptHandle, retryDelaySeconds(attempt));
          } catch (delayError) {
            deps.log({ event: "developer_notifier.delay_failed", error: delayError instanceof Error ? delayError.name : "unknown" });
          }
          deps.log({ event: "developer_notifier.retry", kind: notice.kind, noticeId: notice.id, attempt, reason });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        } else {
          deps.log({ event: "developer_notifier.delivery_failed", kind: notice.kind, noticeId: notice.id, reason });
          deps.deliveryFailed();
          if (notice.kind === "start" && notice.taskId !== undefined) {
            try {
              await markPostFailed(deps, notice.taskId);
            } catch (markError) {
              deps.log({ event: "developer_notifier.mark_failed", taskId: notice.taskId, error: markError instanceof Error ? markError.name : "unknown" });
            }
          }
        }
      }
    }
    return { batchItemFailures };
  };
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
const sqs = new SQSClient(awsClientConfiguration);
const secretsManager = new SecretsManagerClient(awsClientConfiguration);
const SECRET_CACHE_MS = 5 * 60_000;
let cachedToken: { value: Promise<string>; loadedAt: number } | undefined;
function botToken(): Promise<string> {
  if (cachedToken === undefined || Date.now() - cachedToken.loadedAt > SECRET_CACHE_MS) {
    const value = secretsManager.send(new GetSecretValueCommand({ SecretId: requiredEnvironment("SLACK_SECRET_ARN") }))
      .then((response) => parseSlackSecrets(response.SecretString ?? "").botToken);
    cachedToken = { value, loadedAt: Date.now() };
    value.catch(() => { cachedToken = undefined; });
  }
  return cachedToken.value;
}

export const handler = createNotifierHandler({
  documentClient,
  tableName: process.env.STATE_TABLE_NAME ?? "",
  async enqueue(notices) {
    for (let start = 0; start < notices.length; start += 10) {
      const batch = notices.slice(start, start + 10);
      const result = await sqs.send(new SendMessageBatchCommand({
        QueueUrl: requiredEnvironment("NOTICE_QUEUE_URL"),
        Entries: batch.map((notice, index) => ({ Id: String(index), MessageBody: JSON.stringify(notice) })),
      }));
      // The stream mapping retries the whole batch; a notice queued twice still posts once (C9).
      if ((result.Failed ?? []).length > 0) throw new Error("some notices could not be queued");
    }
  },
  async retryLater(receiptHandle, seconds) {
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: requiredEnvironment("NOTICE_QUEUE_URL"), ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  },
  async post(input) {
    return chatPostMessage(await botToken(), input);
  },
  now: Date.now,
  log: (entry) => console.log(JSON.stringify({ component: "developer-task-notifier", ...entry })),
  deliveryFailed: () => console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), Dimensions: [[]], Metrics: [{ Name: "SlackDeliveryFailed", Unit: "Count" }] }] },
    component: "developer-task-notifier", event: "metric", SlackDeliveryFailed: 1,
  })),
});
```

Check that `slack-ingress.ts` has no work at import time besides declarations (its AWS handler is
built lazily in `handler`); if it does, move `parseSlackSecrets` to `slack-web.ts` and re-export it
from `slack-ingress.ts`, so both keep one copy.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-task-notifier.test.ts tests/contract/developer-task-notices.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/slack-web.ts packages/broker/src/aws/developer-task-notifier.ts tests/contract/developer-task-notifier.test.ts
git commit -m "feat(broker): the DeveloperTaskNotifier posts a shared task's thread (spec 025 FR-032, FR-034)"
```

---

### Task 8: Infrastructure: the notifier, its queue and stream mapping, and two grants

C7, C10, C14: the resources of FR-034, in named environments only (D14).

**Files:**
- Create: `infra/lib/developer-task-notifier.ts`
- Modify: `infra/lib/control-plane.ts` (inside the existing `if (naming.env !== undefined && signInParameters !== undefined)` block, line 617)
- Modify: `tests/contract/developer-signin-infrastructure.test.ts` (one reader appended; a new `describe`)

**Interfaces:**
- Consumes: `packagedFunction` (`infra/lib/control-plane.ts:648`), the state table, the Slack secret,
  the Slack threads table, the ingress and broker functions.
- Produces:
  - `class DeveloperTaskNotifier extends Construct` with `readonly function: lambdaNodejs.NodejsFunction`
    and `readonly queue: sqs.Queue`, props `{ naming: AgentXNaming; state: dynamodb.Table; slackSecret: secretsmanager.Secret }`;
  - the notifier's environment: `STATE_TABLE_NAME`, `NOTICE_QUEUE_URL`, `SLACK_SECRET_ARN`, `AGENTX_METRICS_NAMESPACE`;
  - the ingress's `SHARED_TASKS=enabled` and `GetItem` on `SHARED_TASK#*`;
  - the broker's `SLACK_THREADS_TABLE_NAME` and `GetItem` on the Slack threads table's `THREAD#*`.

- [ ] **Step 1: Write the failing test**

In `tests/contract/developer-signin-infrastructure.test.ts`:
- in "lets only the ingress, the orchestrator task role and DeveloperIdentity read the Slack secret
  (R2)", rename it to "... DeveloperIdentity and the task notifier read the Slack secret (R2,
  FR-034)" and append the notifier to the expected list (sorted), which becomes
  `["DeveloperSignInFunctionServiceRole", "DeveloperTaskNotifierFunctionServiceRole", "SlackIngressServiceRole", "SlackOrchestratorTaskRole"]`.
  This is FR-034's one new reader; the list gains an entry and nothing else changes.
- append:

```ts
describe("the developer task notifier (spec 025 phase 25c, named environments)", () => {
  const stateId = () => ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")![0];
  const streamMappings = (template: TemplateJson) => ofType(template, "AWS::Lambda::EventSourceMapping")
    .filter(([, mapping]) => JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));

  it("runs the notifier with its table, queue, Slack secret and metrics namespace", () => {
    const [, notifier] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierFunction")!;
    const variables = (notifier.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(variables).sort()).toEqual(expect.arrayContaining(["AGENTX_METRICS_NAMESPACE", "NOTICE_QUEUE_URL", "SLACK_SECRET_ARN", "STATE_TABLE_NAME"]));
  });

  it("reads the state table's stream as its second and last reader, filtered to task, pointer and developer-operation changes (C7)", () => {
    const mappings = streamMappings(named);
    expect(mappings).toHaveLength(2);
    const notifierMapping = mappings.find(([, mapping]) => JSON.stringify(mapping.Properties.FunctionName).includes("DeveloperTaskNotifierFunction"))![1];
    const patterns = (notifierMapping.Properties.FilterCriteria as { Filters: Array<{ Pattern: string }> }).Filters.map((filter) => JSON.parse(filter.Pattern) as unknown);
    expect(patterns).toEqual([
      { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK"] } } } },
      { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK_POINTER"] } } } },
      { dynamodb: { NewImage: { entityType: { S: ["OPERATION"] }, requestedBy: { M: { kind: { S: ["developer"] } } }, status: { S: ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] } } } },
    ]);
    expect(notifierMapping.Properties).toMatchObject({ StartingPosition: "LATEST", MaximumRecordAgeInSeconds: 3600, BisectBatchOnFunctionError: true });
  });

  it("consumes its own queue with per-message failures and a dead-letter queue", () => {
    const queueMappings = ofType(named, "AWS::Lambda::EventSourceMapping").filter(([, mapping]) => JSON.stringify(mapping.Properties.FunctionName).includes("DeveloperTaskNotifierFunction") && !JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));
    expect(queueMappings).toHaveLength(1);
    expect(queueMappings[0]![1].Properties).toMatchObject({ FunctionResponseTypes: ["ReportBatchItemFailures"] });
    const [, queue] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierNoticeQueue")!;
    expect(queue.Properties).toMatchObject({ MessageRetentionPeriod: 86_400, VisibilityTimeout: 180, SqsManagedSseEnabled: true });
    expect(queue.Properties.RedrivePolicy).toMatchObject({ maxReceiveCount: 100 });
  });

  it("gives the notifier only key-limited item access on the state table: no scan, no delete", () => {
    const statements = statementsOfRole(named, "DeveloperTaskNotifierFunctionServiceRole").filter((statement) => reaches(named, statement, stateId(), "arn:aws:dynamodb:us-east-1:111122223333:table/state"));
    const dynamo = statements.filter((statement) => touches(statement, "dynamodb") && !actionsOf(statement).some((action) => action.startsWith("dynamodb:DescribeStream") || action.startsWith("dynamodb:GetRecords") || action.startsWith("dynamodb:GetShardIterator") || action.startsWith("dynamodb:ListStreams")));
    for (const statement of dynamo) {
      expect(statement.Condition).toMatchObject({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": expect.any(Array) } });
      for (const forbidden of ["dynamodb:Scan", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) expect(allows(statement, forbidden)).toBe(false);
    }
    const reads = dynamo.find((statement) => allows(statement, "dynamodb:GetItem"))!;
    expect((reads.Condition!["ForAllValues:StringLike"] as Record<string, string[]>)["dynamodb:LeadingKeys"].sort()).toEqual(["DEVTASK#*", "OPERATION#*", "WORKSPACE#*"]);
    const writes = dynamo.find((statement) => allows(statement, "dynamodb:PutItem"))!;
    expect((writes.Condition!["ForAllValues:StringLike"] as Record<string, string[]>)["dynamodb:LeadingKeys"].sort()).toEqual(["DEVTASK#*", "SHARED_TASK#*"]);
  });

  it("lets the ingress read shared thread records, and the broker read Slack thread counters, by key", () => {
    const [, ingress] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "SlackIngress")!;
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ SHARED_TASKS: "enabled" });
    expect(statementsOfRole(named, "SlackIngressServiceRole")).toContainEqual(expect.objectContaining({
      Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
    }));
    expect(statementsOfRole(named, "BrokerServiceRole")).toContainEqual(expect.objectContaining({
      Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
    }));
  });

  it("adds none of it to the legacy template", () => {
    expect(ofType(legacy, "AWS::Lambda::Function").map(([id]) => withoutHash(id))).not.toContain("DeveloperTaskNotifierFunction");
    expect(streamMappings(legacy)).toHaveLength(1);
    const [, ingress] = ofType(legacy, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "SlackIngress")!;
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables).not.toHaveProperty("SHARED_TASKS");
  });
});
```

(`State`, `SlackIngress`, `BrokerServiceRole`: check the logical ID prefixes in the synthesized
template first, `npx vitest run tests/contract/developer-signin-infrastructure.test.ts` prints them
on failure, and use the real ones; the test helpers already drop the eight-character hash.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-signin-infrastructure.test.ts`
Expected: FAIL, no `DeveloperTaskNotifierFunction`.

- [ ] **Step 3: Write the construct**

```ts
// infra/lib/developer-task-notifier.ts
// Spec 025 FR-034, C7: the DeveloperTaskNotifier. Named environments only (D14). It is the only new
// reader of the Slack secret; the broker still cannot read it (D11).
import { Duration, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager, aws_sqs as sqs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";

export interface DeveloperTaskNotifierProps {
  naming: AgentXNaming;
  /** The concrete Table: its stream ARN is read here. */
  state: dynamodb.Table;
  slackSecret: secretsmanager.Secret;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"];

export class DeveloperTaskNotifier extends Construct {
  readonly function: lambdaNodejs.NodejsFunction;
  readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: DeveloperTaskNotifierProps) {
    super(scope, id);
    const deadLetters = new sqs.Queue(this, "NoticeDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(14),
    });
    // C9: a notice is retried for one hour, then counted and dropped; one day of retention is ample,
    // and the dead-letter queue only catches a notice the function itself cannot handle.
    this.queue = new sqs.Queue(this, "NoticeQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      retentionPeriod: Duration.days(1),
      // Six times the function's timeout, as AWS advises for an SQS event source.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 100 },
    });
    this.function = packagedFunction(this, "Function", "packages/broker/src/aws/developer-task-notifier.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      NOTICE_QUEUE_URL: this.queue.queueUrl,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      AGENTX_METRICS_NAMESPACE: props.naming.metricsNamespace,
    }, Duration.seconds(30));
    props.slackSecret.grantRead(this.function);
    props.state.grantStreamRead(this.function);
    this.queue.grantSendMessages(this.function);
    this.queue.grantConsumeMessages(this.function);
    // Exactly the items the notifier reads and writes (Task 7), by key: no scan, no delete.
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:Query"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*", "WORKSPACE#*", "OPERATION#*"] } },
    }));
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*", "SHARED_TASK#*"] } },
    }));
    // C7: the stream's second and last reader (the outbox publisher is the first). Phase 25e adds
    // its pending-change filter here rather than a third reader.
    new lambda.EventSourceMapping(this, "StateStreamMapping", {
      target: this.function,
      eventSourceArn: props.state.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      retryAttempts: 10,
      bisectBatchOnError: true,
      maxRecordAge: Duration.hours(1),
      filters: [
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: lambda.FilterRule.isEqual("DEVELOPER_TASK") } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: lambda.FilterRule.isEqual("DEVELOPER_TASK_POINTER") } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: {
          entityType: { S: lambda.FilterRule.isEqual("OPERATION") },
          requestedBy: { M: { kind: { S: lambda.FilterRule.isEqual("developer") } } },
          status: { S: lambda.FilterRule.or(...TERMINAL) },
        } } }),
      ],
    });
    new lambda.EventSourceMapping(this, "NoticeQueueMapping", {
      target: this.function,
      eventSourceArn: this.queue.queueArn,
      batchSize: 10,
      reportBatchItemFailures: true,
    });
  }
}
```

If `packagedFunction` importing from `./control-plane.js` makes a cycle that CDK or TypeScript
refuses (control-plane imports this file too), follow `developer-signin.ts`, which already imports
`packagedFunction` from `./control-plane.js` the same way.

- [ ] **Step 4: Wire it in the named-environment block**

In `infra/lib/control-plane.ts`, import `DeveloperTaskNotifier` from `./developer-task-notifier.js`,
and inside `if (naming.env !== undefined && signInParameters !== undefined) {`, after
`new DeveloperSignIn(...)`, add:

```ts
      // Spec 025 phase 25c: sharing, named environments only (D14).
      new DeveloperTaskNotifier(this, "DeveloperTaskNotifier", { naming, state, slackSecret });
      // C10: the ingress reads shared thread records by key; its SLACK_BINDING# statement is unchanged.
      slackIngress.addEnvironment("SHARED_TASKS", "enabled");
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
      }));
      // C14: TASK_BUSY counts the shared thread's waiting messages.
      broker.addEnvironment("SLACK_THREADS_TABLE_NAME", slackThreads.tableName);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [slackThreads.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
      }));
```

`slackIngress` and `slackThreads` are declared above line 617, so they are in scope.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-signin-infrastructure.test.ts tests/contract/legacy-templates.test.ts tests/contract/infrastructure.test.ts && npm run infra:synth`
Expected: PASS; the legacy templates are unchanged.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/developer-task-notifier.ts infra/lib/control-plane.ts tests/contract/developer-signin-infrastructure.test.ts
git commit -m "feat(infra): the DeveloperTaskNotifier, its queue and stream mapping (spec 025 FR-034)"
```

---

### Task 9: The ingress answers a view-only thread with one notice an hour

C10, C24: FR-035's ingress side, US3 scenario 4. **Depends on Q1** (the notice's words) and **Q3**
(the closed thread).

**Files:**
- Modify: `packages/broker/src/aws/slack-ingress.ts` (`SlackIngressDependencies.sharedTask`, the handler, `createAwsSlackIngressHandler`)
- Test: `tests/contract/slack-ingress.test.ts` (the harness gains `shared`; a new `describe`)

**Interfaces:**
- Consumes: `VIEW_ONLY_NOTICE`, `CLOSED_SHARED_NOTICE`, `sharedTaskKey`, `SharedTaskRecordSchema`,
  `sharedNoticeKey`, `SHARED_THREAD_NOTICE_INTERVAL_SECONDS` (Task 1); `SHARED_TASKS` (Task 8).
- Produces: `SlackIngressDependencies.sharedTask?: { lookup(thread: SlackThread): Promise<{ mode: "view" | "continue"; closed: boolean } | undefined>; claimNotice(threadSubject: string, nowSeconds: number): Promise<boolean> }`.

- [ ] **Step 1: Write the failing test**

In `tests/contract/slack-ingress.test.ts`, add to `harness`'s options
`shared?: { threads: Record<string, { mode: "view" | "continue"; closed?: boolean }>; lookupThrows?: boolean };`,
and to the dependencies, before `now`:

```ts
    ...(options.shared === undefined ? {} : {
      sharedTask: {
        lookup: async (thread: { threadTs: string }) => {
          if (options.shared?.lookupThrows) throw Object.assign(new Error("DynamoDB unavailable"), { name: "InternalServerError" });
          const found = options.shared?.threads[thread.threadTs];
          return found === undefined ? undefined : { mode: found.mode, closed: found.closed ?? false };
        },
        claimNotice: async (subject: string, now: number) => {
          const last = noticeClaims.get(subject);
          if (last !== undefined && now - last < 3_600) return false;
          noticeClaims.set(subject, now);
          return true;
        },
      },
    }),
```

with `const noticeClaims = new Map<string, number>();` beside the other state, and `noticeClaims`
added to the returned object. Then append:

```ts
describe("shared task threads (spec 025 FR-035, C10)", () => {
  const reply = (eventId: string, text = `<@${bot}> also bump the version`) => signedEvent(mention({ eventId, event: { ts: "1695500000.000200", thread_ts: "1695500000.000100", text } }));

  it("answers a mention in a view-only thread with the fixed notice, and queues nothing (US3 scenario 4)", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } }, turnsPerMinute: 6 });
    const response = await send(h.handler, reply("Ev0000000101"));
    expect(response.status).toBe(200);
    expect(h.queue).toEqual([]);
    expect(h.pending.size).toBe(0);
    expect(h.turnWindows).toEqual([]);
    expect(h.posts).toEqual([{ channel, threadTs: "1695500000.000100", text: VIEW_ONLY_NOTICE }]);
  });

  it("says it at most once an hour per thread", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } } });
    await send(h.handler, reply("Ev0000000102"));
    h.clock.seconds += 1_800;
    await send(h.handler, reply("Ev0000000103"));
    expect(h.posts).toHaveLength(1);
    h.clock.seconds += 1_801;
    await send(h.handler, reply("Ev0000000104"));
    expect(h.posts).toHaveLength(2);
    expect(h.queue).toEqual([]);
  });

  it("gives a closed task's thread the closed notice, whatever its mode (C24)", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "continue", closed: true } } } });
    await send(h.handler, reply("Ev0000000105"));
    expect(h.posts).toEqual([{ channel, threadTs: "1695500000.000100", text: CLOSED_SHARED_NOTICE }]);
    expect(h.queue).toEqual([]);
  });

  it("does not stop anything from a view-only thread", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } }, stop: {} });
    await send(h.handler, reply("Ev0000000106", `<@${bot}> stop`));
    expect(h.stopCalls).toEqual([]);
  });

  it("queues a continue thread's mention exactly as any thread message, in the thread's group (FR-035)", async () => {
    const shared = harness({ shared: { threads: { "1695500000.000100": { mode: "continue" } } }, turnsPerMinute: 6 });
    const plain = harness({ turnsPerMinute: 6 });
    await send(shared.handler, reply("Ev0000000107"));
    await send(plain.handler, reply("Ev0000000107"));
    expect(shared.queue).toEqual(plain.queue);
    expect(shared.posts).toEqual(plain.posts);
    expect(shared.turnWindows).toEqual(plain.turnWindows);
  });

  it("answers 500 and releases the event when the shared record cannot be read, so Slack retries", async () => {
    const shared = { threads: {}, lookupThrows: true };
    const h = harness({ shared });
    const response = await send(h.handler, reply("Ev0000000108"));
    expect(response.status).toBe(500);
    expect(h.queue).toEqual([]);
    expect(h.logs).toContainEqual({ event: "shared_task.lookup_failed", fields: { eventId: "Ev0000000108", errorName: "InternalServerError" } });
    // The claim was released, so Slack's retry of the same event is handled as new.
    shared.lookupThrows = false;
    expect((await send(h.handler, reply("Ev0000000108"))).status).toBe(200);
    expect(h.queue).toHaveLength(1);
  });

  it("treats every thread as ordinary without the shared-task switch (the legacy deployment)", async () => {
    const h = harness();
    await send(h.handler, reply("Ev0000000109"));
    expect(h.queue).toHaveLength(1);
  });
});
```

Import `VIEW_ONLY_NOTICE` and `CLOSED_SHARED_NOTICE` from the contracts index. In the "does not
stop anything" test the harness's `stop` option needs an object (`{}` gives the default outcome).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/slack-ingress.test.ts`
Expected: FAIL, the view-only mention is queued.

- [ ] **Step 3: Implement**

In `packages/broker/src/aws/slack-ingress.ts`, import `CLOSED_SHARED_NOTICE`, `SHARED_THREAD_NOTICE_INTERVAL_SECONDS`,
`SharedTaskRecordSchema`, `VIEW_ONLY_NOTICE`, `sharedNoticeKey`, `sharedTaskKey` from
`@agentx/contracts`, and add to `SlackIngressDependencies`:

```ts
  /**
   * Spec 025 FR-035: shared task threads. Absent (the legacy deployment): every thread is ordinary.
   * `lookup` gives the thread's mode, or undefined for an ordinary thread, and throws when it cannot
   * tell. `claimNotice` answers true for at most one caller per thread per hour.
   */
  sharedTask?: {
    lookup: (thread: SlackThread) => Promise<{ mode: "view" | "continue"; closed: boolean } | undefined>;
    claimNotice: (threadSubject: string, nowSeconds: number) => Promise<boolean>;
  };
```

In the handler, right after `const subject = slackThreadSubject(thread);`:

```ts
    // FR-035, C10: a view-only or closed shared thread gets one fixed notice an hour. Nothing is
    // queued or counted, so no thread workspace is ever made for it. A continue thread goes on as
    // any thread does. A record that cannot be read fails closed: Slack retries the event.
    if (dependencies.sharedTask) {
      let shared: { mode: "view" | "continue"; closed: boolean } | undefined;
      try {
        shared = await dependencies.sharedTask.lookup(thread);
      } catch (error) {
        await releaseQuietly(dependencies, log, mention.eventId, "shared_task.release_failed");
        log("shared_task.lookup_failed", { eventId: mention.eventId, errorName: errorName(error) });
        return respond(500, { error: "shared thread could not be checked" });
      }
      if (shared !== undefined && (shared.mode === "view" || shared.closed)) {
        let notify = false;
        try {
          notify = await dependencies.sharedTask.claimNotice(subject, nowSeconds);
        } catch (error) {
          log("shared_task.notice_claim_failed", { eventId: mention.eventId, errorName: errorName(error) });
        }
        log("shared_task.not_run", { eventId: mention.eventId, closed: shared.closed, notified: notify });
        if (notify) await post(dependencies, log, thread, shared.closed ? CLOSED_SHARED_NOTICE : VIEW_ONLY_NOTICE, "shared_task.notice_failed");
        return respond(200, { ok: true });
      }
    }
```

In `createAwsSlackIngressHandler`'s `createSlackIngressHandler({...})`, add:

```ts
    ...(process.env.SHARED_TASKS === "enabled" ? {
      sharedTask: {
        async lookup(thread: SlackThread) {
          const response = await documentClient.send(new GetCommand({ TableName: stateTableName, Key: sharedTaskKey(thread), ConsistentRead: true }));
          if (response.Item === undefined) return undefined;
          // An unreadable record throws, and the handler fails closed.
          const record = SharedTaskRecordSchema.parse(response.Item);
          return { mode: record.mode, closed: record.closedAt !== undefined };
        },
        async claimNotice(threadSubject: string, nowSeconds: number) {
          try {
            await documentClient.send(new UpdateCommand({
              TableName: threadsTableName,
              Key: sharedNoticeKey(threadSubject),
              UpdateExpression: "SET noticedAt = :now, expiresAt = :expires",
              ConditionExpression: "attribute_not_exists(noticedAt) OR noticedAt <= :cutoff",
              ExpressionAttributeValues: {
                ":now": nowSeconds,
                ":expires": nowSeconds + 2 * SHARED_THREAD_NOTICE_INTERVAL_SECONDS,
                ":cutoff": nowSeconds - SHARED_THREAD_NOTICE_INTERVAL_SECONDS,
              },
            }));
            return true;
          } catch (error) {
            if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
            throw error;
          }
        },
      },
    } : {}),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/slack-ingress.test.ts tests/contract/stop-command.test.ts`
Expected: PASS; every existing ingress test is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/slack-ingress.ts tests/contract/slack-ingress.test.ts
git commit -m "feat(slack-ingress): a view-only shared thread gets one notice an hour (spec 025 FR-035)"
```

---

### Task 10: Continue-mode turns act on the task's workspace

C11, C13, C14: FR-054's broker side, D4's `TASK_BUSY`, US3 scenarios 5 and 7, and the edge cases
"the developer continues a task while a channel turn is running" and "the developer switches a
continue thread to view only". **Depends on Q3** (closed threads) and **Q8** (stop).

**Files:**
- Modify: `packages/broker/src/auth.ts` (`AuthenticatedIdentity.sharedTask`)
- Modify: `packages/broker/src/aws/broker.ts` (`sharedThread`, `slackServiceIdentity`, `ensureThreadWorkspace`, `sharedThreadWorkspace`, `prepareThreadWorkspace`, `startThreadWorkspaceClose`, `completeThreadWorkspaceClose`, `channelOperation`, `routeWorkspaceRequest`, `stopSlackThreadTask`, `developerTaskActions.channelActivity`, `AwsBrokerDependencies.slackThreadsTableName`, the `handler`'s input)
- Modify: `packages/broker/src/aws/developer-task-actions.ts` (`channelActivity`)
- Modify: `packages/broker/src/aws/developer-tasks.ts` (`busyOrClosing`, `channelDriver`)
- Modify: `tests/support/slack-broker.ts` (`createBroker`'s `slackThreadsTableName`)
- Modify: `tests/support/developer-task-broker.ts` (passes `slackThreadsTableName: "threads"`; `teammate`)
- Test: `tests/contract/shared-task-identity.test.ts`

**Interfaces:**
- Consumes: `SharedTaskRecordSchema`, `sharedTaskKey`, `DEVELOPER_TASK_OWNER_ISSUER` (contracts),
  `taskOwnerKey`, `taskOwnerSubject`, `sharedSubject` (task-records), `markThreadPosted` (Task 4).
- Produces:
  - `AuthenticatedIdentity.sharedTask?: { taskId: string; workspaceId: string; developerName: string; state: "continue" | "view" | "closed" }`
  - `POST /v1/service/threads/workspace` with `includeSharedTask: true` answers `VIEW_ONLY` for a
    view or closed thread, and WORKSPACE with `sharedTask` for a continue thread;
  - `POST /v1/service/threads/workspace/close` with `includeSharedTask: true` answers `REFUSED`;
  - items `DEVTASK#<taskId>` / `CHANNEL_OPERATION#<operationId>` `{ slackUserId, name?, createdAt }`;
  - `DeveloperTaskActions.channelActivity(input: { taskId: string; operationId: string; threadSubject: string }): Promise<{ driver?: { slackUserId: string; name?: string }; waiting: number }>`
  - test helper `teammate(handler, subject, userId, method, path, body?, name?)`.

- [ ] **Step 1: Add the test support**

In `tests/support/slack-broker.ts`'s `createBroker` options add `slackThreadsTableName?: string;`
and in `brokerInput` add
`...(options.slackThreadsTableName ? { slackThreadsTableName: options.slackThreadsTableName } : {}),`.
In `tests/support/developer-task-broker.ts`, pass `slackThreadsTableName: "threads"` to
`createBroker`, and add:

```ts
/** A teammate's request through the Slack orchestrator's service route, in a shared thread (FR-054). */
export function teammate(handler: Handler, subject: string, slackUserId: string, method: string, path: string, body?: unknown, name?: string) {
  return call(handler, {
    method, path,
    service: { principal: orchestratorPrincipal, thread: subject, slackUser: slackUserId },
    ...(name === undefined ? {} : { headers: { "x-agentx-slack-user-name": encodeURIComponent(name) } }),
    ...(body === undefined ? {} : { body }),
  });
}
```

(import `orchestratorPrincipal` from `./slack-broker.js`).

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/shared-task-identity.test.ts
// Spec 025 FR-054, C11, C13, C14: a shared thread's service calls, resolved by the broker.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker, markThreadPosted, teammate } from "../support/developer-task-broker.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

const PRIYA = "U0PRIYA001";
/** What a Slack service from before 25c sends, and what this release's service sends. */
const OLDER_REQUEST = { includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true, includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true };
const WORKSPACE_REQUEST = { ...OLDER_REQUEST, includeSharedTask: true };

async function continueThread(mode: "view" | "continue" = "continue") {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true, shareMode: mode });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => (harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string | null }).activeOperationId;
  await harness.finish(workspaceId, String(active()), "SUCCEEDED");
  await harness.finish(workspaceId, String(active()), "SUCCEEDED");
  const subject = markThreadPosted(harness.db, taskId);
  const ensure = (body: Record<string, unknown> = WORKSPACE_REQUEST) => teammate(harness.handler, subject, PRIYA, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), ...body });
  const workspaces = () => harness.db.find((item) => item.entityType === "WORKSPACE").length;
  return { ...harness, taskId, workspaceId, subject, active, ensure, workspaces };
}

async function channelTask(h: Awaited<ReturnType<typeof continueThread>>, name?: string) {
  const conversation = await teammate(h.handler, h.subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {}, name);
  const conversationId = String((conversation.body.conversation as { id: string }).id);
  return teammate(h.handler, h.subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "run the linter" }, name);
}

describe("a continue thread acts on the task's workspace (FR-054)", () => {
  it("answers the task's workspace: never created, never charged, nothing to recover", async () => {
    const h = await continueThread();
    const before = h.workspaces();
    const answer = await h.ensure();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "WORKSPACE", workspaceId: h.workspaceId, status: "READY", created: false, recoverableOperations: [], sharedTask: { taskId: h.taskId, developerName: "Maya Chen" } });
    expect(h.workspaces()).toBe(before);
    expect(h.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${PRIYA}`)).toBeUndefined();
  });

  it("runs the teammate's request as the teammate, and records who started it (C13)", async () => {
    const h = await continueThread();
    const accepted = await channelTask(h, "Priya");
    expect(accepted.status).toBe(202);
    const operationId = String((accepted.body.operation as { id: string }).id);
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ kind: "task", requestedBy: { teamId: SLACK_TEAM, userId: PRIYA } });
    expect(h.db.get(`DEVTASK#${h.taskId}`, `CHANNEL_OPERATION#${operationId}`)).toMatchObject({ slackUserId: PRIYA, name: "Priya" });
  });

  it("keeps a WORKSPACE answer strict for a Slack service that does not ask for sharedTask", async () => {
    const h = await continueThread();
    expect((await h.ensure(OLDER_REQUEST)).body).not.toHaveProperty("sharedTask");
  });
});

describe("a thread that is not open to the channel (C11, Review Focus 2)", () => {
  it("answers VIEW_ONLY and creates nothing once the thread is view only", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID(), shareMode: "view" });
    const before = h.workspaces();
    expect((await h.ensure()).body).toEqual({ outcome: "VIEW_ONLY", taskId: h.taskId, closed: false });
    expect((await h.ensure(OLDER_REQUEST)).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(h.workspaces()).toBe(before);
    // The thread's own key owns no workspace, so the task's is out of reach.
    expect((await teammate(h.handler, h.subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {})).status).toBe(404);
  });

  it("says closed once the task is closed", async () => {
    const h = await continueThread();
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, closedAt: new Date().toISOString() });
    expect((await h.ensure()).body).toEqual({ outcome: "VIEW_ONLY", taskId: h.taskId, closed: true });
  });

  it("treats a thread whose channel now serves another project as view only", async () => {
    const h = await continueThread();
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, project: "ledger" });
    expect((await h.ensure()).body).toMatchObject({ outcome: "VIEW_ONLY" });
  });

  it("refuses to close the task from the thread: only the developer closes it", async () => {
    const h = await continueThread();
    expect((await teammate(h.handler, h.subject, PRIYA, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID(), includeSharedTask: true })).body).toEqual({ outcome: "REFUSED", reason: "shared_task" });
    expect((await teammate(h.handler, h.subject, PRIYA, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });
});

describe("stop in a shared thread (Q8)", () => {
  it("cancels the running task operation from a continue thread, and nothing from a view-only one", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "keep going" });
    const thread = Object.fromEntries(["teamId", "channelId", "threadTs"].map((key, index) => [key, h.subject.split("/")[index]]));
    const stop = async () => JSON.parse((await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: PRIYA })).body) as { outcome: string };
    expect(await stop()).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(h.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toEqual([expect.objectContaining({ requestedBy: { teamId: SLACK_TEAM, userId: PRIYA } })]);
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, mode: "view" });
    expect(await stop()).toMatchObject({ outcome: "NOTHING_RUNNING" });
  });
});

describe("the developer meets a channel turn (C14, D4)", () => {
  it("answers TASK_BUSY naming the teammate and the waiting messages, for continue and for a pull request", async () => {
    const h = await continueThread();
    await channelTask(h, "Priya");
    h.db.set({ pk: `THREAD#${h.subject}`, sk: "META", pendingRequests: 3 });
    const continued = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "also this" });
    expect(continued.body.error).toMatchObject({ code: "TASK_BUSY" });
    const message = String((continued.body.error as { message: string }).message);
    expect(message).toContain("a request from Priya in its shared Slack thread");
    expect(message).toContain("2 more channel messages wait behind it");
    expect(message).toContain("agentx_share_task");
    const pr = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/pull-requests`, { requestId: randomUUID(), title: "t" });
    expect(String((pr.body.error as { message: string }).message)).toContain("Priya");
  });

  it("keeps 25b's TASK_BUSY words when the running operation is the developer's own", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "first" });
    const again = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "second" });
    expect((again.body.error as { message: string }).message).toBe(`task ${h.taskId} is still working; wait for it with agentx_wait_for_task, or stop it with agentx_cancel_task`);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/shared-task-identity.test.ts`
Expected: FAIL, the continue thread gets a thread workspace of its own.

- [ ] **Step 4: Resolve the identity**

In `packages/broker/src/auth.ts`, add to `AuthenticatedIdentity`:

```ts
  /**
   * Spec 025 C11: the call comes from a shared task's Slack thread. In `continue` the identity is the
   * task's owner key with the teammate's Slack context; otherwise the thread's own key, which answers
   * VIEW_ONLY and never creates a workspace.
   */
  sharedTask?: { taskId: string; workspaceId: string; developerName: string; state: "continue" | "view" | "closed" };
```

In `packages/broker/src/aws/broker.ts` (import `DEVELOPER_TASK_OWNER_ISSUER`, `SharedTaskRecordSchema`,
`sharedTaskKey`, `type SharedTaskRecord` from `@agentx/contracts`; `taskOwnerKey`, `taskOwnerSubject`
from `"../developer/task-records.js"`), add:

```ts
/** Spec 025 FR-035, FR-054: the thread's shared task record, or undefined for an ordinary thread. */
async function sharedThread(dependencies: AwsBrokerDependencies, thread: SlackThread): Promise<SharedTaskRecord | undefined> {
  // Developer tasks exist only where developer sign-in is set up (D14); nothing else reads this key.
  if (dependencies.developer === undefined) return undefined;
  const item = await getItem<Record<string, unknown>>(dependencies, sharedTaskKey(thread));
  if (item === undefined) return undefined;
  const record = SharedTaskRecordSchema.safeParse(item);
  // Fail closed: an unreadable record must never let the thread act as an ordinary one.
  if (!record.success || record.data.ownerKey !== taskOwnerKey(record.data.developerId, record.data.taskId)) {
    throw agentXError("FORBIDDEN", "this thread's shared task record cannot be read; ask an admin");
  }
  return record.data;
}
```

and replace `slackServiceIdentity`'s `return { ... }` with:

```ts
  const own: AuthenticatedIdentity = {
    issuer: SLACK_THREAD_OWNER_ISSUER,
    subject,
    ownerKey: ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, subject),
    isAdministrator: false,
    claims: {},
    slack: { ...context, binding },
  };
  const shared = await sharedThread(dependencies, context.thread);
  if (shared === undefined) return own;
  const sharedTask = { taskId: shared.taskId, workspaceId: shared.workspaceId, developerName: shared.developerName };
  // C11: open only while continue, not closed, and the channel still serves the task's project.
  if (shared.mode !== "continue" || shared.closedAt !== undefined || binding.projectName !== shared.project) {
    return { ...own, sharedTask: { ...sharedTask, state: shared.closedAt !== undefined ? "closed" : "view" } };
  }
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(shared.developerId, shared.taskId),
    ownerKey: shared.ownerKey,
    isAdministrator: false,
    claims: {},
    // The teammate's Slack context: requesterOf records them on every operation (FR-054).
    slack: { ...context, binding },
    sharedTask: { ...sharedTask, state: "continue" },
  };
```

- [ ] **Step 5: Answer the thread workspace, prepare and close routes**

In `ensureThreadWorkspace`, after `include` is built, add:

```ts
  if (identity.sharedTask !== undefined) return sharedThreadWorkspace(dependencies, identity, identity.sharedTask, input.includeSharedTask === true, include, includeSettingsRevision);
```

and add:

```ts
/**
 * Spec 025 C11: a shared thread's workspace. View or closed: VIEW_ONLY, and nothing is created.
 * Continue: the task's workspace as it is, never created, prepared again or charged (FR-054), with
 * no recoverable operations, because the running one may be the developer's own.
 */
async function sharedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  shared: NonNullable<AuthenticatedIdentity["sharedTask"]>,
  includeSharedTask: boolean,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  if (shared.state !== "continue") {
    if (!includeSharedTask) throw agentXError("FORBIDDEN", "this thread follows a task started from an AI tool and is view only");
    return { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: shared.state === "closed" };
  }
  const workspace = await requireWorkspace(dependencies, shared.workspaceId);
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("FORBIDDEN", "the workspace does not belong to this task");
  if (workspace.status === "CLOSED" && workspace.closedAt) return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: workspace.status,
    operationId: workspace.activeOperationId,
    created: false,
    orchestratorInstructions: settings.definition.orchestratorInstructions,
    ...await threadIntegrations(settings.definition, include, dependencies),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: settings.definition.revision } : {}),
    ...(include.actionPolicy && settings.definition.actionPolicy ? { actionPolicy: settings.definition.actionPolicy } : {}),
    ...(includeSharedTask ? { sharedTask: { taskId: shared.taskId, developerName: shared.developerName } } : {}),
  };
}
```

In `prepareThreadWorkspace`, after `const requestId = uuid(...)`:

```ts
  // C11: a shared task's workspace is the developer's; the thread never prepares it.
  if (identity.sharedTask !== undefined) {
    if (identity.sharedTask.state !== "continue") throw agentXError("FORBIDDEN", "this thread follows a task started from an AI tool and is view only");
    const workspace = await requireWorkspace(dependencies, identity.sharedTask.workspaceId);
    if (workspace.status === "CLOSED" && workspace.closedAt) return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: workspace.status, operationId: workspace.activeOperationId, created: false };
  }
```

(keep `requestId` used, as today, so lint stays quiet). In `startThreadWorkspaceClose`, after
`const input = object(...)`:

```ts
  // C11: only the developer closes a shared task, from their AI tool.
  if (identity.sharedTask !== undefined) {
    if (input.includeSharedTask === true) return { outcome: "REFUSED", reason: "shared_task" };
    throw agentXError("FORBIDDEN", "only the developer who started this task can close it, from their AI tool");
  }
```

and in `completeThreadWorkspaceClose`, after its `const input = object(...)`:
`if (identity.sharedTask !== undefined) throw agentXError("FORBIDDEN", "only the developer who started this task can close it, from their AI tool");`

- [ ] **Step 6: Record who started a channel operation, and stop**

Add to `broker.ts`:

```ts
/** C13: who started an operation from a shared thread, for the developer's TASK_BUSY (C14). */
function channelOperation(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): ExtraItems {
  const shared = identity.sharedTask;
  const slack = identity.slack;
  if (shared?.state !== "continue" || slack === undefined) return () => [];
  return (operation) => [{ Put: {
    TableName: dependencies.tableName,
    Item: {
      pk: `DEVTASK#${shared.taskId}`, sk: `CHANNEL_OPERATION#${operation.id}`, entityType: "CHANNEL_OPERATION",
      slackUserId: slack.requester.userId, ...(slack.requesterName === undefined ? {} : { name: slack.requesterName }), createdAt: operation.createdAt,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  } }];
}
```

In `routeWorkspaceRequest`, pass it as the last argument of the two calls:
`acceptTask(dependencies, identity, tasks[1], body, channelOperation(dependencies, identity))` and
`acceptPullRequest(dependencies, identity, pullRequests[1], body, channelOperation(dependencies, identity))`.
(`ExtraItems` is imported from `./developer-task-actions.js` already, or add the import.)

In `stopSlackThreadTask`, after the binding check:

```ts
  // Q8: in a continue thread a teammate's stop cancels the task's running task operation, as the
  // developer's own cancel would; a view-only or closed thread stops nothing.
  const shared = await sharedThread(dependencies, thread);
  if (shared !== undefined) {
    if (shared.mode !== "continue" || shared.closedAt !== undefined) return { outcome: "NOTHING_RUNNING" };
    return cancelRunningTask(dependencies, await requireWorkspace(dependencies, shared.workspaceId), { requestedBy: requester });
  }
```

- [ ] **Step 7: Name the channel turn in the developer's TASK_BUSY**

In `packages/broker/src/aws/developer-task-actions.ts`, add to `DeveloperTaskActions`:

```ts
  /** C14: who started this operation from the shared thread, if a teammate did, and how many channel messages wait. */
  channelActivity(input: { taskId: string; operationId: string; threadSubject: string }): Promise<{ driver?: { slackUserId: string; name?: string }; waiting: number }>;
```

In `broker.ts`, add `slackThreadsTableName?: string;` to `AwsBrokerDependencies` (and pass it
through `brokerDependencies` if that function copies fields one by one), add to the module's
`handler` input `...(process.env.SLACK_THREADS_TABLE_NAME ? { slackThreadsTableName: process.env.SLACK_THREADS_TABLE_NAME } : {}),`,
and to `developerTaskActions`:

```ts
    channelActivity: async ({ taskId, operationId, threadSubject }) => {
      const marker = await getItem<{ slackUserId?: unknown; name?: unknown }>(dependencies, { pk: `DEVTASK#${taskId}`, sk: `CHANNEL_OPERATION#${operationId}` });
      let waiting = 0;
      if (dependencies.slackThreadsTableName !== undefined) {
        try {
          const thread = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.slackThreadsTableName, Key: { pk: `THREAD#${threadSubject}`, sk: "META" } })) as { Item?: { pendingRequests?: unknown } };
          const pending = Number(thread.Item?.pendingRequests ?? 0);
          // The running turn is one of the thread's pending requests.
          waiting = Number.isFinite(pending) ? Math.max(0, pending - 1) : 0;
        } catch (error) {
          console.log(JSON.stringify({ component: "broker", event: "developer.channel_waiting_unread", taskId, error: error instanceof Error ? error.name : "unknown" }));
        }
      }
      return {
        ...(typeof marker?.slackUserId === "string" ? { driver: { slackUserId: marker.slackUserId, ...(typeof marker.name === "string" ? { name: marker.name } : {}) } } : {}),
        waiting,
      };
    },
```

In `packages/broker/src/aws/developer-tasks.ts`, add:

```ts
/** C14, D4: the words for a developer's action that met a teammate's channel turn, or undefined. */
async function channelDriver(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, operationId: string | null): Promise<string | undefined> {
  if (operationId === null || task.share?.threadTs === undefined) return undefined;
  const activity = await deps.actions.channelActivity({ taskId: task.taskId, operationId, threadSubject: sharedSubject({ ...task.share, threadTs: task.share.threadTs }) });
  if (activity.driver === undefined) return undefined;
  const who = activity.driver.name ?? `Slack user ${activity.driver.slackUserId}`;
  const waiting = activity.waiting === 0 ? "" : `, and ${activity.waiting} more channel message${activity.waiting === 1 ? "" : "s"} wait behind it`;
  return `task ${task.taskId} is running a request from ${who} in its shared Slack thread${waiting}; wait with agentx_wait_for_task, stop it with agentx_cancel_task, or make the thread view only with agentx_share_task`;
}
```

and in `busyOrClosing`, after the `CLOSING` check:

```ts
    const channel = await channelDriver(deps, task, workspace.activeOperationId);
    if (channel !== undefined) throw agentXError("TASK_BUSY", channel);
```

Add `channelActivity: async () => ({ waiting: 0 })` to the hand-written `DeveloperTaskActions`
fakes in the tests, as Task 5 did for `channelTurns`.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/contract/shared-task-identity.test.ts tests/contract/slack-control-plane.test.ts tests/contract/slack-lazy-workspace.test.ts tests/contract/slack-thread-characterization.test.ts tests/contract/stop-command.test.ts tests/contract/cancel-task.test.ts tests/contract/developer-task-actions-routes.test.ts tests/contract/orchestration-tools-characterization.test.ts && npm run typecheck`
Expected: PASS. The Slack characterization suites and the orchestrator tools' characterization are
unchanged (C23): ordinary threads resolve exactly as before, and no `agentx_*` tool changed.

- [ ] **Step 9: Commit**

```bash
git add packages/broker/src tests/support tests/contract/shared-task-identity.test.ts tests/contract
git commit -m "feat(broker): continue-mode threads act on the task's workspace, attributed (spec 025 FR-054)"
```

---

### Task 11: The Slack service runs a continue-mode turn: one at a time, attributed

C10, C12, C13: FR-054's Slack service side, US3 scenarios 4 (queued messages), 5 and 6, and the
edge case "the developer switches a continue thread to view only". **Depends on Q1** (the notice)
and **Q3**.

**Files:**
- Create: `packages/slack-service/src/shared-task.ts`
- Modify: `packages/slack-service/src/lazy-worker.ts` (export `withDeadline`)
- Modify: `packages/slack-service/src/processor.ts`
- Modify: `packages/slack-service/src/turn-records.ts` (`TurnDraft.taskId`, `requesterName`)
- Modify: `packages/slack-service/src/thread-workspace-request.ts`, `thread-api.ts`, `main.ts`
- Modify (additive): `tests/contract/thread-workspace-request.test.ts`
- Test: `tests/integration/shared-task-turns.test.ts`

**Interfaces:**
- Consumes: `VIEW_ONLY`, `sharedTask`, `REFUSED` shapes, `VIEW_ONLY_NOTICE`, `CLOSED_SHARED_NOTICE`,
  `CHANNEL_TURN_WAIT_MS`, `sharedNoticeKey`, `SHARED_THREAD_NOTICE_INTERVAL_SECONDS` (Task 1); the
  broker answers of Task 10.
- Produces:
  - `waitForIdleTask(input: { api: Pick<ThreadServiceApi, "ensureWorkspace" | "waitForOperation">; requestId: string; first: WorkspaceAnswer; post(text: string): Promise<void>; log: ServiceLog; eventId: string; now(): number; deadlineMs?: number; sleep?(ms: number): Promise<void> }): Promise<SlackThreadWorkspaceResult | "BUSY">`
  - `TASK_BUSY_WAIT_MESSAGE`, `TASK_STILL_BUSY_MESSAGE`, `SHARED_CLOSE_REFUSED_MESSAGE`
  - `ProcessorDependencies.userName?(userId: string): Promise<string | undefined>`
  - `ThreadStore.claimSharedNotice?(subject: string, nowSeconds: number): Promise<boolean>`
  - `threadWorkspaceRequest` adds `includeSharedTask: true`; `startClose` sends `includeSharedTask: true`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/shared-task-turns.test.ts
// Spec 025 FR-054, C10, C12, C13: how the Slack service handles a shared task's thread.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSED_SHARED_NOTICE, VIEW_ONLY_NOTICE, type SlackRequestMessage, type SlackThreadWorkspaceResult, type TurnRecord } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { SHARED_CLOSE_REFUSED_MESSAGE, TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE } from "../../packages/slack-service/src/shared-task.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000100" };
const TASK = "44444444-4444-4444-8444-444444444444";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUNNING = "22222222-2222-4222-8222-222222222222";
const message = (text = "run the linter"): SlackRequestMessage => ({ version: 1, eventId: "Ev0000000201", thread, userId: "U0PRIYA001", text, receivedAt: "2026-09-29T10:00:00.000Z" });
const workspace = (operationId: string | null): SlackThreadWorkspaceResult => ({
  outcome: "WORKSPACE", workspaceId: WORKSPACE, status: operationId === null ? "READY" : "BUSY", operationId, created: false,
  orchestratorInstructions: "Delegate work.", sharedTask: { taskId: TASK, developerName: "Maya Chen" },
});

function harness(answers: SlackThreadWorkspaceResult[], options: { claim?: boolean; waitForever?: boolean; startClose?: "REFUSED" } = {}) {
  const posts: string[] = [];
  const order: string[] = [];
  const records: TurnRecord[] = [];
  const claims: string[] = [];
  let answer = 0;
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => answers[Math.min(answer++, answers.length - 1)]!,
      startClose: async () => (options.startClose === "REFUSED" ? { outcome: "REFUSED" as const, reason: "shared_task" as const } : { outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation: async (_workspace, operationId) => {
        order.push(`wait:${operationId}`);
        if (options.waitForever) await new Promise(() => undefined);
        return { status: "SUCCEEDED" };
      },
      createConversation: async () => "33333333-3333-4333-8333-333333333333",
    }),
    threads: {
      load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined,
      close: async () => undefined, finish: async () => undefined,
      claimSharedNotice: async (subject) => { claims.push(subject); return options.claim ?? true; },
    },
    runTurn: async () => { order.push("turn"); return "done"; },
    post: async (_thread, text) => { posts.push(text); },
    userName: async () => "Priya",
    turnRecords: { write: async (record) => { records.push(record); return "written"; } },
  };
  return { dependencies, posts, order, records, claims };
}

afterEach(() => { vi.useRealTimers(); });

describe("a continue thread's turn (FR-054, C12)", () => {
  it("waits for the developer's running operation before the turn starts (Review Focus 1)", async () => {
    const h = harness([workspace(RUNNING), workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.order).toEqual([`wait:${RUNNING}`, "turn"]);
    expect(h.posts[0]).toBe(TASK_BUSY_WAIT_MESSAGE);
  });

  it("waits again when a new operation took the workspace meanwhile", async () => {
    const next = "55555555-5555-4555-8555-555555555555";
    const h = harness([workspace(RUNNING), workspace(next), workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.order).toEqual([`wait:${RUNNING}`, `wait:${next}`, "turn"]);
  });

  it("answers that the task is still busy after 30 minutes, and runs nothing", async () => {
    vi.useFakeTimers();
    const h = harness([workspace(RUNNING)], { waitForever: true });
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    await done;
    expect(h.order).not.toContain("turn");
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE]);
    expect(h.records[0]).toMatchObject({ disposition: "workspace_unavailable", taskId: TASK });
  });

  it("names the teammate in the reply, and records the task and the teammate's name (C13, US3 scenario 5)", async () => {
    const h = harness([workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts.at(-1)).toBe("<@U0PRIYA001> done");
    expect(h.records[0]).toMatchObject({ taskId: TASK, requesterName: "Priya", requestedBy: { userId: "U0PRIYA001" }, disposition: "answered" });
  });
});

describe("a thread that is not open to the channel (C10, Review Focus 2)", () => {
  it("posts the notice for a message queued before the switch, and runs nothing", async () => {
    const h = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: false }]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 1 });
    expect(h.posts).toEqual([VIEW_ONLY_NOTICE]);
    expect(h.order).toEqual([]);
    expect(h.records[0]).toMatchObject({ disposition: "workspace_unavailable", taskId: TASK });
  });

  it("keeps to one notice an hour, shared with the ingress's marker", async () => {
    const h = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: true }], { claim: false });
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([]);
    expect(h.claims).toEqual(["T0BSHLLUGBD/C0123456789/1695500000.000100"]);
    const closed = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: true }]);
    await processSlackRequest(message(), closed.dependencies, { finalAttempt: false });
    expect(closed.posts).toEqual([CLOSED_SHARED_NOTICE]);
  });

  it("refuses to close the task from the thread", async () => {
    const h = harness([workspace(null)], { startClose: "REFUSED" });
    await processSlackRequest(message("close this workspace"), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([SHARED_CLOSE_REFUSED_MESSAGE]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/shared-task-turns.test.ts`
Expected: FAIL, `shared-task.js` does not exist.

- [ ] **Step 3: Write `shared-task.ts`, and export `withDeadline`**

In `packages/slack-service/src/lazy-worker.ts`, change `async function withDeadline` to
`export async function withDeadline`.

```ts
// packages/slack-service/src/shared-task.ts
// Spec 025 FR-054, C12: a continue-mode turn starts only once the task's workspace has no active
// operation (the developer's own run, or the operation the previous channel turn started), waiting
// at most 30 minutes. The consumer's heartbeat keeps the queue message invisible meanwhile.
import { CHANNEL_TURN_WAIT_MS, type SlackThreadWorkspaceResult } from "@agentx/contracts";
import { withDeadline } from "./lazy-worker.js";
import type { ServiceLog, ThreadServiceApi } from "./processor.js";

export const TASK_BUSY_WAIT_MESSAGE = "The task is busy with other work right now. I'll start on this as soon as it's free.";
export const TASK_STILL_BUSY_MESSAGE = "The task was still busy after 30 minutes, so I didn't run this request. Mention me again when it's free.";
export const SHARED_CLOSE_REFUSED_MESSAGE = "This thread follows a task started from an AI tool. Only the developer who started it can close it, from their AI tool.";

type WorkspaceAnswer = Extract<SlackThreadWorkspaceResult, { outcome: "WORKSPACE" }>;
const SAME_OPERATION_PAUSE_MS = 5_000;

export async function waitForIdleTask(input: {
  api: Pick<ThreadServiceApi, "ensureWorkspace" | "waitForOperation">;
  requestId: string;
  first: WorkspaceAnswer;
  post: (text: string) => Promise<void>;
  log: ServiceLog;
  eventId: string;
  now: () => number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SlackThreadWorkspaceResult | "BUSY"> {
  const until = input.now() + (input.deadlineMs ?? CHANNEL_TURN_WAIT_MS);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await input.post(TASK_BUSY_WAIT_MESSAGE);
  input.log("shared_task.waiting", { eventId: input.eventId });
  let current: SlackThreadWorkspaceResult = input.first;
  let waitedFor: string | undefined;
  while (current.outcome === "WORKSPACE" && current.operationId !== null) {
    const remaining = until - input.now();
    if (remaining <= 0) return "BUSY";
    if (current.operationId === waitedFor) {
      // The operation ended but the workspace still names it: a brief pause, never a hot loop.
      await sleep(Math.min(SAME_OPERATION_PAUSE_MS, remaining));
    } else {
      const controller = new AbortController();
      const settled = await withDeadline(input.api.waitForOperation(current.workspaceId, current.operationId, controller.signal), remaining, controller);
      if (settled === "TIMED_OUT") return "BUSY";
      waitedFor = current.operationId;
    }
    current = await input.api.ensureWorkspace(input.requestId);
  }
  return current;
}
```

- [ ] **Step 4: Use it in the processor**

In `packages/slack-service/src/turn-records.ts`, add to `TurnDraft`:
`/** Spec 025: a continue-mode turn's task, and the teammate's display name (C13). */ taskId?: string; requesterName?: string;`
and in `buildTurnRecord`'s object, after `conversationId`:

```ts
    ...(draft.taskId === undefined ? {} : { taskId: draft.taskId }),
    ...(draft.requesterName === undefined ? {} : { requesterName: draft.requesterName }),
```

In `packages/slack-service/src/processor.ts`:
- import `CLOSED_SHARED_NOTICE`, `VIEW_ONLY_NOTICE` from `@agentx/contracts`, and
  `SHARED_CLOSE_REFUSED_MESSAGE`, `TASK_STILL_BUSY_MESSAGE`, `waitForIdleTask` from `./shared-task.js`;
- add to `ThreadStore`:
  `/** C10: claims the shared thread's hourly notice (the ingress's marker); true when this caller may post it. */ claimSharedNotice?(subject: string, nowSeconds: number): Promise<boolean>;`
- add to `ProcessorDependencies`:
  `/** C13: a Slack member's display name, for a continue-mode turn's record. */ userName?: (userId: string) => Promise<string | undefined>;`
- replace Task 1's `REFUSED` stub with `if (started.outcome === "REFUSED") { await post(SHARED_CLOSE_REFUSED_MESSAGE); finished = true; return; }`;
- replace `const workspace = await api.ensureWorkspace(deterministicUuid(\`${message.eventId}:workspace\`));`
  and Task 1's `VIEW_ONLY` stub with:

```ts
    const workspaceRequestId = deterministicUuid(`${message.eventId}:workspace`);
    let workspace = await api.ensureWorkspace(workspaceRequestId);
    // Spec 025 FR-054, C12: a continue thread's turn starts only once the task's workspace is idle.
    if (workspace.outcome === "WORKSPACE" && workspace.sharedTask !== undefined && workspace.operationId !== null) {
      const taskId = workspace.sharedTask.taskId;
      const idle = await waitForIdleTask({ api, requestId: workspaceRequestId, first: workspace, post, log, eventId: message.eventId, now });
      if (idle === "BUSY") {
        draft.disposition = "workspace_unavailable";
        draft.taskId = taskId;
        await post(TASK_STILL_BUSY_MESSAGE);
        finished = true;
        return;
      }
      workspace = idle;
      // The member was told to wait, so the start is said again (spec 014 FR-026).
      waitedForSetup = true;
    }
    // C10: a view-only or closed shared thread; the message was queued before the switch.
    if (workspace.outcome === "VIEW_ONLY") {
      draft.disposition = "workspace_unavailable";
      draft.taskId = workspace.taskId;
      let notify = true;
      if (dependencies.threads.claimSharedNotice !== undefined) {
        try {
          notify = await dependencies.threads.claimSharedNotice(subject, Math.floor(now() / 1000));
        } catch (error) {
          log("shared_task.notice_claim_failed", { eventId: message.eventId, errorName: errorName(error) });
          notify = false;
        }
      }
      if (notify) await post(workspace.closed ? CLOSED_SHARED_NOTICE : VIEW_ONLY_NOTICE);
      finished = true;
      return;
    }
```

  (the `LIMIT_REACHED` and `CLOSED` branches follow unchanged; `now` is already declared above);
- after `if (workspace.settingsRevision !== undefined) draft.settingsRevision = workspace.settingsRevision;`:

```ts
    // C13: a continue-mode turn names its task and the teammate on its record.
    const shared = workspace.sharedTask;
    if (shared !== undefined) {
      draft.taskId = shared.taskId;
      const name = (await dependencies.userName?.(message.userId).catch(() => undefined))?.trim().slice(0, 80);
      if (name) draft.requesterName = name;
    }
```

- where the reply is split into chunks, prefix the teammate's mention:

```ts
      // C13: in a continue thread, the reply names the teammate it answers.
      const mention = shared === undefined ? "" : `<@${message.userId}> `;
      const chunks = splitSlackMessage(`${mention}${slackReplyText(response)}`);
```

In `thread-workspace-request.ts`, append `includeSharedTask: true` to the returned object and add
to the doc comment "`includeSharedTask` opts in to `VIEW_ONLY` and `sharedTask` (spec 025)". In
`tests/contract/thread-workspace-request.test.ts`, append `includeSharedTask: true` to the expected
object (the list gains an entry). In `thread-api.ts`'s `startClose`, send
`{ requestId, includeSharedTask: true }`.

In `packages/slack-service/src/main.ts`, pass `userName: slackUserName` to the processor's
dependencies, and add to `threads` (import `sharedNoticeKey`, `SHARED_THREAD_NOTICE_INTERVAL_SECONDS`):

```ts
  async claimSharedNotice(subject, nowSeconds) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: threadsTableName,
        Key: sharedNoticeKey(subject),
        UpdateExpression: "SET noticedAt = :now, expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(noticedAt) OR noticedAt <= :cutoff",
        ExpressionAttributeValues: {
          ":now": nowSeconds,
          ":expires": nowSeconds + 2 * SHARED_THREAD_NOTICE_INTERVAL_SECONDS,
          ":cutoff": nowSeconds - SHARED_THREAD_NOTICE_INTERVAL_SECONDS,
        },
      }), { abortSignal: AbortSignal.timeout(5000) });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/shared-task-turns.test.ts tests/integration/slack-processor-characterization.test.ts tests/integration/turn-records.test.ts tests/integration/slack-lazy-worker.test.ts tests/contract/slack-reply-characterization.test.ts tests/contract/thread-workspace-request.test.ts tests/contract/thread-api.test.ts tests/contract/orchestration-tools-characterization.test.ts && npm run typecheck`
Expected: PASS. The characterization suites are unchanged: a thread without `sharedTask` takes
exactly today's path, and no `agentx_*` orchestrator tool changed (C23).

- [ ] **Step 6: Commit**

```bash
git add packages/slack-service/src tests/integration/shared-task-turns.test.ts tests/contract/thread-workspace-request.test.ts
git commit -m "feat(slack-service): continue-mode turns wait for the task and name the teammate (spec 025 FR-054)"
```

---

### Task 12: The Slack limit reply counts the member's AI-tool tasks

C16: 25b's owner decision 10. The member counter already holds the tasks (25b's R6 `tasks` set);
the Slack refusal read only its `threads` list.

**Files:**
- Modify: `packages/broker/src/aws/broker.ts` (`threadWorkspaceLimitRefusal`, `startThreadPreparation`, their callers)
- Modify: `packages/slack-service/src/messages.ts` (`limitMessage`)
- Modify: `packages/slack-service/src/thread-workspace-request.ts`, `thread-api.ts` (`prepareWorkspace`)
- Modify (additive): `tests/contract/thread-workspace-request.test.ts`
- Test: `tests/contract/slack-limit-tasks.test.ts`

**Interfaces:**
- Consumes: `openTaskCount` on both `LIMIT_REACHED` shapes (Task 1).
- Produces: `threadWorkspaceLimitRefusal(dependencies, teamId, userId, limits, includeOpenTaskCount: boolean)`;
  `startThreadPreparation(dependencies, identity, requestId, workspace, includeOpenTaskCount = false)`;
  `limitMessage(result: { limit; maximum; starterThreads; openTaskCount?: number }): string`;
  the request bodies gain `includeOpenTaskCount: true`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/slack-limit-tasks.test.ts
// Spec 025 C16 (25b owner decision 10): a member whose AI-tool tasks fill the limit is told so.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { limitMessage } from "../../packages/slack-service/src/messages.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, serviceCall } from "../support/slack-broker.js";

const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };
const TODAY = "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:";

describe("the Slack limit refusal (C16)", () => {
  it("counts the member's open AI-tool tasks for a service that asks", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ memberLimit: 3 });
    for (let index = 0; index < 3; index += 1) {
      await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: `Task ${index}`, client: "claude-code" });
    }
    const subject = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009`;
    const asked = await serviceCall(handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), includeOpenTaskCount: true });
    expect(asked.body).toEqual({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 3 });
    const older = await serviceCall(handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID() });
    expect(older.body).toEqual({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [] });
  });
});

describe("limitMessage (C16)", () => {
  it("keeps today's words exactly when no AI-tool task is open", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 0 }).split("\n")[0]).toBe(TODAY);
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread] })).toBe(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 0 }));
  });

  it("names the AI-tool tasks beside the threads, and says how to close one", () => {
    const text = limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 2 });
    expect(text.split("\n")[0]).toBe(TODAY);
    expect(text.split("\n").at(-1)).toBe("You also have 2 tasks started from an AI tool; closing one there with agentx_close_task frees a workspace.");
  });

  it("says so plainly when the tasks are all there is", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 3 })).toBe(
      "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. 3 of them are tasks started from an AI tool; close one there with agentx_close_task to free a workspace.",
    );
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 1 })).toContain("One of them is a task started from an AI tool");
  });

  it("uses no em dash", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 2 })).not.toContain("\u2014");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/slack-limit-tasks.test.ts`
Expected: FAIL, no `openTaskCount`.

- [ ] **Step 3: Implement**

In `broker.ts`, change `threadWorkspaceLimitRefusal`:

```ts
async function threadWorkspaceLimitRefusal(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  userId: string,
  limits: SlackServiceConfiguration,
  includeOpenTaskCount: boolean,
): Promise<SlackThreadWorkspaceResult> {
  const member = await getItem<{ count?: number; threads?: string[]; tasks?: Set<string> }>(dependencies, slackMemberLimitKey(teamId, userId));
  if ((member?.count ?? 0) >= limits.memberWorkspaceLimit) {
    return {
      outcome: "LIMIT_REACHED",
      limit: "MEMBER",
      maximum: limits.memberWorkspaceLimit,
      starterThreads: (member?.threads ?? []).map((subject) => parseSlackThreadSubject(subject)),
      // C16: the member's open AI-tool tasks share this counter (25b R6), so the reply names them.
      ...(includeOpenTaskCount ? { openTaskCount: member?.tasks?.size ?? 0 } : {}),
    };
  }
  // ... the ORGANIZATION branch and the final throw, unchanged
}
```

Pass the flag at each call site (`grep -n "threadWorkspaceLimitRefusal(" packages/broker/src/aws/broker.ts`):
- in `ensureThreadWorkspace`: `threadWorkspaceLimitRefusal(dependencies, teamId, userId, effective, input.includeOpenTaskCount === true)`;
- give `startThreadPreparation` a last parameter `includeOpenTaskCount = false` and use it in its
  call; `ensureThreadWorkspace` passes `input.includeOpenTaskCount === true` to it, and
  `prepareThreadWorkspace` passes `input.includeOpenTaskCount === true` from its own body.

`SlackThreadPrepareResult`'s LIMIT_REACHED accepts `openTaskCount` since Task 1; if
`startThreadPreparation`'s refusal is typed as `SlackThreadWorkspaceResult`, the two
`LIMIT_REACHED` branches are the same shape, so the value is returned as it is.

In `packages/slack-service/src/messages.ts`:

```ts
export function limitMessage(result: { limit: SlackWorkspaceLimit; maximum: number; starterThreads: readonly SlackThread[]; openTaskCount?: number }): string {
  if (result.limit === "ORGANIZATION") {
    return `This organization already has ${result.maximum} AgentX workspaces, the most allowed, so I can't start a new one. ` +
      "Continue in an existing thread, or ask an administrator to raise the limit.";
  }
  const head = `You already have ${result.maximum} AgentX workspaces, the most one person can have, so I can't start a new one.`;
  const tasks = result.openTaskCount ?? 0;
  // C16: the member's AI-tool tasks count against the same limit.
  if (result.starterThreads.length === 0 && tasks > 0) {
    const which = tasks === 1 ? "One of them is a task" : `${tasks} of them are tasks`;
    return `${head} ${which} started from an AI tool; close one there with agentx_close_task to free a workspace.`;
  }
  const links = result.starterThreads.map((thread, index) => `• <${escapeText(slackThreadUrl(thread))}|Thread ${index + 1}>`);
  return [
    `${head} Continue in one of your existing threads instead:`,
    ...links,
    ...(tasks > 0 ? [`You also have ${tasks} task${tasks === 1 ? "" : "s"} started from an AI tool; closing one there with agentx_close_task frees a workspace.`] : []),
  ].join("\n");
}
```

The processor and the lazy worker already pass the whole `LIMIT_REACHED` result to `limitMessage`,
so `openTaskCount` reaches it with no other change.

In `thread-workspace-request.ts`, append `includeOpenTaskCount: true` (and name it in the comment);
append it to the expected object in `tests/contract/thread-workspace-request.test.ts`. In
`thread-api.ts`'s `prepareWorkspace`, send `{ requestId, includeOpenTaskCount: true }`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/slack-limit-tasks.test.ts tests/contract/workspace-limits.test.ts tests/integration/slack-lazy-worker.test.ts tests/contract/slack-lazy-workspace.test.ts tests/contract/thread-workspace-request.test.ts tests/contract/thread-api.test.ts`
Expected: PASS; `slack-lazy-worker.test.ts`'s exact `MEMBER_LIMIT` text is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/broker.ts packages/slack-service/src tests/contract/slack-limit-tasks.test.ts tests/contract/thread-workspace-request.test.ts
git commit -m "fix(slack): the limit reply counts the member's AI-tool tasks (spec 025, 25b owner decision 10)"
```

---

### Task 13: The stuck-setup sweep

C17, C18: FR-055's first half and D21. **Depends on Q4** (only developer-task prepares are
watched) and **Q5** (the clock starts at the prepare's creation).

**Files:**
- Create: `packages/broker/src/aws/stuck-setup.ts`
- Modify: `packages/broker/src/aws/developer-tasks.ts` (`startTask` writes the watch)
- Modify: `packages/broker/src/aws/broker.ts` (`isSweptPrepare` in `recordTerminalResult`)
- Modify: `packages/broker/src/aws/session-reconciler.ts` (`sweepStuckSetups`, the report, the metric, the AWS wiring)
- Modify: `tests/support/fake-dynamodb.ts` (the `pk = :pk AND sk < :value` key condition)
- Test: `tests/contract/stuck-setup.test.ts`; `tests/contract/session-reconciler.test.ts` (one test appended)

**Interfaces:**
- Consumes: the task pointer (25b); `failureCategory` reads `setup_failed` for any failed prepare.
- Produces:
  - `STUCK_SETUP_MS = 900_000`, `STUCK_SETUP_MESSAGE = "setup did not finish within 15 minutes; close this task and start a new one"`
  - `setupWatchKey(createdAt: string, workspaceId: string): { pk: "SETUP_WATCH"; sk: string }`
  - `sweepStuckSetups(client, tableName: string, now: Date, log?): Promise<{ failed: string[]; settled: number }>`
  - `ReconcilerDependencies.sweepStuckSetups?(now: Date): Promise<{ failed: string[] }>`; `ReconcilerReport.stuckSetups: string[]`; metric `ReconcilerStuckSetups`.

- [ ] **Step 1: Let the fake table answer a sort-key range**

In `tests/support/fake-dynamodb.ts`'s `query`, before the `begins_with` match, add:

```ts
    // The stuck-setup sweep's "older than" range (spec 025 C17).
    const before = /^pk = :pk AND sk < (:[a-zA-Z]+)$/.exec(String(input.KeyConditionExpression));
    if (before) {
      const bound = values[before[1]!] as string;
      const found = this.find((item) => item.pk === values[":pk"] && compareKeys(item.sk as string, bound) < 0)
        .sort((left, right) => compareKeys(left.sk as string, right.sk as string));
      const limit = input.Limit as number | undefined;
      return (limit === undefined ? found : found.slice(0, limit)).map((item) => structuredClone(item));
    }
```

and update the comment above `query` to name both shapes.

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/stuck-setup.test.ts
// Spec 025 FR-055, D21, C17, C18: a developer task's setup is failed 15 minutes after it started.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STUCK_SETUP_MESSAGE, sweepStuckSetups } from "../../packages/broker/src/aws/stuck-setup.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

async function starting() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const prepareId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const watches = () => harness.db.find((item) => item.pk === "SETUP_WATCH");
  const minutesLater = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const sweep = (minutes: number) => sweepStuckSetups(harness.db, "state", minutesLater(minutes), () => undefined);
  return { ...harness, taskId, workspaceId, prepareId, watches, sweep };
}

describe("the setup watch (C17)", () => {
  it("is written with the start, naming the prepare, and only for a developer task (Q4)", async () => {
    const { watches, prepareId, taskId, workspaceId, handler } = await starting();
    expect(watches()).toEqual([expect.objectContaining({ entityType: "SETUP_WATCH", workspaceId, operationId: prepareId, taskId, expiresAt: expect.any(Number) })]);
    await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, "U0PRATIK01");
    expect(watches()).toHaveLength(1);
  });
});

describe("the sweep (FR-055)", () => {
  it("fails a prepare still running 15 minutes after it started, whatever the instance's health", async () => {
    const { db, sweep, workspaceId, prepareId, watches, dev, taskId } = await starting();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 1 });
    expect(await sweep(16)).toEqual({ failed: [workspaceId], settled: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(db.get(`WORKSPACE#${workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
    expect(watches()).toEqual([]);
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "FAILED", failure: { category: "setup_failed", message: STUCK_SETUP_MESSAGE } });
    // FR-020: closing the task frees its slot, as for any failed setup.
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 0 });
  });

  it("leaves a younger prepare alone", async () => {
    const { db, sweep, workspaceId, watches } = await starting();
    expect(await sweep(14)).toEqual({ failed: [], settled: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
    expect(watches()).toHaveLength(1);
  });

  it("drops the watch of a setup that finished, and changes nothing else", async () => {
    const { db, sweep, finish, workspaceId, prepareId, watches } = await starting();
    await finish(workspaceId, prepareId, "SUCCEEDED");
    const before = db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(await sweep(16)).toEqual({ failed: [], settled: 1 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(before);
    expect(watches()).toEqual([]);
  });

  it("lets a result that lands during the sweep win, and drops the watch on the next run", async () => {
    const { db, sweep, workspaceId, prepareId, watches, finish } = await starting();
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(STUCK_SETUP_MESSAGE)) {
        raced = true;
        db.send = original;
        await finish(workspaceId, prepareId, "SUCCEEDED");
      }
      return original(command);
    };
    expect(await sweep(16)).toEqual({ failed: [], settled: 1 });
    expect(raced).toBe(true);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(watches()).toHaveLength(1);
    expect(await sweep(17)).toEqual({ failed: [], settled: 1 });
    expect(watches()).toEqual([]);
  });

  it("answers a late SUCCEEDED result for a swept prepare and queues nothing (Review Focus 4)", async () => {
    const { db, sweep, finish, workspaceId, prepareId } = await starting();
    await sweep(16);
    await expect(finish(workspaceId, prepareId, "SUCCEEDED")).resolves.toBeDefined();
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "task")).toHaveLength(0);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
  });
});
```

Append to `tests/contract/session-reconciler.test.ts` (the `setup` helper gains an optional
`sweepStuckSetups` it passes through):

```ts
describe("reconciler: stuck setups (spec 025 FR-055)", () => {
  it("runs the sweep last, reports what it failed and counts it", async () => {
    const failedWorkspace = randomUUID();
    const sweep = vi.fn(async () => ({ failed: [failedWorkspace], settled: 0 }));
    const { reconcile, emit } = setup({ sweepStuckSetups: sweep });
    const report = await reconcile();
    expect(sweep).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(report.stuckSetups).toEqual([failedWorkspace]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetups: 1 }));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/stuck-setup.test.ts tests/contract/session-reconciler.test.ts`
Expected: FAIL, `stuck-setup.js` does not exist.

- [ ] **Step 4: Write `stuck-setup.ts`**

```ts
// packages/broker/src/aws/stuck-setup.ts
// Spec 025 FR-055, D21, C17: a developer task's setup never stays in PREPARING for good. The start
// writes a watch; each reconciler run fails a watched prepare still live 15 minutes after it
// started, whatever the instance's health, and drops every other old watch.
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

type Client = { send(command: unknown): Promise<unknown> };

export const STUCK_SETUP_MS = 15 * 60_000;
export const STUCK_SETUP_MESSAGE = "setup did not finish within 15 minutes; close this task and start a new one";
export const SETUP_WATCH_PK = "SETUP_WATCH";
const SWEEP_PAGE = 100;

export const setupWatchKey = (createdAt: string, workspaceId: string) => ({ pk: SETUP_WATCH_PK, sk: `${createdAt}#${workspaceId}` });

interface SetupWatch { pk: string; sk: string; workspaceId: string; operationId: string; taskId: string }

export async function sweepStuckSetups(client: Client, tableName: string, now: Date, log: (entry: Record<string, unknown>) => void = () => undefined): Promise<{ failed: string[]; settled: number }> {
  const cutoff = new Date(now.getTime() - STUCK_SETUP_MS).toISOString();
  const response = await client.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "pk = :pk AND sk < :cutoff",
    ExpressionAttributeValues: { ":pk": SETUP_WATCH_PK, ":cutoff": cutoff },
    ConsistentRead: true,
    Limit: SWEEP_PAGE,
  })) as { Items?: SetupWatch[] };
  const failed: string[] = [];
  let settled = 0;
  for (const watch of response.Items ?? []) {
    if (await settle(client, tableName, watch, now.toISOString()) === "failed") {
      failed.push(watch.workspaceId);
      log({ event: "stuck_setup.failed", workspaceId: watch.workspaceId, taskId: watch.taskId, operationId: watch.operationId });
    } else {
      settled += 1;
    }
  }
  return { failed, settled };
}

async function settle(client: Client, tableName: string, watch: SetupWatch, now: string): Promise<"failed" | "settled"> {
  const get = async (sk: string) => ((await client.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${watch.workspaceId}`, sk }, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const [workspace, operation] = await Promise.all([get("META"), get(`OPERATION#${watch.operationId}`)]);
  const live = ["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"].includes(String(operation?.status));
  const drop = { TableName: tableName, Key: { pk: watch.pk, sk: watch.sk } };
  if (workspace?.status !== "PREPARING" || workspace.activeOperationId !== watch.operationId || !live || typeof operation?.fence !== "number") {
    await client.send(new DeleteCommand(drop));
    return "settled";
  }
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: { pk: `WORKSPACE#${watch.workspaceId}`, sk: `OPERATION#${watch.operationId}` },
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #result = :result, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancelRequested) AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED", ":now": now, ":result": null, ":error": STUCK_SETUP_MESSAGE, ":fence": operation.fence,
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING", ":cancelRequested": "CANCEL_REQUESTED",
        },
      } },
      { Update: {
        TableName: tableName, Key: { pk: `WORKSPACE#${watch.workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :released, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":released": "PREPARATION_FAILED", ":now": now, ":operation": watch.operationId, ":fence": operation.fence },
      } },
      // FR-018: pending instructions never linger unqueued.
      { Update: {
        TableName: tableName, Key: { pk: `WORKSPACE#${watch.workspaceId}`, sk: "DEVELOPER_TASK" },
        UpdateExpression: "REMOVE pendingPrompt", ConditionExpression: "attribute_exists(pk)",
      } },
      { Delete: drop },
    ] }));
    return "failed";
  } catch (error) {
    // A result landed first: it stands, and the next run drops the watch.
    if (error instanceof Error && error.name === "TransactionCanceledException") return "settled";
    throw error;
  }
}
```

- [ ] **Step 5: Write the watch at the start, and answer a late result**

In `packages/broker/src/aws/developer-tasks.ts`, import `setupWatchKey` from `./stuck-setup.js` and
add to `startTask`'s `items`, after the pointer's `putNew`:

```ts
    // FR-055, C17: the sweep's watch on this prepare (removed by the sweep, or by its one-day TTL).
    putNew(deps.tableName, {
      ...setupWatchKey(preparation.workspace.createdAt, workspaceId), entityType: "SETUP_WATCH",
      workspaceId, operationId: preparation.operationId, taskId, createdAt: preparation.workspace.createdAt,
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    }),
```

In `packages/broker/src/aws/broker.ts`, import `STUCK_SETUP_MESSAGE` from `./stuck-setup.js` and
add beside `isQueueFailedPrepare`:

```ts
/** C18: a prepare the stuck-setup sweep failed; the worker's late result is answered, not refused. */
const isSweptPrepare = (operation: OperationRecord): boolean =>
  operation.kind === "prepare" && operation.status === "FAILED" && operation.error === STUCK_SETUP_MESSAGE;
```

In `recordTerminalResult`, change the immutability check to
`if (operation.status !== status && !isQueueFailedPrepare(operation, status) && !isSweptPrepare(operation)) throw agentXError("IDEMPOTENCY_CONFLICT", "terminal result is immutable");`
and the conflict path's early return to
`if (existing.status === terminalStatus || isQueueFailedPrepare(existing, terminalStatus) || isSweptPrepare(existing)) return existing;`.

- [ ] **Step 6: Run the sweep from the reconciler**

In `packages/broker/src/aws/session-reconciler.ts`:
- import `sweepStuckSetups` from `./stuck-setup.js`;
- add `stuckSetups: string[];` to `ReconcilerReport` (initialized `[]`), and
  `/** Spec 025 FR-055: fails developer-task prepares 15 minutes old; absent in tests that do not need it. */ sweepStuckSetups?: (now: Date) => Promise<{ failed: string[] }>;`
  to `ReconcilerDependencies`;
- just before `dependencies.emit(...)`:

```ts
    // FR-055, C17: last, so a failure here never stops the EC2 repairs above; a failed run still
    // raises the existing ReconcilerErrors alarm.
    if (dependencies.sweepStuckSetups !== undefined) {
      report.stuckSetups = (await dependencies.sweepStuckSetups(new Date(now))).failed;
      for (const workspaceId of report.stuckSetups) log({ event: "reconciler.stuck_setup_failed", workspaceId });
    }
```

- add `ReconcilerStuckSetups: report.stuckSetups.length,` to the emitted metrics;
- in the module's `handler`, add
  `sweepStuckSetups: (now) => sweepStuckSetups(documentClient, tableName, now, (entry) => console.log(JSON.stringify({ component: "session-reconciler", ...entry }))),`.

The reconciler already has read and write access to the state table
(`props.state.grantReadWriteData(this.reconciler)`), so no grant changes; no alarm is added, so the
legacy template does not change. If any existing reconciler test compares a whole report with
`toEqual`, append `stuckSetups: []` to its expected object.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/stuck-setup.test.ts tests/contract/session-reconciler.test.ts tests/contract/developer-task-start.test.ts tests/contract/developer-task-chain.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/broker/src/aws/stuck-setup.ts packages/broker/src/aws/developer-tasks.ts packages/broker/src/aws/broker.ts packages/broker/src/aws/session-reconciler.ts tests/support/fake-dynamodb.ts tests/contract/stuck-setup.test.ts tests/contract/session-reconciler.test.ts
git commit -m "feat(broker): fail a developer task's setup still running after 15 minutes (spec 025 FR-055)"
```

---

### Task 14: A temporary AWS error while queuing the first instructions is retried

C19: FR-055's second half. Only after Task 13, because the sweep is what makes a retry safe (D21):
without it, a worker whose three tries all fail would leave the task in `STARTING` with its slot
taken.

**Files:**
- Modify: `packages/broker/src/aws/broker-shared.ts` (`isTemporaryAwsError`)
- Modify: `packages/broker/src/aws/broker.ts` (`sendTerminalResult`)
- Modify (deliberate): `tests/contract/developer-task-chain.test.ts` (two tests, Step 1)
- Test: `tests/contract/developer-task-chain.test.ts`, `tests/contract/broker-shared.test.ts` (create if absent)

**Interfaces:**
- Consumes: `sweepStuckSetups`, `STUCK_SETUP_MESSAGE` (Task 13).
- Produces: `isTemporaryAwsError(error: unknown): error is Error` (throttling names, or an HTTP
  status of 500 or more); the result callback answers `503 RUNTIME_UNAVAILABLE` for such an error
  while queuing a developer task's first instructions, and records nothing.

- [ ] **Step 1: Change the two tests that pinned "fail at once" (deliberate, C19)**

In `tests/contract/developer-task-chain.test.ts`:
1. Replace the `it.each([["ThrottlingException", {}], ["InternalServerError", { $metadata: { httpStatusCode: 500 } }]])("records the prepare as FAILED on the first callback even for a retryable %s (final re-review: pinned on purpose)", ...)`
   test, whose own comment says it was pinned only because nothing ended a stuck prepare, with:

```ts
  it.each([
    ["ThrottlingException", {}],
    ["ProvisionedThroughputExceededException", {}],
    ["InternalServerError", { $metadata: { httpStatusCode: 500 } }],
  ])("answers a retryable %s with 503 and records nothing, so the worker's next try queues the first task (FR-055, C19)", async (name, extra) => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const original = db.send;
    let failedReads = 0;
    db.send = async (command) => {
      if (failedReads === 0 && command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("REV#")) {
        failedReads += 1;
        throw Object.assign(new Error("try again later"), { name, ...extra });
      }
      return original(command);
    };
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(finish(task.workspaceId, prepareId, "SUCCEEDED")).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "developer.first_task_queue_retry", operationId: prepareId, error: name }));
    } finally {
      db.send = original;
      logged.mockRestore();
    }
    expect(failedReads).toBe(1);
    // Nothing was recorded: the prepare still runs, and the instructions still wait.
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).not.toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARING", activeOperationId: prepareId });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).toHaveProperty("pendingPrompt");
    // The worker's next try queues the first task.
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(1);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "BUSY" });
  });

  it("leaves a prepare whose every try met a temporary error to the stuck-setup sweep (D21)", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const original = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("REV#")) throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      return original(command);
    };
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await expect(finish(task.workspaceId, prepareId, "SUCCEEDED")).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
    } finally {
      db.send = original;
      logged.mockRestore();
    }
    expect(await sweepStuckSetups(db, "state", new Date(Date.now() + 16 * 60_000))).toMatchObject({ failed: [task.workspaceId] });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    expect(taskOperations()).toHaveLength(0);
  });
```

   (import `STUCK_SETUP_MESSAGE` and `sweepStuckSetups` from
   `../../packages/broker/src/aws/stuck-setup.js`). The pinned behaviour was a stopgap the old test
   named; FR-055 replaces it, and the new tests assert more: the 503, the unchanged records, the
   successful retry, and the sweep's end.
2. In "records the prepare as FAILED when the project's latest revision cannot be read, so close
   frees the slot (final review I1)", the injected error was `ProvisionedThroughputExceededException`,
   which is now temporary and retried. Change it to a non-temporary error with the same meaning,
   `Object.assign(new Error("The table does not exist"), { name: "ResourceNotFoundException" })`,
   and the expected log line's `error` to `"ResourceNotFoundException"`. Every other assertion of
   that test stays: a non-temporary error still records the prepare `FAILED` at once (25b's I1).

- [ ] **Step 2: Write the failing test for the classifier**

```ts
// tests/contract/broker-shared.test.ts (append if the file exists)
import { describe, expect, it } from "vitest";
import { isTemporaryAwsError } from "../../packages/broker/src/aws/broker-shared.js";

describe("isTemporaryAwsError (spec 025 C19)", () => {
  it("names throttling and 5xx answers temporary, and nothing else", () => {
    const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("x"), { name, ...extra });
    for (const name of ["ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "TooManyRequestsException", "InternalServerError", "ServiceUnavailable", "TransactionConflictException"]) {
      expect(isTemporaryAwsError(named(name))).toBe(true);
    }
    expect(isTemporaryAwsError(named("SomethingNew", { $metadata: { httpStatusCode: 503 } }))).toBe(true);
    for (const error of [named("ResourceNotFoundException"), named("ValidationException", { $metadata: { httpStatusCode: 400 } }), named("TransactionCanceledException"), "ThrottlingException", undefined]) {
      expect(isTemporaryAwsError(error)).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/broker-shared.test.ts tests/contract/developer-task-chain.test.ts`
Expected: FAIL, `isTemporaryAwsError` is not exported, and the retryable errors still record `FAILED`.

- [ ] **Step 4: Implement**

In `packages/broker/src/aws/broker-shared.ts`:

```ts
/**
 * Spec 025 C19: an AWS error worth trying again: throttling, or any 5xx. A cancelled transaction is
 * not one of them: its conditions decide what happens next.
 */
const TEMPORARY_AWS_ERRORS = new Set([
  "ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "TooManyRequestsException",
  "InternalServerError", "InternalFailure", "ServiceUnavailable", "ServiceUnavailableException", "TransactionConflictException", "TimeoutError",
]);
export function isTemporaryAwsError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return TEMPORARY_AWS_ERRORS.has(error.name) || (typeof status === "number" && status >= 500);
}
```

In `packages/broker/src/aws/broker.ts`'s `sendTerminalResult`, import `isTemporaryAwsError` from
`./broker-shared.js`, and:
- in the `catch (partsError)`, after `if (isConditional(partsError)) throw partsError;`:

```ts
      if (isTemporaryAwsError(partsError)) {
        // FR-055, C19: the worker tries the result again; if every try fails, the stuck-setup sweep
        // ends the prepare (D21). Nothing is recorded, so the next try can still queue the task.
        console.log(JSON.stringify({ component: "broker", event: "developer.first_task_queue_retry", taskId: pointer.taskId, operationId: operation.id, error: partsError.name }));
        throw agentXError("RUNTIME_UNAVAILABLE", "the task's first instructions could not be queued yet; send the result again");
      }
```

- in the queuing `send(...)`'s `catch (queueError)`, before
  `if (!isConditional(queueError)) throw queueError;`, add the same shape:

```ts
    if (isTemporaryAwsError(queueError)) {
      console.log(JSON.stringify({ component: "broker", event: "developer.first_task_queue_retry", taskId: pointer!.taskId, operationId: operation.id, error: queueError.name }));
      throw agentXError("RUNTIME_UNAVAILABLE", "the task's first instructions could not be queued yet; send the result again");
    }
```

  (a `TransactionConflictException` thrown by a single write is temporary; a
  `TransactionCanceledException` with a `TransactionConflict` reason keeps 25b's `QueuingConflict`
  path, which `isTemporaryAwsError` does not match).

`recordTerminalResult`'s outer `catch` rethrows any non-conditional error, so the `AgentXError`
reaches the handler, which answers its status (503).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/broker-shared.test.ts tests/contract/developer-task-chain.test.ts tests/contract/stuck-setup.test.ts tests/contract/cloud-handlers.test.ts tests/contract/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/broker-shared.ts packages/broker/src/aws/broker.ts tests/contract/broker-shared.test.ts tests/contract/developer-task-chain.test.ts
git commit -m "feat(broker): retry a temporary AWS error while queuing a task's first instructions (spec 025 FR-055)"
```

---

### Task 15: The MCP tools: `agentx_share_task`, the share fields and the next steps

C6, C20, C21: FR-030 (`agentx_share_task`, the share output of `agentx_start_task` and
`agentx_get_task`), FR-049 (`CHANNEL_AMBIGUOUS`), FR-048 (API 1.2). **Depends on Q6** (no link in
the start's answer) and **Q7** (1.2).

**Files:**
- Modify: `packages/mcp/src/client.ts` (`shareTask`)
- Modify: `packages/mcp/src/errors.ts` (`NEXT_STEPS`, `PASSED_THROUGH`)
- Modify: `packages/mcp/src/compatibility.ts:7` (`REQUIRED_SERVER_MINOR`)
- Modify: `packages/mcp/src/tools.ts` (`TaskShape`, `taskOutput`, `taskText`, descriptions, `agentx_share_task`)
- Modify (expected constants and lists): `tests/contract/mcp-tools.test.ts`, `tests/contract/mcp-client.test.ts`, `tests/contract/mcp-stdio.test.ts`, `tests/contract/mcp-developer-flow.test.ts`
- Test: `tests/contract/mcp-share-tool.test.ts`

**Interfaces:**
- Consumes: `ShareDeveloperTaskRequest`, `DeveloperTaskShare`, `ChannelTurn`, `SHARED_BY_POLICY`,
  `VIEW_ONLY_BY_POLICY` (Task 1); the share route (Task 4).
- Produces:
  - `ControlPlaneClient.shareTask(taskId: string, request: ShareDeveloperTaskRequest): Promise<DeveloperTaskView>`
  - tool `agentx_share_task` (inputs `task_id`, `share_mode?`, `channel?`, `request_id?`; output the task shape);
  - task output fields `share_mode` (`view`, `continue` or null), `share_reason?`, `share_mode_reason?`,
    `channel?: { id, name? }`, `thread_url?`, `share_posting?`, `share_post_failed?`,
    `channel_turns?: Array<{ author, slack_user, at, request, outcome }>`;
  - `REQUIRED_SERVER_MINOR = 2`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/mcp-share-tool.test.ts
// Spec 025 FR-030, FR-049, C21: sharing through the MCP tools, against a fake control plane.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import { NEXT_STEPS, createAgentXMcpServer, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const TASK = "44444444-4444-4444-8444-444444444444";
const view = (extra: Partial<DeveloperTaskView> = {}): DeveloperTaskView => ({
  taskId: TASK, title: "Fix the flaky retry test", project: "payments", status: "RUNNING", startingRevision: 7, client: "Claude Code", shared: false,
  createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:00.000Z", events: [], ...extra,
});

async function connect(client: Partial<ControlPlaneClient>) {
  const context = (name: string | undefined): ToolContext => ({
    client: client as ControlPlaneClient, clientName: name, serverVersion: "0.5.0", adminSignedIn: async () => false,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined,
    newRequestId: () => "33333333-3333-4333-8333-333333333333",
  });
  const server = createAgentXMcpServer({ version: "0.5.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  await mcp.listTools();
  return mcp;
}
const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0]?.text ?? "";

describe("share fields in task results (FR-030, C21)", () => {
  it("says a start was shared because the project requires it, view only because continue is not allowed", async () => {
    const shared = view({ shared: true, share: { mode: "view", channelId: "C0123456789", channelName: "payments-dev", sharedReason: "required", modeReason: "continue_not_allowed" } });
    const mcp = await connect({ startTask: vi.fn(async () => shared) });
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix it", share_mode: "continue" } });
    expect(result.structuredContent).toMatchObject({
      shared: true, share_mode: "view", share_reason: "required by project", share_mode_reason: "continue not allowed by project",
      channel: { id: "C0123456789", name: "payments-dev" }, share_posting: true,
    });
    expect(result.structuredContent).not.toHaveProperty("thread_url");
    expect(text(result)).toContain("#payments-dev");
    expect(text(result)).toContain("agentx_get_task");
  });

  it("gives the thread link once it is posted, and the channel's turns", async () => {
    const mcp = await connect({ getTask: vi.fn(async () => view({
      shared: true,
      share: { mode: "continue", channelId: "C0123456789", sharedReason: "requested", threadUrl: "https://slack.com/archives/C0123456789/p1695500000000100" },
      channelTurns: [{ author: { slackUserId: "U0PRIYA001", name: "Priya" }, at: "2026-09-29T10:05:00.000Z", request: "run the linter", outcome: "answered" }],
    })) });
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({
      share_mode: "continue", thread_url: "https://slack.com/archives/C0123456789/p1695500000000100",
      channel_turns: [{ author: "Priya", slack_user: "U0PRIYA001", at: "2026-09-29T10:05:00.000Z", request: "run the linter", outcome: "answered" }],
    });
    expect(result.structuredContent).not.toHaveProperty("share_reason");
  });

  it("keeps share_mode null for a private task", async () => {
    const mcp = await connect({ getTask: vi.fn(async () => view()) });
    expect((await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } })).structuredContent).toMatchObject({ shared: false, share_mode: null });
  });
});

describe("agentx_share_task (FR-030)", () => {
  it("shares a task, or changes its mode, with a remembered request ID", async () => {
    const shareTask = vi.fn(async () => view({ shared: true, share: { mode: "continue", channelId: "C0123456789", sharedReason: "requested" } }));
    const mcp = await connect({ shareTask });
    const result = await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "continue", channel: "#payments-dev" } });
    expect(shareTask).toHaveBeenCalledWith(TASK, { requestId: "33333333-3333-4333-8333-333333333333", shareMode: "continue", channel: "#payments-dev" });
    expect(result.structuredContent).toMatchObject({ task_id: TASK, shared: true, share_mode: "continue", request_id: "33333333-3333-4333-8333-333333333333" });
    expect(text(result)).toContain("open to the channel");
  });

  it("passes CHANNEL_AMBIGUOUS through with the channels named and a next step that fits", async () => {
    const { ToolError } = await import("../../packages/mcp/src/index.js");
    const mcp = await connect({ shareTask: vi.fn(async () => { throw new ToolError("CHANNEL_AMBIGUOUS", "project `payments` has several Slack channels: #payments-dev, #payments-ops"); }) });
    const error = toolError(await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK } }));
    expect(error).toMatchObject({ code: "CHANNEL_AMBIGUOUS", nextStep: NEXT_STEPS.CHANNEL_AMBIGUOUS });
    expect(error.message).toContain("#payments-ops");
  });
});
```

(Check `toolError`'s return shape in `tests/support/mcp-tool-error.ts` and match its field names.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-share-tool.test.ts`
Expected: FAIL, no `share_reason`, and no `agentx_share_task`.

- [ ] **Step 3: Implement**

In `packages/mcp/src/errors.ts`:

```ts
  CHANNEL_REQUIRED: "ask an AgentX admin to bind a Slack channel to the project; if the project does not require sharing, start the task without share_to_channel",
  CHANNEL_AMBIGUOUS: "send channel with one of the channels the message names",
```

and add `"CHANNEL_AMBIGUOUS"` to `PASSED_THROUGH` (its comment becomes "exactly these nine").

In `packages/mcp/src/compatibility.ts:7`: `export const REQUIRED_SERVER_MINOR = 2;` with the comment
"Spec 025 C20: the share route arrived in API 1.2."

In `packages/mcp/src/client.ts`, import `type ShareDeveloperTaskRequest`, add to `ControlPlaneClient`
`shareTask(taskId: string, request: ShareDeveloperTaskRequest): Promise<DeveloperTaskView>;` and to
the returned object
`shareTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/share"), request)),`.

In `packages/mcp/src/tools.ts` (import `SHARED_BY_POLICY`, `VIEW_ONLY_BY_POLICY` from `@agentx/contracts`):
- in `TaskShape`, after `share_mode: z.string().nullable(),` add:

```ts
  share_reason: z.string().optional(), share_mode_reason: z.string().optional(),
  channel: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  thread_url: z.string().optional(), share_posting: z.boolean().optional(), share_post_failed: z.boolean().optional(),
  channel_turns: z.array(z.object({ author: z.string(), slack_user: z.string(), at: z.string(), request: z.string(), outcome: z.string() })).optional(),
```

- in `taskOutput`, replace `shared: task.shared, share_mode: null,` (and its comment) with:

```ts
    shared: task.shared, share_mode: task.share?.mode ?? null,
    ...(task.share === undefined ? {} : {
      ...(task.share.sharedReason === "required" ? { share_reason: SHARED_BY_POLICY } : {}),
      ...(task.share.modeReason === "continue_not_allowed" ? { share_mode_reason: VIEW_ONLY_BY_POLICY } : {}),
      channel: { id: task.share.channelId, ...(task.share.channelName === undefined ? {} : { name: task.share.channelName }) },
      ...(task.share.threadUrl !== undefined ? { thread_url: task.share.threadUrl } : task.share.postFailed === true ? { share_post_failed: true } : { share_posting: true }),
    }),
    ...(task.channelTurns === undefined ? {} : {
      channel_turns: task.channelTurns.map((turn) => ({ author: turn.author.name ?? turn.author.slackUserId, slack_user: turn.author.slackUserId, at: turn.at, request: turn.request, outcome: turn.outcome })),
    }),
```

  (the order keeps `starting_revision` and `client` where they were; only `share_mode`'s value and
  the new optional fields change);
- add, and call from `taskText` after the failure and wait sentences:

```ts
/** C6, C21: where the task is shared, and why the policy changed what was asked. */
function shareText(task: DeveloperTaskView): string {
  const share = task.share;
  if (share === undefined) return "";
  const where = share.channelName === undefined ? `channel ${share.channelId}` : `#${share.channelName}`;
  const mode = share.mode === "view" ? "view only" : "open to the channel";
  const why = [
    ...(share.sharedReason === "required" ? [`shared because it is ${SHARED_BY_POLICY}`] : []),
    ...(share.modeReason === "continue_not_allowed" ? [`view only because ${VIEW_ONLY_BY_POLICY}`] : []),
  ];
  const thread = share.threadUrl !== undefined
    ? ` Thread: ${share.threadUrl}.`
    : share.postFailed === true ? " AgentX could not post the thread in Slack." : " The Slack thread link appears in agentx_get_task within a few seconds.";
  return ` Shared in ${where}, ${mode}${why.length === 0 ? "" : ` (${why.join("; ")})`}.${thread}`;
}
```

- change the descriptions:
  - `agentx_list_projects`: replace the sentence "A project with tasks_enabled false, or with
    share_policy required, cannot take tasks from an AI tool yet; use its Slack channel instead."
    with "A project with tasks_enabled false cannot take tasks from an AI tool; use its Slack channel
    instead. With share_policy required, every task is shared to the project's channel.";
  - `agentx_start_task`: replace "The task is private to you." with "The task is private to you
    unless you share it, or the project requires sharing." and the three share inputs' descriptions
    with: `share_to_channel` "post the task in the project's Slack channel, where AgentX replies as
    it runs; false by default"; `share_mode` "view (the channel watches) or continue (channel members
    may mention AgentX in the thread to steer the task); the project's default when left out, and
    view when the project does not allow continue"; `channel` "which bound channel to share in, by
    name or ID; needed only when the project has several";
  - `agentx_get_task`: append "For a shared task it shows the channel, the mode, the thread link
    once posted, and in continue mode the channel's turns.";
- add the tool, after `agentx_close_task`:

```ts
  {
    name: "agentx_share_task",
    title: "Share an AgentX task to its Slack channel",
    description:
      `Shares one of your tasks to its project's Slack channel, or changes how a shared task is shared. view lets the channel watch while you drive the task from here; continue also lets channel members mention AgentX in the thread to steer it, one request at a time. On a shared task it changes the mode, within the project's policy; the channel cannot change. Answers at once: AgentX posts the thread within seconds, and agentx_get_task then shows its link. Switching to view makes channel messages that are still waiting get a notice instead of running. ${RETRY}.`,
    inputSchema: {
      task_id: taskIdInput,
      share_mode: z.enum(["view", "continue"]).optional().describe("view or continue; for a new share, the project's default when left out"),
      channel: z.string().max(80).optional().describe("which bound channel, by name or ID; needed only when the project has several"),
      request_id: requestIdInput,
    },
    outputSchema: ActionShape,
    async handler(context, input, call) {
      const taskId = input.task_id as string;
      const id = requestIdFor(context, call, input, ["agentx_share_task", taskId, optional(input.share_mode), optional(input.channel)]);
      const task = await context.client.shareTask(taskId, {
        requestId: id,
        ...(input.share_mode === undefined ? {} : { shareMode: input.share_mode as "view" | "continue" }),
        ...(input.channel === undefined ? {} : { channel: input.channel as string }),
      });
      return { structured: { ...taskOutput(task), request_id: id }, text: taskText(task) };
    },
  },
```

- [ ] **Step 4: Move the expected constants and lists (additive, SC-008)**
  - `tests/contract/mcp-tools.test.ts`: append `"agentx_share_task"` after `"agentx_close_task"` in
    the tool list test's expected names (the module's order); `expect(REQUIRED_SERVER_MINOR).toBe(1)`
    becomes `toBe(2)`; in "works with 1.1 and gives a notice for a newer minor", rename it to "works
    with 1.2 ...", change `configured("1.1")` and its expected `apiVersion` to `"1.2"`, and add
    `await expect(compatibilityChecker(configured("1.1") as unknown as ControlPlaneClient)()).rejects.toMatchObject({ code: "UPGRADE_REQUIRED", nextStep: UPGRADE_AGENTX_STEP });`
    (a 25b control plane has no share route: C20); in "asks AgentX again only after 10 minutes",
    `configured("1.1")` becomes `configured("1.2")`; the fake `compatibility` in `connect` returns
    `"1.2"`.
  - `tests/contract/mcp-client.test.ts`: append `["CHANNEL_AMBIGUOUS", 409, "CHANNEL_AMBIGUOUS"],`
    after the `CHANNEL_REQUIRED` row; replace the test "gives CHANNEL_REQUIRED a next step that fits a
    project which requires sharing as well as a start that asked to share" with:

```ts
  it("gives CHANNEL_REQUIRED and CHANNEL_AMBIGUOUS next steps that fit what is left once sharing exists (C21)", () => {
    expect(NEXT_STEPS.CHANNEL_REQUIRED).toBe("ask an AgentX admin to bind a Slack channel to the project; if the project does not require sharing, start the task without share_to_channel");
    expect(NEXT_STEPS.CHANNEL_AMBIGUOUS).toBe("send channel with one of the channels the message names");
  });
```

    It still pins the exact words; the words change because the case they describe changed (25b's
    "use the project's Slack channel" fitted "sharing is not available yet", which no longer happens).
  - `tests/contract/mcp-stdio.test.ts`: the fake configuration's `apiVersion: "1.1"` becomes `"1.2"`,
    `toHaveLength(10)` becomes `toHaveLength(11)`, and `control_plane_api_version: "1.1"` becomes `"1.2"`.
  - `tests/contract/mcp-developer-flow.test.ts`: `apiVersion: "1.1"` becomes `"1.2"` and
    `toHaveLength(10)` becomes `toHaveLength(11)` (Task 16 moves this helper to support).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/mcp-share-tool.test.ts tests/contract/mcp-tools.test.ts tests/contract/mcp-client.test.ts tests/contract/mcp-stdio.test.ts tests/contract/mcp-developer-flow.test.ts tests/contract/mcp-wait.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src tests/contract/mcp-share-tool.test.ts tests/contract/mcp-tools.test.ts tests/contract/mcp-client.test.ts tests/contract/mcp-stdio.test.ts tests/contract/mcp-developer-flow.test.ts
git commit -m "feat(mcp): agentx_share_task and the share fields (spec 025 FR-030, FR-049)"
```

---

### Task 16: Sharing end to end, and SC-012's burst

US3's independent test and SC-012: the MCP server, the broker, the notifier and the Slack service's
processor together, with fake Slack, fake worker and the fake table. No new production code; a
defect this finds is fixed with a failing test in the task that owns the code.

**Files:**
- Create: `tests/support/mcp-broker-client.ts` (moved from `tests/contract/mcp-developer-flow.test.ts`)
- Modify: `tests/contract/mcp-developer-flow.test.ts` (imports the moved helpers; no assertion changes)
- Test: `tests/contract/shared-task-flow.test.ts`

**Interfaces:**
- Consumes: everything above; `createThreadApi`, `createSignedServiceFetch` (slack-service),
  `brokerFetch` (`tests/support/broker-fetch.ts`), `turnRecordKeys` (contracts).
- Produces: `signedInClient(harness, who)` and `brokerFetch`-for-MCP (`mcpBrokerFetch(harness)`)
  exported from `tests/support/mcp-broker-client.ts`, with the same behaviour they had inline.

- [ ] **Step 1: Move the MCP client helpers to support**

Move `brokerFetch` (rename it `mcpBrokerFetch`, since `tests/support/broker-fetch.ts` already
exports a `brokerFetch` for Slack service calls), `ToolAnswer`, `signedInClient`, `URL_BASE` and
`REFRESH_TOKEN` from `tests/contract/mcp-developer-flow.test.ts` to
`tests/support/mcp-broker-client.ts`, unchanged except the export keywords and the name, and import
them back in `mcp-developer-flow.test.ts`. Run
`npx vitest run tests/contract/mcp-developer-flow.test.ts`: PASS, with the same number of tests.

- [ ] **Step 2: Write the test**

```ts
// tests/contract/shared-task-flow.test.ts
// Spec 025 US3 and SC-012: a shared task through the MCP tools, the notifier and the Slack
// service's processor, against the broker in process.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VIEW_ONLY_NOTICE, parseSlackThreadSubject, turnRecordKeys, type SlackRequestMessage, type TurnRecord } from "../../packages/contracts/src/index.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import { MAYA, createDeveloperTaskBroker, recordStream, registerPolicy, teammate } from "../support/developer-task-broker.js";
import { signedInClient } from "../support/mcp-broker-client.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

/** The notifier over the harness's table, with Slack faked; pump() delivers everything pending. */
function notifier(harness: Harness) {
  const stream = recordStream(harness.db);
  const posts: Array<{ channel: string; threadTs?: string; text: string }> = [];
  const queue: Notice[] = [];
  let ts = 1_695_500_000_000_100;
  const handle = createNotifierHandler({
    documentClient: harness.db, tableName: "state",
    enqueue: async (notices) => { queue.push(...notices); },
    retryLater: async () => undefined,
    post: async (input) => { posts.push(input); ts += 1; const text = String(ts); return { ts: `${text.slice(0, 10)}.${text.slice(10)}` }; },
    now: Date.now, log: () => undefined, deliveryFailed: () => undefined,
  });
  const pump = async () => {
    for (let round = 0; round < 3; round += 1) {
      await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
      const batch = queue.splice(0, queue.length);
      await handle({ Records: batch.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } })) });
    }
  };
  return { posts, pump };
}

/** The Slack service's processor for one shared thread, on the real thread client against the broker. */
function slackService(harness: Harness, subject: string, runTurn: ProcessorDependencies["runTurn"]) {
  const posts: string[] = [];
  const records: TurnRecord[] = [];
  const dependencies = (userId: string): ProcessorDependencies => ({
    api: () => createThreadApi({
      controlPlaneUrl: "https://agentx.example.test", pollIntervalMilliseconds: 1,
      signedFetch: createSignedServiceFetch({ region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" }, thread: parseSlackThreadSubject(subject), userId, baseFetch: brokerFetch(harness.handler) }),
    }),
    threads: {
      load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined,
      close: async () => undefined, finish: async () => undefined, claimSharedNotice: async () => true,
    },
    runTurn,
    post: async (_thread, text) => { posts.push(text); },
    userName: async (id) => ({ U0PRIYA001: "Priya", U0LEO00001: "Leo", U0SAM00001: "Sam" } as Record<string, string>)[id],
    turnRecords: { write: async (record) => { records.push(record); harness.db.set({ ...turnRecordKeys(record), ...record }); return "written"; } },
  });
  let sequence = 0;
  const mention = (userId: string, text: string): SlackRequestMessage => {
    sequence += 1;
    return { version: 1, eventId: `Ev${String(sequence).padStart(10, "0")}`, thread: parseSlackThreadSubject(subject), userId, text, receivedAt: new Date(Date.now() + sequence).toISOString() };
  };
  const handle = (message: SlackRequestMessage, queuedBehind = 0) => processSlackRequest(message, dependencies(message.userId), { finalAttempt: true, queuedBehind });
  return { posts, records, mention, handle };
}

describe("a shared task through its life (US3)", () => {
  it("shares in continue mode, steers from the thread, switches to view only and closes", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool, expectNoTokenLeaked } = await signedInClient(harness, MAYA);

    // US3 scenario 1: the start message within the start, then a reply at each change.
    const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix the flaky retry test", share_to_channel: true, share_mode: "continue" });
    expect(started.value).toMatchObject({ shared: true, share_mode: "continue", share_posting: true });
    const taskId = String(started.value.task_id);
    await slack.pump();
    expect(slack.posts[0]!.text).toContain("started a task from Claude Code");
    const read = await tool("agentx_get_task", { task_id: taskId });
    const threadUrl = String(read.value.thread_url);
    expect(threadUrl).toMatch(/^https:\/\/slack\.com\/archives\//);

    const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
    const active = () => (harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string | null }).activeOperationId;
    await harness.finish(workspaceId, String(active()), "SUCCEEDED");
    const first = String(active());
    await harness.events(workspaceId, first, [say("Fixed the retry test.")]);
    await harness.finish(workspaceId, first, "SUCCEEDED");
    await slack.pump();
    expect(slack.posts.slice(1).map((post) => post.text.split("\n")[0])).toEqual(["The workspace is ready, and the task is running.", "The task ended SUCCEEDED."]);

    // US3 scenario 5: a teammate steers the task from the thread, as themselves.
    const share = (harness.db.get(`DEVTASK#${taskId}`, "META") as { share: { threadTs: string; teamId: string; channelId: string } }).share;
    const subject = `${share.teamId}/${share.channelId}/${share.threadTs}`;
    const service = slackService(harness, subject, async (input) => {
      const accepted = await teammate(harness.handler, subject, input.message.userId, "POST", `/v1/service/workspaces/${input.workspaceId}/tasks`, { requestId: randomUUID(), conversationId: input.conversationId, prompt: input.message.text }, "Priya");
      await harness.finish(input.workspaceId, String((accepted.body.operation as { id: string }).id), "SUCCEEDED");
      return "Ran the linter.";
    });
    await service.handle(service.mention("U0PRIYA001", "also run the linter"));
    expect(service.posts.at(-1)).toBe("<@U0PRIYA001> Ran the linter.");
    // The notifier does not post a teammate's operation: the Slack service already replied.
    await slack.pump();
    expect(slack.posts).toHaveLength(3);

    // US3 scenario 7: the developer sees the channel's turn, and can still switch to view only.
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ channel_turns: [{ author: "Priya", slack_user: "U0PRIYA001", request: "also run the linter", outcome: "answered" }] });
    expect((await tool("agentx_share_task", { task_id: taskId, share_mode: "view" })).value).toMatchObject({ share_mode: "view" });
    await slack.pump();
    expect(slack.posts.at(-1)!.text).toBe("This thread is now view only: follow-ups happen in the developer's AI tool.");
    await service.handle(service.mention("U0LEO00001", "one more thing"));
    expect(service.posts.at(-1)).toBe(VIEW_ONLY_NOTICE);

    // FR-032: the close ends the thread.
    await tool("agentx_close_task", { task_id: taskId });
    await harness.finish(workspaceId, String(active()), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    await slack.pump();
    expect(slack.posts.at(-1)!.text).toContain("This thread no longer drives it.");
    expectNoTokenLeaked();
  });

  it("shares ledger's tasks view only, whatever the developer asks, and says why (US3 scenarios 2 and 8)", async () => {
    const harness = await createDeveloperTaskBroker();
    await registerPolicy(harness.handler, 2, { share: "required", shareMode: { default: "view", allowContinue: false } });
    const { tool } = await signedInClient(harness, MAYA);
    const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix it", share_to_channel: false, share_mode: "continue" });
    expect(started.value).toMatchObject({ shared: true, share_mode: "view", share_reason: "required by project", share_mode_reason: "continue not allowed by project" });
  });

  it("shares a private task later with its current status (US3 scenario 9)", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const taskId = String((await tool("agentx_start_task", { project: "payments", instructions: "Fix it" })).value.task_id);
    await slack.pump();
    expect(slack.posts).toEqual([]);
    await tool("agentx_share_task", { task_id: taskId });
    await slack.pump();
    expect(slack.posts[0]!.text).toContain("Status: STARTING");
  });
});

describe("SC-012: 20 mentions from 3 teammates in a burst", () => {
  it("runs them one at a time, in delivery order, each attributed to its author", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const taskId = String((await tool("agentx_start_task", { project: "payments", instructions: "Fix it", share_to_channel: true, share_mode: "continue" })).value.task_id);
    await slack.pump();
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; share: { threadTs: string; teamId: string; channelId: string } };
    const workspaceId = task.workspaceId;
    const active = () => (harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string | null }).activeOperationId;
    await harness.finish(workspaceId, String(active()), "SUCCEEDED");
    // The developer's own first run is still going when the burst arrives (Review Focus 1).
    const developerRun = String(active());
    setTimeout(() => { void harness.finish(workspaceId, developerRun, "SUCCEEDED"); }, 20);

    const subject = `${task.share.teamId}/${task.share.channelId}/${task.share.threadTs}`;
    const started: string[] = [];
    const overlaps: string[] = [];
    const service = slackService(harness, subject, async (input) => {
      if (active() !== null) overlaps.push(input.message.eventId);
      started.push(input.message.eventId);
      const accepted = await teammate(harness.handler, subject, input.message.userId, "POST", `/v1/service/workspaces/${input.workspaceId}/tasks`, { requestId: randomUUID(), conversationId: input.conversationId, prompt: input.message.text });
      const operationId = String((accepted.body.operation as { id: string }).id);
      // The worker ends the operation after the turn has answered; the next turn must wait for it.
      setTimeout(() => { void harness.finish(input.workspaceId, operationId, "SUCCEEDED"); }, 5);
      return `ok ${input.message.eventId}`;
    });
    const authors = ["U0PRIYA001", "U0LEO00001", "U0SAM00001"];
    const burst = Array.from({ length: 20 }, (_, index) => service.mention(authors[index % 3]!, `request ${index}`));
    // The FIFO queue delivers a thread's messages one at a time, in order (processGroup).
    for (const [index, message] of burst.entries()) await service.handle(message, index);

    expect(overlaps).toEqual([]);
    expect(started).toEqual(burst.map((message) => message.eventId));
    expect(service.records.map((record) => [record.eventId, record.requestedBy.userId, record.taskId, record.disposition])).toEqual(burst.map((message) => [message.eventId, message.userId, taskId, "answered"]));
    const channelOperations = harness.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("CHANNEL_OPERATION#"));
    expect(channelOperations.map((item) => item.slackUserId).sort()).toEqual(burst.map((message) => message.userId).sort());
  });
});
```

(The notifier is created before the start in every test, so its stream recorder sees the task's
first write. The close's safe preflight result, `{ safeToClose: true, repositories: [] }`, is the
one `developer-task-close.test.ts` uses.)

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/contract/shared-task-flow.test.ts tests/contract/mcp-developer-flow.test.ts`
Expected: PASS. If a step fails, find the owning task's code, write the failing test there, fix
it, and rerun both files.

- [ ] **Step 4: Run the whole gate**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: PASS (rerun a known load flake from issue #59 alone). Confirm no em dash was added to any
user-facing text: `git diff mainline --unified=0 -- packages infra | grep "^+" | grep -c "$(printf '\342\200\224')"`
prints 0.

- [ ] **Step 5: Commit**

```bash
git add tests/support/mcp-broker-client.ts tests/contract/mcp-developer-flow.test.ts tests/contract/shared-task-flow.test.ts
git commit -m "test(spec-025): a shared task end to end, and SC-012's burst of channel turns"
```

---

### Task 17: Record the rulings and the owner's answers in the spec

This task changes no code. It writes this plan's rulings, and the owner's answers to
[phase-25c-questions.md](phase-25c-questions.md) as given (not as recommended, where the owner
chose otherwise), into the spec, so the spec and the code agree. If an answer differs from the
recommendation this plan followed, stop: the owning task changes first (with its test), then this
task records it.

**Files:**
- Modify: `specs/025-mcp-server/spec.md`
- Modify: `specs/025-mcp-server/plans/README.md`

- [ ] **Step 1: Amend the spec**
  - FR-030: `agentx_share_task`'s output says "the task, with the thread link once AgentX has posted
    it (`agentx_get_task` shows it within seconds)" (Q6); add "Only the developer who owns a task
    may share it or change its mode" (Q2).
  - FR-032: add the setup-failure reply (C8).
  - FR-034: "The notifier is triggered by the control plane's state table stream, filtered to task,
    pointer and developer-operation changes, and posts from its own queue; it is the stream's second
    and last reader" (C7).
  - FR-035: the fixed notice's words (Q1), and "a closed task's thread gets a closed notice, at most
    once an hour, and runs nothing" (Q3, C24).
  - FR-037: add "and a share or mode change (action `share`)" to the actions that write an
    `accepted` record (Q9); add "a close's outcome gets its `completed` record in phase 25e" (C22).
  - FR-048 and SC-008: `DEVELOPER_API_VERSION` moves to `1.2` in phase 25c (Q7).
  - FR-054: "A teammate's `stop` in a continue thread cancels the running task operation, whoever
    started it; `close this workspace` in a shared thread is refused" (Q8, C11).
  - FR-055: "Only developer-task prepares are watched; the sweep runs in the session reconciler,
    every 10 minutes, so a stuck setup is failed between 15 and 25 minutes after it started" (Q4,
    C17).
  - Decisions: add **D23** (C7: the stream-triggered notifier with its own queue, and why not a send
    from the broker), **D24** (C1: share state on the task, replaced whole under `shareVersion`), and
    **D25** (C11: the broker resolves a continue thread to the task's owner key; view, closed and
    rebound threads answer `VIEW_ONLY`), each one paragraph, marked with the owner's decision date.
- [ ] **Step 2: Update the phase README.** The 25b row says "Merged as PR #149." at the start of
  "What it delivers"; the 25c row says "Built, see PR #<n>." and its known follow-up from 25b is
  marked done.
- [ ] **Step 3: Check the copy** with `grep -c "$(printf '\342\200\224')" specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md` (prints 0 for each), then commit:

```bash
git add specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md
git commit -m "docs(spec-025): record the phase 25c rulings and the owner's answers"
```

---

### Task 18: Live check in a throwaway environment (owner present)

This task changes no code unless it finds a defect. A defect is fixed with a failing test first, in
the task that owns the code, then reviewed. It tests the real flow: Claude Code, `agentx mcp`, a
shared task, the notifier's posts, a teammate in the thread, and the stuck-setup sweep. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for account 944937319445 (`aws login --profile agentx-admin`, driven from
  this session, the owner's preference; or CloudShell), because the access stack creates IAM roles;
- **no other throwaway environment in the account**: only one fits at a time because of the Elastic
  IP quota. Confirm `live25b` (and any other `live*`) is torn down before Step 3;
- a Slack workspace with two test users (the developer, and a teammate who is in the bound
  channel), a GitHub organization or account, and a test repository the owner names. Never
  production's Slack app, GitHub App, stacks, secrets or `/agentx/production/*`;
- Claude Code on the owner's machine.

It uses a new environment, `live25c`, in `us-east-1`.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release and pack the CLI from this branch:
    `npm run release:build -- --version 0.0.5 --out <scratch>/rel` and
    `npm run release:pack-cli -- --version 0.0.5 --out <scratch>/cli`.
  - Read production's image digests, read-only, exactly as 25b's live check did.
  - Confirm `aws ssm get-parameters-by-path --path /agentx/live25c --recursive --region us-east-1`
    returns nothing, that no `agentx-live*` stack exists, and that no EC2 instance, volume or Elastic
    IP is tagged for a `live*` environment.
- [ ] **Step 2: Owner approval.** Tell the owner:
  - what it creates: the environment's stacks (now with the notifier function, its two queues and
    two event source mappings), a GitHub App and a Slack app in their test organization and
    workspace, a KMS RSA key, the sign-in table, and EC2 worker instances and volumes while tasks
    run;
  - the cost while it exists: about $3 a day for the stacks, the KMS key prorated, the EC2 time of
    each task, and one setup deliberately left running for up to 25 minutes (Step 9);
  - that everything is torn down in Step 12.
- [ ] **Step 3: Install.** `node packages/cli/dist/main.js --env live25c init --region us-east-1 --release <scratch>/rel --worker-image <worker digest ref> --slack-image <slack digest ref>`,
  taking Slack at the `developer-signin` step. As admin, register a test project on the owner's test
  repository with an `ec2-ebs` binding and no `developerTasks` (the defaults: optional sharing, view
  by default, continue allowed), and bind a test channel. Invite the AgentX bot to the channel. Both
  Slack test users join it.
- [ ] **Step 4: Developer sign-in and Claude Code**, as 25b's Step 4: `login <ApiEndpoint>`,
  `claude mcp add --scope user agentx-live25c -- node <scratch>/cli/package/bin/agentx.mjs mcp`, and
  `/mcp` lists eleven tools, including `agentx_share_task`. `agentx_whoami` shows API 1.2.
- [ ] **Step 5: View only (US3 scenarios 1 and 4, SC-006).** In Claude Code: "have AgentX add a line
  to the README of <project>, and share it to the channel". Time from the tool's answer to the start
  message in Slack: under 10 seconds (SC-006). The start message names the developer (a mention), Claude
  Code, the title, the project, the status and "View only". `agentx_get_task` shows `thread_url`.
  The thread gets "The workspace is ready", then "The task ended SUCCEEDED" with the summary, within
  60 seconds of the task's end (SC-006). As the teammate, mention AgentX in the thread: the fixed
  notice appears once; a second mention in the same hour gets nothing; no new workspace appears
  (`agentx admin` workspace list, or the state table).
- [ ] **Step 6: Continue (US3 scenarios 5, 6 and 7, D4).** "share it in continue mode" for a new
  task. As the teammate, mention AgentX in the thread with a small request: the reply starts with the
  teammate's mention; `agentx admin turns export --since <step start>` shows the Slack turn record
  with `taskId`; the operation's requester is the teammate. While a teammate's request runs, ask
  Claude Code to continue the task: `TASK_BUSY` names the teammate. Post two mentions quickly as two
  users: they run one after the other (the second says it is waiting). `agentx_get_task` lists the
  channel turns. Then "make the thread view only": the thread says so, and the next mention gets the
  notice.
- [ ] **Step 7: Required sharing and view only (US3 scenarios 2 and 8).** Register a revision with
  `developerTasks: { share: "required", shareMode: { default: "view", allowContinue: false } }`. Ask
  Claude Code to start a private task in continue mode: the result says shared, view only, with
  "required by project" and "continue not allowed by project". Bind a second channel and start
  again without naming one: `CHANNEL_AMBIGUOUS` naming both. Unbind it.
- [ ] **Step 8: Close and the limit reply.** Close the tasks: each thread gets the closed reply; a
  mention in a closed thread gets the closed notice. Then start three private tasks as the developer
  (limit 3) and mention AgentX in a new Slack thread as the developer's own Slack user: the reply
  says the AI-tool tasks fill the limit and how to close one (C16). Close them.
- [ ] **Step 9: The stuck-setup sweep (FR-055).** Register a revision whose setup runs longer than
  25 minutes (a setup step such as `sleep 1800`; check the setup step's shape in the project schema
  first) and start a task. After 15 to 25 minutes, `agentx_get_task` shows `FAILED`,
  `setup_failed`, "setup did not finish within 15 minutes; close this task and start a new one",
  and the reconciler's log has `reconciler.stuck_setup_failed`. When the worker finally reports
  (after the sleep), the broker log shows the result answered, with no `IDEMPOTENCY_CONFLICT`. Close
  the task: the slot is free again. Register a revision without the sleep afterwards.
- [ ] **Step 10: Slack delivery (C9), optional, with the owner's consent to wait.** Remove the bot
  from the channel and share a task: the notifier's log shows `developer_notifier.retry` with
  `not_in_channel` and growing delays; the task runs normally. If the owner is willing to wait an
  hour, the `SlackDeliveryFailed` alarm fires and `agentx_get_task` shows `share_post_failed`.
  Otherwise record that this rests on the contract tests. Invite the bot back.
- [ ] **Step 11: No secret leaked (SC-004).** Plant `ghp_` followed by 36 letters in a task's
  instructions' last line and ask the worker to echo it in its summary; the Slack thread shows
  `[REDACTED]`. `aws logs filter-log-events` over the broker, notifier, ingress and DeveloperIdentity
  log groups for `agxr_`, `xoxb-`, `Bearer ` and the planted token: no events. Local files as 25b's
  Step 11.
- [ ] **Step 12: Tear down**, exactly as 25b's Step 12 for `live25c` (the MCP entry, the local
  sign-in, every tagged instance and volume, the stacks and what they retain, the secrets and
  parameters, the test PRs, the GitHub App and the Slack app), then confirm no `agentx-live25c-*`
  stack, no `/agentx/live25c` parameter and no `live25c` instance, volume or Elastic IP remains, so
  the next phase's live check has room.
- [ ] **Step 13: Record the evidence** in the PR description: the commands, outcomes and timings
  (SC-006's two times), the sweep's time to fail, each defect fixed, and any finding that changes a
  ruling above. Raise those with the owner before merge.

## Not in this phase

- **Phase 25d:** the admin read routes and tools; `agentx_admin_turns`'s `task_id` filter (which
  would also list a task's channel turns).
- **Phase 25e:** pending changes and confirmations, including the Slack Confirm button DM, which
  reuses this phase's notifier through its stream mapping (C7: a filter, never a third stream
  reader); a `completed` audit record for a close's outcome (C22).
- **Later, by owner decision:** the hosted MCP endpoint; developer sign-in and sharing on the legacy
  production deployment; a sweep for Slack thread prepares (Q4's other option).

## Self-review

- **Spec coverage.** FR-031: Tasks 2, 3, 4 (and 15's reasons). FR-032: Tasks 2, 6, 7. FR-033: the
  start message uses the stored client name (Task 7). FR-034: Tasks 6, 7, 8 (retries and
  `SlackDeliveryFailed` in Task 7; the only new Slack secret reader in Task 8). FR-035: Tasks 4
  (record and mode), 7 (record written), 9 (ingress), 10 (broker). FR-054: Tasks 10 (identity,
  requester, no workspace or charge) and 11 (the 30-minute wait, attribution); SC-012 in Task 16.
  FR-055 and D21: Tasks 13 and 14. FR-030 (`agentx_share_task`, share fields, channel turns):
  Tasks 4, 5, 15. FR-037 (Slack turn records carry `taskId`): Task 11. FR-049
  (`CHANNEL_AMBIGUOUS`, `TASK_BUSY` naming the driver): Tasks 1, 10, 15. US3 scenarios 1 to 9:
  Tasks 3, 4, 5, 7, 9, 10, 11 and 16; SC-006: Task 18. The spec's edge cases "several bound
  channels", "required sharing with no bound channel", "the developer continues while a channel
  turn runs", "switches to view only" and "a teammate who is not a member" (unchanged ingress
  checks, Task 9's test): Tasks 3, 9, 10, 11. 25b owner decision 10: Task 12.
- **Placeholder scan.** Every code step shows its code. Where a step says "unchanged" it names the
  lines left alone (Task 3 Step 4's `checkProjectAccess`, Task 12 Step 3's organization branch). The
  two places that ask the implementer to confirm a fact first (logical ID prefixes in Task 8, the
  setup step's shape in Task 18) say what to do with the answer.
- **Type consistency.** `TaskShare` (Task 3) is the one shape of `share` on the task; the notifier
  (Task 7), the share route (Task 4), the close (Task 4), the view (Task 3) and `channelDriver`
  (Task 10) use its fields as defined. `ShareDecision` and `BoundChannel` are Task 2's. `Notice`
  and `StreamRecord` are Task 6's, used unchanged by Task 7 and Task 16. `sharedTask` on
  `AuthenticatedIdentity` (Task 10) and on the WORKSPACE answer (Task 1) are different shapes on
  purpose: the identity carries the workspace ID and state; the answer carries only the task ID and
  developer name. `DeveloperTaskActions` gains `channelTurns` (Task 5) and `channelActivity`
  (Task 10), each added to the test fakes in its own task.
- **Review Focus.** Each line has its test in the owning task: 1 in Tasks 11 and 16, 2 in Tasks 10
  and 11, 3 in Task 7, 4 in Task 13, 5 in Task 3.
- **The caller's four carry-overs.** FR-055 and D21: Tasks 13 and 14, with the pinned
  `developer-task-chain.test.ts` test changed deliberately (Task 14 Step 1). The limit reply: Task
  12. `CHANNEL_REQUIRED`: the 25b refusals are replaced (Task 3 Step 5) and the MCP next steps fit
  what remains (Task 15). The refused close's audit: C22 leaves it to 25e, with the reason.
