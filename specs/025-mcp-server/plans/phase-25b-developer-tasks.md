# Phase 25b: Developer Tasks and the Local MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in developer adds AgentX to Claude Code, Codex or Cursor with one command, and
their AI tool hands AgentX a coding task on a project they may use. AgentX runs the tool's own
instructions in a private workspace of its own, with no AgentX model in between, and the tool can
move on or wait, read the result, continue in the same workspace, cancel, close, and open a pull
request.

**Architecture:**
- **The broker serves the developer task API under `/v1/dev/tasks`** (FR-016), behind the token
  check 25a built (D17). Each task gets an ordinary workspace owned by the key
  `sha256("agentx-developer-task", "<developerId>/<taskId>")` (FR-017). The start writes the task,
  its index row, the workspace with its prepare operation and outbox item, the conversation, the
  workspace-limit charges, the idempotency record and the audit record in one transaction
  (FR-018).
- **Nothing else is new on the worker path.** The existing outbox, dispatcher and EC2 worker run
  the prepare. When the prepare's result arrives, the broker queues the first task in the same
  transaction that records the result, so the client never calls again (FR-018). Continue, cancel,
  close and pull requests call the existing handlers with the task's owner key (FR-021).
- **Tasks share the Slack workspace limits** (FR-020): a developer linked to a Slack user is
  charged on that user's counter; others get their own counter with the same limit. The limits
  come from the state table setting `SETTINGS` / `WORKSPACE_LIMITS` when an admin has set one, and
  from the stack parameters otherwise (FR-053's read; the writer is phase 25e).
- **Every developer action writes an immutable, 30-day turn record** in the existing TurnRecords
  table, keyed `TASK#<taskId>`, with `origin: "ai_tool"` (FR-037).
- **A new package, `@agentx/mcp`**, holds the tool definitions, the control-plane client and the
  waits (FR-027). The CLI's new `agentx mcp` runs it over stdio with the MCP TypeScript SDK
  (FR-026), and `agentx mcp install` adds it to each AI tool (FR-043).
- **Sharing is phase 25c.** A start that asks to share, or on a project whose `share` is
  `required`, is refused with `CHANNEL_REQUIRED` and a message that sharing is not yet available.
  The task keeps a `shared: false` field for 25c, and nothing more.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4
(4.6.5), Vitest, `@modelcontextprotocol/sdk` 1.30.1 (already pinned by `@agentx/gateway`), AWS SDK
v3 3.1134.0 (`@aws-sdk/lib-dynamodb`, `client-s3`), AWS CDK, commander 15, `node:child_process`
(for `claude mcp add`).

**Spec:** [../spec.md](../spec.md). Phase 25b delivers the phase README's row:
- FR-014 (the `developerTasks` project settings, which replace 25a's R16 `() => true`);
- FR-016 to FR-030 for the developer tools (the task API, one workspace per task, the task index,
  shared limits, instructions sent unchanged, the developer requester, the PR footer, statuses and
  failure categories, `agentx mcp`, `@agentx/mcp`, redaction);
- FR-033 (client names), FR-036 (tasks visible only to their developer), FR-037 (AI-tool turn
  records);
- FR-043 and FR-047 (`agentx mcp install` and the install guide);
- the MCP side of FR-048 (`UPGRADE_REQUIRED` and the upgrade notice);
- FR-049 for the developer error codes, including `PROJECT_ACCESS_DENIED`'s visible channels;
- User Stories 1, 2 and 7.

The phase map is in [README.md](README.md). What 25a left for this phase is its plan's "Not in this
phase" list.

**Branch:** build on `feat/025b-developer-tasks`, cut from mainline after this plan merges (this
plan was written on `docs/025b-plan`, from mainline `e805b49`, which has 25a from PR #143). One PR,
against `mainline`. No stacked PRs.

## Decisions recorded by this plan

Each ruling is written into the code by the task named. The ones marked **(owner)** interpret or
go beyond the spec's text; the owner decided each of them on 2026-09-28 (Owner decisions, below).

- **R1. No constitution change.** Constitution 4.0.0 (25a) already admits the developer task API
  and one workspace per developer task (FR-050). Nothing in this phase changes a principle.
- **R2. Three records per task, beside the ordinary workspace.**
  - `DEVTASK#<taskId>` / `META`: the task (developer, project, title, client, workspace, owner
    key, conversation, starting revision, the counters it charged, `shared: false`, `closedAt`).
    Every `/v1/dev/tasks/<id>` route reads it first, and answers `TASK_NOT_FOUND` unless its
    developer is the caller (FR-036).
  - `DEVELOPER#<developerId>` / `TASK#<createdAt>#<taskId>`: the index row of FR-017 (project,
    workspace ID, title, client, status, `shared`, starting revision), newest first for
    `GET /v1/dev/tasks`.
  - `WORKSPACE#<workspaceId>` / `DEVELOPER_TASK`: a pointer from the workspace to its task,
    holding the first instructions until they are queued. The worker callbacks only know the
    workspace, so this is how the broker finds the task.

  The workspace record itself is unchanged (its schema is strict). Task 4.
- **R3. The first task is queued in the prepare's result transaction.** The start transaction also
  writes the task's conversation. When the prepare succeeds, `recordTerminalResult` moves the
  workspace straight from `PREPARING` to `BUSY` with the task operation, writes the task's
  operation, outbox item and idempotency record, and removes the stored instructions, all in the
  one transaction that records the prepare's result. A retried callback finds the prepare already
  terminal and queues nothing twice. So FR-018's "no further call from the client" holds without a
  new queue or poller. Task 9.
- **R4. A task's status is derived on every read** from its workspace and operations, and the
  index row keeps the last status the API saw:

  | Workspace and operations | Status |
  |---|---|
  | the task was closed, or its workspace is `CLOSED` | `CLOSED` |
  | the instructions are still waiting, or the workspace is `PREPARING` | `STARTING` |
  | the instructions were cancelled before they ran | `CANCELLED` |
  | the workspace is `PREPARATION_FAILED` | `FAILED`, `setup_failed` |
  | the latest task or publish operation is not finished | `RUNNING` |
  | the latest task or publish operation ended | its status (`SUCCEEDED`, `FAILED`, `CANCELLED`, `INTERRUPTED`) |

  A close in progress keeps the status and adds `closing: true`. "Latest" is the newest by
  `createdAt` among the workspace's `task` and `publish` operations, so no operation list has to
  be kept in step. Tasks 4 and 10.
- **R5. Failure categories (FR-025)** come from the operation's kind, status and error text:
  `INTERRUPTED` is `interrupted`; an error from dispatch (the outbox gave up) is
  `worker_unavailable`; a failed prepare is `setup_failed`; a failed publish is
  `publication_failed`; a task whose error says it timed out is `timed_out`; any other failed task
  is `task_failed`. The message is redacted and cut to 1,000 characters. Task 4.
- **R6. Shared counters (owner).** The member counter is the Slack member's
  `SLACK_LIMIT#<team>` / `MEMBER#<slackUserId>` when the developer is linked, and
  `DEVELOPER_LIMIT#<developerId>` / `MEMBER` otherwise. The organization counter is
  `SLACK_LIMIT#<team>` / `ORGANIZATION`, or `DEVELOPER_LIMIT#ORGANIZATION` when the environment has
  no Slack team ID. A task is recorded in a string set `tasks` on the member counter, never in the
  `threads` list, because the Slack limit refusal reads every `threads` entry as a thread subject.
  The task stores the two keys it charged, and its close releases exactly those, even if the
  developer's Slack link changed since. Task 5.
- **R7. The limits setting is read in this phase (owner).** The owner decided the limits live in
  the state table. `readWorkspaceLimits` reads `SETTINGS` / `WORKSPACE_LIMITS` with a consistent
  read at each workspace creation, for Slack threads and developer tasks alike, and falls back to
  `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit` when it is absent or invalid.
  Nothing in 25b writes the setting; phase 25e's `agentx_admin_set_workspace_limits` and 15e's
  `agentx config set` do. Task 5.
- **R8. The start's order (FR-018):** the token; then the idempotency record, so a retried tool
  call returns the first task even if something changed since; then `PROJECT_NOT_FOUND`,
  `PROJECT_ACCESS_DENIED`, `PROJECT_TASKS_DISABLED`; then sharing (R9); then the workspace limit;
  then the one transaction. Nothing is written before the transaction except the audit record of a
  refusal (R12). Task 8.
- **R9. Sharing is refused, not built.** `shareToChannel: true`, or a project whose `share` is
  `required`, gives `CHANNEL_REQUIRED` with "sharing tasks to Slack is not available yet". The task
  and index rows carry `shared: false`, and the start request accepts `shareMode` and `channel`
  so 25c changes no wire shape. There is no share route and no `agentx_share_task` tool. Task 8.
- **R10. `PROJECT_ACCESS_DENIED` names only public bound channels.** The spec says to name the
  bound channels the person can see: public ones, and private ones they are in. A person in any
  bound channel already has access when `channelMembersMayUse` is true, so when they are refused,
  the only bound channels they can see are the public ones. The names come from a new
  `channel-info` request to `DeveloperIdentity` (Slack `conversations.info`, the bot's existing
  `channels:read` and `groups:read` scopes). The message is just "ask an admin" when the developer
  has no Slack link, when `channelMembersMayUse` is false, or when there is no public bound
  channel. Task 7.
- **R11. Access is checked at the start only.** The project's latest revision gives
  `developerTasks` for `GET /v1/dev/projects` and for the start. Continue, cancel, close, reads and
  pull requests on an existing task do not check access again (the spec's edge case: a developer
  who leaves the channel can still read their tasks and open their PRs). Tasks 7 and 11.
- **R12. Two audit records per action, and one per refusal (owner).** Turn records are written once
  and never changed:
  - an `accepted` record, in the same transaction as the action, with the request (the
    instructions, redacted and capped) and the immediate answer;
  - a `completed` record, in the same transaction as the operation's result, with the result
    summary as response text (FR-037);
  - a `refused` record for a start refused after its request parses (by project, access, policy,
    sharing or limit), under the task ID the start would have used, with the error code. A request
    that does not parse is answered `INVALID_REQUEST` and logged by its field name only.

  The broker may put items in TurnRecords only under `TASK#*` (IAM `dynamodb:LeadingKeys`). The
  admin export (`GET /v1/admin/turns`) returns both kinds, and its cursor accepts `TASK#` keys.
  Tasks 3, 8, 11 and 13.
- **R13. The developer requester (FR-022).** `Operation.requestedBy` is a Slack requester or
  `{ kind: "developer", developerId, provider }`. Connector calls stay Slack-only: their context
  takes the Slack requester alone, so no connector code changes. Task 6.
- **R14. The PR footer and drafts (FR-023).** A developer task's PR body ends with
  "Requested by `<name>` via AgentX, started from <client>", the name made inert as the Slack
  footer's is. The Slack footer is unchanged. `draft` (default true) reaches GitHub's create call
  through a new optional `draft` on the publication; Slack requests never send it. Task 6.
- **R15. Closing (owner).** `POST tasks/<id>/close` runs the existing close preflight operation.
  When it ends safe, the broker completes the close itself: it deletes the compute, marks the
  workspace `CLOSED` and releases the charged counters. If that step fails, the next read or close
  of the task tries it again. When the preflight finds unpublished work, the answer is
  `closed: false` with each repository's reasons, and the task keeps its status. A task that never
  started (`PREPARATION_FAILED`) closes at once; a task still `STARTING` answers `TASK_BUSY`. There
  is no "discard" flag. Task 12.
- **R16. Cancelling before the instructions run** removes them from the pointer, so the prepare's
  result queues nothing, and the task reads `CANCELLED`. Task 11.
- **R17. A task that never started cannot be continued.** Continuing a `setup_failed` task answers
  `INVALID_REQUEST`: "this task never started; close it and start a new one". Task 11.
- **R18. The result.** The summary is the last assistant message of the latest task operation
  (the Slack orchestrator's `lastAssistantResponse`, moved to the contracts package so both use
  one copy), redacted and cut to 4,000 characters. Changed files and line counts come from the
  `workspace.diff` artifact the worker already writes. Artifact records gain a `size`. Tasks 2,
  6 and 10.
- **R19. Tool results.** Every tool declares an output schema and returns `structuredContent` plus
  a one-line text summary. Output fields use snake_case, like the inputs (`task_id`). An error is
  a result with `isError: true` and `{ code, message, next_step }`. Every result passes through
  `redactSecrets` (FR-029). Task 15.
- **R20. `INVALID_REQUEST` is added to FR-049 (owner)** for input the control plane refuses (a
  reused request ID with other content, instructions over 65,536 bytes, a malformed task ID). Task
  14.
- **R21. Waits.** The server polls the task every 2 seconds, growing to 5, and sends a progress
  notification after every poll when the client sent a progress token, so the gap is at most 5
  seconds (the spec's bound is 15). A cancelled tool call stops polling at once; the task keeps
  running. A wait that ends first returns `timed_out: true`, not an error. Task 15.
- **R22. `agentx_open_pull_request` and `agentx_close_task` return at once (owner, Owner decision 6).**
  Neither tool waits. `agentx_open_pull_request` answers with the publish operation's ID and its
  status (`ACCEPTED` when just started), and `agentx_close_task` with the task, `closing: true`,
  while the worker checks for unpublished work. The AI tool checks back with `agentx_get_task`: the
  PR's URL appears in `pull_requests` once it is published, a finished close shows `CLOSED`, and a
  refused close shows `unpublished`, with each repository and why. A call repeated with the same
  `request_id` returns the same operation and writes nothing, so a retried tool call is safe. The
  task wait of R21 (off by default, at most 600 seconds) is the only wait. Tasks 11, 12 and 15.
- **R23. API version 1.1.** `DEVELOPER_API_VERSION` becomes `"1.1"`. The MCP server needs the
  control plane's major version 1 and minor version 1 or more: a different major, or a control
  plane still on 1.0 (which has no task routes), gives `UPGRADE_REQUIRED`; a newer minor gives the
  upgrade notice in `agentx_whoami`. Tasks 2 and 15.
- **R24. `agentx_whoami`'s "admin" (owner)** says whether this computer holds an unexpired admin
  sign-in for the environment. The admin tools themselves are 25d. Task 16.
- **R25. Client names (FR-033).** The MCP server sends `clientInfo.name` as it came, and the
  broker cleans it (Slack display-name rules) and maps it to `Claude Code`, `Codex` or `Cursor` by
  pattern (`claude-code` or `claude code` at the start; a name containing `codex`; a name
  containing `cursor`), otherwise "an AI tool". Only those four strings are ever stored or shown,
  so a client cannot write its own text into a PR footer. The live check records each client's
  real `clientInfo.name`. Tasks 2 and 8.
- **R26. `agentx mcp install`.** The entry runs `npx -y @charterarc/agentx@<version> mcp`, where
  the version is the packed release's, or `latest` for a CLI built from source. Claude Code: `claude
  mcp remove --scope user agentx` (a failure is ignored), then `claude mcp add --scope user agentx
  -- ...`. Codex: the `[mcp_servers.agentx]` table in `~/.codex/config.toml`, edited as text so
  every other line stays byte for byte, refusing a file that defines `agentx` another way. Cursor:
  `mcpServers.agentx` in `~/.cursor/mcp.json`, refusing a file that is not plain JSON. `--env` is
  added to the entry only when typed. Task 17.
- **R27. One infrastructure change.** The broker gets `dynamodb:PutItem` on TurnRecords for
  `TASK#*` keys, in named environments only. No new table, function, route or parameter, so no
  resource that CloudFormation validates against our own API, and nothing that needs
  `RetainExceptOnCreate`. Task 13.
- **R28. No project description.** FR-030's `agentx_list_projects` names a description, but the
  project definition has none. The tool shows name, bound channels, policy and whether tasks are
  enabled. Task 15.

## Owner decisions (2026-09-28)

The owner answered each question this plan raised. Eleven recommendations were accepted as
written; one (6) was changed. The plan follows these answers, and Task 18 writes them into the spec.

1. **The limits setting (R7). Accepted.** 25b reads `SETTINGS` / `WORKSPACE_LIMITS` (with the
   stack parameters as the fallback), for Slack threads and developer tasks alike; 25e adds the
   change tool that writes it. The README's 25e row is amended to say so.
2. **No Slack team ID (R6). Accepted.** Developers in an environment with no Slack team ID count
   on `DEVELOPER_LIMIT#ORGANIZATION`, with the same limit.
3. **Audit records (R12). Accepted.** Three stages: an `accepted` record in the action's
   transaction, a `completed` record with the result summary when the operation ends, and a
   `refused` record for a start refused after its request parses. FR-037 is amended.
4. **`INVALID_REQUEST` (R20). Accepted.** It is added to FR-049.
5. **Closing with unpublished work (R15). Accepted.** The close is refused, listing each repository
   and why. There is no force flag.
6. **Waiting for the PR URL and the close (R22). Changed.** `agentx_open_pull_request` and
   `agentx_close_task` do not wait. They return at once with a started status and the operation or
   task reference, and the AI tool checks back with `agentx_get_task`. The task wait (off by
   default, at most 600 seconds) stays exactly as it is.
7. **`agentx_whoami`'s admin field (R24). Accepted.** It says whether this computer holds an
   unexpired admin sign-in for the environment.
8. **Project description (R28). Accepted.** "description" is dropped from FR-030's
   `agentx_list_projects`.
9. **SC-009 and AgentCore. Accepted.** SC-009 becomes "the developer task contract tests pass
   with an `ec2-ebs` binding, and no developer task code reads the deployment mode" (Task 10 has a
   test for the second part). The spec's Context item 11 and the Testing line that names AgentCore
   are updated too.
10. **A Slack member at the limit because of AI-tool tasks. Accepted.** The Slack refusal lists
    only the member's open threads, so it undercounts when AI-tool tasks fill the limit. 25b
    accepts this; the fix, adding the open task count to the Slack reply, is a known follow-up in
    25c's README row.
11. **Rolling back past 25b. Accepted.** The release notes say: before rolling back to a release
    before 25b, register a revision without `developerTasks`, since the strict schema of an older
    control plane cannot read it.
12. **SC-008 and the API version. Accepted.** The expected `DEVELOPER_API_VERSION` in
    `tests/contract/developer-contracts.test.ts` changes from `"1.0"` to `"1.1"` (Task 2). SC-008
    means no assertion is removed or weakened.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Never run vitest with `-u`. No test and no step of
  the live check touches production's stacks, `/agentx/production/*`, production's Slack app or
  its secrets.
- **The 25a live check's lessons hold:** no resource that CloudFormation validates at create time
  against our own API; every retained resource in a named environment uses `RetainExceptOnCreate`
  (this phase adds none); legacy templates and snapshots never change; the live check runs in a
  throwaway named environment with the owner present.
- **No test reaches AWS, Slack, GitHub or a company IdP.** Every client is injected. The only real
  network use in tests is `127.0.0.1`.
- **Never printed, logged, stored in local files, or put in a tool result or error message:**
  access tokens, refresh tokens, the Slack bot token, secret values. The MCP server writes only
  protocol messages to stdout and its logs to stderr (FR-026). Every task that handles one plants
  a known value and asserts it appears nowhere it must not.
- **The developer's instructions reach the worker unchanged** (FR-019): the same string, byte for
  byte, as the task prompt. No AgentX model reads them.
- **No developer task code reads the deployment mode** (FR-024). The existing handlers keep their
  own switches.
- **Exact names and values:**
  - routes `GET /v1/dev/projects`, `POST /v1/dev/tasks`, `GET /v1/dev/tasks`,
    `GET /v1/dev/tasks/{taskId}`, `GET /v1/dev/tasks/{taskId}/events`,
    `POST /v1/dev/tasks/{taskId}/continue`, `/cancel`, `/close`, `/pull-requests`;
  - owner issuer `agentx-developer-task`, owner subject `<developerId>/<taskId>`;
  - state items `DEVTASK#<taskId>`/`META`, `DEVELOPER#<developerId>`/`TASK#<createdAt>#<taskId>`,
    `WORKSPACE#<workspaceId>`/`DEVELOPER_TASK`, `IDEMPOTENCY#<developerId>#DEVTASK`/`REQUEST#<id>`,
    `SETTINGS`/`WORKSPACE_LIMITS`, `DEVELOPER_LIMIT#<developerId>`/`MEMBER`,
    `DEVELOPER_LIMIT#ORGANIZATION`/`ORGANIZATION`;
  - turn records `TASK#<taskId>` / `TURN#<receivedAt>#<turnId>`, 30 days;
  - limits 3 per person and 20 per organization by default;
  - instructions at most 65,536 UTF-8 bytes; title at most 120 characters; client name at most 40;
    summary at most 4,000 characters; failure message at most 1,000; event text at most 300;
  - `wait_seconds` 0 to 600 (default 0 on start and continue), 1 to 600 on `agentx_wait_for_task`;
    `events` 0 to 50, default 10; `limit` 1 to 50, default 20; no other tool waits (R22);
  - `DEVELOPER_API_VERSION = "1.1"`;
  - packages `@agentx/mcp` (workspace) and `@charterarc/agentx` (published CLI);
    `@modelcontextprotocol/sdk` at exactly `1.30.1`;
  - tool names: `agentx_whoami`, `agentx_list_projects`, `agentx_start_task`, `agentx_get_task`,
    `agentx_wait_for_task`, `agentx_list_tasks`, `agentx_continue_task`, `agentx_cancel_task`,
    `agentx_close_task`, `agentx_open_pull_request`.
- **Copy:**
  - plain words;
  - every error says what to do next;
  - no em dashes in any user-facing text, tool description, AWS resource name or description.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Existing suites:** no assertion is removed or weakened (SC-008). Lists of commands, error codes
  and workspace manifests gain the new entries by appending.
- **Build process:** the owner approves this plan before building. Building uses
  superpowers:subagent-driven-development, with a fresh implementer and a fresh reviewer per task.

## Review Focus

1. **The prepare's result callback arrives twice.** The EC2 worker retries a terminal callback it
   is not sure landed. If the first task were queued outside the transaction that records the
   prepare, a retry could queue it twice and the worker would run the instructions twice.
   Expected: one task operation, one outbox item. Pinned in Task 9
   (`developer-task-chain.test.ts`, "a repeated prepare result queues the first task once").
2. **The AI tool gives up during a long wait.** Claude Code cancels a tool call it has waited on
   too long, or the person presses Escape. Expected: the server stops polling at once, sends no
   more progress for that call, and the task keeps running. Pinned in Task 15 (`mcp-wait.test.ts`,
   "stops polling when the call is cancelled").
3. **Instructions that fit in characters but not in bytes.** A tool writes 21,846 euro signs (3
   bytes each, 65,538 bytes). Expected: `INVALID_REQUEST` naming the 65,536-byte limit, before
   anything is written, never a truncated prompt. Pinned in Task 8 (`developer-task-start.test.ts`,
   "refuses instructions over 65,536 bytes even when they are under 65,536 characters").
4. **The admin export pages across an AI-tool record.** Today's cursor check accepts only
   `THREAD#` keys. A page that ends on a `TASK#` record would make `agentx admin turns export`
   fail with "could not continue". Expected: the export pages through both kinds. Pinned in Task 3
   (`turn-export.test.ts`, "hands out and accepts a cursor that ends on an AI-tool record").
5. **A Codex config with our table, a sub-table and comments.** `~/.codex/config.toml` has
   `[mcp_servers.agentx]`, `[mcp_servers.agentx.env]` and a comment line between other servers.
   Re-running `agentx mcp install --client codex` must replace only our table and its sub-table,
   leaving every other byte as it was. Pinned in Task 17 (`mcp-install.test.ts`, "replaces the
   agentx table and its sub-tables and keeps every other byte").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/project.ts` (modify) | `developerTasks` policy (FR-014), `developerTaskPolicy()` | 1 |
| `packages/contracts/src/operation.ts` (modify) | developer requester, `requestedBy` union, PR `draft` | 1 |
| `packages/contracts/src/errors.ts` (modify) | the new error codes | 1 |
| `packages/contracts/src/developer-tasks.ts` | task API constants, request and response schemas, client names, titles, `lastAssistantResponse`, `diffStat` | 2 |
| `packages/contracts/src/developer.ts` (modify) | API version 1.1, project policy and channel names, the `channel-info` request | 2 |
| `packages/orchestrator/src/control-plane-api.ts` (modify) | re-export `lastAssistantResponse` from contracts | 2 |
| `packages/contracts/src/turns.ts` (modify) | `origin`, `AiToolTurnRecordSchema`, `AnyTurnRecordSchema`, keys | 3 |
| `packages/broker/src/aws/turns.ts` (modify) | export both kinds; cursor accepts `TASK#` | 3 |
| `packages/broker/src/developer/task-records.ts` | task keys, owner key, status and failure rules, event text, turn record builder, PR footer | 4 |
| `packages/broker/src/developer/limits.ts` | the limits setting, counter keys, charge and release items | 5 |
| `packages/broker/src/aws/broker.ts` (modify) | limits setting in the Slack paths; developer identity; requester; footer; `draft`; artifact size; the actions the developer routes use; the prepare-result hook | 5, 6, 9, 11, 12 |
| `packages/broker/src/auth.ts` (modify) | `AuthenticatedIdentity.developer` | 6 |
| `packages/broker/src/github-app.ts` (modify) | `draft` on PR create | 6 |
| `packages/broker/src/developer/access.ts` (modify) | per-project policy, one-project check | 7 |
| `packages/broker/src/developer/slack-directory.ts`, `server.ts` (modify) | `channel-info` | 7 |
| `packages/broker/src/aws/developer-routes.ts` (modify) | projects with policy and channel names; route `/v1/dev/tasks*` | 7, 8 |
| `packages/broker/src/aws/developer-task-actions.ts` | the `DeveloperTaskActions` interface (types only) | 6 |
| `packages/broker/src/aws/developer-tasks.ts` | the task routes | 8, 10, 11, 12 |
| `infra/lib/developer-signin.ts`, `control-plane.ts` (modify) | TurnRecords `PutItem` on `TASK#*` | 13 |
| `packages/mcp/*` | `@agentx/mcp`: errors, client names, control-plane client, waits, tools, server | 14, 15 |
| `tsconfig.json`, `environments/*/Dockerfile`, `scripts/release-production.ts` (modify) | the new workspace package | 14 |
| `packages/cli/src/mcp/serve.ts` | `agentx mcp` over stdio | 16 |
| `packages/cli/src/mcp/install.ts` | `agentx mcp install` | 17 |
| `packages/cli/src/main.ts`, `package.json`, `tsconfig.json` (modify) | the `mcp` command | 16, 17 |
| `docs/mcp-install.md` | the install guide (FR-047) | 17 |
| `tests/support/slack-broker.ts` (modify) | `createBroker` passes `developer` and `turnRecordsTableName` through | 6 |
| `tests/support/developer-task-broker.ts` | broker harness for developer tasks: two developers, worker callbacks | 6, 16 |
| `tests/support/developer-fakes.ts` (modify) | the fake Slack answers `conversations.info` | 7 |
| `specs/025-mcp-server/spec.md`, `plans/README.md` (modify) | record the rulings | 18 |

---
### Task 1: Project policy, the developer requester and the new error codes

FR-014, FR-022, FR-049's codes, and the `draft` flag of R14. Contracts only.

**Files:**
- Modify: `packages/contracts/src/project.ts`
- Modify: `packages/contracts/src/operation.ts`
- Modify: `packages/contracts/src/errors.ts`
- Test: `tests/contract/developer-task-contracts.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `DeveloperShareModeSchema` (`"view" | "continue"`), `DeveloperTaskPolicySchema`,
    `type DeveloperTaskPolicy = { enabled: boolean; share: "optional" | "required"; shareMode: { default: "view" | "continue"; allowContinue: boolean }; channelMembersMayUse: boolean }`,
    `DEFAULT_DEVELOPER_TASK_POLICY`, `developerTaskPolicy(definition: { developerTasks?: unknown }): DeveloperTaskPolicy`;
  - `ProjectDefinition.developerTasks?: DeveloperTaskPolicy`;
  - `DeveloperRequesterSchema`, `type DeveloperRequester = { kind: "developer"; developerId: string; provider: "slack" | "oidc" }`,
    `OperationRequesterSchema`, `type OperationRequester = SlackRequester | DeveloperRequester`;
  - `Operation.requestedBy?: OperationRequester`;
  - `PullRequestRequest.draft?: boolean`;
  - error codes `PROJECT_NOT_FOUND` (404), `PROJECT_ACCESS_DENIED` (403), `PROJECT_TASKS_DISABLED`
    (403), `TASK_NOT_FOUND` (404), `TASK_BUSY` (409), `CHANNEL_REQUIRED` (409), `WORKSPACE_LIMIT`
    (409), `SLACK_UNAVAILABLE` (503).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-contracts.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVELOPER_TASK_POLICY,
  DeveloperTaskPolicySchema,
  OperationSchema,
  ProjectDefinitionSchema,
  PullRequestRequestSchema,
  agentXError,
  developerTaskPolicy,
} from "../../packages/contracts/src/index.js";

const definition = {
  name: "payments",
  revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [],
  readiness: [],
  orchestratorInstructions: "Delegate work.",
};
const operation = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  kind: "task",
  requestId: "33333333-3333-4333-8333-333333333333",
  payloadHash: "a".repeat(64),
  status: "ACCEPTED",
  fence: 2,
  createdAt: "2026-09-27T12:00:00.000Z",
  updatedAt: "2026-09-27T12:00:00.000Z",
};

describe("developerTasks project policy (FR-014)", () => {
  it("fills every default when the object is present but empty", () => {
    expect(DeveloperTaskPolicySchema.parse({})).toEqual({
      enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true,
    });
  });

  it("is optional on the definition, and part of the revision when given", () => {
    expect(ProjectDefinitionSchema.parse(definition)).not.toHaveProperty("developerTasks");
    const parsed = ProjectDefinitionSchema.parse({ ...definition, developerTasks: { share: "required", shareMode: { allowContinue: false } } });
    expect(parsed.developerTasks).toEqual({ enabled: true, share: "required", shareMode: { default: "view", allowContinue: false }, channelMembersMayUse: true });
  });

  it("refuses unknown keys and values", () => {
    expect(ProjectDefinitionSchema.safeParse({ ...definition, developerTasks: { enabled: "yes" } }).success).toBe(false);
    expect(ProjectDefinitionSchema.safeParse({ ...definition, developerTasks: { sharing: "on" } }).success).toBe(false);
    expect(ProjectDefinitionSchema.safeParse({ ...definition, developerTasks: { shareMode: { default: "edit" } } }).success).toBe(false);
  });

  it("reads the defaults for a definition without it", () => {
    expect(developerTaskPolicy(definition)).toEqual(DEFAULT_DEVELOPER_TASK_POLICY);
  });

  it("fails closed on a stored value it cannot read: tasks off, channel access off", () => {
    expect(developerTaskPolicy({ developerTasks: { enabled: 1 } })).toEqual({ ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false, channelMembersMayUse: false });
  });
});

describe("the developer requester on operations (FR-022)", () => {
  it("accepts a Slack requester, as today", () => {
    expect(OperationSchema.parse({ ...operation, requestedBy: { teamId: "T0TEAM1", userId: "U0MAYA001" } }).requestedBy).toEqual({ teamId: "T0TEAM1", userId: "U0MAYA001" });
  });

  it("accepts a developer requester", () => {
    const requestedBy = { kind: "developer", developerId: "d".repeat(64), provider: "oidc" };
    expect(OperationSchema.parse({ ...operation, requestedBy }).requestedBy).toEqual(requestedBy);
  });

  it("refuses a developer requester with a malformed ID or an extra field", () => {
    expect(OperationSchema.safeParse({ ...operation, requestedBy: { kind: "developer", developerId: "maya", provider: "slack" } }).success).toBe(false);
    expect(OperationSchema.safeParse({ ...operation, requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya" } }).success).toBe(false);
  });
});

describe("draft pull requests (R14)", () => {
  it("accepts draft, and leaves it out when not given", () => {
    const base = { requestId: operation.requestId, repository: "demo", title: "Fix the retry test" };
    expect(PullRequestRequestSchema.parse({ ...base, draft: true }).draft).toBe(true);
    expect(PullRequestRequestSchema.parse(base)).not.toHaveProperty("draft");
  });
});

describe("developer error codes (FR-049)", () => {
  it.each([
    ["PROJECT_NOT_FOUND", 404], ["PROJECT_ACCESS_DENIED", 403], ["PROJECT_TASKS_DISABLED", 403], ["TASK_NOT_FOUND", 404],
    ["TASK_BUSY", 409], ["CHANNEL_REQUIRED", 409], ["WORKSPACE_LIMIT", 409], ["SLACK_UNAVAILABLE", 503],
  ] as const)("%s answers HTTP %i", (code, status) => {
    expect(agentXError(code, "x").statusCode).toBe(status);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-contracts.test.ts`
Expected: FAIL, `DeveloperTaskPolicySchema` is not exported.

- [ ] **Step 3: Add the policy to the project definition**

In `packages/contracts/src/project.ts`, above `function projectDefinitionObject`:

```ts
export const DeveloperShareModeSchema = z.enum(["view", "continue"]);

/** Spec 025 FR-014: how a project treats tasks started from an AI tool. Part of the revision. */
export const DeveloperTaskPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    share: z.enum(["optional", "required"]).default("optional"),
    shareMode: z
      .object({
        default: DeveloperShareModeSchema.default("view"),
        allowContinue: z.boolean().default(true),
      })
      .strict()
      .default({ default: "view", allowContinue: true }),
    channelMembersMayUse: z.boolean().default(true),
  })
  .strict();
export type DeveloperTaskPolicy = z.output<typeof DeveloperTaskPolicySchema>;
export const DEFAULT_DEVELOPER_TASK_POLICY: DeveloperTaskPolicy = DeveloperTaskPolicySchema.parse({});

/**
 * The policy a stored definition carries, or the defaults when it has none. A value that no longer
 * parses turns tasks and channel access off, so a damaged record never widens access.
 */
export function developerTaskPolicy(definition: { developerTasks?: unknown }): DeveloperTaskPolicy {
  const parsed = DeveloperTaskPolicySchema.safeParse(definition.developerTasks ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false, channelMembersMayUse: false };
}
```

In `projectDefinitionObject`, after `actionPolicy: ActionPolicySchema.optional(),` add:

```ts
      developerTasks: DeveloperTaskPolicySchema.optional(),
```

- [ ] **Step 4: Add the developer requester and `draft`**

In `packages/contracts/src/operation.ts`, below the imports:

```ts
/** Spec 025 FR-022: an operation a developer started from an AI tool. */
export const DeveloperRequesterSchema = z
  .object({
    kind: z.literal("developer"),
    developerId: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.enum(["slack", "oidc"]),
  })
  .strict();
export const OperationRequesterSchema = z.union([SlackRequesterSchema, DeveloperRequesterSchema]);
export type DeveloperRequester = z.infer<typeof DeveloperRequesterSchema>;
export type OperationRequester = z.infer<typeof OperationRequesterSchema>;
```

In `PullRequestRequestSchema`, after `body`, add `draft: z.boolean().optional(),`. In
`OperationSchema`, replace `requestedBy: SlackRequesterSchema.optional(),` with
`requestedBy: OperationRequesterSchema.optional(),`.

- [ ] **Step 5: Add the error codes**

In `packages/contracts/src/errors.ts`, append to the enum, after `"STALE_FENCE",`:

```ts
  "PROJECT_NOT_FOUND",
  "PROJECT_ACCESS_DENIED",
  "PROJECT_TASKS_DISABLED",
  "TASK_NOT_FOUND",
  "TASK_BUSY",
  "CHANNEL_REQUIRED",
  "WORKSPACE_LIMIT",
  "SLACK_UNAVAILABLE",
```

and replace `errorStatus` with:

```ts
export function errorStatus(code: AgentXErrorCode): number {
  if (code === "AUTH_REQUIRED") return 401;
  if (code === "FORBIDDEN" || code === "PROJECT_ACCESS_DENIED" || code === "PROJECT_TASKS_DISABLED") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "TASK_NOT_FOUND") return 404;
  if (code === "CONFIG_INVALID") return 400;
  if (code === "RUNTIME_UNAVAILABLE" || code === "SLACK_UNAVAILABLE") return 503;
  return 409;
}
```

- [ ] **Step 6: Run the test, then the typecheck**

Run: `npx vitest run tests/contract/developer-task-contracts.test.ts && npm run typecheck`
Expected: PASS. `requesterOf` in `broker.ts` still returns a Slack requester until Task 6, so
nothing that writes the field changes type. If the typecheck names a file that reads
`operation.requestedBy` as a Slack requester, that file is a real reader: narrow it there with
`"userId" in requestedBy`, and add a test with a developer requester to that file's suite.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/project.ts packages/contracts/src/operation.ts packages/contracts/src/errors.ts tests/contract/developer-task-contracts.test.ts
git commit -m "feat(contracts): developerTasks policy, developer requester and task error codes (spec 025 FR-014, FR-022)"
```

---

### Task 2: The developer task API's shapes

FR-016's wire shapes, FR-025's statuses, FR-033's client names, R18's summary and changed files,
R23's API version, R10's `channel-info` request.

**Files:**
- Create: `packages/contracts/src/developer-tasks.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/developer.ts`
- Modify: `packages/orchestrator/src/control-plane-api.ts`
- Modify: `tests/contract/developer-contracts.test.ts:28` (the version value only; Owner decision 12)
- Test: `tests/contract/developer-task-shapes.test.ts`

**Interfaces:**
- Consumes: `cleanDisplayName` (`display-name.ts`), `OperationStatusSchema`, `DeveloperShareModeSchema` (Task 1).
- Produces:
  - constants `DEVELOPER_TASK_OWNER_ISSUER = "agentx-developer-task"`,
    `DEVELOPER_INSTRUCTIONS_MAX_BYTES = 65_536`, `DEVELOPER_TASK_TITLE_MAX = 120`,
    `DEVELOPER_CLIENT_NAME_MAX = 40`, `DEVELOPER_TASK_SUMMARY_MAX = 4_000`,
    `DEVELOPER_FAILURE_MESSAGE_MAX = 1_000`, `DEVELOPER_EVENT_TEXT_MAX = 300`,
    `DEVELOPER_EVENTS_MAX = 50`, `DEVELOPER_EVENTS_DEFAULT = 10`, `DEVELOPER_TASK_LIST_MAX = 50`,
    `DEVELOPER_TASK_LIST_DEFAULT = 20`, `DEVELOPER_WAIT_MAX_SECONDS = 600`,
    `UNKNOWN_CLIENT_NAME = "an AI tool"`;
  - `DeveloperTaskStatusSchema`, `type DeveloperTaskStatus`, `ENDED_TASK_STATUSES: ReadonlySet<DeveloperTaskStatus>`;
  - `DeveloperTaskFailureCategorySchema`, `type DeveloperTaskFailureCategory`;
  - `DeveloperInstructionsSchema`;
  - request schemas `StartDeveloperTaskRequestSchema`, `ContinueDeveloperTaskRequestSchema`,
    `DeveloperTaskActionRequestSchema`, `DeveloperPullRequestRequestSchema` (strict) and their types;
  - response schemas (not strict) `DeveloperTaskEventSchema`, `DeveloperTaskViewSchema`,
    `DeveloperTaskListItemSchema`, `DeveloperTaskListResponseSchema`, `DeveloperTaskResponseSchema`,
    `DeveloperCloseResponseSchema`, `DeveloperPullRequestResponseSchema`,
    `DeveloperTaskEventsResponseSchema` and their types (`DeveloperTaskView`, `DeveloperTaskEvent`,
    `DeveloperTaskListItem`, `DeveloperCloseResponse`, `DeveloperPullRequestResponse`);
  - `cleanClientName(value: string | undefined): string` (one of `Claude Code`, `Codex`, `Cursor`, `an AI tool`);
  - `taskTitle(instructions: string, title?: string): string`;
  - `lastAssistantResponse(events: ReadonlyArray<{ payload: unknown }>): string | undefined`;
  - `type ChangedFile = { repository: string; path: string; added: number; removed: number }`,
    `diffStat(diff: string, limit?: number): ChangedFile[]`;
  - in `developer.ts`: `DEVELOPER_API_VERSION = "1.1"`; `DeveloperProjectSchema` gains
    `channels[].name?: string`, `channels[].isPrivate?: boolean` and
    `tasks?: DeveloperTaskPolicy`; `ChannelInfoRequestSchema`, `type ChannelInfoRequest`,
    `type ChannelInfoResponse = { ok: true; channels: Array<{ channelId: string; name: string; isPrivate: boolean }> } | { ok: false; error: "slack_unavailable" | "invalid_request" }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-shapes.test.ts
import { describe, expect, it } from "vitest";
import {
  ChannelInfoRequestSchema,
  DEVELOPER_API_VERSION,
  DeveloperProjectSchema,
  DeveloperTaskViewSchema,
  StartDeveloperTaskRequestSchema,
  cleanClientName,
  diffStat,
  lastAssistantResponse,
  taskTitle,
} from "../../packages/contracts/src/index.js";
import { lastAssistantResponse as orchestratorCopy } from "../../packages/orchestrator/src/control-plane-api.js";

const requestId = "33333333-3333-4333-8333-333333333333";

describe("the start request", () => {
  it("accepts the tool's fields, and the sharing fields 25c will use", () => {
    const parsed = StartDeveloperTaskRequestSchema.parse({
      requestId, project: "payments", instructions: "Fix the flaky retry test", client: "Claude Code",
      shareToChannel: false, shareMode: "view", channel: "C0123456789",
    });
    expect(parsed.instructions).toBe("Fix the flaky retry test");
  });

  it("counts the instruction limit in UTF-8 bytes, not characters", () => {
    const euros = "\u20ac".repeat(21_846); // 65,538 bytes in 21,846 characters
    const result = StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: euros });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("65536");
    expect(StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: "a".repeat(65_536) }).success).toBe(true);
  });

  it("refuses unknown fields and empty instructions", () => {
    expect(StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: "x", model: "big" }).success).toBe(false);
    expect(StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: "" }).success).toBe(false);
  });
});

describe("client names (FR-033, R25)", () => {
  it("maps the known clientInfo names, after cleaning them like a Slack display name", () => {
    expect(cleanClientName("claude-code")).toBe("Claude Code");
    expect(cleanClientName("Claude Code")).toBe("Claude Code");
    expect(cleanClientName("  codex-mcp-client\u200b\n")).toBe("Codex");
    expect(cleanClientName("cursor-vscode")).toBe("Cursor");
  });

  it("says 'an AI tool' for any other name, so a client cannot choose the text of a footer", () => {
    expect(cleanClientName(undefined)).toBe("an AI tool");
    expect(cleanClientName("\u200b \n")).toBe("an AI tool");
    expect(cleanClientName("@everyone please review")).toBe("an AI tool");
    expect(cleanClientName("x".repeat(60))).toBe("an AI tool");
  });
});

describe("task titles", () => {
  it("uses the given title, else the first non-empty line, cut to 120 characters", () => {
    expect(taskTitle("Fix it\nmore detail", "Retry test")).toBe("Retry test");
    expect(taskTitle("\n\n  Fix the flaky retry test  \nThe test is in retry.test.ts")).toBe("Fix the flaky retry test");
    expect(taskTitle(`${"a".repeat(150)}\n`)).toBe("a".repeat(120));
    expect(taskTitle("\u0007\n")).toBe("Untitled task");
  });
});

describe("the summary (R18)", () => {
  it("is the last assistant message's text, and the orchestrator uses the same function", () => {
    const events = [
      { payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "First try failed." }] } } },
      { payload: { type: "tool_execution_end" } },
      { payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<thinking>x</thinking>All tests pass." }] } } },
    ];
    expect(lastAssistantResponse(events)).toBe("All tests pass.");
    expect(orchestratorCopy).toBe(lastAssistantResponse);
  });
});

describe("changed files from the workspace diff (R18)", () => {
  it("counts added and removed lines per file, per repository, and lists untracked files", () => {
    const diff = [
      "## demo", "", "### status", " M src/retry.ts", "?? notes/new.md", "### diff",
      "diff --git a/src/retry.ts b/src/retry.ts", "index 1..2 100644", "--- a/src/retry.ts", "+++ b/src/retry.ts",
      "@@ -1,3 +1,4 @@", " keep", "-old", "+new", "+added", "--- a removed line that starts with two dashes",
      "## docs", "", "### status", " M README.md", "### diff",
      "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-a", "+b",
    ].join("\n");
    expect(diffStat(diff)).toEqual([
      { repository: "demo", path: "src/retry.ts", added: 2, removed: 2 },
      { repository: "demo", path: "notes/new.md", added: 0, removed: 0 },
      { repository: "docs", path: "README.md", added: 1, removed: 1 },
    ]);
  });

  it("stops at the limit", () => {
    const one = (index: number) => [`diff --git a/f${index} b/f${index}`, "@@ -0,0 +1 @@", "+x"].join("\n");
    const diff = ["## demo", "### diff", ...Array.from({ length: 5 }, (_, index) => one(index))].join("\n");
    expect(diffStat(diff, 3)).toHaveLength(3);
  });
});

describe("the task view", () => {
  it("parses a view with extra fields a newer control plane may add", () => {
    const view = {
      taskId: requestId, title: "Fix", project: "payments", status: "RUNNING", startingRevision: 7, client: "Claude Code", shared: false,
      createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:05.000Z", events: [], futureField: 1,
    };
    expect(DeveloperTaskViewSchema.parse(view).status).toBe("RUNNING");
  });
});

describe("developer API 1.1 (R23)", () => {
  it("reports 1.1 and adds the project's task policy and channel names", () => {
    expect(DEVELOPER_API_VERSION).toBe("1.1");
    const project = DeveloperProjectSchema.parse({
      name: "payments", latestRevision: 7, access: "channel",
      channels: [{ channelId: "C0123456789", name: "payments-dev", isPrivate: false }],
      tasks: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true },
    });
    expect(project.channels[0]?.name).toBe("payments-dev");
  });

  it("names the channel-info request DeveloperIdentity answers", () => {
    expect(ChannelInfoRequestSchema.parse({ kind: "channel-info", channelIds: ["C0123456789"] })).toEqual({ kind: "channel-info", channelIds: ["C0123456789"] });
    expect(ChannelInfoRequestSchema.safeParse({ kind: "channel-info", channelIds: Array.from({ length: 51 }, () => "C0123456789") }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-shapes.test.ts`
Expected: FAIL, `StartDeveloperTaskRequestSchema` is not exported.

- [ ] **Step 3: Write `developer-tasks.ts`**

```ts
// packages/contracts/src/developer-tasks.ts
// Spec 025 phase 25b: the developer task API's names and wire shapes. Requests are strict; the MCP
// server parses responses with the non-strict schemas here, so a newer control plane can add fields.
import { Buffer } from "node:buffer";
import { z } from "zod";
import { cleanDisplayName } from "./display-name.js";
import { OperationStatusSchema } from "./operation.js";
import { DeveloperShareModeSchema } from "./project.js";

export const DEVELOPER_TASK_OWNER_ISSUER = "agentx-developer-task";
export const DEVELOPER_INSTRUCTIONS_MAX_BYTES = 65_536;
export const DEVELOPER_TASK_TITLE_MAX = 120;
export const DEVELOPER_CLIENT_NAME_MAX = 40;
export const DEVELOPER_TASK_SUMMARY_MAX = 4_000;
export const DEVELOPER_FAILURE_MESSAGE_MAX = 1_000;
export const DEVELOPER_EVENT_TEXT_MAX = 300;
export const DEVELOPER_EVENTS_MAX = 50;
export const DEVELOPER_EVENTS_DEFAULT = 10;
export const DEVELOPER_TASK_LIST_MAX = 50;
export const DEVELOPER_TASK_LIST_DEFAULT = 20;
export const DEVELOPER_WAIT_MAX_SECONDS = 600;
export const UNKNOWN_CLIENT_NAME = "an AI tool";

export const DeveloperTaskStatusSchema = z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);
export type DeveloperTaskStatus = z.infer<typeof DeveloperTaskStatusSchema>;
export const ENDED_TASK_STATUSES: ReadonlySet<DeveloperTaskStatus> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);

export const DeveloperTaskFailureCategorySchema = z.enum(["setup_failed", "worker_unavailable", "task_failed", "timed_out", "interrupted", "publication_failed"]);
export type DeveloperTaskFailureCategory = z.infer<typeof DeveloperTaskFailureCategorySchema>;

export const DeveloperInstructionsSchema = z
  .string()
  .min(1, "instructions are empty")
  .refine((value) => Buffer.byteLength(value, "utf8") <= DEVELOPER_INSTRUCTIONS_MAX_BYTES, `instructions exceed ${DEVELOPER_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`);

const RequestIdSchema = z.string().uuid();
const hasControlCharacter = (value: string) => [...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
});

export const StartDeveloperTaskRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    project: z.string().min(1).max(200),
    instructions: DeveloperInstructionsSchema,
    title: z.string().max(DEVELOPER_TASK_TITLE_MAX).optional(),
    client: z.string().max(200).optional(),
    // 25c: sharing. 25b accepts the fields and refuses a request to share (R9).
    shareToChannel: z.boolean().optional(),
    shareMode: DeveloperShareModeSchema.optional(),
    channel: z.string().min(1).max(80).optional(),
  })
  .strict();
export type StartDeveloperTaskRequest = z.infer<typeof StartDeveloperTaskRequestSchema>;

export const ContinueDeveloperTaskRequestSchema = z.object({ requestId: RequestIdSchema, instructions: DeveloperInstructionsSchema }).strict();
export type ContinueDeveloperTaskRequest = z.infer<typeof ContinueDeveloperTaskRequestSchema>;

export const DeveloperTaskActionRequestSchema = z.object({ requestId: RequestIdSchema }).strict();

export const DeveloperPullRequestRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    title: z.string().trim().min(1).max(256).refine((value) => !hasControlCharacter(value), "title contains control characters"),
    body: z
      .string()
      .refine((value) => !value.includes("\0"), "body contains a NUL character")
      .refine((value) => Buffer.byteLength(value, "utf8") <= 30_000, "body exceeds 30000 UTF-8 bytes")
      .optional(),
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
    draft: z.boolean().default(true),
  })
  .strict();
export type DeveloperPullRequestRequest = z.infer<typeof DeveloperPullRequestRequestSchema>;

export const DeveloperTaskEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["status", "progress", "tool", "message", "error"]),
  text: z.string().max(DEVELOPER_EVENT_TEXT_MAX),
});
export type DeveloperTaskEvent = z.infer<typeof DeveloperTaskEventSchema>;

const PullRequestSummarySchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["open", "closed", "merged"]),
});

export const DeveloperTaskViewSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  project: z.string(),
  status: DeveloperTaskStatusSchema,
  failure: z.object({ category: DeveloperTaskFailureCategorySchema, message: z.string().max(DEVELOPER_FAILURE_MESSAGE_MAX) }).optional(),
  startingRevision: z.number().int().positive(),
  client: z.string(),
  shared: z.boolean(),
  closing: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  events: z.array(DeveloperTaskEventSchema).max(DEVELOPER_EVENTS_MAX),
  summary: z.string().max(DEVELOPER_TASK_SUMMARY_MAX).optional(),
  changedFiles: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative().optional() })).optional(),
  pullRequests: z.array(PullRequestSummarySchema).optional(),
  /** R22: what the latest close preflight found, when it refused to close. */
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
});
export type DeveloperTaskView = z.infer<typeof DeveloperTaskViewSchema>;

export const DeveloperTaskListItemSchema = DeveloperTaskViewSchema.pick({ taskId: true, title: true, project: true, status: true, shared: true, createdAt: true, updatedAt: true });
export type DeveloperTaskListItem = z.infer<typeof DeveloperTaskListItemSchema>;
export const DeveloperTaskListResponseSchema = z.object({ tasks: z.array(DeveloperTaskListItemSchema) });
export const DeveloperTaskResponseSchema = z.object({ task: DeveloperTaskViewSchema });
export const DeveloperCloseResponseSchema = z.object({
  task: DeveloperTaskViewSchema,
  closed: z.boolean(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
});
export type DeveloperCloseResponse = z.infer<typeof DeveloperCloseResponseSchema>;
export const DeveloperPullRequestResponseSchema = z.object({
  task: DeveloperTaskViewSchema,
  operationId: z.string().uuid(),
  operationStatus: OperationStatusSchema,
  pullRequest: PullRequestSummarySchema.optional(),
});
export type DeveloperPullRequestResponse = z.infer<typeof DeveloperPullRequestResponseSchema>;
export const DeveloperTaskEventsResponseSchema = z.object({ events: z.array(DeveloperTaskEventSchema) });

const KNOWN_CLIENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude[-_ ]?code\b/i, "Claude Code"],
  [/codex/i, "Codex"],
  [/cursor/i, "Cursor"],
];

/**
 * FR-033: the MCP client's clientInfo.name, cleaned like a Slack display name, then mapped to
 * "Claude Code", "Codex" or "Cursor", and otherwise "an AI tool". Only these four strings ever
 * reach a PR footer or a turn record, so a client cannot choose that text (R25).
 */
export function cleanClientName(value: string | undefined): string {
  const cleaned = value === undefined ? undefined : cleanDisplayName(value);
  if (cleaned === undefined) return UNKNOWN_CLIENT_NAME;
  const known = KNOWN_CLIENTS.find(([pattern]) => pattern.test(cleaned))?.[1] ?? UNKNOWN_CLIENT_NAME;
  return known.slice(0, DEVELOPER_CLIENT_NAME_MAX);
}

// Control, format and separator characters that must not reach a title.
// eslint-disable-next-line no-control-regex
const TITLE_NOISE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/gu;

/** FR-030: the given title, else the first non-empty line of the instructions, at most 120 characters. */
export function taskTitle(instructions: string, title?: string): string {
  const firstLine = instructions.split(/\r\n|\r|\n/).find((line) => line.trim() !== "") ?? "";
  const source = title !== undefined && title.trim() !== "" ? title : firstLine;
  const clean = source.replace(TITLE_NOISE, " ").replace(/\s+/g, " ").trim();
  const cut = Array.from(clean).slice(0, DEVELOPER_TASK_TITLE_MAX).join("").trimEnd();
  return cut === "" ? "Untitled task" : cut;
}

/** The text of the last assistant message among a worker's events (pi's message_end), without thinking blocks. */
export function lastAssistantResponse(events: ReadonlyArray<{ payload: unknown }>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (!payload || typeof payload !== "object") continue;
    const event = payload as Record<string, unknown>;
    if (event.type !== "message_end" || !event.message || typeof event.message !== "object") continue;
    const message = event.message as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const content = block as Record<string, unknown>;
        return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
      })
      .join("\n")
      .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, "")
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

export interface ChangedFile { repository: string; path: string; added: number; removed: number }

/**
 * Changed files from the worker's workspace.diff artifact: per repository a "## <name>" section
 * with "### status" (git status --short) and "### diff" (git diff HEAD). Lines are counted only
 * inside hunks, so a removed line that starts with "--" is not taken for a file header.
 * Untracked files (status "??") are listed with no line counts, since git diff HEAD omits them.
 */
export function diffStat(diff: string, limit = 200): ChangedFile[] {
  const files: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];
  let repository = "";
  let section: "none" | "status" | "diff" = "none";
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const heading = /^## (\S+)$/.exec(line);
    if (heading) {
      repository = heading[1]!;
      section = "none";
      current = undefined;
      inHunk = false;
      continue;
    }
    if (line === "### status") { section = "status"; continue; }
    if (line === "### diff") { section = "diff"; continue; }
    if (section === "status") {
      const entry = /^\?\? (.+)$/.exec(line);
      if (entry) untracked.push({ repository, path: entry[1]!, added: 0, removed: 0 });
      continue;
    }
    if (section !== "diff") continue;
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      current = { repository, path: header[1]!, added: 0, removed: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  const byRepository = new Map<string, ChangedFile[]>();
  for (const file of [...files, ...untracked.filter((entry) => !files.some((file) => file.repository === entry.repository && file.path === entry.path))]) {
    byRepository.set(file.repository, [...(byRepository.get(file.repository) ?? []), file]);
  }
  return [...byRepository.values()].flat().slice(0, limit);
}
```

Add `export * from "./developer-tasks.js";` to `packages/contracts/src/index.ts`, after the
`developer.js` line.

- [ ] **Step 4: Point the orchestrator at the shared copy**

In `packages/orchestrator/src/control-plane-api.ts`, delete the body of `lastAssistantResponse`
and the function itself, and add near the top:

```ts
import { lastAssistantResponse } from "@agentx/contracts";
export { lastAssistantResponse };
```

`completedTaskResult` keeps calling `lastAssistantResponse(events)`; its argument type
(`RemoteEventPage["events"]`) fits `ReadonlyArray<{ payload: unknown }>`.

- [ ] **Step 5: Version 1.1, project policy, channel names and `channel-info`**

In `packages/contracts/src/developer.ts`:
- change `DEVELOPER_API_VERSION` to `"1.1"`;
- add `import { DeveloperTaskPolicySchema } from "./project.js";`;
- replace `DeveloperProjectSchema` with:

```ts
export const DeveloperProjectSchema = z.object({
  name: z.string().min(1),
  latestRevision: z.number().int().positive(),
  access: z.enum(["granted", "channel"]),
  channels: z.array(z.object({ channelId: SlackChannelIdSchema, name: z.string().optional(), isPrivate: z.boolean().optional() })),
  // Absent from a 1.0 control plane.
  tasks: DeveloperTaskPolicySchema.optional(),
});
```

- append:

```ts
/** R10: the names and privacy of bound channels, read by DeveloperIdentity with the bot token. */
export const ChannelInfoRequestSchema = z
  .object({
    kind: z.literal("channel-info"),
    channelIds: z.array(SlackChannelIdSchema).max(CHANNEL_MEMBERS_MAX_CHANNELS),
  })
  .strict();
export type ChannelInfoRequest = z.infer<typeof ChannelInfoRequestSchema>;
export type ChannelInfoResponse =
  | { ok: true; channels: Array<{ channelId: string; name: string; isPrivate: boolean }> }
  | { ok: false; error: "slack_unavailable" }
  | { ok: false; error: "invalid_request" };
```

In `tests/contract/developer-contracts.test.ts:28`, change the expected version `"1.0"` to
`"1.1"` (the only existing assertion this plan changes; Owner decision 12). The fixtures that
report `apiVersion: "1.0"` in other suites stay as they are: they test the CLI against a 1.0
server, which `apiVersionCompatible` still accepts.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/developer-task-shapes.test.ts tests/contract/developer-contracts.test.ts tests/contract/orchestrator-characterization.test.ts tests/contract/orchestration-tools-characterization.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src packages/orchestrator/src/control-plane-api.ts tests/contract/developer-task-shapes.test.ts tests/contract/developer-contracts.test.ts
git commit -m "feat(contracts): developer task API shapes, API version 1.1 (spec 025 FR-016, FR-025, FR-033)"
```

---

### Task 3: AI-tool turn records

FR-037 and R12: the schema, keys, and the admin export reading both kinds.

**Files:**
- Modify: `packages/contracts/src/turns.ts`
- Modify: `packages/broker/src/aws/turns.ts`
- Test: `tests/contract/turn-record-contract.test.ts` (append), `tests/contract/turn-export.test.ts` (append)

**Interfaces:**
- Consumes: `SlackUserIdSchema`.
- Produces:
  - `TurnRecordSchema` gains `origin?: "slack"` (absent reads as Slack);
  - `AiToolTurnRecordSchema`, `type AiToolTurnRecord` with fields `origin: "ai_tool"`, `taskId`,
    `turnId` (UUIDs), `action: "start" | "continue" | "pull_request" | "cancel" | "close"`,
    `phase: "accepted" | "completed" | "refused"`,
    `developer: { developerId; provider: "slack" | "oidc"; displayName; slackUserId? }`,
    `client`, `receivedAt`, `project?`, `settingsRevision?`, `workspaceId?`, `operationId?`,
    `outcome: "accepted" | "refused" | "succeeded" | "failed" | "cancelled" | "interrupted"`,
    `startedAt`, `finishedAt`, `durationMs`, `requestText`, `responseText`, `textTruncated?`,
    `error?: { code }`;
  - `type ExportedTurnRecord = TurnRecord | AiToolTurnRecord`;
  - `aiToolTurnRecordKeys(record: Pick<AiToolTurnRecord, "taskId" | "receivedAt" | "turnId">)`
    returning `{ pk: "TASK#<taskId>", sk: "TURN#<receivedAt>#<turnId>", exportPk: "TURNS", exportSk: "<receivedAt>#<turnId>", expiresAt }`;
  - `TurnRecordExport.page` returns `{ turns: ExportedTurnRecord[]; cursor?; skipped? }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/turn-record-contract.test.ts`:

```ts
import { AiToolTurnRecordSchema, aiToolTurnRecordKeys, type AiToolTurnRecord } from "../../packages/contracts/src/turns.js";

describe("AI-tool turn records (spec 025 FR-037)", () => {
  const aiRecord: AiToolTurnRecord = {
    origin: "ai_tool",
    taskId: "44444444-4444-4444-8444-444444444444",
    turnId: "55555555-5555-4555-8555-555555555555",
    action: "start",
    phase: "accepted",
    developer: { developerId: "d".repeat(64), provider: "slack", displayName: "Maya Chen", slackUserId: "U0MAYA001" },
    client: "Claude Code",
    receivedAt: "2026-09-27T12:00:00.000Z",
    project: "payments",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    outcome: "accepted",
    startedAt: "2026-09-27T12:00:00.000Z",
    finishedAt: "2026-09-27T12:00:00.200Z",
    durationMs: 200,
    requestText: "Fix the flaky retry test",
    responseText: "STARTING",
  };

  it("round-trips, with no Slack event ID or Slack requester", () => {
    expect(AiToolTurnRecordSchema.parse(aiRecord)).toEqual(aiRecord);
    expect(AiToolTurnRecordSchema.safeParse({ ...aiRecord, eventId: "EvX1234" }).success).toBe(false);
  });

  it("is keyed by task and exported on the same time index, kept 30 days", () => {
    expect(aiToolTurnRecordKeys(aiRecord)).toEqual({
      pk: "TASK#44444444-4444-4444-8444-444444444444",
      sk: "TURN#2026-09-27T12:00:00.000Z#55555555-5555-4555-8555-555555555555",
      exportPk: "TURNS",
      exportSk: "2026-09-27T12:00:00.000Z#55555555-5555-4555-8555-555555555555",
      expiresAt: Math.floor(Date.parse(aiRecord.receivedAt) / 1000) + 30 * 86_400,
    });
  });

  it("still parses Slack records written before origin existed, and with origin slack", () => {
    const slack = TurnRecordSchema.parse(record);
    expect(slack).not.toHaveProperty("origin");
    expect(TurnRecordSchema.parse({ ...slack, origin: "slack" }).origin).toBe("slack");
    expect(TurnRecordSchema.safeParse({ ...slack, origin: "ai_tool" }).success).toBe(false);
  });
});
```

`record` is the Slack record already declared at the top of this file.

Append to `tests/contract/turn-export.test.ts`:

```ts
import { aiToolTurnRecordKeys, type AiToolTurnRecord } from "../../packages/contracts/src/turns.js";

function aiTool(turnId: string, receivedAt: string): Record<string, unknown> {
  const record: AiToolTurnRecord = {
    origin: "ai_tool", taskId: "44444444-4444-4444-8444-444444444444", turnId, action: "start", phase: "accepted",
    developer: { developerId: "d".repeat(64), provider: "oidc", displayName: "Maya Chen" }, client: "Codex", receivedAt, workspaceId,
    outcome: "accepted", startedAt: receivedAt, finishedAt: receivedAt, durationMs: 0, requestText: "run the tests", responseText: "STARTING",
  };
  return { ...aiToolTurnRecordKeys(record), ...record };
}

describe("turn record export with AI-tool records (spec 025 FR-037)", () => {
  it("returns Slack and AI-tool records together, newest first, with the project added", async () => {
    const items = [aiTool("55555555-5555-4555-8555-555555555555", "2026-09-24T11:00:00.000Z"), stored("EvTURN00031", "2026-09-24T10:00:00.000Z")];
    const { exporter: turns } = exporter({ page: async () => ({ items }) });
    const result = await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }));
    expect(result.turns.map((turn) => ("origin" in turn && turn.origin === "ai_tool" ? turn.turnId : (turn as TurnRecord).eventId))).toEqual(["55555555-5555-4555-8555-555555555555", "EvTURN00031"]);
    expect(result.turns[0]).toMatchObject({ origin: "ai_tool", project: "payments" });
  });

  it("hands out and accepts a cursor that ends on an AI-tool record (Review Focus 4)", async () => {
    const last = aiTool("66666666-6666-4666-8666-666666666666", "2026-09-24T09:00:00.000Z");
    const lastEvaluatedKey = { pk: last.pk as string, sk: last.sk as string, exportPk: last.exportPk as string, exportSk: last.exportSk as string };
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [last], lastEvaluatedKey }));
    const { exporter: turns } = exporter({ page });
    const first = await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }));
    expect(first.cursor).toBeDefined();
    await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z", cursor: first.cursor! }));
    expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ exclusiveStartKey: lastEvaluatedKey }));
  });

  it("logs a malformed AI-tool record's field name, like a Slack one's", async () => {
    const malformed = { ...aiTool("77777777-7777-4777-8777-777777777777", "2026-09-24T08:00:00.000Z"), outcome: "exploded" };
    const { exporter: turns, log } = exporter({ page: async () => ({ items: [malformed] }) });
    expect((await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }))).turns).toEqual([]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "turn_record.invalid", count: 1, fields: ["outcome"] });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/turn-record-contract.test.ts tests/contract/turn-export.test.ts`
Expected: FAIL, `AiToolTurnRecordSchema` is not exported.

- [ ] **Step 3: Add the schema and keys**

In `packages/contracts/src/turns.ts`, add `origin: z.literal("slack").optional(),` to
`TurnRecordSchema`'s extension (after `eventId`), then append:

```ts
/** Spec 025 FR-037: one developer action from an AI tool, keyed by task, in the same table and export. */
export const AiToolTurnRecordSchema = z.object({
  origin: z.literal("ai_tool"),
  taskId: z.string().uuid(),
  turnId: z.string().uuid(),
  action: z.enum(["start", "continue", "pull_request", "cancel", "close"]),
  phase: z.enum(["accepted", "completed", "refused"]),
  developer: z.object({
    developerId: Hex64,
    provider: z.enum(["slack", "oidc"]),
    displayName: z.string().min(1).max(200),
    slackUserId: SlackUserIdSchema.optional(),
  }).strict(),
  client: z.string().min(1).max(40),
  receivedAt: z.string().datetime(),
  /** Added at export from the workspace record; never stored. */
  project: z.string().max(63).optional(),
  settingsRevision: z.number().int().positive().optional(),
  workspaceId: z.string().uuid().optional(),
  operationId: z.string().uuid().optional(),
  outcome: z.enum(["accepted", "refused", "succeeded", "failed", "cancelled", "interrupted"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  requestText: z.string().max(TURN_TEXT_LIMIT),
  responseText: z.string().max(TURN_TEXT_LIMIT),
  textTruncated: z.boolean().optional(),
  error: z.object({ code: z.string().max(64) }).strict().optional(),
}).strict();
export type AiToolTurnRecord = z.infer<typeof AiToolTurnRecordSchema>;
export type ExportedTurnRecord = TurnRecord | AiToolTurnRecord;

export function aiToolTurnRecordKeys(record: Pick<AiToolTurnRecord, "taskId" | "receivedAt" | "turnId">) {
  const at = `${record.receivedAt}#${record.turnId}`;
  return {
    pk: `TASK#${record.taskId}`,
    sk: `TURN#${at}`,
    exportPk: TURN_EXPORT_PARTITION,
    exportSk: at,
    expiresAt: Math.floor(Date.parse(record.receivedAt) / 1000) + TURN_RETENTION_DAYS * 86_400,
  } as const;
}
```

- [ ] **Step 4: Export both kinds**

In `packages/broker/src/aws/turns.ts`:
- import `AiToolTurnRecordSchema` and `type ExportedTurnRecord`;
- in `page()`, choose the schema per item, and keep the field logging per schema:

```ts
      const schema = item.origin === "ai_tool" ? AiToolTurnRecordSchema : TurnRecordSchema;
      const parsed = schema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
      if (!parsed.success) {
        invalid += 1;
        if (invalidKeys.length < LOGGED_KEY_LIMIT) invalidKeys.push(typeof item.sk === "string" ? item.sk.slice(0, 160) : "unknown");
        for (const issue of parsed.error.issues) {
          if (invalidFields.size >= LOGGED_KEY_LIMIT) break;
          const field = issue.path[0];
          invalidFields.add(typeof field === "string" && Object.hasOwn(schema.shape, field) ? field : "(root)");
        }
        continue;
      }
```

- type `records` as `{ record: ExportedTurnRecord; ... }[]`, `turns` as `ExportedTurnRecord[]`, and
  the return type of `page` as `Promise<{ turns: ExportedTurnRecord[]; cursor?: string; skipped?: number }>`;
- in `parseCursor`, replace `if (!key.pk.startsWith("THREAD#") || ...` with:

```ts
  // The shapes turnRecordKeys and aiToolTurnRecordKeys write.
  if (!(key.pk.startsWith("THREAD#") || key.pk.startsWith("TASK#")) || key.sk !== `TURN#${key.exportSk}`) return undefined;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/turn-record-contract.test.ts tests/contract/turn-export.test.ts tests/contract/slack-details.test.ts tests/contract/slack-details-contract.test.ts tests/contract/turn-records-infrastructure.test.ts && npm run typecheck`
Expected: PASS. The Details view reads only Slack records (`THREAD#` keys) and is unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/turns.ts packages/broker/src/aws/turns.ts tests/contract/turn-record-contract.test.ts tests/contract/turn-export.test.ts
git commit -m "feat(turns): AI-tool turn records keyed by task, in the admin export (spec 025 FR-037)"
```

---
### Task 4: Task records, status rules and audit records

R2, R4, R5, R12, R14's footer and the task's event text, as pure functions with no I/O.

**Files:**
- Create: `packages/broker/src/developer/task-records.ts`
- Modify: `packages/broker/src/aws/broker.ts` (import `inertName` from the new file and delete
  the local copy; `attributionText` keeps calling it)
- Test: `tests/contract/developer-task-records.test.ts`

**Interfaces:**
- Consumes: Task 2's constants and `lastAssistantResponse`; Task 3's `AiToolTurnRecordSchema`,
  `aiToolTurnRecordKeys`; `redactAndCap`, `redactText`.
- Produces:
  - `type CounterKey = { pk: string; sk: string }`, `type WorkspaceCharge = { member: CounterKey; organization: CounterKey }`;
  - `interface DeveloperTaskRecord` (fields in R2), `interface DeveloperTaskIndexRecord`,
    `interface DeveloperTaskPointerRecord { taskId; developerId; requester: DeveloperRequester; conversationId; firstRequestId; pendingPrompt?; cancelledAt? }`;
  - `taskKey(taskId)`, `taskIndexKey(developerId, createdAt, taskId)`, `taskPointerKey(workspaceId)`,
    `startIdempotencyKey(developerId, requestId)`;
  - `taskOwnerSubject(developerId, taskId): string`, `taskOwnerKey(developerId, taskId): string`;
  - `interface OperationFacts { id: string; kind: string; status: string; error?: string; createdAt: string }`;
  - `currentOperation(operations: readonly OperationFacts[]): OperationFacts | undefined`;
  - `deriveTaskStatus(input: { closedAt?: string; workspaceStatus: string; pointer?: { pendingPrompt?: string; cancelledAt?: string }; operations: readonly OperationFacts[] }): { status: DeveloperTaskStatus; failure?: { category: DeveloperTaskFailureCategory; message: string }; closing: boolean; current?: OperationFacts }`;
  - `failureCategory(kind: string, status: string, error: string | undefined): DeveloperTaskFailureCategory`;
  - `interface StoredEvent { sequence: number; type: string; timestamp: string; payload: unknown }`;
  - `taskEvent(event: StoredEvent): DeveloperTaskEvent | undefined`,
    `recentTaskEvents(newestFirst: readonly StoredEvent[], count: number): DeveloperTaskEvent[]` (oldest first);
  - `interface TurnParty { taskId; developerId; provider; developerName; slackUserId?; client; workspaceId?; settingsRevision? }`;
  - `aiToolTurn(input: { party: TurnParty; turnId: string; action: AiToolTurnRecord["action"]; phase: AiToolTurnRecord["phase"]; outcome: AiToolTurnRecord["outcome"]; receivedAt: string; finishedAt: string; request: string; response: string; operationId?: string; errorCode?: string }): Record<string, unknown>`
    (the record plus its keys, validated);
  - `inertName(name: string): string` (moved from `broker.ts`), `developerFooter(name: string, client: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-records.test.ts
import { describe, expect, it } from "vitest";
import { AiToolTurnRecordSchema } from "../../packages/contracts/src/index.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import {
  aiToolTurn,
  deriveTaskStatus,
  developerFooter,
  failureCategory,
  recentTaskEvents,
  taskOwnerKey,
  type OperationFacts,
  type StoredEvent,
} from "../../packages/broker/src/developer/task-records.js";

const developerId = "d".repeat(64);
const taskId = "44444444-4444-4444-8444-444444444444";
const op = (kind: string, status: string, createdAt: string, error?: string): OperationFacts => ({
  id: `${kind}-${createdAt}`, kind, status, createdAt, ...(error === undefined ? {} : { error }),
});
const PLANTED = "xoxb-1111111111-planted-secret";

describe("the task's owner key (FR-017)", () => {
  it("is ownerKeyForSubject over agentx-developer-task and developer/task", () => {
    expect(taskOwnerKey(developerId, taskId)).toBe(ownerKeyForSubject("agentx-developer-task", `${developerId}/${taskId}`));
    expect(taskOwnerKey(developerId, taskId)).not.toBe(taskOwnerKey(developerId, "55555555-5555-4555-8555-555555555555"));
  });
});

describe("task status (R4, FR-025)", () => {
  it.each([
    ["the instructions are waiting", { workspaceStatus: "PREPARING", pointer: { pendingPrompt: "x" }, operations: [op("prepare", "RUNNING", "t1")] }, "STARTING"],
    ["cancelled before it ran", { workspaceStatus: "PREPARING", pointer: { cancelledAt: "t2" }, operations: [op("prepare", "RUNNING", "t1")] }, "CANCELLED"],
    ["a running task", { workspaceStatus: "BUSY", pointer: {}, operations: [op("prepare", "SUCCEEDED", "t1"), op("task", "RUNNING", "t2")] }, "RUNNING"],
    ["a finished task", { workspaceStatus: "READY", pointer: {}, operations: [op("prepare", "SUCCEEDED", "t1"), op("task", "SUCCEEDED", "t2")] }, "SUCCEEDED"],
    ["a publish after it", { workspaceStatus: "BUSY", pointer: {}, operations: [op("task", "SUCCEEDED", "t2"), op("publish", "DISPATCHING", "t3")] }, "RUNNING"],
    ["a cancel operation does not count", { workspaceStatus: "READY", pointer: {}, operations: [op("task", "CANCELLED", "t2"), op("cancel", "SUCCEEDED", "t3")] }, "CANCELLED"],
    ["closed", { closedAt: "t9", workspaceStatus: "CLOSED", pointer: {}, operations: [op("task", "SUCCEEDED", "t2")] }, "CLOSED"],
  ] as const)("%s", (_name, input, status) => {
    expect(deriveTaskStatus(input).status).toBe(status);
  });

  it("gives a failed prepare setup_failed, with the redacted, capped error", () => {
    const derived = deriveTaskStatus({ workspaceStatus: "PREPARATION_FAILED", pointer: { pendingPrompt: "x" }, operations: [op("prepare", "FAILED", "t1", `clone failed ${PLANTED} ${"e".repeat(2_000)}`)] });
    expect(derived.status).toBe("FAILED");
    expect(derived.failure?.category).toBe("setup_failed");
    expect(derived.failure?.message).not.toContain(PLANTED);
    expect(derived.failure?.message.length).toBeLessThanOrEqual(1_000);
  });

  it("marks a close in progress without changing the status", () => {
    const derived = deriveTaskStatus({ workspaceStatus: "CLOSING", pointer: {}, operations: [op("task", "SUCCEEDED", "t2"), op("close", "RUNNING", "t3")] });
    expect(derived).toMatchObject({ status: "SUCCEEDED", closing: true });
  });
});

describe("failure categories (R5)", () => {
  it.each([
    ["task", "INTERRUPTED", undefined, "interrupted"],
    ["prepare", "FAILED", "RUNTIME_UNAVAILABLE: worker dispatch failed after 5 attempts (Error)", "worker_unavailable"],
    ["task", "FAILED", "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request", "worker_unavailable"],
    ["prepare", "FAILED", "npm ci exited 1", "setup_failed"],
    ["publish", "FAILED", "push rejected", "publication_failed"],
    ["task", "FAILED", "the task timed out after 30 minutes", "timed_out"],
    ["task", "FAILED", "the model call failed: overloaded", "task_failed"],
  ] as const)("%s %s %s is %s", (kind, status, error, category) => {
    expect(failureCategory(kind, status, error)).toBe(category);
  });
});

describe("task events", () => {
  const event = (sequence: number, type: string, payload: unknown): StoredEvent => ({ sequence, type, timestamp: `2026-09-27T12:00:${String(sequence).padStart(2, "0")}.000Z`, payload });

  it("keeps status, progress, tools, assistant messages and errors, oldest first, and skips streaming noise", () => {
    const newestFirst = [
      event(6, "error", { message: `failed with ${PLANTED}` }),
      event(5, "progress", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests pass." }] } }),
      event(4, "progress", { type: "message_update", delta: "Te" }),
      event(3, "tool_end", { type: "tool_execution_end", toolName: "bash", isError: false }),
      event(2, "tool_start", { type: "tool_execution_start", toolName: "bash" }),
      event(1, "lifecycle", { status: "RUNNING" }),
    ];
    const events = recentTaskEvents(newestFirst, 10);
    expect(events.map((entry) => [entry.kind, entry.text])).toEqual([
      ["status", "Worker status: RUNNING"],
      ["tool", "Started bash"],
      ["tool", "Finished bash"],
      ["message", "Tests pass."],
      ["error", "failed with [REDACTED]"],
    ]);
  });

  it("returns the newest ones when there are more than asked for, and caps each at 300 characters", () => {
    const newestFirst = Array.from({ length: 30 }, (_, index) => event(30 - index, "progress", { message: `step ${30 - index} ${"x".repeat(400)}` }));
    const events = recentTaskEvents(newestFirst, 3);
    expect(events.map((entry) => entry.text.split(" ").slice(0, 2).join(" "))).toEqual(["step 28", "step 29", "step 30"]);
    expect(events.every((entry) => entry.text.length <= 300)).toBe(true);
  });
});

describe("AI-tool turn records (R12)", () => {
  const party = { taskId, developerId, provider: "slack" as const, developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code", workspaceId: "22222222-2222-4222-8222-222222222222" };

  it("builds a valid record with its keys, redacting the request", () => {
    const record = aiToolTurn({
      party, turnId: "55555555-5555-4555-8555-555555555555", action: "start", phase: "accepted", outcome: "accepted",
      receivedAt: "2026-09-27T12:00:00.000Z", finishedAt: "2026-09-27T12:00:00.250Z", request: `use ${PLANTED}`, response: "STARTING",
    });
    expect(record).toMatchObject({ pk: `TASK#${taskId}`, exportPk: "TURNS", durationMs: 250 });
    expect(JSON.stringify(record)).not.toContain(PLANTED);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the storage keys are dropped to check the stored fields
    const { pk, sk, exportPk, exportSk, expiresAt, ...stored } = record;
    expect(AiToolTurnRecordSchema.safeParse(stored).success).toBe(true);
  });

  it("caps long instructions and says the text was cut", () => {
    const record = aiToolTurn({
      party, turnId: "55555555-5555-4555-8555-555555555556", action: "start", phase: "accepted", outcome: "accepted",
      receivedAt: "2026-09-27T12:00:00.000Z", finishedAt: "2026-09-27T12:00:00.000Z", request: "run the tests. ".repeat(4_000), response: "STARTING",
    });
    expect((record.requestText as string).length).toBe(40_000);
    expect(record.textTruncated).toBe(true);
  });
});

describe("the PR footer (FR-023, R14)", () => {
  it("names the developer inertly and the client", () => {
    expect(developerFooter("Maya @here Chen", "Claude Code")).toBe("Requested by `Maya @here Chen` via AgentX, started from Claude Code");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-records.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the module**

```ts
// packages/broker/src/developer/task-records.ts
// Spec 025 phase 25b: a developer task's records, owner key, status and failure rules, event text
// and audit records. No I/O; aws/developer-tasks.ts and the broker's result hook call these.
import { createHash } from "node:crypto";
import {
  AiToolTurnRecordSchema,
  DEVELOPER_EVENT_TEXT_MAX,
  DEVELOPER_FAILURE_MESSAGE_MAX,
  DEVELOPER_TASK_OWNER_ISSUER,
  TURN_TEXT_LIMIT,
  aiToolTurnRecordKeys,
  redactAndCap,
  redactText,
  type AiToolTurnRecord,
  type DeveloperRequester,
  type DeveloperTaskEvent,
  type DeveloperTaskFailureCategory,
  type DeveloperTaskStatus,
} from "@agentx/contracts";

export interface CounterKey { pk: string; sk: string }
export interface WorkspaceCharge { member: CounterKey; organization: CounterKey }

/** DEVTASK#<taskId> / META: the task. */
export interface DeveloperTaskRecord {
  pk: string;
  sk: "META";
  entityType: "DEVELOPER_TASK";
  taskId: string;
  developerId: string;
  provider: "slack" | "oidc";
  developerName: string;
  slackUserId?: string;
  client: string;
  project: string;
  title: string;
  workspaceId: string;
  ownerKey: string;
  conversationId: string;
  startingRevision: number;
  charge: WorkspaceCharge;
  /** Phase 25c shares tasks; until then every task is private. */
  shared: false;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/** DEVELOPER#<developerId> / TASK#<createdAt>#<taskId>: the task index of FR-017. */
export interface DeveloperTaskIndexRecord {
  pk: string;
  sk: string;
  entityType: "DEVELOPER_TASK_INDEX";
  taskId: string;
  project: string;
  title: string;
  client: string;
  status: DeveloperTaskStatus;
  shared: boolean;
  startingRevision: number;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

/** WORKSPACE#<workspaceId> / DEVELOPER_TASK: how a worker callback finds the task (R2, R3). */
export interface DeveloperTaskPointerRecord {
  pk: string;
  sk: "DEVELOPER_TASK";
  entityType: "DEVELOPER_TASK_POINTER";
  taskId: string;
  developerId: string;
  requester: DeveloperRequester;
  conversationId: string;
  firstRequestId: string;
  /** The first instructions, until the prepare's result queues them (R3). */
  pendingPrompt?: string;
  /** Set when the task was cancelled before its instructions ran (R16). */
  cancelledAt?: string;
}

export const taskKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "META" as const });
export const taskIndexKey = (developerId: string, createdAt: string, taskId: string) => ({ pk: `DEVELOPER#${developerId}`, sk: `TASK#${createdAt}#${taskId}` });
export const taskPointerKey = (workspaceId: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK" as const });
export const startIdempotencyKey = (developerId: string, requestId: string) => ({ pk: `IDEMPOTENCY#${developerId}#DEVTASK`, sk: `REQUEST#${requestId}` });

export const taskOwnerSubject = (developerId: string, taskId: string): string => `${developerId}/${taskId}`;

/** FR-017: the same function as ownerKeyForSubject, so every workspace handler accepts it. */
export function taskOwnerKey(developerId: string, taskId: string): string {
  return createHash("sha256").update(DEVELOPER_TASK_OWNER_ISSUER).update("\0").update(taskOwnerSubject(developerId, taskId)).digest("hex");
}

export interface OperationFacts { id: string; kind: string; status: string; error?: string | undefined; createdAt: string }

const LIVE = new Set(["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"]);
const byCreated = (left: OperationFacts, right: OperationFacts) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0);

/** The newest task or publish operation: what the developer last asked for (R4). */
export function currentOperation(operations: readonly OperationFacts[]): OperationFacts | undefined {
  return operations.filter((operation) => operation.kind === "task" || operation.kind === "publish").sort(byCreated).at(-1);
}

const DISPATCH_OR_COMPUTE = /^RUNTIME_UNAVAILABLE:/;
const TIMED_OUT = /\btimed? ?out\b/i;

/** R5. */
export function failureCategory(kind: string, status: string, error: string | undefined): DeveloperTaskFailureCategory {
  if (status === "INTERRUPTED") return "interrupted";
  if (error !== undefined && DISPATCH_OR_COMPUTE.test(error)) return "worker_unavailable";
  if (kind === "prepare") return "setup_failed";
  if (kind === "publish") return "publication_failed";
  if (error !== undefined && TIMED_OUT.test(error)) return "timed_out";
  return "task_failed";
}

const failureOf = (kind: string, status: string, error: string | undefined) => ({
  category: failureCategory(kind, status, error),
  message: redactText(error ?? `the ${kind} operation ended ${status}`).slice(0, DEVELOPER_FAILURE_MESSAGE_MAX),
});

export interface DerivedStatus {
  status: DeveloperTaskStatus;
  failure?: { category: DeveloperTaskFailureCategory; message: string };
  closing: boolean;
  current?: OperationFacts;
}

/** R4's table. */
export function deriveTaskStatus(input: {
  closedAt?: string | undefined;
  workspaceStatus: string;
  pointer?: { pendingPrompt?: string | undefined; cancelledAt?: string | undefined } | undefined;
  operations: readonly OperationFacts[];
}): DerivedStatus {
  const closing = input.workspaceStatus === "CLOSING" || input.operations.some((operation) => operation.kind === "close" && LIVE.has(operation.status));
  const current = currentOperation(input.operations);
  const withCurrent = current === undefined ? {} : { current };
  if (input.closedAt !== undefined || input.workspaceStatus === "CLOSED") return { status: "CLOSED", closing: false, ...withCurrent };
  if (input.pointer?.cancelledAt !== undefined && current === undefined) return { status: "CANCELLED", closing };
  if (input.workspaceStatus === "PREPARATION_FAILED") {
    const prepare = input.operations.filter((operation) => operation.kind === "prepare").sort(byCreated).at(-1);
    return { status: "FAILED", closing, failure: failureOf("prepare", prepare?.status ?? "FAILED", prepare?.error) };
  }
  if (input.pointer?.pendingPrompt !== undefined || input.workspaceStatus === "PREPARING" || current === undefined) return { status: "STARTING", closing };
  if (LIVE.has(current.status)) return { status: "RUNNING", closing, current };
  const status = current.status as "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  return {
    status, closing, current,
    ...(status === "FAILED" || status === "INTERRUPTED" ? { failure: failureOf(current.kind, status, current.error) } : {}),
  };
}

export interface StoredEvent { sequence: number; type: string; timestamp: string; payload: unknown }

const text = (value: string) => redactText(value).replace(/\s+/g, " ").trim().slice(0, DEVELOPER_EVENT_TEXT_MAX);
const field = (payload: unknown, name: string): unknown => (payload && typeof payload === "object" ? (payload as Record<string, unknown>)[name] : undefined);

/** One worker event as a line the developer can read, or undefined for streaming noise. */
export function taskEvent(event: StoredEvent): DeveloperTaskEvent | undefined {
  const at = event.timestamp;
  const payload = event.payload;
  switch (event.type) {
    case "lifecycle":
    case "result": {
      const status = field(payload, "status");
      return typeof status === "string" ? { at, kind: "status", text: text(`Worker status: ${status}`) } : undefined;
    }
    case "error": {
      const message = field(payload, "message");
      return { at, kind: "error", text: text(typeof message === "string" ? message : "the worker reported an error") };
    }
    case "tool_start":
    case "tool_end": {
      const name = field(payload, "toolName");
      const tool = typeof name === "string" ? name : "a tool";
      const verb = event.type === "tool_start" ? "Started" : field(payload, "isError") === true ? "Failed" : "Finished";
      return { at, kind: "tool", text: text(`${verb} ${tool}`) };
    }
    case "progress": {
      const message = field(payload, "message");
      if (typeof message === "string") return { at, kind: "progress", text: text(message) };
      if (field(payload, "type") !== "message_end") return undefined;
      const said = lastText(message);
      return said === undefined ? undefined : { at, kind: "message", text: text(said) };
    }
    default:
      return undefined;
  }
}

function lastText(message: unknown): string | undefined {
  if (field(message, "role") !== "assistant") return undefined;
  const content = field(message, "content");
  if (!Array.isArray(content)) return undefined;
  const joined = content.flatMap((block) => (field(block, "type") === "text" && typeof field(block, "text") === "string" ? [field(block, "text") as string] : [])).join(" ")
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, "").trim();
  return joined === "" ? undefined : joined;
}

/** The newest `count` readable events, returned oldest first. */
export function recentTaskEvents(newestFirst: readonly StoredEvent[], count: number): DeveloperTaskEvent[] {
  const picked: DeveloperTaskEvent[] = [];
  for (const event of newestFirst) {
    if (picked.length >= count) break;
    const readable = taskEvent(event);
    if (readable !== undefined) picked.push(readable);
  }
  return picked.reverse();
}

export interface TurnParty {
  taskId: string;
  developerId: string;
  provider: "slack" | "oidc";
  developerName: string;
  slackUserId?: string | undefined;
  client: string;
  workspaceId?: string | undefined;
  settingsRevision?: number | undefined;
}

/** R12: one immutable AI-tool turn record and its keys. Free text only through redactAndCap. */
export function aiToolTurn(input: {
  party: TurnParty;
  turnId: string;
  action: AiToolTurnRecord["action"];
  phase: AiToolTurnRecord["phase"];
  outcome: AiToolTurnRecord["outcome"];
  receivedAt: string;
  finishedAt: string;
  request: string;
  response: string;
  operationId?: string | undefined;
  errorCode?: string | undefined;
}): Record<string, unknown> & AiToolTurnRecord {
  const request = redactAndCap(input.request, TURN_TEXT_LIMIT);
  const response = redactAndCap(input.response, TURN_TEXT_LIMIT);
  const { party } = input;
  const record = AiToolTurnRecordSchema.parse({
    origin: "ai_tool",
    taskId: party.taskId,
    turnId: input.turnId,
    action: input.action,
    phase: input.phase,
    developer: {
      developerId: party.developerId,
      provider: party.provider,
      displayName: party.developerName.slice(0, 200) || "developer",
      ...(party.slackUserId === undefined ? {} : { slackUserId: party.slackUserId }),
    },
    client: party.client,
    receivedAt: input.receivedAt,
    ...(party.settingsRevision === undefined ? {} : { settingsRevision: party.settingsRevision }),
    ...(party.workspaceId === undefined ? {} : { workspaceId: party.workspaceId }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    outcome: input.outcome,
    startedAt: input.receivedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.receivedAt)),
    requestText: request.text,
    responseText: response.text,
    ...(request.truncated || response.truncated ? { textTruncated: true } : {}),
    ...(input.errorCode === undefined ? {} : { error: { code: input.errorCode.slice(0, 64) } }),
  });
  return { ...aiToolTurnRecordKeys(record), ...record };
}

/**
 * Text as a GFM code span, which GitHub renders literally: no mention, link, autolink, HTML or
 * issue reference. Per CommonMark the fence is one backtick longer than the text's longest
 * backtick run, padded with a space when the text starts or ends with a backtick.
 */
export function inertName(name: string): string {
  const longestRun = Math.max(0, ...(name.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = name.startsWith("`") || name.endsWith("`") ? " " : "";
  return `${fence}${pad}${name}${pad}${fence}`;
}

/** FR-023. The client is one of the four names cleanClientName gives, so it needs no escaping. */
export function developerFooter(name: string, client: string): string {
  return `Requested by ${inertName(name)} via AgentX, started from ${client}`;
}
```

In `broker.ts`, delete the local `inertName` and add `inertName` to a new import from
`"../developer/task-records.js"`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/developer-task-records.test.ts tests/contract/github-mcp-broker.test.ts tests/contract/generic-connector-routes.test.ts && npm run typecheck`
Expected: PASS. The two connector suites cover the Slack attribution that still uses `inertName`.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/developer/task-records.ts packages/broker/src/aws/broker.ts tests/contract/developer-task-records.test.ts
git commit -m "feat(broker): developer task records, status rules and AI-tool turn records (spec 025 FR-017, FR-025, FR-037)"
```

---

### Task 5: Shared workspace limits and the limits setting

FR-020, R6 and R7. The Slack paths change only in where the two numbers come from, so their
existing limit tests are the characterization; this task adds the setting's cases.

**Files:**
- Create: `packages/broker/src/developer/limits.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`ensureThreadWorkspace`, `startThreadPreparation`)
- Test: `tests/contract/workspace-limits.test.ts`

**Interfaces:**
- Consumes: `CounterKey`, `WorkspaceCharge` (Task 4).
- Produces:
  - `WORKSPACE_LIMITS_KEY = { pk: "SETTINGS", sk: "WORKSPACE_LIMITS" }`; the item's fields are
    `perPerson` (1 to 50), `perOrganization` (1 to 1,000), `updatedBy`, `updatedAt` (25e writes it);
  - `interface WorkspaceLimits { member: number; organization: number; source: "setting" | "parameters" }`;
  - `readWorkspaceLimits(client, tableName, fallback: { member: number; organization: number }, log?): Promise<WorkspaceLimits>`;
  - `developerCharge(input: { teamId?: string; slackUserId?: string; developerId: string }): WorkspaceCharge`;
  - `chargeItems(tableName, charge, limits: { member: number; organization: number }, taskId): TransactItems`;
  - `releaseItems(tableName, charge, taskId): TransactItems`;
  - `limitReached(client, tableName, charge, limits): Promise<"member" | "organization" | undefined>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/workspace-limits.test.ts
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { chargeItems, developerCharge, limitReached, readWorkspaceLimits, releaseItems } from "../../packages/broker/src/developer/limits.js";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const fallback = { member: 3, organization: 20 };
const thread = (n: number) => `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.00000${n}`;

beforeAll(async () => {
  await loadSlackBroker();
});

describe("readWorkspaceLimits (FR-053, R7)", () => {
  it("uses the stack parameters when no admin has set the limits", async () => {
    expect(await readWorkspaceLimits(new FakeDynamoDb(), "state", fallback)).toEqual({ member: 3, organization: 20, source: "parameters" });
  });

  it("uses the setting with a consistent read when it is set", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 5, perOrganization: 40, updatedBy: "admin", updatedAt: "2026-09-27T00:00:00.000Z" });
    const send = vi.spyOn(db, "send");
    expect(await readWorkspaceLimits(db, "state", fallback)).toEqual({ member: 5, organization: 40, source: "setting" });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Key: { pk: "SETTINGS", sk: "WORKSPACE_LIMITS" }, ConsistentRead: true });
  });

  it.each([
    [{ perPerson: 0, perOrganization: 20 }],
    [{ perPerson: 51, perOrganization: 100 }],
    [{ perPerson: 5, perOrganization: 4 }],
    [{ perPerson: "5", perOrganization: 20 }],
    [{ perOrganization: 20 }],
  ])("falls back to the parameters, and logs it, for a setting it cannot use: %j", async (fields) => {
    const db = new FakeDynamoDb();
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", ...fields });
    const log = vi.fn();
    expect(await readWorkspaceLimits(db, "state", fallback, log)).toEqual({ ...fallback, source: "parameters" });
    expect(log).toHaveBeenCalledWith({ event: "workspace_limits.invalid_setting" });
  });
});

describe("developer counters (FR-020, R6)", () => {
  const developerId = "d".repeat(64);

  it("shares the linked Slack member's counter and the Slack organization counter", () => {
    expect(developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId })).toEqual({
      member: { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001" },
      organization: { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION" },
    });
  });

  it("gives an unlinked developer their own counter, and uses the developer organization counter without a team", () => {
    expect(developerCharge({ teamId: SLACK_TEAM, developerId }).member).toEqual({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER" });
    expect(developerCharge({ developerId }).organization).toEqual({ pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" });
  });

  it("charges and releases one slot on each counter, and records the task in a set, never in threads", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", entityType: "SLACK_LIMIT", count: 1, threads: [thread(1)] });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-1") } });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 2, threads: [thread(1)], tasks: new Set(["task-1"]) });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-1") } });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 1, threads: [thread(1)] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).not.toHaveProperty("tasks");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it("refuses a charge at the limit, and says which counter is full", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", count: 3 });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await expect(db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-2") } })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(await limitReached(db, "state", charge, fallback)).toBe("member");
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", count: 0 });
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION", count: 20 });
    expect(await limitReached(db, "state", charge, fallback)).toBe("organization");
  });
});

describe("Slack threads read the setting too (R7)", () => {
  it("uses the setting's per-person limit at workspace creation", async () => {
    const { db, handler } = createBroker({ memberLimit: 3 });
    await registerSlackProject(handler);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 1, perOrganization: 20 });
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body.created).toBe(true);
    expect((await ensureWorkspace(handler, thread(2), "U0PRATIK01")).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
  });

  it("keeps existing workspaces when the limit is lowered below the count, and refuses new ones", async () => {
    const { db, handler } = createBroker({ memberLimit: 3 });
    await registerSlackProject(handler);
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body.created).toBe(true);
    expect((await ensureWorkspace(handler, thread(2), "U0PRATIK01")).body.created).toBe(true);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 1, perOrganization: 20 });
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body).toMatchObject({ outcome: "WORKSPACE", created: false });
    expect((await ensureWorkspace(handler, thread(3), "U0PRATIK01")).body).toMatchObject({ outcome: "LIMIT_REACHED", maximum: 1 });
  });

  it("does not read the setting for a thread that already has a workspace", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread(1), "U0PRATIK01");
    const send = vi.spyOn(db, "send");
    await ensureWorkspace(handler, thread(1), "U0PRATIK01");
    expect(send.mock.calls.some(([command]) => (command.input.Key as { pk?: string } | undefined)?.pk === "SETTINGS")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/workspace-limits.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the module**

```ts
// packages/broker/src/developer/limits.ts
// Spec 025 FR-020 and FR-053: one set of workspace limits for Slack threads and developer tasks.
// The numbers are the admin's setting when there is one, else the stack parameters (R7).
import { GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { CounterKey, WorkspaceCharge } from "./task-records.js";

type Client = { send(command: unknown): Promise<unknown> };
type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;

export const WORKSPACE_LIMITS_KEY = { pk: "SETTINGS", sk: "WORKSPACE_LIMITS" } as const;
export interface WorkspaceLimits { member: number; organization: number; source: "setting" | "parameters" }

const defaultLog = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
const whole = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;

export async function readWorkspaceLimits(
  client: Client,
  tableName: string,
  fallback: { member: number; organization: number },
  log: (entry: Record<string, unknown>) => void = defaultLog,
): Promise<WorkspaceLimits> {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: WORKSPACE_LIMITS_KEY, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined) return { ...fallback, source: "parameters" };
  const member = item.perPerson;
  const organization = item.perOrganization;
  // FR-053: the per-person limit never exceeds the per-organization one.
  if (!whole(member, 50) || !whole(organization, 1_000) || member > organization) {
    log({ event: "workspace_limits.invalid_setting" });
    return { ...fallback, source: "parameters" };
  }
  return { member, organization, source: "setting" };
}

/** R6: a linked developer shares their Slack member's counter; everyone shares the organization's. */
export function developerCharge(input: { teamId?: string | undefined; slackUserId?: string | undefined; developerId: string }): WorkspaceCharge {
  return {
    member: input.teamId !== undefined && input.slackUserId !== undefined
      ? { pk: `SLACK_LIMIT#${input.teamId}`, sk: `MEMBER#${input.slackUserId}` }
      : { pk: `DEVELOPER_LIMIT#${input.developerId}`, sk: "MEMBER" },
    organization: input.teamId !== undefined
      ? { pk: `SLACK_LIMIT#${input.teamId}`, sk: "ORGANIZATION" }
      : { pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" },
  };
}

const entityOf = (key: CounterKey) => (key.pk.startsWith("SLACK_LIMIT#") ? "SLACK_LIMIT" : "DEVELOPER_LIMIT");

/**
 * The same conditions as a Slack thread's charge. The task goes in a string set `tasks`; the
 * Slack limit refusal reads every `threads` entry as a thread subject, so tasks never go there.
 */
export function chargeItems(tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number }, taskId: string): TransactItems {
  return [
    { Update: {
      TableName: tableName,
      Key: charge.organization,
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.organization, ":entity": entityOf(charge.organization) },
    } },
    { Update: {
      TableName: tableName,
      Key: charge.member,
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity ADD #tasks :task",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.member, ":entity": entityOf(charge.member), ":task": new Set([taskId]) },
    } },
  ];
}

/** Releases what chargeItems took. The caller's transaction also marks the task closed, once. */
export function releaseItems(tableName: string, charge: WorkspaceCharge, taskId: string): TransactItems {
  return [
    { Update: {
      TableName: tableName,
      Key: charge.organization,
      UpdateExpression: "SET #count = #count - :one",
      ConditionExpression: "#count >= :one",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":one": 1 },
    } },
    { Update: {
      TableName: tableName,
      Key: charge.member,
      UpdateExpression: "SET #count = #count - :one DELETE #tasks :task",
      ConditionExpression: "#count >= :one",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":one": 1, ":task": new Set([taskId]) },
    } },
  ];
}

/** Which counter is full, read before the start's transaction so the refusal can say so. */
export async function limitReached(client: Client, tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number }): Promise<"member" | "organization" | undefined> {
  const count = async (key: CounterKey) => {
    const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: { count?: unknown } };
    return typeof response.Item?.count === "number" ? response.Item.count : 0;
  };
  if (await count(charge.member) >= limits.member) return "member";
  if (await count(charge.organization) >= limits.organization) return "organization";
  return undefined;
}
```

- [ ] **Step 4: Read the setting where Slack creates a workspace**

In `packages/broker/src/aws/broker.ts`, import `readWorkspaceLimits` from
`"../developer/limits.js"` and add below `threadWorkspaceLimitRefusal`:

```ts
/** The Slack limits with the admin's setting applied (R7); read only when a workspace is created. */
async function effectiveSlackLimits(dependencies: AwsBrokerDependencies, configured: SlackServiceConfiguration): Promise<SlackServiceConfiguration> {
  const limits = await readWorkspaceLimits(dependencies.documentClient, dependencies.tableName, {
    member: configured.memberWorkspaceLimit,
    organization: configured.organizationWorkspaceLimit,
  });
  return { ...configured, memberWorkspaceLimit: limits.member, organizationWorkspaceLimit: limits.organization };
}
```

In `ensureThreadWorkspace`, keep the early `const limits = dependencies.slack;` check, and just
before `const preparation = await newWorkspacePreparation(...)` add
`const effective = await effectiveSlackLimits(dependencies, limits);`. Then use `effective` in
that transaction's two `:limit` values and in its `threadWorkspaceLimitRefusal(..., effective)`
call. In `startThreadPreparation`, after `if (workspace.status !== "UNPREPARED") return ...`, add
the same line and use `effective` for its two `:limit` values and its refusal call. No other line
of either function changes.

- [ ] **Step 5: Run the new test and the Slack suites**

Run: `npx vitest run tests/contract/workspace-limits.test.ts tests/contract/slack-control-plane.test.ts tests/contract/slack-lazy-workspace.test.ts tests/contract/slack-thread-characterization.test.ts`
Expected: PASS, with every existing limit test unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/developer/limits.ts packages/broker/src/aws/broker.ts tests/contract/workspace-limits.test.ts
git commit -m "feat(broker): shared workspace limits and the limits setting (spec 025 FR-020, FR-053)"
```

---
### Task 6: Broker seams the developer routes use

FR-021 to FR-023 and R13, R14, R18. The existing handlers gain a developer identity, the
developer requester, the developer footer, `draft`, an artifact `size`, and one hook each for
writing extra items (the audit records) in their own transaction. The developer routes (Tasks 8
to 12) call them through one interface, `DeveloperTaskActions`, so they never reach into
`broker.ts`'s internals.

**Files:**
- Create: `packages/broker/src/aws/developer-task-actions.ts` (types only)
- Modify: `packages/broker/src/auth.ts`
- Modify: `packages/broker/src/aws/broker.ts`
- Modify: `packages/broker/src/github-app.ts`
- Modify: `packages/broker/src/developer/task-records.ts` (add `developerTaskIdentity`)
- Modify: `tests/support/slack-broker.ts` (`createBroker` passes `developer` and `turnRecordsTableName` through)
- Create: `tests/support/developer-task-broker.ts`
- Test: `tests/contract/developer-task-actions.test.ts`, `tests/contract/github-app.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1, 4.
- Produces:
  - `AuthenticatedIdentity.developer?: { developerId: string; provider: "slack" | "oidc"; name: string; client: string; taskId: string }`;
  - `developerTaskIdentity(task: Pick<DeveloperTaskRecord, "taskId" | "developerId" | "provider" | "developerName" | "client">): AuthenticatedIdentity` in `task-records.ts`;
  - in `developer-task-actions.ts`:

```ts
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { Operation, OperationRequest, PullRequestRequest, WorkspaceInstance } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import type { StoredEvent } from "../developer/task-records.js";
import type { RegisteredProjectRecord } from "./broker.js";

export type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
/** Extra items a handler writes in its own transaction, built from the operation it accepted. */
export type ExtraItems = (operation: Operation) => TransactItems;
export interface StoredArtifact { id: string; operationId: string; name: string; mediaType: string; objectKey: string; size?: number }
export interface StoredPullRequest { repository: string; number: number; url: string; state: "open" | "closed" | "merged" }
export type TaskCancellationResult =
  | { outcome: "CANCEL_REQUESTED"; targetOperationId: string; cancelOperationId: string }
  | { outcome: "NOTHING_RUNNING" };

export interface DeveloperTaskActions {
  tableName: string;
  turnRecordsTableName?: string;
  /** The stack parameters: the limits when no admin setting exists (R7). */
  limitDefaults: { member: number; organization: number };
  latestProject(projectName: string): Promise<RegisteredProjectRecord | undefined>;
  preparation(identity: AuthenticatedIdentity, project: RegisteredProjectRecord, requestId: string): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems }>;
  workspace(workspaceId: string): Promise<WorkspaceInstance>;
  operations(workspaceId: string): Promise<Operation[]>;
  eventsNewestFirst(operationId: string, limit: number): Promise<StoredEvent[]>;
  artifacts(workspaceId: string, operationId: string): Promise<StoredArtifact[]>;
  readArtifact(objectKey: string, maxBytes: number): Promise<string>;
  pullRequests(workspaceId: string): Promise<StoredPullRequest[]>;
  acceptTask(identity: AuthenticatedIdentity, workspaceId: string, request: OperationRequest, extra: ExtraItems): Promise<{ operation: Operation; duplicate: boolean }>;
  acceptPullRequest(identity: AuthenticatedIdentity, workspaceId: string, request: PullRequestRequest, extra: ExtraItems): Promise<{ operation: Operation; duplicate: boolean }>;
  cancelRunning(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, extra: ExtraItems): Promise<TaskCancellationResult>;
  startClose(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, requestId: string, extra: ExtraItems): Promise<{ operationId: string; duplicate: boolean }>;
  /** Deletes the workspace's compute; the existing per-mode switch lives behind it (FR-024). */
  deleteCompute(workspace: WorkspaceInstance): Promise<void>;
  transact(items: TransactItems): Promise<void>;
}
```

  - `createDeveloperTaskActions(input: AwsBrokerInput): DeveloperTaskActions` exported from
    `broker.ts` (tests and the route wiring use the same factory);
  - test support: `createDeveloperTaskBroker(options?)` returning
    `{ db, handler, actions, deleteEc2Session, channelMembers, channelInfo, dev(who, method, path, body?), finish(workspaceId, operationId, status, detail?), events(workspaceId, operationId, events), artifact(workspaceId, operationId, name, content) }`
    and the developers `MAYA` (Slack-linked) and `OMAR` (company sign-in, unlinked).

- [ ] **Step 1: Write the test support**

In `tests/support/slack-broker.ts`, add to `createBroker`'s options
`developer?: DeveloperApiConfiguration; turnRecordsTableName?: string;` (import the type from
`../../packages/broker/src/aws/developer-routes.js`), and to the object it passes to
`createAwsBrokerHandler`:

```ts
    ...(options.developer ? { developer: options.developer } : {}),
    ...(options.turnRecordsTableName ? { turnRecordsTableName: options.turnRecordsTableName } : {}),
```

Also export the input object it builds as `brokerInput` from `createBroker`'s return value, so
the developer harness can build actions over the same fake table.

```ts
// tests/support/developer-task-broker.ts
// A hosted broker with developer sign-in for developer task tests: the Slack harness's fake table,
// the payments project bound to the test channel, two signed-in developers, and worker callbacks.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { ChannelInfoRequest, ChannelInfoResponse, ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { localSigner } from "./developer-fakes.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, registerSlackProject } from "./slack-broker.js";

export const DEV_ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
export interface Developer { developerId: string; name: string; provider: "slack" | "oidc"; sessionId: string; slackUserId?: string }
export const MAYA: Developer = { developerId: "d".repeat(64), name: "Maya Chen", provider: "slack", sessionId: "s-maya", slackUserId: "U0MAYA001" };
export const OMAR: Developer = { developerId: "e".repeat(64), name: "Omar Diaz", provider: "oidc", sessionId: "s-omar" };

const signer = localSigner();

async function bearer(who: Developer): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: DEV_ISSUER, aud: "agentx-developer", sub: who.developerId, amr: who.provider, env: "staging", sid: who.sessionId, iat: now, nbf: now, exp: now + 3600 };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}

export async function createDeveloperTaskBroker(options: {
  memberLimit?: number;
  organizationLimit?: number;
  /** null: the environment has no Slack team ID. */
  slackTeamId?: string | null;
  channelMembers?: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  register?: boolean;
} = {}) {
  const module = await loadSlackBroker() as unknown as { createDeveloperTaskActions: (input: never) => DeveloperTaskActions };
  const channelMembers = vi.fn(options.channelMembers ?? (async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({ ok: true, memberOf: request.slackUserId === MAYA.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [] })));
  const channelInfo = vi.fn(options.channelInfo ?? (async (request: ChannelInfoRequest): Promise<ChannelInfoResponse> => ({ ok: true, channels: request.channelIds.map((channelId) => ({ channelId, name: "payments-dev", isPrivate: false })) })));
  const developer: DeveloperApiConfiguration = {
    issuer: DEV_ISSUER, env: "staging", methods: { slack: true, oidc: true },
    ...(options.slackTeamId === null ? {} : { slackTeamId: options.slackTeamId ?? SLACK_TEAM }),
    signInTableName: "signin", channelMembers, channelInfo,
    verifyAccessToken: developerTokenVerifier({ issuer: DEV_ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  const { db, handler, deleteEc2Session, brokerInput } = createBroker({
    ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }),
    ...(options.organizationLimit === undefined ? {} : { organizationLimit: options.organizationLimit }),
    developer, turnRecordsTableName: "turns",
  });
  const actions = module.createDeveloperTaskActions(brokerInput as never);
  for (const who of [MAYA, OMAR]) {
    db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    db.set({
      pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name,
      ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false,
    });
  }
  if (options.register !== false) await registerSlackProject(handler);

  const dev = async (who: Developer, method: string, path: string, body?: unknown) => {
    const response = await handler({
      version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "",
      headers: { authorization: await bearer(who) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { requestId: randomUUID(), http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const capability = (operationId: string) => {
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
    const value = (outbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
    if (!value) throw new Error(`no outbox item for operation ${operationId}`);
    return value;
  };
  const callback = async (workspaceId: string, operationId: string, action: string, body: unknown) => {
    const response = await call(handler, {
      method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${action}`,
      headers: { "x-agentx-callback-capability": capability(operationId) }, body,
    });
    if (response.status !== 200) throw new Error(`${action} callback failed: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  return {
    db, handler, actions, deleteEc2Session, channelMembers, channelInfo, dev,
    finish: (workspaceId: string, operationId: string, status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED", detail: { result?: unknown; error?: string } = {}) =>
      callback(workspaceId, operationId, "result", { operationId, status, ...(detail.result === undefined ? {} : { result: detail.result }), ...(detail.error === undefined ? {} : { error: detail.error }) }),
    events: (workspaceId: string, operationId: string, events: Array<{ type: string; payload: unknown }>) =>
      callback(workspaceId, operationId, "events", { events: events.map((event) => ({ ...event, timestamp: new Date().toISOString() })) }),
    artifact: (workspaceId: string, operationId: string, name: string, content: string) =>
      callback(workspaceId, operationId, "artifacts", { name, mediaType: "text/plain", content }),
  };
}
```

`createBroker` stays synchronous; `loadSlackBroker` is awaited first so the module is loaded.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/developer-task-actions.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerTaskIdentity, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { markReady } from "../support/slack-broker.js";

const taskId = "44444444-4444-4444-8444-444444444444";
const task = { taskId, developerId: MAYA.developerId, provider: "slack" as const, developerName: "Maya Chen", client: "Claude Code" };

async function readyWorkspace() {
  const harness = await createDeveloperTaskBroker();
  const identity = developerTaskIdentity(task);
  const project = await harness.actions.latestProject("payments");
  if (!project) throw new Error("project missing");
  const preparation = await harness.actions.preparation(identity, project, randomUUID());
  await harness.actions.transact(preparation.items);
  markReady(harness.db, preparation.workspace.id);
  const conversationId = randomUUID();
  harness.db.set({ pk: `WORKSPACE#${preparation.workspace.id}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId: preparation.workspace.id, createdAt: "x", updatedAt: "x" });
  return { ...harness, identity, workspaceId: preparation.workspace.id, conversationId };
}

describe("the developer identity (FR-017, FR-021)", () => {
  it("owns the workspace it prepares, with a developer membership for its key", async () => {
    const { db, workspaceId } = await readyWorkspace();
    const ownerKey = taskOwnerKey(MAYA.developerId, taskId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ ownerKey, projectName: "payments" });
    expect(db.get(`MEMBER#${ownerKey}`, "PROJECT#payments")).toMatchObject({ role: "developer" });
  });
});

describe("acceptTask with a developer identity (FR-019, FR-022)", () => {
  it("records the developer requester, sends the instructions unchanged, and writes the extra items in the same transaction", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const prompt = "Fix the flaky retry test.\n\nKeep the public API.\u00a0";
    const accepted = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt }, (operation) => [
      { Put: { TableName: "turns", Item: { pk: `TASK#${taskId}`, sk: `TURN#${operation.id}`, marker: true } } },
    ]);
    expect(accepted.operation.requestedBy).toEqual({ kind: "developer", developerId: MAYA.developerId, provider: "slack" });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === accepted.operation.id)[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe(prompt);
    expect(db.get(`TASK#${taskId}`, `TURN#${accepted.operation.id}`)).toMatchObject({ marker: true });
  });

  it("writes nothing when an extra item's condition fails", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    db.set({ pk: "BLOCK", sk: "BLOCK" });
    await expect(actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => [
      { Put: { TableName: "state", Item: { pk: "BLOCK", sk: "BLOCK" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ])).rejects.toBeDefined();
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(0);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("answers a repeated request with the first operation and writes no extra items again", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const request = { requestId: randomUUID(), conversationId, prompt: "x" };
    let calls = 0;
    const extra = () => { calls += 1; return []; };
    const first = await actions.acceptTask(identity, workspaceId, request, extra);
    const second = await actions.acceptTask(identity, workspaceId, request, extra);
    expect(second).toMatchObject({ duplicate: true, operation: { id: first.operation.id } });
    expect(calls).toBe(1);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(1);
  });
});

describe("acceptPullRequest with a developer identity (FR-023, R14)", () => {
  it("ends the body with the developer footer and keeps draft on the publication", async () => {
    const { db, actions, identity, workspaceId } = await readyWorkspace();
    const accepted = await actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix the retry test", body: "Fixes #12.", draft: true }, () => []);
    const record = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${accepted.operation.id}`) as { publication: { body: string; draft?: boolean } };
    expect(record.publication.body).toBe("Fixes #12.\n\n---\nRequested by `Maya Chen` via AgentX, started from Claude Code");
    expect(record.publication.draft).toBe(true);
  });
});

describe("closing and cancelling with a developer identity", () => {
  it("starts the close preflight with the developer requester and no Slack closedBy", async () => {
    const { db, actions, identity, workspaceId } = await readyWorkspace();
    const workspace = await actions.workspace(workspaceId);
    const started = await actions.startClose(identity, workspace, randomUUID(), () => []);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${started.operationId}`)).toMatchObject({ kind: "close", requestedBy: { kind: "developer" } });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("closedBy");
  });

  it("says nothing is running when the workspace is idle", async () => {
    const { actions, identity, workspaceId } = await readyWorkspace();
    expect(await actions.cancelRunning(identity, await actions.workspace(workspaceId), () => [])).toEqual({ outcome: "NOTHING_RUNNING" });
  });
});

describe("what the task reads", () => {
  it("lists the workspace's operations, newest events first, artifacts with their size, and pull requests", async () => {
    const { actions, identity, workspaceId, conversationId, events, artifact } = await readyWorkspace();
    const { operation } = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    await events(workspaceId, operation.id, [{ type: "lifecycle", payload: { status: "RUNNING" } }, { type: "progress", payload: { message: "npm test" } }]);
    await artifact(workspaceId, operation.id, "workspace.diff", "## demo\n");
    expect((await actions.operations(workspaceId)).map((entry) => entry.kind).sort()).toEqual(["prepare", "task"]);
    expect((await actions.eventsNewestFirst(operation.id, 10)).map((entry) => entry.type)).toEqual(["progress", "lifecycle"]);
    expect(await actions.artifacts(workspaceId, operation.id)).toEqual([expect.objectContaining({ name: "workspace.diff", size: 8 })]);
    expect(await actions.pullRequests(workspaceId)).toEqual([]);
  });
});
```

Append to `tests/contract/github-app.test.ts`, inside its `describe`:

```ts
  it("opens a draft only when asked", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const created: unknown[] = [];
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "pr-token" }), { status: 201 });
        if (init?.method === "POST") {
          created.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ number: 43, html_url: "https://github.com/ps06756/personal-website-test/pull/43" }), { status: 201 });
        }
        return new Response("[]", { status: 200 });
      },
    });
    const input = { repositoryUrl: "https://github.com/ps06756/personal-website-test.git", headBranch: "agentx/00000000-0000-4000-8000-000000000002", baseBranch: "main", title: "Draft change" };
    await provider.reconcilePullRequest({ ...input, draft: true });
    await provider.reconcilePullRequest(input);
    expect(created).toEqual([
      { title: "Draft change", head: input.headBranch, base: "main", draft: true },
      { title: "Draft change", head: input.headBranch, base: "main" },
    ]);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/contract/developer-task-actions.test.ts tests/contract/github-app.test.ts`
Expected: FAIL, `createDeveloperTaskActions` is not exported.

- [ ] **Step 4: The identity and its requester**

In `packages/broker/src/auth.ts`, add to `AuthenticatedIdentity`:

```ts
  /** Spec 025: a developer task's workspace owner (FR-017); never set with `slack`. */
  developer?: {
    developerId: string;
    provider: "slack" | "oidc";
    name: string;
    client: string;
    taskId: string;
  };
```

In `task-records.ts`, add (with `import { DEVELOPER_TASK_OWNER_ISSUER } ...` already there and
`import type { AuthenticatedIdentity } from "../auth.js";`):

```ts
/** The identity every workspace handler sees for a developer task: its own owner key (FR-021). */
export function developerTaskIdentity(task: Pick<DeveloperTaskRecord, "taskId" | "developerId" | "provider" | "developerName" | "client">): AuthenticatedIdentity {
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(task.developerId, task.taskId),
    ownerKey: taskOwnerKey(task.developerId, task.taskId),
    isAdministrator: false,
    claims: {},
    developer: { developerId: task.developerId, provider: task.provider, name: task.developerName, client: task.client, taskId: task.taskId },
  };
}
```

In `broker.ts`, replace `requesterOf` and add `slackRequesterOf`:

```ts
/** Who asked, for the operation record (FR-022): a Slack member or a developer. */
function requesterOf(identity: AuthenticatedIdentity): { requestedBy?: OperationRequester } {
  if (identity.slack) return { requestedBy: identity.slack.requester };
  if (identity.developer) return { requestedBy: { kind: "developer", developerId: identity.developer.developerId, provider: identity.developer.provider } };
  return {};
}

/** Connector calls come from Slack turns only; their context keeps the Slack requester alone (R13). */
function slackRequesterOf(identity: AuthenticatedIdentity): { requestedBy?: SlackRequester } {
  return identity.slack ? { requestedBy: identity.slack.requester } : {};
}
```

Use `slackRequesterOf` in `connectorContext` and `gitHubContext`. Change the `requester`
parameter type of `requestCancellation` and `cancelRunningTask` to
`{ requestedBy?: OperationRequester }`. Import `OperationRequester` from `@agentx/contracts`.

- [ ] **Step 5: The footer and `draft`**

In `broker.ts`, rename `slackAttributedBody` to `attributedBody` and give it the developer case
first:

```ts
async function attributedBody(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  body: string | undefined,
): Promise<string | undefined> {
  if (identity.developer) {
    const footer = developerFooter(identity.developer.name, identity.developer.client);
    const attributed = body ? `${body}\n\n---\n${footer}` : footer;
    return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
  }
  const slack = identity.slack;
  if (!slack) return body;
  // ... the existing Slack lines, unchanged ...
}
```

In `acceptPullRequest`: add `...(request.draft === undefined ? {} : { draft: request.draft })`
to the `hashJson` input, the `operation.publication` object, and nothing else; call
`attributedBody`. Add `draft?: boolean;` to `OperationRecord.publication`. In
`reconcilePullRequest`, add `...(expected.draft === undefined ? {} : { draft: expected.draft })`
to the object passed to `githubPullRequests.reconcilePullRequest`.

In `packages/broker/src/github-app.ts`, add `draft?: boolean;` to `GitHubPullRequestInput`, and to
the create request's JSON body `...(input.draft === undefined ? {} : { draft: input.draft }),`.

- [ ] **Step 6: The extra-items hooks and the shared task operation**

In `broker.ts`:
- extract the task operation from `acceptTask` so the first developer task (Task 9) builds it the
  same way:

```ts
/** A task operation, its worker invocation and outbox item: acceptTask's and the first developer task's (R3). */
async function taskOperationParts(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  input: { requestId: string; conversationId: string; prompt: string; conversationStarted: boolean; requester: { requestedBy?: OperationRequester } },
  now: string,
): Promise<{ operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number }> {
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  const resolvedModel = await resolveProjectModel(dependencies, settings);
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    conversationId: input.conversationId,
    kind: "task",
    requestId: input.requestId,
    payloadHash: hashJson({ conversationId: input.conversationId, prompt: input.prompt }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...input.requester,
  });
  operation.settingsRevision = settings.definition.revision;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "task",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      conversationId: input.conversationId,
      prompt: input.prompt,
      conversationStarted: input.conversationStarted,
      ...(resolvedModel.model === undefined ? {} : { model: resolvedModel.model }),
      ...(resolvedModel.diagnostic === undefined ? {} : { modelSelectionDiagnostic: resolvedModel.diagnostic }),
    },
  };
  return { operation, outbox: outboxRecord(workspace, invocation), fence };
}
```

  `acceptTask` then calls it after its READY check (`const { operation, outbox, fence } = await
  taskOperationParts(dependencies, workspace, { requestId: request.requestId, conversationId:
  request.conversationId, prompt: request.prompt, conversationStarted, requester:
  requesterOf(identity) }, now);`) and keeps its transaction as it is, with
  `":operation": operation.id` and `...extra(publicOperation(operation))` appended to
  `TransactItems`;
- give `acceptTask`, `acceptPullRequest`, `requestCancellation` and `cancelRunningTask` a last
  parameter `extra: ExtraItems = () => []`, appended to their transactions the same way
  (`cancelRunningTask` passes it on to `requestCancellation`);
- extract the close preflight's operation, invocation and outbox from `startThreadWorkspaceClose`
  into `closeOperationParts(dependencies, workspace, requestId, requester, now)`, used by it and
  by the new `startTaskClose`, which is the same flow without `closedBy`, keyed
  `IDEMPOTENCY#<ownerKey>#CLOSE` like the Slack one, and with `...extra(publicOperation(operation))`;
- extract the per-mode compute deletion from `completeThreadWorkspaceClose` (the `switch` over
  `workspace.deploymentMode`, unchanged) into `deleteWorkspaceCompute(dependencies, workspace)`,
  used by it and by the actions;
- in `putArtifact`, add `size: Buffer.byteLength(input.content, "utf8"),` to the artifact item;
- keep `turnRecordsTableName` on the dependencies: in `createAwsBrokerHandler`, add
  `...(turnRecordsTableName ? { turnRecordsTableName } : {})` to `dependencies`, and
  `turnRecordsTableName?: string;` to `AwsBrokerDependencies`;
- move the body of `createAwsBrokerHandler` that builds `dependencies` into
  `function brokerDependencies(input: AwsBrokerInput): AwsBrokerDependencies`, and add:

```ts
export function createDeveloperTaskActions(input: AwsBrokerInput): DeveloperTaskActions {
  return developerTaskActions(brokerDependencies(input));
}

function developerTaskActions(dependencies: AwsBrokerDependencies): DeveloperTaskActions {
  const query = async (pk: string, prefix: string, extra: Record<string, unknown> = {}) => (await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
    ConsistentRead: true,
    ...extra,
  }))).Items ?? [];
  return {
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName ? { turnRecordsTableName: dependencies.turnRecordsTableName } : {}),
    limitDefaults: {
      member: dependencies.slack?.memberWorkspaceLimit ?? 3,
      organization: dependencies.slack?.organizationWorkspaceLimit ?? 20,
    },
    latestProject: (name) => requireLatestProject(dependencies, name).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    preparation: (identity, project, requestId) => newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId),
    workspace: (id) => requireWorkspace(dependencies, id),
    operations: async (workspaceId) => (await query(`WORKSPACE#${workspaceId}`, "OPERATION#"))
      .filter((item) => item.entityType === "OPERATION")
      .map((item) => publicOperation(item as OperationRecord)),
    eventsNewestFirst: async (operationId, limit) => (await query(`OPERATION#${operationId}`, "EVENT#", { ScanIndexForward: false, Limit: limit }))
      .filter((item) => item.entityType === "EVENT")
      .map((item) => parseStoredEvent(item)),
    artifacts: async (workspaceId, operationId) => (await query(`WORKSPACE#${workspaceId}`, "ARTIFACT#"))
      .filter((item) => item.operationId === operationId)
      .map((item) => ({
        id: String(item.id), operationId: String(item.operationId), name: String(item.name), mediaType: String(item.mediaType), objectKey: String(item.objectKey),
        ...(typeof item.size === "number" ? { size: item.size } : {}),
      })),
    readArtifact: async (objectKey, maxBytes) => {
      const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey, Range: `bytes=0-${maxBytes - 1}` }));
      return object.Body ? await object.Body.transformToString("utf8") : "";
    },
    pullRequests: async (workspaceId) => (await query(`WORKSPACE#${workspaceId}`, "PULL_REQUEST#"))
      .map((item) => ({ repository: String(item.repository), number: Number(item.number), url: String(item.url), state: item.state as "open" | "closed" | "merged" })),
    acceptTask: (identity, workspaceId, request, extra) => acceptTask(dependencies, identity, workspaceId, request, extra),
    acceptPullRequest: (identity, workspaceId, request, extra) => acceptPullRequest(dependencies, identity, workspaceId, request, extra),
    cancelRunning: async (identity, workspace, extra) => {
      const result = await cancelRunningTask(dependencies, workspace, requesterOf(identity), extra);
      return result.outcome === "CANCEL_REQUESTED"
        ? { outcome: "CANCEL_REQUESTED", targetOperationId: result.targetOperationId, cancelOperationId: result.cancelOperationId }
        : { outcome: "NOTHING_RUNNING" };
    },
    startClose: (identity, workspace, requestId, extra) => startTaskClose(dependencies, identity, workspace, requestId, extra),
    deleteCompute: (workspace) => deleteWorkspaceCompute(dependencies, workspace),
    transact: async (items) => {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    },
  };
}
```

  `import type { DeveloperTaskActions, ExtraItems } from "./developer-task-actions.js";` and
  `developerFooter` from `"../developer/task-records.js"`.

- [ ] **Step 7: Run the new tests and the suites of every handler touched**

Run: `npx vitest run tests/contract/developer-task-actions.test.ts tests/contract/github-app.test.ts tests/contract/slack-control-plane.test.ts tests/contract/slack-lazy-workspace.test.ts tests/contract/cancel-task.test.ts tests/contract/stop-command.test.ts tests/contract/pull-request-tools.test.ts tests/contract/idempotency.test.ts tests/contract/admin-preparation.test.ts tests/contract/artifact-bounds.test.ts && npm run typecheck`
Expected: PASS, with no existing assertion changed. The Slack publication hash and body are
unchanged because `draft` and the developer branch apply only when given.

- [ ] **Step 8: Commit**

```bash
git add packages/broker/src tests/support/slack-broker.ts tests/support/developer-task-broker.ts tests/contract/developer-task-actions.test.ts tests/contract/github-app.test.ts
git commit -m "feat(broker): developer identity, requester, PR footer and draft, and the task actions (spec 025 FR-021 to FR-023)"
```

---
### Task 7: Project access with the task policy, and the visible channels

FR-013 with FR-014 (replacing 25a's R16 `() => true`), FR-016's "bound channels and task policy",
FR-049's `PROJECT_ACCESS_DENIED` text, R10 and R11.

**Files:**
- Modify: `packages/broker/src/developer/access.ts`
- Modify: `packages/broker/src/developer/slack-directory.ts`
- Modify: `packages/broker/src/developer/server.ts`, `packages/broker/src/aws/developer-identity.ts`
- Modify: `packages/broker/src/aws/developer-routes.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`developerConfiguration` wires `channelInfo`)
- Modify: `tests/support/developer-fakes.ts` (`fakeSlack` answers `conversations.info`)
- Test: `tests/contract/developer-access.test.ts`, `tests/contract/developer-slack-directory.test.ts`,
  `tests/contract/developer-identity-server.test.ts`, `tests/contract/developer-routes.test.ts` (append)

**Interfaces:**
- Consumes: `developerTaskPolicy`, `DeveloperTaskPolicy` (Task 1); `ChannelInfoRequestSchema`,
  `ChannelInfoResponse` (Task 2).
- Produces:
  - `SlackDirectory.channelInfo(channelIds: readonly string[]): Promise<ChannelInfoResponse>` (cached 10 minutes);
  - DeveloperIdentity answers `{ kind: "channel-info", channelIds }`;
  - `DeveloperApiConfiguration.channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>`,
    `channelInfoThroughLambda(invoke)`;
  - `projectsWithPolicy(deps, names: readonly string[]): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>>` in `developer-routes.ts`;
  - `checkProjectAccess(deps, caller, project): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel" }>`,
    which throws `PROJECT_NOT_FOUND`, `PROJECT_ACCESS_DENIED` (with R10's text), `SLACK_UNAVAILABLE`
    (when only a channel could have given access and Slack is down), or `PROJECT_TASKS_DISABLED`;
  - `accessDeniedMessage(project: string, channelNames: readonly string[]): string` in `access.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/developer-access.test.ts`:

```ts
import { accessDeniedMessage } from "../../packages/broker/src/developer/access.js";

describe("the access-denied message (FR-049, R10)", () => {
  it("names the public bound channels to join", () => {
    expect(accessDeniedMessage("payments", ["payments-dev", "payments-ops"])).toBe("you don't have access to `payments`: join one of its channels (#payments-dev, #payments-ops) or ask an admin");
  });

  it("just says ask an admin when there is no channel to name", () => {
    expect(accessDeniedMessage("ledger", [])).toBe("you don't have access to `ledger`: ask an admin");
  });
});
```

Append to `tests/contract/developer-slack-directory.test.ts` (extend `fakeSlack`'s options with
`channelInfo?: Record<string, { name: string; isPrivate: boolean }>`, answered at
`/api/conversations.info` as `{ ok: true, channel: { id, name, is_private } }`, or
`{ ok: false, error: "channel_not_found" }`, and pass it through `directory()`):

```ts
describe("conversations.info for channel names (R10)", () => {
  it("returns each channel's name and privacy, and caches them for 10 minutes", async () => {
    const { dir, fetch, tick } = directory([], {}, { channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false }, C0SEC0001: { name: "payments-sec", isPrivate: true } } });
    expect(await dir.channelInfo(["C0PAY0001", "C0SEC0001"])).toEqual({ ok: true, channels: [
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0SEC0001", name: "payments-sec", isPrivate: true },
    ] });
    await dir.channelInfo(["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.info"))).toHaveLength(2);
    tick(600_001);
    await dir.channelInfo(["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.info"))).toHaveLength(3);
  });

  it("leaves out a channel Slack does not know, and is unavailable when Slack is down", async () => {
    const { dir, fake } = directory([], {}, { channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false } } });
    expect(await dir.channelInfo(["C0PAY0001", "C0GONE001"])).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: false }] });
    fake.state.down = true;
    expect(await dir.channelInfo(["C0OTHER01"])).toEqual({ ok: false, error: "slack_unavailable" });
  });
});
```

Append to `tests/contract/developer-identity-server.test.ts`, inside
`describe("revocation and the channel-members invoke", ...)`, using the same `identityHarness`
(which passes `channelInfo` on to `fakeSlack`; add that option to `identityHarness` in
`tests/support/developer-fakes.ts`):

```ts
  it("answers the broker's channel-info request, and refuses a malformed one", async () => {
    const h = identityHarness({ channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false } } });
    expect(await h.handler({ kind: "channel-info", channelIds: ["C0PAY0001"] })).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: false }] });
    expect(await h.handler({ kind: "channel-info", channelIds: ["not-a-channel"] })).toEqual({ ok: false, error: "invalid_request" });
  });
```

Append to `tests/contract/developer-routes.test.ts`:

```ts
describe("GET /v1/dev/projects with the task policy (FR-014, FR-016)", () => {
  it("adds each project's policy from its latest revision", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { enabled: true, share: "required", shareMode: { default: "view", allowContinue: false }, channelMembersMayUse: true } } });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; latestRevision: number; tasks: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")).toMatchObject({
      latestRevision: 8, tasks: { share: "required", shareMode: { allowContinue: false } },
    });
    expect(body.projects.find((project) => project.name === "solo")?.tasks).toEqual({ enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true });
  });

  it("does not give channel access to a project whose channelMembersMayUse is false, and does not ask Slack for it", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { channelMembersMayUse: false } } });
    db.set({ pk: "PROJECT#ledger", sk: "REV#000000000003", entityType: "PROJECT", definition: { name: "ledger", revision: 3, developerTasks: { channelMembersMayUse: false } } });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }> };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("names public bound channels when DeveloperIdentity can read them, and only flags private ones", async () => {
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAYSEC1", teamId: "T0TEAM1", channelId: "C0PAYSEC1", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
    config.channelInfo = vi.fn(async () => ({ ok: true as const, channels: [
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0PAYSEC1", name: "payments-sec", isPrivate: true },
    ] }));
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: ["C0PAY0001"] });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")?.channels).toEqual([
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0PAYSEC1", isPrivate: true },
    ]);
  });

  it("still answers with channel IDs when the names cannot be read", async () => {
    config.channelInfo = vi.fn(async () => ({ ok: false as const, error: "slack_unavailable" as const }));
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")?.channels).toEqual([{ channelId: "C0PAY0001" }]);
  });
});
```

The broker keeps a reference to `config`, so a test that sets `config.channelInfo` before its
call is served with it. The existing first test's expected projects gain
`tasks: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true }`
on each entry (the field FR-016 adds; nothing is removed).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/developer-access.test.ts tests/contract/developer-slack-directory.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-routes.test.ts`
Expected: FAIL, `accessDeniedMessage` and `channelInfo` do not exist.

- [ ] **Step 3: The message**

Append to `packages/broker/src/developer/access.ts`:

```ts
/**
 * FR-049's PROJECT_ACCESS_DENIED text. The caller passes only public bound channels (R10): a
 * person in any bound channel already has access when channelMembersMayUse is on, so those are the
 * only bound channels they can see. No names means "ask an admin".
 */
export function accessDeniedMessage(project: string, channelNames: readonly string[]): string {
  if (channelNames.length === 0) return `you don't have access to \`${project}\`: ask an admin`;
  return `you don't have access to \`${project}\`: join one of its channels (${channelNames.map((name) => `#${name}`).join(", ")}) or ask an admin`;
}
```

- [ ] **Step 4: `conversations.info` in the directory and DeveloperIdentity**

In `slack-directory.ts`, add `channelInfo` to the `SlackDirectory` interface and implement it
beside `channelMembers`, with its own cache:

```ts
  const info = new Map<string, { at: number; name: string; isPrivate: boolean }>();
  // ...
    async channelInfo(channelIds) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      const channels: Array<{ channelId: string; name: string; isPrivate: boolean }> = [];
      for (const channelId of [...new Set(channelIds)].sort()) {
        const cached = info.get(channelId);
        if (cached !== undefined && input.now() - cached.at < cacheMs) {
          channels.push({ channelId, name: cached.name, isPrivate: cached.isPrivate });
          continue;
        }
        const reply = await get("conversations.info", { channel: channelId });
        if (reply === undefined) return { ok: false, error: "slack_unavailable" };
        const channel = reply.body.channel as { name?: unknown; is_private?: unknown } | undefined;
        if (reply.body.ok !== true || typeof channel?.name !== "string") {
          // A channel Slack no longer knows is left out; any other refusal is about the token.
          if (reply.body.error === "channel_not_found") continue;
          refused("conversations.info", reply);
          return { ok: false, error: "slack_unavailable" };
        }
        const entry = { at: input.now(), name: channel.name, isPrivate: channel.is_private === true };
        if (info.size >= CACHE_CAP) info.delete(info.keys().next().value as string);
        info.set(channelId, entry);
        channels.push({ channelId, name: entry.name, isPrivate: entry.isPrivate });
      }
      return { ok: true, channels };
    },
```

In `server.ts`, widen the invoke branch:

```ts
    if ("kind" in event) {
      if (event.kind === "channel-info") {
        const parsed = ChannelInfoRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelInfo(parsed.data.channelIds);
      }
      const parsed = ChannelMembersRequestSchema.safeParse(event);
      if (!parsed.success) return { ok: false, error: "invalid_request" };
      return deps.directory.channelMembers(parsed.data.slackUserId, parsed.data.channelIds);
    }
```

with the handler's event type `HttpApiV2Event | ChannelMembersRequest | ChannelInfoRequest` and
result type `HttpResult | ChannelMembersResult | ChannelInfoResponse`. Change the exported
`handler`'s parameter type in `developer-identity.ts` the same way.

- [ ] **Step 5: The broker's side**

In `developer-routes.ts`:
- add `channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;` to
  `DeveloperApiConfiguration`;
- add `channelInfoThroughLambda(invoke)`, built like `channelMembersThroughLambda`: an invoke error,
  a `FunctionError`, an empty or unreadable reply gives `{ ok: false, error: "slack_unavailable" }`
  and one `developer.channel_info_failed` log line with the reason; a good reply keeps only
  entries with string `channelId` and `name` and boolean `isPrivate`;
- replace `listProjects` with the policy-aware version below, and add `projectsWithPolicy`,
  `channelNames` and `checkProjectAccess`:

```ts
async function latestDefinition(deps: DeveloperRouteDependencies, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":prefix": "REV#" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number; developerTasks?: unknown } }> };
  return response.Items?.[0]?.definition;
}

/** Each named project's latest revision and task policy; projects with no revision are left out. */
export async function projectsWithPolicy(deps: DeveloperRouteDependencies, names: readonly string[]): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>> {
  const found = new Map<string, { revision: number; policy: DeveloperTaskPolicy }>();
  for (const name of [...new Set(names)].sort()) {
    const definition = await latestDefinition(deps, name);
    if (definition !== undefined) found.set(name, { revision: definition.revision, policy: developerTaskPolicy(definition) });
  }
  return found;
}

/** Channel names and privacy, best effort: without them the channels are listed by ID (R10). */
async function channelNames(deps: DeveloperRouteDependencies, channelIds: readonly string[]): Promise<Map<string, { name: string; isPrivate: boolean }>> {
  const names = new Map<string, { name: string; isPrivate: boolean }>();
  if (deps.developer.channelInfo === undefined || channelIds.length === 0) return names;
  const unique = [...new Set(channelIds)].sort();
  for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
    let answer: ChannelInfoResponse;
    try {
      answer = await deps.developer.channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
    } catch (error) {
      logDeveloperEvent({ event: "developer.channel_info_failed", reason: "threw", error: errorName(error) });
      return names;
    }
    if (!answer.ok) return names;
    for (const channel of answer.channels) names.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
  }
  return names;
}

const describeChannel = (channelId: string, names: Map<string, { name: string; isPrivate: boolean }>) => {
  const known = names.get(channelId);
  if (known === undefined) return { channelId };
  return known.isPrivate ? { channelId, isPrivate: true } : { channelId, name: known.name, isPrivate: false };
};

async function grantsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string[]> {
  return (await queryAll<{ projectName: string; role?: string }>(deps, `MEMBER#${caller.developerId}`, "PROJECT#"))
    .filter((membership) => membership.role === "developer")
    .map((membership) => membership.projectName);
}

async function bindingsOf(deps: DeveloperRouteDependencies): Promise<SlackChannelBinding[]> {
  return deps.developer.slackTeamId === undefined ? [] : queryAll<SlackChannelBinding>(deps, `SLACK_BINDING#${deps.developer.slackTeamId}`, "CHANNEL#");
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grants = await grantsOf(deps, caller);
  const bindings = await bindingsOf(deps);
  const policies = await projectsWithPolicy(deps, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    // FR-013 with FR-014: a project's own switch decides whether channel members may use it.
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  const names = await channelNames(deps, [...access.projects.values()].flatMap((entry) => entry.channels));
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of access.projects) {
    const known = policies.get(name);
    if (known === undefined) continue;
    projects.push({ name, latestRevision: known.revision, access: entry.access, channels: entry.channels.map((channelId) => describeChannel(channelId, names)), tasks: known.policy });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

/** FR-018's first three checks, in order, for one project; the start route calls it (Task 8). */
export async function checkProjectAccess(deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel" }> {
  const known = AgentXNameSchema.safeParse(project).success ? (await projectsWithPolicy(deps, [project])).get(project) : undefined;
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX; run agentx_list_projects`);
  const grants = (await grantsOf(deps, caller)).filter((name) => name === project);
  const bindings = (await bindingsOf(deps)).filter((binding) => binding.projectName === project);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: () => known.policy.channelMembersMayUse,
    channelMembers: safeChannelMembers(deps),
  });
  const entry = access.projects.get(project);
  if (entry === undefined) {
    if (access.slackUnavailable) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
    const visible = caller.slackUserId === undefined || !known.policy.channelMembersMayUse
      ? []
      : [...(await channelNames(deps, bindings.map((binding) => binding.channelId))).values()].filter((channel) => !channel.isPrivate).map((channel) => channel.name).sort();
    throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, visible));
  }
  if (!known.policy.enabled) throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
  return { revision: known.revision, policy: known.policy, access: entry.access };
}
```

  where `safeChannelMembers(deps)` is the existing inline `channelMembers` wrapper (the `try`,
  the `developer.channel_members_failed` log line and `SLACK_UNAVAILABLE`), moved into a function.
  Delete the old `latestRevision` helper. Import `AgentXNameSchema`, `developerTaskPolicy`,
  `CHANNEL_MEMBERS_MAX_CHANNELS`, and the types `DeveloperTaskPolicy`, `ChannelInfoRequest`,
  `ChannelInfoResponse` from `@agentx/contracts`, and `accessDeniedMessage` from
  `../developer/access.js`.

In `broker.ts`'s `developerConfiguration()`, add
`channelInfo: channelInfoThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/developer-access.test.ts tests/contract/developer-slack-directory.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-routes.test.ts tests/contract/developer-cli.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src tests/support/developer-fakes.ts tests/contract/developer-access.test.ts tests/contract/developer-slack-directory.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-routes.test.ts
git commit -m "feat(broker): project access with developerTasks, channel names and visible channels (spec 025 FR-013, FR-014, FR-049)"
```

---
### Task 8: Starting a task

`POST /v1/dev/tasks`: FR-017, FR-018, FR-019, FR-020, R8, R9, R12. After this task a started task
sits in `STARTING`; Task 9 makes the prepare's result queue its instructions.

**Files:**
- Create: `packages/broker/src/aws/developer-tasks.ts`
- Modify: `packages/broker/src/aws/developer-routes.ts` (route `/v1/dev/tasks*`; `tasks` on the dependencies)
- Modify: `packages/broker/src/aws/broker.ts` (pass `tasks: developerTaskActions(dependencies)`)
- Test: `tests/contract/developer-task-start.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6, 7 (`checkProjectAccess`, `DeveloperTaskActions`, `readWorkspaceLimits`,
  `developerCharge`, `chargeItems`, `limitReached`, `aiToolTurn`, the record keys).
- Produces:
  - `interface DeveloperTaskRouteDependencies { documentClient; tableName: string; slackTeamId?: string; actions: DeveloperTaskActions; checkAccess(project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel" }>; now(): number; log?(entry: Record<string, unknown>): void }`;
  - `routeDeveloperTaskRequest(deps, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown>` (every developer task route answers 200);
  - `loadOwnedTask(deps, caller, taskId): Promise<DeveloperTaskRecord>` (throws `TASK_NOT_FOUND`);
  - `taskView(deps, task, options: { events: number; details: boolean }): Promise<DeveloperTaskView>`
    (Task 10 fills `details`);
  - `DeveloperRouteDependencies.tasks?: DeveloperTaskActions`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-start.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace } from "../support/slack-broker.js";

const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const workspaces = (db: { find(predicate: (item: Record<string, unknown>) => boolean): unknown[] }) => db.find((item) => item.entityType === "WORKSPACE");
const refusals = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }) =>
  db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused");

describe("POST /v1/dev/tasks (FR-018)", () => {
  it("answers STARTING with a task ID and writes the task, its workspace and its audit record in one transaction", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(200);
    const task = response.body.task as { taskId: string; status: string; project: string; startingRevision: number; client: string; shared: boolean; title: string };
    expect(task).toMatchObject({ status: "STARTING", project: "payments", startingRevision: 1, client: "Claude Code", shared: false, title: "Fix the flaky retry test" });

    const record = db.get(`DEVTASK#${task.taskId}`, "META") as { workspaceId: string; ownerKey: string; conversationId: string; charge: unknown };
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK_INDEX" && item.taskId === task.taskId)).toEqual([expect.objectContaining({ pk: `DEVELOPER#${MAYA.developerId}`, status: "STARTING", shared: false })]);
    expect(db.get(`WORKSPACE#${record.workspaceId}`, "META")).toMatchObject({ ownerKey: record.ownerKey, status: "PREPARING", projectRevision: 1 });
    expect(db.get(`WORKSPACE#${record.workspaceId}`, "DEVELOPER_TASK")).toMatchObject({ taskId: task.taskId, pendingPrompt: "Fix the flaky retry test", conversationId: record.conversationId });
    expect(db.get(`WORKSPACE#${record.workspaceId}`, `CONVERSATION#${record.conversationId}`)).toMatchObject({ entityType: "CONVERSATION" });
    expect(db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === record.workspaceId).map((item) => (item.invocation as { kind: string }).kind)).toEqual(["prepare"]);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1, tasks: new Set([task.taskId]) });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
    expect(db.find((item) => item.pk === `TASK#${task.taskId}`)).toEqual([expect.objectContaining({ origin: "ai_tool", action: "start", phase: "accepted", requestText: "Fix the flaky retry test", client: "Claude Code" })]);
  });

  it("keeps the instructions exactly as the tool wrote them (FR-019)", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const instructions = "  Fix it.\r\n\r\n```ts\nconst x = 1;\t\n```\n\u00e9\u{1f600}  ";
    const { body } = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions }));
    const record = db.get(`DEVTASK#${(body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    expect((db.get(`WORKSPACE#${record.workspaceId}`, "DEVELOPER_TASK") as { pendingPrompt: string }).pendingPrompt).toBe(instructions);
  });

  it("refuses instructions over 65,536 bytes even when they are under 65,536 characters (Review Focus 3)", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions: "\u20ac".repeat(21_846) }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify(response.body)).toContain("65536");
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toHaveLength(0);
  });

  it("returns the first task for a repeated request ID, and refuses one reused with other content", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const request = start();
    const first = await dev(MAYA, "POST", "/v1/dev/tasks", request);
    const again = await dev(MAYA, "POST", "/v1/dev/tasks", request);
    expect((again.body.task as { taskId: string }).taskId).toBe((first.body.task as { taskId: string }).taskId);
    expect(workspaces(db)).toHaveLength(1);
    const reused = await dev(MAYA, "POST", "/v1/dev/tasks", { ...request, instructions: "something else" });
    expect(reused.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("the start's refusals, in FR-018's order, before anything starts", () => {
  it("PROJECT_NOT_FOUND for a project that does not exist, and for a malformed name", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    for (const project of ["nope", "Not A Name!"]) {
      const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ project }));
      expect(response.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
      expect(String((response.body.error as { message: string }).message)).toContain("agentx_list_projects");
    }
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_NOT_FOUND", "PROJECT_NOT_FOUND"]);
  });

  it("PROJECT_ACCESS_DENIED names the public channel to join for a Slack member outside it", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelMembers: async () => ({ ok: true, memberOf: [] }) });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: join one of its channels (#payments-dev) or ask an admin" });
    expect(workspaces(db)).toHaveLength(0);
  });

  it("PROJECT_ACCESS_DENIED just says ask an admin to a developer with no Slack link", async () => {
    const { dev } = await createDeveloperTaskBroker();
    const response = await dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(response.body.error).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: ask an admin" });
  });

  it("SLACK_UNAVAILABLE when only a channel could give access and Slack cannot be reached", async () => {
    const { dev } = await createDeveloperTaskBroker({ channelMembers: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("PROJECT_TASKS_DISABLED when the latest revision turns tasks off", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    await registerRevision(handler, 2, { enabled: false });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "PROJECT_TASKS_DISABLED" });
    expect(workspaces(db)).toHaveLength(0);
  });

  it("CHANNEL_REQUIRED, not yet available, for a start that asks to share or a project that requires it (R9)", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    const asked = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "view" }));
    expect(asked.body.error).toMatchObject({ code: "CHANNEL_REQUIRED" });
    expect(String((asked.body.error as { message: string }).message)).toContain("not available yet");
    await registerRevision(handler, 2, { share: "required" });
    const required = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(required.body.error).toMatchObject({ code: "CHANNEL_REQUIRED" });
    expect(String((required.body.error as { message: string }).message)).toContain("requires");
    expect(workspaces(db)).toHaveLength(0);
  });

  it("WORKSPACE_LIMIT counts the developer's Slack threads, lists open tasks, and starts nothing", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker({ memberLimit: 2 });
    const first = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions: "First task" }));
    expect(first.status).toBe(200);
    expect((await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, MAYA.slackUserId!)).body.created).toBe(true);
    const refused = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(refused.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
    const message = String((refused.body.error as { message: string }).message);
    expect(message).toContain("limit of 2");
    expect(message).toContain((first.body.task as { taskId: string }).taskId);
    expect(message).toContain("First task");
    expect(workspaces(db)).toHaveLength(2);
  });
});

describe("developers without a Slack link (FR-020, R6)", () => {
  it("can use a granted project, on their own member counter", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    db.set({ pk: `MEMBER#${OMAR.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", role: "developer" });
    const response = await dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(200);
    expect(db.get(`DEVELOPER_LIMIT#${OMAR.developerId}`, "MEMBER")).toMatchObject({ count: 1 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
  });

  it("counts on the developer organization counter when the environment has no Slack team ID", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ slackTeamId: null });
    db.set({ pk: `MEMBER#${OMAR.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", role: "developer" });
    expect((await dev(OMAR, "POST", "/v1/dev/tasks", start())).status).toBe(200);
    expect(db.get("DEVELOPER_LIMIT#ORGANIZATION", "ORGANIZATION")).toMatchObject({ count: 1 });
  });
});

/** Registers revision `revision` of payments with the given developerTasks, as an administrator. */
async function registerRevision(handler: Parameters<typeof call>[0], revision: number, developerTasks: Record<string, unknown>) {
  const response = await call(handler, {
    method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-start.test.ts`
Expected: FAIL, `POST /v1/dev/tasks` answers `NOT_FOUND`.

- [ ] **Step 3: Write the start route**

```ts
// packages/broker/src/aws/developer-tasks.ts
// Spec 025 FR-016 to FR-021: the developer task routes. Every task has its own workspace, reached
// through the existing handlers (DeveloperTaskActions) with the task's owner key. Nothing here
// reads the deployment mode (FR-024).
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  DEVELOPER_EVENTS_DEFAULT,
  StartDeveloperTaskRequestSchema,
  agentXError,
  cleanClientName,
  taskTitle,
  type DeveloperTaskPolicy,
  type DeveloperTaskView,
  type StartDeveloperTaskRequest,
} from "@agentx/contracts";
import type { z } from "zod";
import { chargeItems, developerCharge, limitReached, readWorkspaceLimits, type WorkspaceLimits } from "../developer/limits.js";
import {
  aiToolTurn,
  deriveTaskStatus,
  developerTaskIdentity,
  recentTaskEvents,
  startIdempotencyKey,
  taskIndexKey,
  taskKey,
  taskPointerKey,
  type DeveloperTaskIndexRecord,
  type DeveloperTaskPointerRecord,
  type DeveloperTaskRecord,
  type TurnParty,
} from "../developer/task-records.js";
import type { DeveloperTaskActions, TransactItems } from "./developer-task-actions.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export interface DeveloperTaskRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  slackTeamId?: string;
  actions: DeveloperTaskActions;
  checkAccess(project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel" }>;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashJson = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (deps: DeveloperTaskRouteDependencies) => new Date(deps.now()).toISOString();
const log = (deps: DeveloperTaskRouteDependencies, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

function isConditional(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}

function parse<T>(schema: z.ZodType<T>, body: unknown, deps: DeveloperTaskRouteDependencies, route: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "body";
  // Field names only: the values are the developer's text (R12).
  log(deps, { event: "developer.task_request_invalid", route, field });
  throw agentXError("CONFIG_INVALID", `${field}: ${issue?.message ?? "invalid"}`);
}

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

async function get<T>(deps: DeveloperTaskRouteDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

const putNew = (tableName: string, item: Record<string, unknown>) => ({ Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } });

function turnTable(deps: DeveloperTaskRouteDependencies): string {
  const table = deps.actions.turnRecordsTableName;
  // FR-037: an action that cannot be audited does not run.
  if (table === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "turn records are not configured in this deployment; developer tasks are off");
  return table;
}

/** One EMF line for the RecordingFailures alarm, which already sums TurnRecordWriteFailed. */
function turnRecordFailed(deps: DeveloperTaskRouteDependencies, error: unknown) {
  console.log(JSON.stringify({
    _aws: { Timestamp: deps.now(), CloudWatchMetrics: [{ Namespace: process.env.AGENTX_METRICS_NAMESPACE || "AgentX", Dimensions: [[]], Metrics: [{ Name: "TurnRecordWriteFailed", Unit: "Count" }] }] },
    component: "broker", event: "developer.turn_record_failed", error: error instanceof Error ? error.name : "unknown", TurnRecordWriteFailed: 1,
  }));
}

function partyOf(caller: DeveloperCaller, taskId: string, client: string, extra: Partial<TurnParty> = {}): TurnParty {
  return {
    taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    ...extra,
  };
}

/** R12: the refused start's audit record. A failed write is counted and logged, never hides the refusal. */
async function refuse(deps: DeveloperTaskRouteDependencies, party: TurnParty, request: StartDeveloperTaskRequest, receivedAt: string, error: AgentXError): Promise<never> {
  try {
    const record = aiToolTurn({
      party, turnId: randomUUID(), action: "start", phase: "refused", outcome: "refused", receivedAt, finishedAt: iso(deps),
      request: request.instructions, response: error.message, errorCode: error.code,
    });
    await deps.documentClient.send(new PutCommand({ TableName: turnTable(deps), Item: record, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (writeError) {
    turnRecordFailed(deps, writeError);
  }
  throw error;
}

/** The developer's own task, or TASK_NOT_FOUND for anyone else and for a malformed ID (FR-036). */
export async function loadOwnedTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<DeveloperTaskRecord> {
  const task = TASK_ID.test(taskId) ? await get<DeveloperTaskRecord>(deps, taskKey(taskId)) : undefined;
  if (task === undefined || task.developerId !== caller.developerId) throw agentXError("TASK_NOT_FOUND", `no task ${taskId} of yours; run agentx_list_tasks`);
  return task;
}

/** The live view of a task (R4). Task 10 adds the result details. */
export async function taskView(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, options: { events: number; details: boolean }): Promise<DeveloperTaskView> {
  const [workspace, pointer, operations] = await Promise.all([
    deps.actions.workspace(task.workspaceId),
    get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId)),
    deps.actions.operations(task.workspaceId),
  ]);
  const derived = deriveTaskStatus({
    closedAt: task.closedAt,
    workspaceStatus: workspace.status,
    pointer,
    operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, error: operation.error, createdAt: operation.createdAt })),
  });
  const events = derived.current === undefined || options.events === 0
    ? []
    : recentTaskEvents(await deps.actions.eventsNewestFirst(derived.current.id, 200), options.events);
  return {
    taskId: task.taskId,
    title: task.title,
    project: task.project,
    status: derived.status,
    ...(derived.failure === undefined ? {} : { failure: derived.failure }),
    startingRevision: task.startingRevision,
    client: task.client,
    shared: task.shared,
    ...(derived.closing ? { closing: true } : {}),
    createdAt: task.createdAt,
    updatedAt: derived.current?.createdAt ?? task.updatedAt,
    events,
  };
}

async function openTasksText(deps: DeveloperTaskRouteDependencies, developerId: string): Promise<string> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" },
    ScanIndexForward: false,
    Limit: 50,
    ConsistentRead: true,
  })) as { Items?: DeveloperTaskIndexRecord[] };
  const open = (response.Items ?? []).filter((row) => row.status !== "CLOSED").slice(0, 10);
  return open.length === 0 ? "" : ` Your open AI-tool tasks: ${open.map((row) => `${row.taskId} (${row.title})`).join("; ")}.`;
}

async function limitError(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, full: "member" | "organization", limits: WorkspaceLimits): Promise<AgentXError> {
  const open = await openTasksText(deps, caller.developerId);
  return full === "member"
    ? agentXError("WORKSPACE_LIMIT", `you have reached the limit of ${limits.member} open workspaces per person, counting Slack threads and AI-tool tasks; close a task with agentx_close_task.${open}`)
    : agentXError("WORKSPACE_LIMIT", `this AgentX has reached its limit of ${limits.organization} open workspaces; close a task with agentx_close_task, or ask an admin.${open}`);
}

async function startTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(StartDeveloperTaskRequestSchema, value, deps, "start");
  const turns = turnTable(deps);
  const client = cleanClientName(request.client);
  const payloadHash = hashJson({
    project: request.project, instructions: request.instructions, title: request.title ?? null,
    shareToChannel: request.shareToChannel ?? null, shareMode: request.shareMode ?? null, channel: request.channel ?? null,
  });
  const idempotencyKey = startIdempotencyKey(caller.developerId, request.requestId);
  const returning = async (previous: { taskId: string; payloadHash: string }) => {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another task; use a new request_id");
    const task = await loadOwnedTask(deps, caller, previous.taskId);
    return { task: await taskView(deps, task, { events: DEVELOPER_EVENTS_DEFAULT, details: false }) };
  };
  // R8: a retried call returns the first task, whatever changed since.
  const previous = await get<{ taskId: string; payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) return returning(previous);

  const taskId = randomUUID();
  const receivedAt = iso(deps);
  const party = partyOf(caller, taskId, client);
  let access: Awaited<ReturnType<DeveloperTaskRouteDependencies["checkAccess"]>>;
  try {
    access = await deps.checkAccess(request.project);
  } catch (error) {
    if (error instanceof AgentXError) return refuse(deps, party, request, receivedAt, error);
    throw error;
  }
  // R9: sharing is phase 25c.
  if (access.policy.share === "required") {
    return refuse(deps, party, request, receivedAt, agentXError("CHANNEL_REQUIRED", `project \`${request.project}\` requires tasks to be shared to its Slack channel, which this AgentX cannot do yet; use the project's Slack channel`));
  }
  if (request.shareToChannel === true) {
    return refuse(deps, party, request, receivedAt, agentXError("CHANNEL_REQUIRED", "sharing tasks to Slack is not available yet in this AgentX; start the task without share_to_channel"));
  }
  const project = await deps.actions.latestProject(request.project);
  if (project === undefined) return refuse(deps, party, request, receivedAt, agentXError("PROJECT_NOT_FOUND", `project \`${request.project}\` doesn't exist in this AgentX; run agentx_list_projects`));
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.actions.limitDefaults);
  const charge = developerCharge({ teamId: deps.slackTeamId, slackUserId: caller.slackUserId, developerId: caller.developerId });
  const full = await limitReached(deps.documentClient, deps.tableName, charge, limits);
  if (full !== undefined) return refuse(deps, party, request, receivedAt, await limitError(deps, caller, full, limits));

  const identity = developerTaskIdentity({ taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client });
  const preparation = await deps.actions.preparation(identity, project, request.requestId);
  const workspaceId = preparation.workspace.id;
  const conversationId = randomUUID();
  const revision = project.definition.revision;
  const title = taskTitle(request.instructions, request.title);
  const task: DeveloperTaskRecord = {
    ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    client, project: request.project, title, workspaceId, ownerKey: identity.ownerKey, conversationId, startingRevision: revision,
    charge, shared: false, createdAt: receivedAt, updatedAt: receivedAt,
  };
  const index: DeveloperTaskIndexRecord = {
    ...taskIndexKey(caller.developerId, receivedAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, project: request.project, title, client,
    status: "STARTING", shared: false, startingRevision: revision, workspaceId, createdAt: receivedAt, updatedAt: receivedAt,
  };
  const pointer: DeveloperTaskPointerRecord = {
    ...taskPointerKey(workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId, developerId: caller.developerId,
    requester: { kind: "developer", developerId: caller.developerId, provider: caller.amr },
    conversationId, firstRequestId: randomUUID(), pendingPrompt: request.instructions,
  };
  const turn = aiToolTurn({
    party: { ...party, workspaceId, settingsRevision: revision }, turnId: randomUUID(), action: "start", phase: "accepted", outcome: "accepted",
    receivedAt, finishedAt: iso(deps), request: request.instructions, response: `Task ${taskId} is STARTING on ${request.project} revision ${revision}.`,
  });
  const items: TransactItems = [
    ...preparation.items,
    putNew(deps.tableName, { ...task }),
    putNew(deps.tableName, { ...index }),
    putNew(deps.tableName, { ...pointer }),
    putNew(deps.tableName, { pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId, createdAt: receivedAt, updatedAt: receivedAt }),
    putNew(deps.tableName, { ...idempotencyKey, entityType: "IDEMPOTENCY", taskId, payloadHash }),
    ...chargeItems(deps.tableName, charge, limits, taskId),
    putNew(turns, turn),
  ];
  try {
    await deps.actions.transact(items);
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await get<{ taskId: string; payloadHash: string }>(deps, idempotencyKey);
    if (concurrent !== undefined) return returning(concurrent);
    const nowFull = await limitReached(deps.documentClient, deps.tableName, charge, limits);
    if (nowFull !== undefined) return refuse(deps, party, request, receivedAt, await limitError(deps, caller, nowFull, limits));
    throw agentXError("WORKSPACE_BUSY", "AgentX could not start the task just now; try again with the same request_id");
  }
  return { task: await taskView(deps, task, { events: 0, details: false }) };
}

export async function routeDeveloperTaskRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (request.method === "POST" && url.pathname === "/v1/dev/tasks") return startTask(deps, caller, body(request));
  throw agentXError("NOT_FOUND", "route not found");
}
```

- [ ] **Step 4: Route to it**

In `developer-routes.ts`, add `tasks?: DeveloperTaskActions;` to `DeveloperRouteDependencies`
(type import from `./developer-task-actions.js`), import `routeDeveloperTaskRequest`, and in
`routeDeveloperRequest`, after the projects route:

```ts
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    return routeDeveloperTaskRequest({
      documentClient: deps.documentClient,
      tableName: deps.tableName,
      ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
      actions: deps.tasks,
      checkAccess: (project) => checkProjectAccess(deps, caller, project),
      now: deps.now,
    }, caller, request, url);
  }
```

In `broker.ts`, where `/v1/dev/` is routed, pass `tasks: developerTaskActions(dependencies)`
with the other dependencies.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-task-start.test.ts tests/contract/developer-routes.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/developer-tasks.ts packages/broker/src/aws/developer-routes.ts packages/broker/src/aws/broker.ts tests/contract/developer-task-start.test.ts
git commit -m "feat(broker): start a developer task in its own workspace (spec 025 FR-017 to FR-020)"
```

---
### Task 9: The prepare's result queues the first task

R3 and FR-018's "no further call from the client". R16's race with a cancel before start.

**Files:**
- Modify: `packages/broker/src/aws/broker.ts` (`recordTerminalResult`, new `queuedFirstTask`)
- Test: `tests/contract/developer-task-chain.test.ts`

**Interfaces:**
- Consumes: `taskOperationParts` (Task 6), `DeveloperTaskPointerRecord`, `taskPointerKey` (Task 4).
- Produces: after a developer task's prepare succeeds, the workspace is `BUSY` with a task
  operation whose `requestId` is the pointer's `firstRequestId`, whose `conversationId` is the
  pointer's, and whose prompt is the pointer's `pendingPrompt`; the pointer no longer has
  `pendingPrompt`. Tasks 10 to 12 read this state.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-chain.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

async function started(instructions = "Fix the flaky retry test") {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions, client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; conversationId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const taskOperations = () => harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "task");
  const taskOutbox = () => harness.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === task.workspaceId && (item.invocation as { kind: string }).kind === "task");
  return { ...harness, taskId, task, prepareId, taskOperations, taskOutbox };
}

describe("the first task is queued by the prepare's result (R3, FR-018)", () => {
  it("moves the workspace to BUSY with the task operation in the same transaction", async () => {
    const instructions = "Fix the flaky retry test\n\nexactly as written \u00e9  ";
    const { db, finish, task, prepareId, taskOperations, taskOutbox } = await started(instructions);
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    const [operation] = taskOperations();
    expect(operation).toMatchObject({ status: "ACCEPTED", conversationId: task.conversationId, requestedBy: { kind: "developer", developerId: MAYA.developerId, provider: "slack" } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: operation?.id, preparationManifest: ".agentx/preparation-manifest.json" });
    const [outbox] = taskOutbox();
    expect((outbox?.invocation as { payload: { prompt: string; conversationStarted: boolean } }).payload).toMatchObject({ prompt: instructions, conversationStarted: false });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("a repeated prepare result queues the first task once (Review Focus 1)", async () => {
    const { finish, task, prepareId, taskOperations, taskOutbox } = await started();
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
  });

  it("queues nothing when the prepare fails, and keeps the instructions for the record", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    await finish(task.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).toHaveProperty("pendingPrompt");
  });

  it("queues nothing when the task was cancelled before its instructions ran (R16)", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const pointer = db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")!;
    delete pointer.pendingPrompt;
    pointer.cancelledAt = new Date().toISOString();
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("still records the prepare when a cancel lands between the read and the write", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      // The cancel lands just before the result's transaction is committed.
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("REMOVE pendingPrompt")) {
        raced = true;
        const pointer = db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")!;
        delete pointer.pendingPrompt;
        pointer.cancelledAt = new Date().toISOString();
      }
      return original(command);
    };
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(raced).toBe(true);
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("leaves a Slack thread's prepare as it was: READY, nothing queued", async () => {
    const { db, handler, finish } = await createDeveloperTaskBroker();
    const thread = await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, "U0PRATIK01");
    const workspaceId = String(thread.body.workspaceId);
    await finish(workspaceId, String(thread.body.operationId), "SUCCEEDED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "task")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-chain.test.ts`
Expected: FAIL, the workspace is `READY` and no task operation exists.

- [ ] **Step 3: Queue the first task in the result's transaction**

In `broker.ts`, import `taskPointerKey` and `type DeveloperTaskPointerRecord` from
`"../developer/task-records.js"` and add:

```ts
/**
 * Spec 025 R3: the first instructions of a developer task, queued in the prepare's own result
 * transaction. Returns the workspace update that replaces the prepare's (PREPARING straight to
 * BUSY) and the task's items. The pointer's condition makes a cancel that lands first win.
 */
async function queuedFirstTask(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  prepare: OperationRecord,
  pointer: DeveloperTaskPointerRecord & { pendingPrompt: string },
  now: string,
): Promise<{ workspaceUpdate: TransactItems[number]; items: TransactItems }> {
  const { operation, outbox, fence } = await taskOperationParts(dependencies, workspace, {
    requestId: pointer.firstRequestId,
    conversationId: pointer.conversationId,
    prompt: pointer.pendingPrompt,
    conversationStarted: false,
    requester: { requestedBy: pointer.requester },
  }, now);
  return {
    workspaceUpdate: { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :busy, updatedAt = :now, preparationManifest = :manifest, activeOperationId = :task, fence = :taskFence",
      ConditionExpression: "activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":busy": "BUSY", ":now": now, ":manifest": ".agentx/preparation-manifest.json",
        ":task": operation.id, ":taskFence": fence, ":operation": prepare.id, ":fence": prepare.fence,
      },
    } },
    items: [
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${workspace.ownerKey}#${workspace.id}`, sk: `REQUEST#${pointer.firstRequestId}`, entityType: "IDEMPOTENCY", operationId: operation.id, payloadHash: operation.payloadHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: taskPointerKey(workspace.id),
        UpdateExpression: "REMOVE pendingPrompt",
        ConditionExpression: "attribute_exists(pendingPrompt) AND attribute_not_exists(cancelledAt)",
      } },
    ],
  };
}
```

In `recordTerminalResult`:
- hold the workspace update in a variable (`const workspaceUpdate = { Update: { ... } }`, the
  existing object, unchanged) and push it only in its existing condition;
- before sending, when `operation.kind === "prepare" && terminalStatus === "SUCCEEDED"`, read the
  pointer and, if it has `pendingPrompt`, build `queuedFirstTask(...)`, and send the items with
  the queued workspace update in place of the prepare's own, plus the task's items;
- if that transaction fails its conditions, read the pointer again; when `pendingPrompt` is gone
  (a cancel won), send the original items once more, without the task. Any other failure keeps
  today's handling.

```ts
  const send = (items: typeof transactItems) => dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  const pointer = operation.kind === "prepare" && terminalStatus === "SUCCEEDED"
    ? await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id))
    : undefined;
  const queued = pointer?.pendingPrompt !== undefined && pointer.cancelledAt === undefined
    ? await queuedFirstTask(dependencies, workspace, operation, { ...pointer, pendingPrompt: pointer.pendingPrompt }, now)
    : undefined;
  try {
    if (queued === undefined) {
      await send(transactItems);
    } else {
      try {
        await send([...transactItems.filter((item) => item !== workspaceUpdate), queued.workspaceUpdate, ...queued.items]);
      } catch (error) {
        if (!isConditional(error)) throw error;
        const again = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id));
        if (again?.pendingPrompt !== undefined) throw error;
        await send(transactItems);
      }
    }
  } catch (transactionError) {
    // ... the existing isConditional / STALE_FENCE handling, unchanged ...
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/developer-task-chain.test.ts tests/contract/slack-control-plane.test.ts tests/contract/slack-lazy-workspace.test.ts tests/contract/admin-preparation.test.ts tests/contract/dispatch.test.ts tests/contract/cloud-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/broker.ts tests/contract/developer-task-chain.test.ts
git commit -m "feat(broker): the prepare's result queues a developer task's instructions (spec 025 FR-018)"
```

---
### Task 10: Reading tasks

`GET /v1/dev/tasks`, `GET /v1/dev/tasks/{taskId}` and `GET /v1/dev/tasks/{taskId}/events`:
FR-016, FR-025, FR-036, R4, R18, and the checks for FR-024 and SC-004.

**Files:**
- Modify: `packages/broker/src/aws/developer-tasks.ts`
- Test: `tests/contract/developer-task-reads.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 8, 9.
- Produces:
  - `taskView(deps, task, { events, details: true })` fills `summary`, `changedFiles`,
    `artifacts` and `pullRequests` once the latest task operation has ended;
  - `syncIndex(deps, task, status)`: writes a changed status to the index row, best effort;
  - the three read routes. Query parameters: `events` (0 to 50, default 10) on the task; `project`,
    `status`, `limit` (1 to 50, default 20) on the list; `limit` (1 to 50, default 10) on events.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-reads.test.ts
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

const PLANTED = "xoxb-2222222222-planted-secret";
const DIFF = ["## demo", "", "### status", " M src/retry.ts", "### diff", "diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts", "@@ -1 +1,2 @@", "-old", "+new", "+more"].join("\n");

async function running() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(workspaceId, prepareId, "SUCCEEDED");
  const operationId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const read = async (query = "") => (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}${query}`)).body;
  return { ...harness, taskId, workspaceId, prepareId, operationId, read };
}

describe("GET /v1/dev/tasks/{taskId} (FR-016, FR-025)", () => {
  it("follows the task from STARTING to SUCCEEDED, with progress, then the summary, changed files and artifacts", async () => {
    const { read, events, artifact, finish, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, [
      { type: "lifecycle", payload: { status: "RUNNING" } },
      { type: "tool_start", payload: { type: "tool_execution_start", toolName: "bash" } },
    ]);
    expect(await read()).toMatchObject({ task: { status: "RUNNING", events: [{ kind: "status" }, { kind: "tool", text: "Started bash" }] } });
    await events(workspaceId, operationId, [{ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The retry test waits on a real clock. I faked it; all 212 tests pass." }] } } }]);
    await artifact(workspaceId, operationId, "workspace.diff", DIFF);
    await finish(workspaceId, operationId, "SUCCEEDED");
    const { task } = await read() as { task: Record<string, unknown> };
    expect(task).toMatchObject({
      status: "SUCCEEDED",
      summary: "The retry test waits on a real clock. I faked it; all 212 tests pass.",
      changedFiles: [{ repository: "demo", path: "src/retry.ts", added: 2, removed: 1 }],
      artifacts: [{ name: "workspace.diff", size: Buffer.byteLength(DIFF) }],
    });
    expect(task).not.toHaveProperty("failure");
  });

  it("returns only as many events as asked, and none for events=0", async () => {
    const { read, events, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, Array.from({ length: 5 }, (_, index) => ({ type: "progress", payload: { message: `step ${index}` } })));
    expect(((await read("?events=2")) as { task: { events: Array<{ text: string }> } }).task.events.map((entry) => entry.text)).toEqual(["step 3", "step 4"]);
    expect(((await read("?events=0")) as { task: { events: unknown[] } }).task.events).toEqual([]);
    expect(((await read("?events=51")) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });

  it("gives a failed task its category and redacted message, and an interrupted one interrupted", async () => {
    const first = await running();
    await first.finish(first.workspaceId, first.operationId, "FAILED", { error: `tests failed near ${PLANTED}` });
    const failed = (await first.read()) as { task: { status: string; failure: { category: string; message: string } } };
    expect(failed.task).toMatchObject({ status: "FAILED", failure: { category: "task_failed" } });
    expect(JSON.stringify(failed)).not.toContain(PLANTED);
    const second = await running();
    await second.finish(second.workspaceId, second.operationId, "INTERRUPTED", { error: "worker process lost" });
    expect(((await second.read()) as { task: { failure: { category: string } } }).task.failure.category).toBe("interrupted");
  });

  it("answers TASK_NOT_FOUND to another developer and for a malformed ID (FR-036)", async () => {
    const { dev, taskId } = await running();
    for (const [who, id] of [[OMAR, taskId], [MAYA, "not-a-task"], [MAYA, randomUUID()]] as const) {
      const response = await dev(who, "GET", `/v1/dev/tasks/${id}`);
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(String((response.body.error as { message: string }).message)).toContain("agentx_list_tasks");
    }
  });

  it("never returns a planted secret from events, the summary, artifact names or errors (SC-004)", async () => {
    const { read, events, artifact, finish, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, [
      { type: "progress", payload: { message: `export SLACK=${PLANTED}` } },
      { type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `done, token ${PLANTED}` }] } } },
      { type: "error", payload: { message: `warning ${PLANTED}` } },
    ]);
    await artifact(workspaceId, operationId, `notes-${PLANTED}.txt`, "x");
    await finish(workspaceId, operationId, "SUCCEEDED");
    expect(JSON.stringify(await read("?events=50"))).not.toContain(PLANTED);
  });
});

describe("GET /v1/dev/tasks (FR-016)", () => {
  it("lists only the caller's tasks, newest first, with filters and a limit, and refreshes live statuses", async () => {
    const harness = await createDeveloperTaskBroker({ memberLimit: 5 });
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: title });
      ids.push((response.body.task as { taskId: string }).taskId);
      // Distinct createdAt values, so "newest first" has one answer.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const first = harness.db.get(`DEVTASK#${ids[0]}`, "META") as { workspaceId: string; createdAt: string };
    const prepareId = String((harness.db.get(`WORKSPACE#${first.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(first.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });

    const all = (await harness.dev(MAYA, "GET", "/v1/dev/tasks")).body as { tasks: Array<{ taskId: string; title: string; status: string }> };
    expect(all.tasks.map((task) => task.title)).toEqual(["three", "two", "one"]);
    expect(all.tasks.find((task) => task.taskId === ids[0])?.status).toBe("FAILED");
    expect(harness.db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${first.createdAt}#${ids[0]}`)).toMatchObject({ status: "FAILED" });
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?status=FAILED")).body as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?project=other")).body as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?limit=2")).body as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(((await harness.dev(OMAR, "GET", "/v1/dev/tasks")).body as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?limit=0")).body as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });
});

describe("GET /v1/dev/tasks/{taskId}/events", () => {
  it("returns the latest readable events of the current operation", async () => {
    const { dev, events, taskId, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, [{ type: "progress", payload: { message: "a" } }, { type: "progress", payload: { message: "b" } }]);
    expect(((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/events?limit=1`)).body as { events: Array<{ text: string }> }).events.map((entry) => entry.text)).toEqual(["b"]);
  });
});

describe("no developer task code reads the deployment mode (FR-024)", () => {
  const files = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : path.endsWith(".ts") ? [path] : [];
  it.each([
    "packages/broker/src/aws/developer-tasks.ts",
    "packages/broker/src/aws/developer-task-actions.ts",
    "packages/broker/src/developer/task-records.ts",
    "packages/broker/src/developer/limits.ts",
  ])("%s", (path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(/deploymentMode|ec2-ebs|agentcore/i);
  });
  it.skipIf(!existsSync("packages/mcp/src"))("the MCP package", () => {
    for (const path of files("packages/mcp/src")) expect(readFileSync(path, "utf8"), path).not.toMatch(/deploymentMode|ec2-ebs|agentcore/i);
  });
});
```

The MCP package check is skipped until Task 14 creates `packages/mcp/src`, and runs from then on.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-reads.test.ts`
Expected: FAIL, the read routes answer `NOT_FOUND`.

- [ ] **Step 3: Add the details, the index sync and the routes**

In `developer-tasks.ts`, import `DEVELOPER_EVENTS_MAX`, `DEVELOPER_TASK_LIST_DEFAULT`,
`DEVELOPER_TASK_LIST_MAX`, `DEVELOPER_TASK_SUMMARY_MAX`, `DeveloperTaskStatusSchema`,
`diffStat`, `lastAssistantResponse`, `redactText`, and the types
`DeveloperTaskListItem`, `DeveloperTaskStatus`; import `UpdateCommand`. Then:

```ts
const DIFF_READ_BYTES = 1_000_000;
const byCreated = (left: { createdAt: string }, right: { createdAt: string }) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0);

/** R18: what the latest task operation left, and the task's pull requests. */
async function taskDetails(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<Pick<DeveloperTaskView, "summary" | "changedFiles" | "artifacts" | "pullRequests">> {
  const [operations, pullRequests] = await Promise.all([deps.actions.operations(task.workspaceId), deps.actions.pullRequests(task.workspaceId)]);
  const details: Pick<DeveloperTaskView, "summary" | "changedFiles" | "artifacts" | "pullRequests"> = {};
  const lastTask = operations.filter((operation) => operation.kind === "task").sort(byCreated).at(-1);
  if (lastTask !== undefined) {
    const said = lastAssistantResponse((await deps.actions.eventsNewestFirst(lastTask.id, 500)).reverse());
    if (said !== undefined) details.summary = redactText(said).slice(0, DEVELOPER_TASK_SUMMARY_MAX);
    const artifacts = await deps.actions.artifacts(task.workspaceId, lastTask.id);
    details.artifacts = artifacts.map((artifact) => ({ name: redactText(artifact.name).slice(0, 200), ...(artifact.size === undefined ? {} : { size: artifact.size }) }));
    const diff = artifacts.find((artifact) => artifact.name === "workspace.diff");
    if (diff !== undefined) {
      details.changedFiles = diffStat(await deps.actions.readArtifact(diff.objectKey, DIFF_READ_BYTES))
        .map((file) => ({ ...file, path: redactText(file.path) }));
    }
  }
  if (pullRequests.length > 0) details.pullRequests = pullRequests;
  return details;
}

/** R4: the index row keeps the last status the API saw; a failed write only costs a stale list row. */
export async function syncIndex(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, status: DeveloperTaskStatus): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #status = :status, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND #status <> :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": status, ":now": iso(deps) },
    }));
  } catch (error) {
    if (!isConditional(error)) log(deps, { event: "developer.task_index_sync_failed", error: error instanceof Error ? error.name : "unknown" });
  }
}

const whole = (value: string | null, fallback: number, min: number, max: number, name: string): number => {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw agentXError("CONFIG_INVALID", `${name} must be a whole number from ${min} to ${max}`);
  return parsed;
};

async function readTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, url: URL): Promise<{ task: DeveloperTaskView }> {
  const task = await loadOwnedTask(deps, caller, taskId);
  const view = await taskView(deps, task, { events: whole(url.searchParams.get("events"), DEVELOPER_EVENTS_DEFAULT, 0, DEVELOPER_EVENTS_MAX, "events"), details: true });
  await syncIndex(deps, task, view.status);
  return { task: view };
}

async function listTasks(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, url: URL): Promise<{ tasks: DeveloperTaskListItem[] }> {
  const limit = whole(url.searchParams.get("limit"), DEVELOPER_TASK_LIST_DEFAULT, 1, DEVELOPER_TASK_LIST_MAX, "limit");
  const project = url.searchParams.get("project");
  const statusParam = url.searchParams.get("status");
  const status = statusParam === null ? undefined : DeveloperTaskStatusSchema.safeParse(statusParam);
  if (status !== undefined && !status.success) throw agentXError("CONFIG_INVALID", `status must be one of ${DeveloperTaskStatusSchema.options.join(", ")}`);
  const tasks: DeveloperTaskListItem[] = [];
  let start: Record<string, unknown> | undefined;
  let scanned = 0;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" },
      ScanIndexForward: false,
      Limit: 50,
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: DeveloperTaskIndexRecord[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of response.Items ?? []) {
      scanned += 1;
      let current: DeveloperTaskStatus = row.status;
      if (row.status !== "CLOSED") {
        const task = await get<DeveloperTaskRecord>(deps, taskKey(row.taskId));
        if (task !== undefined) {
          current = (await taskView(deps, task, { events: 0, details: false })).status;
          if (current !== row.status) await syncIndex(deps, task, current);
        }
      }
      if (project !== null && row.project !== project) continue;
      if (status?.success === true && current !== status.data) continue;
      tasks.push({ taskId: row.taskId, title: row.title, project: row.project, status: current, shared: row.shared, createdAt: row.createdAt, updatedAt: row.updatedAt });
      if (tasks.length >= limit) return { tasks };
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined && scanned < 200);
  return { tasks };
}

async function taskEvents(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, url: URL) {
  const task = await loadOwnedTask(deps, caller, taskId);
  return { events: (await taskView(deps, task, { events: whole(url.searchParams.get("limit"), DEVELOPER_EVENTS_DEFAULT, 1, DEVELOPER_EVENTS_MAX, "limit"), details: false })).events };
}
```

In `taskView`, when `options.details` is true and the status is not `STARTING` or `RUNNING`,
spread `...(await taskDetails(deps, task))` into the view.

The list re-derives every row that is not `CLOSED` (a closed task never changes again), so a
list of 50 open tasks costs at most 50 derivations, and a developer with many closed tasks pays
nothing for them. Extend `routeDeveloperTaskRequest`:

```ts
  if (request.method === "GET" && url.pathname === "/v1/dev/tasks") return listTasks(deps, caller, url);
  const route = /^\/v1\/dev\/tasks\/([^/]+)(?:\/(events|continue|cancel|close|pull-requests))?$/.exec(url.pathname);
  const taskId = route?.[1] === undefined ? undefined : decodeURIComponent(route[1]);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === undefined) return readTask(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "events") return taskEvents(deps, caller, taskId, url);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/developer-task-reads.test.ts tests/contract/developer-task-start.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/developer-tasks.ts tests/contract/developer-task-reads.test.ts
git commit -m "feat(broker): read and list developer tasks with their results (spec 025 FR-016, FR-025, FR-036)"
```

---
### Task 11: Continue, cancel, pull requests, and the completed audit records

`POST tasks/{taskId}/continue`, `/cancel` and `/pull-requests`: FR-016, FR-021, FR-023, FR-037,
R12's `completed` record, R16, R17, and US1 scenarios 4 and 5.

**Files:**
- Modify: `packages/broker/src/aws/developer-tasks.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`recordTerminalResult` writes the `completed` record)
- Test: `tests/contract/developer-task-actions-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 8, 9, 10.
- Produces:
  - `POST /v1/dev/tasks/{taskId}/continue` with `ContinueDeveloperTaskRequest`, answering `{ task }`;
  - `POST /v1/dev/tasks/{taskId}/cancel` with `{ requestId }`, answering `{ task }`;
  - `POST /v1/dev/tasks/{taskId}/pull-requests` with `DeveloperPullRequestRequest`, answering
    `DeveloperPullRequestResponse`. It answers at once with the publish operation's ID and status
    (R22). Posting the same `requestId` again returns the same operation with its current status
    and, once published, `pullRequest`, and writes nothing, so a retried call is safe;
  - `completedTurn(input: { task: DeveloperTaskRecord; pointer: DeveloperTaskPointerRecord; operation: Operation; status: OperationStatus; events: StoredEvent[]; now: string }): Record<string, unknown>`
    in `task-records.ts`, keyed by the operation's ID so a repeated result cannot write it twice.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-actions-routes.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";

const said = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

async function finished(status: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; conversationId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const prepareId = active();
  await harness.finish(task.workspaceId, prepareId, "SUCCEEDED");
  const firstTaskId = active();
  await harness.events(task.workspaceId, firstTaskId, [said("Fixed: the test used a real clock.")]);
  await harness.finish(task.workspaceId, firstTaskId, status, status === "FAILED" ? { error: "tests failed" } : {});
  const post = (route: string, body: unknown) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/${route}`, body);
  const turns = () => harness.db.find((item) => item.pk === `TASK#${taskId}`);
  return { ...harness, taskId, task, prepareId, firstTaskId, active, post, turns };
}

describe("continue (US1 scenario 5, FR-019)", () => {
  it("runs the new instructions unchanged in the same workspace and conversation", async () => {
    const { db, post, task, active, turns } = await finished();
    const requestId = randomUUID();
    const response = await post("continue", { requestId, instructions: "Now add a test for the timeout path." });
    expect(response.body.task).toMatchObject({ status: "RUNNING" });
    const operation = db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${active()}`);
    expect(operation).toMatchObject({ kind: "task", conversationId: task.conversationId, requestId, requestedBy: { kind: "developer" } });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === active())[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe("Now add a test for the timeout path.");
    expect(turns().filter((item) => item.action === "continue" && item.phase === "accepted")).toHaveLength(1);
    expect((await post("continue", { requestId, instructions: "Now add a test for the timeout path." })).body.task).toMatchObject({ status: "RUNNING" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "task")).toHaveLength(2);
  });

  it("keeps the starting revision when the project has a newer one", async () => {
    const { db, handler, post, task } = await finished();
    await registerRevision(handler, 2, [{ name: "demo" }]);
    await post("continue", { requestId: randomUUID(), instructions: "more" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ projectRevision: 1 });
  });

  it("answers TASK_BUSY while the task runs, naming what to do", async () => {
    const { post } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "one" });
    const busy = await post("continue", { requestId: randomUUID(), instructions: "two" });
    expect(busy.body.error).toMatchObject({ code: "TASK_BUSY" });
    expect(String((busy.body.error as { message: string }).message)).toMatch(/agentx_wait_for_task|agentx_cancel_task/);
  });

  it("refuses a task that never started (R17)", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "npm ci exited 1" });
    const refused = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "retry" });
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "this task never started; close it with agentx_close_task and start a new one" });
  });
});

describe("cancel", () => {
  it("before the instructions run, removes them, and the task reads CANCELLED (R16)", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const cancelled = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(cancelled.body.task).toMatchObject({ status: "CANCELLED" });
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, "DEVELOPER_TASK")).toMatchObject({ cancelledAt: expect.any(String) });
    expect(harness.db.find((item) => item.pk === `TASK#${taskId}` && item.action === "cancel")).toHaveLength(1);
  });

  it("while it runs, asks the worker to stop, and the task reads CANCELLED once the worker says so", async () => {
    const { db, post, task, active, finish, taskId, dev } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const running = active();
    await post("cancel", { requestId: randomUUID() });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${running}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    const cancelOperation = db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")[0]!;
    await finish(task.workspaceId, String(cancelOperation.id), "SUCCEEDED");
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CANCELLED" });
  });

  it("with nothing running, answers with the task as it is", async () => {
    const { post } = await finished();
    expect((await post("cancel", { requestId: randomUUID() })).body.task).toMatchObject({ status: "SUCCEEDED" });
  });
});

describe("pull requests (US1 scenario 4, FR-023)", () => {
  it("opens a draft on the only repository through the publication path, with the developer footer", async () => {
    const { db, post, task, turns } = await finished();
    const requestId = randomUUID();
    const response = await post("pull-requests", { requestId, title: "Fix the flaky retry test", body: "Uses a fake clock." });
    expect(response.body).toMatchObject({ operationStatus: "ACCEPTED", task: { status: "RUNNING" } });
    const operationId = String(response.body.operationId);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({
      kind: "publish",
      publication: { repository: "demo", draft: true, body: "Uses a fake clock.\n\n---\nRequested by `Maya Chen` via AgentX, started from Claude Code" },
    });
    expect(turns().filter((item) => item.action === "pull_request" && item.phase === "accepted")).toHaveLength(1);
    const again = await post("pull-requests", { requestId, title: "Fix the flaky retry test", body: "Uses a fake clock." });
    expect(again.body.operationId).toBe(operationId);
    expect(turns().filter((item) => item.action === "pull_request")).toHaveLength(1);
  });

  it("asks for the repository when the project has several", async () => {
    const { handler, post } = await finished();
    await registerRevision(handler, 2, [{ name: "demo" }, { name: "docs" }]);
    const response = await post("pull-requests", { requestId: randomUUID(), title: "x" });
    expect(response.body.error).toEqual({ code: "CONFIG_INVALID", message: "this project has several repositories; name one of: demo, docs" });
  });

  it("answers TASK_BUSY while the task runs", async () => {
    const { post } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "one" });
    expect((await post("pull-requests", { requestId: randomUUID(), title: "x" })).body.error).toMatchObject({ code: "TASK_BUSY" });
  });
});

describe("completed audit records (R12, FR-037)", () => {
  it("records the result summary when a task operation ends, once, keyed by the operation", async () => {
    const { turns, finish, task, firstTaskId } = await finished();
    const completed = turns().filter((item) => item.phase === "completed");
    expect(completed).toEqual([expect.objectContaining({ action: "start", outcome: "succeeded", operationId: firstTaskId, responseText: "Fixed: the test used a real clock." })]);
    await finish(task.workspaceId, firstTaskId, "SUCCEEDED");
    expect(turns().filter((item) => item.phase === "completed")).toHaveLength(1);
  });

  it("records a failure with its outcome", async () => {
    const { turns } = await finished("FAILED");
    expect(turns().filter((item) => item.phase === "completed")).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});

async function registerRevision(handler: Parameters<typeof call>[0], revision: number, repositories: Array<{ name: string }>) {
  const response = await call(handler, {
    method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
    body: {
      definition: {
        name: "payments", revision,
        repositories: repositories.map((repository) => ({ name: repository.name, url: `https://github.com/example/${repository.name}.git`, path: `repo/${repository.name}`, defaultBranch: "main", credentialRef: "github-app" })),
        setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      },
      runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
    },
  });
  if (response.status !== 201) throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-actions-routes.test.ts`
Expected: FAIL, the routes answer `NOT_FOUND`.

- [ ] **Step 3: The completed record**

Append to `task-records.ts` (importing `lastAssistantResponse`, `PullRequestResultSchema` and the
`Operation`, `OperationStatus` types):

```ts
const OUTCOME: Record<string, AiToolTurnRecord["outcome"]> = { SUCCEEDED: "succeeded", FAILED: "failed", CANCELLED: "cancelled", INTERRUPTED: "interrupted" };

/** R12: the result of a developer's task or publish operation, keyed by the operation (a retry cannot add one). */
export function completedTurn(input: {
  task: DeveloperTaskRecord;
  pointer: DeveloperTaskPointerRecord;
  operation: Pick<Operation, "id" | "kind" | "requestId" | "createdAt"> & { result?: unknown; error?: string | undefined };
  status: string;
  events: readonly StoredEvent[];
  now: string;
}): Record<string, unknown> {
  const { task, operation } = input;
  const published = operation.kind === "publish" ? PullRequestResultSchema.safeParse(operation.result) : undefined;
  const response = operation.kind === "publish"
    ? (published?.success ? `Pull request ${published.data.url}` : `The pull request ended ${input.status}${operation.error ? `: ${operation.error}` : ""}`)
    : lastAssistantResponse(input.events) ?? `The task ended ${input.status}${operation.error ? `: ${operation.error}` : ""}`;
  return aiToolTurn({
    party: {
      taskId: task.taskId, developerId: task.developerId, provider: task.provider, developerName: task.developerName,
      slackUserId: task.slackUserId, client: task.client, workspaceId: task.workspaceId, settingsRevision: task.startingRevision,
    },
    turnId: operation.id,
    action: operation.kind === "publish" ? "pull_request" : operation.requestId === input.pointer.firstRequestId ? "start" : "continue",
    phase: "completed",
    outcome: OUTCOME[input.status] ?? "failed",
    receivedAt: operation.createdAt,
    finishedAt: input.now,
    request: "",
    response,
    operationId: operation.id,
  });
}
```

In `broker.ts`'s `recordTerminalResult`, read the pointer for `prepare`, `task`, `publish` and
`close` operations (one `getItem`, reused by Tasks 9 and 12). When the operation is `task` or
`publish`, a pointer exists, and `dependencies.turnRecordsTableName` is set, load
`DEVTASK#<pointer.taskId>`, read the operation's events (newest 500, reversed), and add

```ts
{ Put: { TableName: dependencies.turnRecordsTableName, Item: completedTurn({ task, pointer, operation: { ...operation, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }, status: terminalStatus, events, now }), ConditionExpression: "attribute_not_exists(pk)" } }
```

to the transaction's items (in every branch). The record and the result land together or not at
all.

- [ ] **Step 4: The three routes**

In `developer-tasks.ts`, import `ContinueDeveloperTaskRequestSchema`,
`DeveloperTaskActionRequestSchema`, `DeveloperPullRequestRequestSchema`, `PullRequestResultSchema`
and the type `DeveloperPullRequestResponse`, and add:

```ts
const partyOfTask = (task: DeveloperTaskRecord): TurnParty => ({
  taskId: task.taskId, developerId: task.developerId, provider: task.provider, developerName: task.developerName,
  slackUserId: task.slackUserId, client: task.client, workspaceId: task.workspaceId, settingsRevision: task.startingRevision,
});

/** The existing handlers' busy answers, in the developer's words (FR-049's TASK_BUSY). */
function busy(error: unknown, taskId: string): never {
  if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) {
    throw agentXError("TASK_BUSY", `task ${taskId} is still working; wait for it with agentx_wait_for_task, or stop it with agentx_cancel_task`);
  }
  throw error;
}

async function continueTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "continue");
  const task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const before = await taskView(deps, task, { events: 0, details: false });
  if (before.status === "CLOSED") throw agentXError("CONFIG_INVALID", "this task is closed; start a new one with agentx_start_task");
  if (before.failure?.category === "setup_failed") throw agentXError("CONFIG_INVALID", "this task never started; close it with agentx_close_task and start a new one");
  const receivedAt = iso(deps);
  try {
    await deps.actions.acceptTask(developerTaskIdentity(task), task.workspaceId, { requestId: request.requestId, conversationId: task.conversationId, prompt: request.instructions }, (operation) => [
      putNew(turns, aiToolTurn({
        party: partyOfTask(task), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: request.instructions, response: `Continuing task ${taskId} as operation ${operation.id}.`, operationId: operation.id,
      })),
    ]);
  } catch (error) {
    busy(error, taskId);
  }
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status);
  return { task: view };
}

async function cancelTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  parse(DeveloperTaskActionRequestSchema, value, deps, "cancel");
  const task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const receivedAt = iso(deps);
  const record = (response: string, operationId?: string) => aiToolTurn({
    party: partyOfTask(task), turnId: randomUUID(), action: "cancel", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
    request: "cancel", response, ...(operationId === undefined ? {} : { operationId }),
  });
  let handled = false;
  const pointer = await get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId));
  if (pointer?.pendingPrompt !== undefined) {
    // R16: before the instructions run, removing them is the whole cancel.
    try {
      await deps.actions.transact([
        { Update: {
          TableName: deps.tableName, Key: taskPointerKey(task.workspaceId),
          UpdateExpression: "SET cancelledAt = :now REMOVE pendingPrompt", ConditionExpression: "attribute_exists(pendingPrompt)",
          ExpressionAttributeValues: { ":now": receivedAt },
        } },
        putNew(turns, record("Cancelled before the instructions ran.")),
      ]);
      handled = true;
    } catch (error) {
      // The prepare's result queued them meanwhile: cancel the running task instead.
      if (!isConditional(error)) throw error;
    }
  }
  if (!handled) {
    const result = await deps.actions.cancelRunning(developerTaskIdentity(task), await deps.actions.workspace(task.workspaceId), (operation) => [
      putNew(turns, record("Asked the worker to stop.", operation.id)),
    ]);
    if (result.outcome === "NOTHING_RUNNING") {
      try {
        await deps.documentClient.send(new PutCommand({ TableName: turns, Item: record("Nothing was running."), ConditionExpression: "attribute_not_exists(pk)" }));
      } catch (error) {
        turnRecordFailed(deps, error);
      }
    }
  }
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status);
  return { task: view };
}

async function openPullRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<DeveloperPullRequestResponse> {
  const request = parse(DeveloperPullRequestRequestSchema, value, deps, "pull-request");
  const task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "this task is closed; start a new one with agentx_start_task");
  let repository = request.repository;
  if (repository === undefined) {
    const repositories = (await deps.actions.latestProject(task.project))?.definition.repositories.map((entry) => entry.name) ?? [];
    if (repositories.length !== 1) throw agentXError("CONFIG_INVALID", `this project has several repositories; name one of: ${repositories.join(", ")}`);
    repository = repositories[0]!;
  }
  const receivedAt = iso(deps);
  let accepted: Awaited<ReturnType<DeveloperTaskActions["acceptPullRequest"]>>;
  try {
    accepted = await deps.actions.acceptPullRequest(developerTaskIdentity(task), task.workspaceId, {
      requestId: request.requestId, repository, title: request.title, draft: request.draft,
      ...(request.body === undefined ? {} : { body: request.body }),
    }, (operation) => [
      putNew(turns, aiToolTurn({
        party: partyOfTask(task), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: `${request.title}\n\n${request.body ?? ""}`, response: `Opening a pull request on ${repository} as operation ${operation.id}.`, operationId: operation.id,
      })),
    ]);
  } catch (error) {
    busy(error, taskId);
  }
  const published = PullRequestResultSchema.safeParse(accepted.operation.result);
  const pullRequest = accepted.operation.status === "SUCCEEDED" && published.success
    ? { repository: published.data.repository, number: published.data.number, url: published.data.url, state: "open" as const }
    : undefined;
  return {
    task: await taskView(deps, task, { events: 0, details: true }),
    operationId: accepted.operation.id,
    operationStatus: accepted.operation.status,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}
```

and in `routeDeveloperTaskRequest`:

```ts
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "continue") return continueTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "cancel") return cancelTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "pull-requests") return openPullRequest(deps, caller, taskId, body(request));
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/developer-task-actions-routes.test.ts tests/contract/developer-task-chain.test.ts tests/contract/developer-task-reads.test.ts tests/contract/slack-control-plane.test.ts tests/contract/cancel-task.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src tests/contract/developer-task-actions-routes.test.ts
git commit -m "feat(broker): continue, cancel and open a PR for a developer task, with its audit records (spec 025 FR-016, FR-023, FR-037)"
```

---
### Task 12: Closing a task

`POST /v1/dev/tasks/{taskId}/close`: FR-016, FR-030's "the workspace is released and stops
counting against limits", R6's release of the charged counters, and R15.

**Files:**
- Modify: `packages/broker/src/aws/developer-tasks.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`recordTerminalResult` finishes a safe developer close)
- Test: `tests/contract/developer-task-close.test.ts`

**Interfaces:**
- Consumes: Tasks 5 (`releaseItems`), 6 (`startClose`, `deleteCompute`), 10, 11.
- Produces:
  - `finishTaskClose(deps: { tableName: string; actions: DeveloperTaskActions }, task: DeveloperTaskRecord, closeOperationId: string | undefined): Promise<void>`
    (deletes the compute, then in one transaction: the workspace `CLOSED`, the counters released, the
    task's `closedAt`, the index row `CLOSED`; a lost race is not an error);
  - `resumeClose(deps, task): Promise<void>`: finishes a close whose preflight succeeded safe
    but whose completion did not land (called by the read and close routes);
  - `POST /v1/dev/tasks/{taskId}/close` with `{ requestId }`, answering `DeveloperCloseResponse`
    at once, usually with `closing: true` while the worker checks (R22). Posting the same
    `requestId` again reports the preflight's outcome and writes nothing, so a retried call is safe;
  - `taskView` reports `unpublished` from the latest close preflight that refused, while no later
    close is running and the task is not closed, so `agentx_get_task` shows why a close did not
    happen (R22).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-close.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

async function finished(options: { memberLimit?: number } = {}) {
  const harness = await createDeveloperTaskBroker(options);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; createdAt: string };
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(task.workspaceId, active(), "SUCCEEDED");
  await harness.finish(task.workspaceId, active(), "SUCCEEDED");
  const close = (requestId: string) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId });
  const member = () => harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`);
  return { ...harness, taskId, task, active, close, member };
}

describe("closing a task (R15)", () => {
  it("runs the preflight, then finishes the close itself: compute deleted, workspace CLOSED, counters released", async () => {
    const { db, close, task, taskId, active, finish, deleteEc2Session, member, dev } = await finished();
    const requestId = randomUUID();
    const started = await close(requestId);
    expect(started.body).toMatchObject({ closed: false, task: { closing: true } });
    const closeId = active();
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${closeId}`)).toMatchObject({ kind: "close", requestedBy: { kind: "developer" } });
    await finish(task.workspaceId, closeId, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(deleteEc2Session).toHaveBeenCalledWith(task.workspaceId);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(member()).toMatchObject({ count: 0 });
    expect(member()).not.toHaveProperty("tasks");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
    expect(db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
    expect(db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${task.createdAt}#${taskId}`)).toMatchObject({ status: "CLOSED" });
    expect((await close(requestId)).body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CLOSED" });
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close")).toHaveLength(1);
  });

  it("keeps the task when the preflight finds unpublished work, and says which", async () => {
    const { db, close, task, active, finish, member } = await finished();
    const requestId = randomUUID();
    await close(requestId);
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    expect((await close(requestId)).body).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], task: { status: "SUCCEEDED" } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(member()).toMatchObject({ count: 1 });
  });

  it("shows the refused close on the task itself, so the AI tool can check back with agentx_get_task (R22)", async () => {
    const { dev, close, task, taskId, active, finish } = await finished();
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }] } });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "SUCCEEDED", unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).not.toHaveProperty("closing");
  });

  it("closes a task that never started at once", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "npm ci exited 1" });
    const closed = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 0 });
  });

  it("answers TASK_BUSY while the task is still starting", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body.error).toMatchObject({ code: "TASK_BUSY" });
  });

  it("finishes a close on the next read when the first completion failed", async () => {
    const { db, close, task, taskId, active, finish, deleteEc2Session, dev } = await finished();
    deleteEc2Session!.mockRejectedValueOnce(Object.assign(new Error("starting"), { name: "AgentXError" }));
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CLOSED" });
  });

  it("releases the counter it charged even when the developer's Slack link changed since (R6)", async () => {
    const { db, close, task, active, finish, member } = await finished();
    (db.get(`DEVELOPER#${MAYA.developerId}`, "META") as Record<string, unknown>).slackUserId = "U0MAYANEW";
    const requestId = randomUUID();
    await close(requestId);
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(member()).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYANEW")).toBeUndefined();
  });

  it("frees the slot for a new task", async () => {
    const { close, task, active, finish, dev } = await finished({ memberLimit: 1 });
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "next" })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-close.test.ts`
Expected: FAIL, the close route answers `NOT_FOUND`.

- [ ] **Step 3: Finish, resume and route the close**

In `developer-tasks.ts`, import `releaseItems` and `WorkspaceClosePreflightResultSchema`, and add:

```ts
/** R15: deletes the compute, then closes the workspace, releases the counters and marks the task, in one transaction. */
export async function finishTaskClose(deps: { tableName: string; actions: DeveloperTaskActions }, task: DeveloperTaskRecord, closeOperationId: string | undefined): Promise<void> {
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status !== "CLOSED") await deps.actions.deleteCompute(workspace);
  const now = new Date().toISOString();
  const items: TransactItems = [
    ...(workspace.status === "CLOSED" ? [] : [{ Update: {
      TableName: deps.tableName,
      Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" },
      UpdateExpression: "SET #status = :closed, closedAt = :now, updatedAt = :now REMOVE activeOperationId, closeError",
      ConditionExpression: closeOperationId === undefined ? "#status = :failed" : "#status = :closing AND closeOperationId = :operation",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":closed": "CLOSED", ":now": now,
        ...(closeOperationId === undefined ? { ":failed": "PREPARATION_FAILED" } : { ":closing": "CLOSING", ":operation": closeOperationId }),
      },
    } }]),
    ...releaseItems(deps.tableName, task.charge, task.taskId),
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET closedAt = :now, updatedAt = :now", ConditionExpression: "attribute_not_exists(closedAt)",
      ExpressionAttributeValues: { ":now": now },
    } },
    { Update: {
      TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #status = :closed, updatedAt = :now", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
    } },
  ];
  try {
    await deps.actions.transact(items);
  } catch (error) {
    // Another call finished the close first; its transaction released the counters once.
    if (!isConditional(error)) throw error;
  }
}

/** A preflight that ended safe but whose completion did not land: finish it now (R15). */
export async function resumeClose(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (task.closedAt !== undefined) return;
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status !== "CLOSING" || workspace.closeOperationId === undefined) return;
  const operation = (await deps.actions.operations(task.workspaceId)).find((entry) => entry.id === workspace.closeOperationId);
  const preflight = WorkspaceClosePreflightResultSchema.safeParse(operation?.result);
  if (operation?.status !== "SUCCEEDED" || !preflight.success || !preflight.data.safeToClose) return;
  try {
    await finishTaskClose(deps, task, operation.id);
  } catch (error) {
    log(deps, { event: "developer.task_close_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

async function closeTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<DeveloperCloseResponse> {
  const request = parse(DeveloperTaskActionRequestSchema, value, deps, "close");
  let task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const record = (response: string, operationId?: string) => aiToolTurn({
    party: partyOfTask(task), turnId: randomUUID(), action: "close", phase: "accepted", outcome: "accepted", receivedAt: iso(deps), finishedAt: iso(deps),
    request: "close", response, ...(operationId === undefined ? {} : { operationId }),
  });
  let unpublished: DeveloperCloseResponse["unpublished"];
  if (task.closedAt === undefined) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "PREPARATION_FAILED") {
      await finishTaskClose(deps, task, undefined);
      await deps.documentClient.send(new PutCommand({ TableName: turns, Item: record("Closed; the task's workspace never started."), ConditionExpression: "attribute_not_exists(pk)" })).catch((error: unknown) => turnRecordFailed(deps, error));
    } else if (workspace.status === "PREPARING") {
      throw agentXError("TASK_BUSY", `task ${taskId} is still starting; cancel it with agentx_cancel_task, then close it once it has stopped`);
    } else if (workspace.status !== "CLOSED") {
      let started: Awaited<ReturnType<DeveloperTaskActions["startClose"]>>;
      try {
        started = await deps.actions.startClose(developerTaskIdentity(task), workspace, request.requestId, (operation) => [
          putNew(turns, record("Checking the workspace for unpublished work before closing.", operation.id)),
        ]);
      } catch (error) {
        busy(error, taskId);
      }
      const operation = (await deps.actions.operations(task.workspaceId)).find((entry) => entry.id === started.operationId);
      const preflight = WorkspaceClosePreflightResultSchema.safeParse(operation?.result);
      if (operation?.status === "SUCCEEDED" && preflight.success && !preflight.data.safeToClose) {
        unpublished = preflight.data.repositories.map((repository) => ({ repository: repository.name, reasons: [...repository.reasons] }));
      }
    }
    await resumeClose(deps, task);
    task = await loadOwnedTask(deps, caller, taskId);
  }
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status);
  return { task: view, closed: view.status === "CLOSED", ...(unpublished === undefined ? {} : { unpublished }) };
}
```

`startClose` (Task 6) checks its idempotency record before the workspace status, so a repeated
request finds its first close operation even after the preflight put the workspace back to
`READY`. In `readTask`, call `await resumeClose(deps, task)` and reload the task before building
the view. In `taskView`, after deriving the status, add the refused close (R22):

```ts
  const lastClose = operations.filter((operation) => operation.kind === "close").sort(byCreated).at(-1);
  const refused = lastClose?.status === "SUCCEEDED" && !derived.closing && task.closedAt === undefined
    ? WorkspaceClosePreflightResultSchema.safeParse(lastClose.result)
    : undefined;
  // ...and in the returned view:
  ...(refused?.success === true && !refused.data.safeToClose
    ? { unpublished: refused.data.repositories.map((repository) => ({ repository: repository.name, reasons: [...repository.reasons] })) }
    : {}),
```

(`byCreated` is Task 10's; move it above `taskView`.) Add the route:

```ts
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "close") return closeTask(deps, caller, taskId, body(request));
```

In `broker.ts`'s `recordTerminalResult`, after the transaction commits: when the operation is a
`close`, the preflight is safe (`closePreflight?.safeToClose === true`) and the pointer exists,
load `DEVTASK#<pointer.taskId>` and call `finishTaskClose({ tableName: dependencies.tableName,
actions: developerTaskActions(dependencies) }, task, operation.id)` inside a `try`; a failure
is logged as `developer.task_close_failed` (error name only) and left to `resumeClose`. The
worker's callback never fails because of it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/developer-task-close.test.ts tests/contract/developer-task-reads.test.ts tests/contract/slack-control-plane.test.ts && npm run typecheck && npm run lint`
Expected: PASS. The Slack close suites are unchanged: `finishTaskClose` runs only for workspaces
with a developer task pointer.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src tests/contract/developer-task-close.test.ts
git commit -m "feat(broker): close a developer task and release its workspace (spec 025 FR-016, FR-020)"
```

---

### Task 13: Infrastructure: the broker writes AI-tool turn records

R27. One policy statement, named environments only.

**Files:**
- Modify: `infra/lib/developer-signin.ts`
- Modify: `infra/lib/control-plane.ts` (pass the TurnRecords table to the construct)
- Test: `tests/contract/developer-signin-infrastructure.test.ts` (append)

**Interfaces:**
- Consumes: the TurnRecords table in `control-plane.ts`.
- Produces: `DeveloperSignInProps.turnRecords: dynamodb.ITable`; the broker's role may
  `dynamodb:PutItem` on TurnRecords only for `TASK#*` leading keys.

- [ ] **Step 1: Write the failing test**

Append to `tests/contract/developer-signin-infrastructure.test.ts` (its `beforeAll` already builds
`named` and `legacy`):

```ts
describe("AI-tool turn records (spec 025 FR-037, R27)", () => {
  const brokerRole = (template: TemplateJson) => {
    const brokerFunction = template.Resources[functionId(template, "Broker")]!;
    return ((brokerFunction.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
  };
  const turnTable = (template: TemplateJson) => ofType(template, "AWS::DynamoDB::Table").map(([id]) => id).find((id) => withoutHash(id) === "TurnRecords")!;

  it("lets the broker put items in TurnRecords only under TASK#", () => {
    const puts = grants(named).filter(({ role, statement }) => role === brokerRole(named) && allows(statement, "dynamodb:PutItem") && JSON.stringify(statement.Resource).includes(turnTable(named)));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.statement.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } });
    expect(actionsOf(puts[0]!.statement)).toEqual(["dynamodb:PutItem"]);
  });

  it("gives the broker no other write on TurnRecords, and no update or delete anywhere on it", () => {
    for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
      expect(grants(named).some(({ role, statement }) => role === brokerRole(named) && allows(statement, action) && JSON.stringify(statement.Resource ?? "").includes(turnTable(named)))).toBe(false);
    }
  });

  it("adds nothing to the legacy templates", () => {
    expect(grants(legacy).some(({ statement }) => (statement.Condition as Record<string, Record<string, unknown>> | undefined)?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] !== undefined
      && JSON.stringify(statement.Condition).includes("TASK#"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-signin-infrastructure.test.ts`
Expected: FAIL, no `PutItem` statement for TurnRecords.

- [ ] **Step 3: Add the grant**

In `developer-signin.ts`, add `turnRecords: dynamodb.ITable;` to `DeveloperSignInProps`, and after
the broker's sign-in table grant:

```ts
    // FR-037, R27: the developer task routes write immutable AI-tool turn records, only under TASK#.
    // No update or delete: a record is written once with a condition and never changed.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [props.turnRecords.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } },
    }));
```

In `control-plane.ts`, pass `turnRecords` in the `new DeveloperSignIn(...)` props.

- [ ] **Step 4: Run the infrastructure suites and synth**

Run: `npx vitest run tests/contract/developer-signin-infrastructure.test.ts tests/contract/legacy-templates.test.ts tests/contract/turn-records-infrastructure.test.ts tests/contract/infrastructure.test.ts tests/contract/named-retention.test.ts && npm run infra:synth`
Expected: PASS; the legacy templates are byte-identical.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/developer-signin.ts infra/lib/control-plane.ts tests/contract/developer-signin-infrastructure.test.ts
git commit -m "feat(infra): the broker writes AI-tool turn records under TASK# (spec 025 FR-037)"
```

---
### Task 14: The `@agentx/mcp` package: errors and the control-plane client

FR-027's package, FR-049's codes and next steps, R20, and the "3 tries" of
`CONTROL_PLANE_UNAVAILABLE`.

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`
- Create: `packages/mcp/src/errors.ts`, `packages/mcp/src/client.ts`, `packages/mcp/src/index.ts`
- Modify: `tsconfig.json` (reference `packages/mcp`, before `packages/cli`)
- Modify: `environments/base/Dockerfile`, `environments/slack/Dockerfile` (copy its manifest before `npm ci`)
- Modify: `scripts/release-production.ts` (`WORKER_IMAGE_INPUTS` and `SLACK_ORCHESTRATOR_IMAGE_INPUTS` gain `"packages/mcp/package.json"`)
- Modify: `package-lock.json` (by `npm install`)
- Test: `tests/contract/mcp-client.test.ts`

**Interfaces:**
- Consumes: Task 2's schemas; `AgentXError`.
- Produces:
  - `TOOL_ERROR_CODES` (FR-049's list plus `INVALID_REQUEST`), `type ToolErrorCode`,
    `class ToolError extends Error { code: ToolErrorCode; nextStep: string }`,
    `NEXT_STEPS: Record<ToolErrorCode, string>`;
  - `interface ControlPlaneSession { baseUrl: string; accessToken: string; signInCommand: string }`;
  - `interface ControlPlaneClient`:

```ts
export interface ControlPlaneClient {
  /** The environment's agentx-configuration, read without a token. */
  configuration(): Promise<{ env: string; apiVersion: string; baseUrl: string }>;
  projects(): Promise<DeveloperProjectsResponse>;
  startTask(request: StartDeveloperTaskRequest): Promise<DeveloperTaskView>;
  getTask(taskId: string, events: number): Promise<DeveloperTaskView>;
  listTasks(query: { project?: string; status?: DeveloperTaskStatus; limit: number }): Promise<DeveloperTaskListItem[]>;
  continueTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskView>;
  cancelTask(taskId: string, requestId: string): Promise<DeveloperTaskView>;
  closeTask(taskId: string, requestId: string): Promise<DeveloperCloseResponse>;
  openPullRequest(taskId: string, request: DeveloperPullRequestRequest): Promise<DeveloperPullRequestResponse>;
}
```

  - `httpControlPlaneClient(options: { session(): Promise<ControlPlaneSession>; fetch: typeof fetch; traceId?(): string; sleep?(ms: number): Promise<void>; tries?: number }): ControlPlaneClient`.

- [ ] **Step 1: Scaffold the package**

```json
{
  "name": "@agentx/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@agentx/contracts": "0.1.0",
    "@modelcontextprotocol/sdk": "1.30.1",
    "zod": "4.6.5"
  }
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../contracts" }]
}
```

Add `{ "path": "packages/mcp" },` to the root `tsconfig.json` before `packages/cli`. In both
Dockerfiles add `COPY packages/mcp/package.json packages/mcp/package.json` after the
`packages/gateway` line. Add `"packages/mcp/package.json",` to both image input lists in
`scripts/release-production.ts`. Run `npm install` to add the workspace to `package-lock.json`
(the SDK is already in the lock file at 1.30.1), then
`npx vitest run tests/contract/workspace-packages.test.ts`: PASS.

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/mcp-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { NEXT_STEPS, TOOL_ERROR_CODES, ToolError, httpControlPlaneClient } from "../../packages/mcp/src/index.js";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.planted-access-token.sig";
const session = async () => ({ baseUrl: "https://agentx.example.test", accessToken: TOKEN, signInCommand: "npx @charterarc/agentx login https://agentx.example.test" });
const view = { taskId: "44444444-4444-4444-8444-444444444444", title: "Fix", project: "payments", status: "STARTING", startingRevision: 1, client: "Claude Code", shared: false, createdAt: "t", updatedAt: "t", events: [] };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetch: typeof globalThis.fetch, overrides: Partial<Parameters<typeof httpControlPlaneClient>[0]> = {}) =>
  httpControlPlaneClient({ session, fetch, sleep: async () => undefined, traceId: () => "trace-1", ...overrides });
const start = { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "Fix it", client: "claude-code" };

describe("the control-plane client (FR-027)", () => {
  it("sends the token and a trace ID, and parses a response with fields it does not know", async () => {
    const fetch = vi.fn(async () => reply(200, { task: { ...view, later: true }, requestId: "r" }));
    expect((await client(fetch).startTask(start)).status).toBe("STARTING");
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://agentx.example.test/v1/dev/tasks");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(init.headers).get("x-agentx-trace-id")).toBe("trace-1");
    expect(JSON.parse(String(init.body))).toEqual(start);
  });

  it("reads the configuration without a token", async () => {
    const fetch = vi.fn(async () => reply(200, { env: "staging", apiVersion: "1.1", issuer: "x" }));
    expect(await client(fetch).configuration()).toEqual({ env: "staging", apiVersion: "1.1", baseUrl: "https://agentx.example.test" });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://agentx.example.test/v1/auth/.well-known/agentx-configuration");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("tries three times on a network error or 5xx, then answers CONTROL_PLANE_UNAVAILABLE", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(client(down).getTask(view.taskId, 10)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(down).toHaveBeenCalledTimes(3);
    const flaky = vi.fn().mockResolvedValueOnce(reply(502, {})).mockResolvedValueOnce(reply(200, { task: view }));
    expect((await client(flaky).getTask(view.taskId, 10)).taskId).toBe(view.taskId);
  });

  it.each([
    ["PROJECT_NOT_FOUND", 404, "PROJECT_NOT_FOUND"],
    ["PROJECT_ACCESS_DENIED", 403, "PROJECT_ACCESS_DENIED"],
    ["PROJECT_TASKS_DISABLED", 403, "PROJECT_TASKS_DISABLED"],
    ["TASK_NOT_FOUND", 404, "TASK_NOT_FOUND"],
    ["TASK_BUSY", 409, "TASK_BUSY"],
    ["WORKSPACE_BUSY", 409, "TASK_BUSY"],
    ["CHANNEL_REQUIRED", 409, "CHANNEL_REQUIRED"],
    ["WORKSPACE_LIMIT", 409, "WORKSPACE_LIMIT"],
    ["SLACK_UNAVAILABLE", 503, "SLACK_UNAVAILABLE"],
    ["CONFIG_INVALID", 400, "INVALID_REQUEST"],
    ["IDEMPOTENCY_CONFLICT", 409, "INVALID_REQUEST"],
    ["AUTH_REQUIRED", 401, "SIGN_IN_REQUIRED"],
    ["FORBIDDEN", 403, "CONTROL_PLANE_UNAVAILABLE"],
  ] as const)("maps %s to %s with a next step", async (brokerCode, status, toolCode) => {
    const error = await client(async () => reply(status, { error: { code: brokerCode, message: "the broker's words" } })).getTask(view.taskId, 10).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: toolCode });
    expect((error as ToolError).message).toContain("the broker's words");
    expect((error as ToolError).nextStep.length).toBeGreaterThan(0);
  });

  it("gives SIGN_IN_REQUIRED the exact sign-in command, from a 401 or from the local session", async () => {
    const refused = await client(async () => reply(401, { error: { code: "AUTH_REQUIRED", message: "your AgentX sign-in has ended" } })).projects().catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: "SIGN_IN_REQUIRED", nextStep: "run npx @charterarc/agentx login https://agentx.example.test" });
    const local = await client(vi.fn(), {
      session: async () => { throw agentXError("AUTH_REQUIRED", "this computer is not signed in to AgentX environment staging; run npx @charterarc/agentx login https://agentx.example.test"); },
    }).projects().catch((caught: unknown) => caught);
    expect(local).toMatchObject({ code: "SIGN_IN_REQUIRED", nextStep: "run npx @charterarc/agentx login https://agentx.example.test" });
  });

  it("never repeats the access token in an error", async () => {
    const error = await client(async () => reply(500, { error: { code: "RUNTIME_UNAVAILABLE", message: `echo ${TOKEN}` } })).projects().catch((caught: unknown) => caught);
    expect(JSON.stringify({ message: (error as Error).message, nextStep: (error as ToolError).nextStep })).not.toContain("planted-access-token");
  });

  it("answers CONTROL_PLANE_UNAVAILABLE for a reply it cannot read", async () => {
    await expect(client(async () => reply(200, { task: { status: "SOMETHING" } })).getTask(view.taskId, 10)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
  });

  it("has a next step for every code", () => {
    for (const code of TOOL_ERROR_CODES) expect(NEXT_STEPS[code].length, code).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-client.test.ts`
Expected: FAIL, the package has no source.

- [ ] **Step 4: Write the errors**

```ts
// packages/mcp/src/errors.ts
// Spec 025 FR-049: every tool error has a stable code, a plain message and a next step.
export const TOOL_ERROR_CODES = [
  "SIGN_IN_REQUIRED", "SIGN_IN_REJECTED", "ADMIN_REQUIRED", "PROJECT_NOT_FOUND", "PROJECT_ACCESS_DENIED",
  "PROJECT_TASKS_DISABLED", "TASK_NOT_FOUND", "CHANNEL_REQUIRED", "CHANNEL_AMBIGUOUS", "WORKSPACE_LIMIT", "TASK_BUSY",
  "SLACK_UNAVAILABLE", "CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE",
  "UPGRADE_REQUIRED", "CONTROL_PLANE_UNAVAILABLE", "INVALID_REQUEST",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const NEXT_STEPS: Record<ToolErrorCode, string> = {
  SIGN_IN_REQUIRED: "run npx @charterarc/agentx login <your AgentX URL>",
  SIGN_IN_REJECTED: "contact an AgentX admin; the message says why the sign-in was refused",
  ADMIN_REQUIRED: "run npx @charterarc/agentx login --admin",
  PROJECT_NOT_FOUND: "run agentx_list_projects to see the projects you can use",
  PROJECT_ACCESS_DENIED: "join one of the project's Slack channels, or ask an admin for access",
  PROJECT_TASKS_DISABLED: "use the project's Slack channel, or ask an admin",
  TASK_NOT_FOUND: "run agentx_list_tasks to see your tasks",
  CHANNEL_REQUIRED: "start the task without share_to_channel, or use the project's Slack channel",
  CHANNEL_AMBIGUOUS: "name one of the project's channels",
  WORKSPACE_LIMIT: "close a task you no longer need with agentx_close_task",
  TASK_BUSY: "wait with agentx_wait_for_task, or stop the task with agentx_cancel_task",
  SLACK_UNAVAILABLE: "try again in a few minutes; projects an admin granted you still work",
  CONFIRMATION_UNAVAILABLE: "use a client that supports elicitation, link a Slack user, or use the agentx CLI",
  CONFIRMATION_DECLINED: "ask for the change again",
  CONFIRMATION_EXPIRED: "ask for the change again",
  CHANGE_STALE: "ask for the change again",
  UPGRADE_REQUIRED: "run npx -y @charterarc/agentx@latest mcp install --client <claude-code, codex or cursor>",
  CONTROL_PLANE_UNAVAILABLE: "check your connection and try again",
  INVALID_REQUEST: "fix the input the message names and try again",
};

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string, readonly nextStep: string = NEXT_STEPS[code]) {
    super(message);
    this.name = "ToolError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Server text made safe to show: no control characters, at most 1,000 characters. */
export function plainText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(CONTROL, " ").trim().slice(0, 1_000);
  return clean === "" ? fallback : clean;
}

const PASSED_THROUGH = new Set<string>(["PROJECT_NOT_FOUND", "PROJECT_ACCESS_DENIED", "PROJECT_TASKS_DISABLED", "TASK_NOT_FOUND", "TASK_BUSY", "CHANNEL_REQUIRED", "WORKSPACE_LIMIT", "SLACK_UNAVAILABLE"]);
const SIGN_IN = /\brun (npx @charterarc\/agentx login \S+)/;

/** The exact sign-in command from a message, else the session's own. */
export function signInStep(message: string, fallback: string): string {
  return `run ${SIGN_IN.exec(message)?.[1] ?? fallback}`;
}

/** A control-plane error answer as the tool error of FR-049. */
export function toolErrorFromResponse(status: number, value: unknown, signInCommand: string): ToolError {
  const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = plainText(error?.message, `AgentX answered HTTP ${status}`);
  if (status === 401 || code === "AUTH_REQUIRED") return new ToolError("SIGN_IN_REQUIRED", message, `run ${signInCommand}`);
  if (code !== undefined && PASSED_THROUGH.has(code)) return new ToolError(code as ToolErrorCode, message);
  if (code === "WORKSPACE_BUSY") return new ToolError("TASK_BUSY", message);
  if (code === "CONFIG_INVALID" || code === "IDEMPOTENCY_CONFLICT") return new ToolError("INVALID_REQUEST", message);
  return new ToolError("CONTROL_PLANE_UNAVAILABLE", message);
}
```

- [ ] **Step 5: Write the client**

```ts
// packages/mcp/src/client.ts
// Spec 025 FR-027: the tools' view of the control plane. The stdio server gives it the signed-in
// developer's session (packages/cli); the hosted endpoint will give it another.
import { randomUUID } from "node:crypto";
import {
  AgentXError,
  DeveloperCloseResponseSchema,
  DeveloperProjectsResponseSchema,
  DeveloperPullRequestResponseSchema,
  DeveloperTaskListResponseSchema,
  DeveloperTaskResponseSchema,
  type ContinueDeveloperTaskRequest,
  type DeveloperCloseResponse,
  type DeveloperProjectsResponse,
  type DeveloperPullRequestRequest,
  type DeveloperPullRequestResponse,
  type DeveloperTaskListItem,
  type DeveloperTaskStatus,
  type DeveloperTaskView,
  type StartDeveloperTaskRequest,
} from "@agentx/contracts";
import { z } from "zod";
import { NEXT_STEPS, ToolError, plainText, signInStep, toolErrorFromResponse } from "./errors.js";

export interface ControlPlaneSession { baseUrl: string; accessToken: string; signInCommand: string }

export interface ControlPlaneClient {
  configuration(): Promise<{ env: string; apiVersion: string; baseUrl: string }>;
  projects(): Promise<DeveloperProjectsResponse>;
  startTask(request: StartDeveloperTaskRequest): Promise<DeveloperTaskView>;
  getTask(taskId: string, events: number): Promise<DeveloperTaskView>;
  listTasks(query: { project?: string; status?: DeveloperTaskStatus; limit: number }): Promise<DeveloperTaskListItem[]>;
  continueTask(taskId: string, request: ContinueDeveloperTaskRequest): Promise<DeveloperTaskView>;
  cancelTask(taskId: string, requestId: string): Promise<DeveloperTaskView>;
  closeTask(taskId: string, requestId: string): Promise<DeveloperCloseResponse>;
  openPullRequest(taskId: string, request: DeveloperPullRequestRequest): Promise<DeveloperPullRequestResponse>;
}

const ConfigurationSchema = z.object({ env: z.string(), apiVersion: z.string() });
const UNREADABLE = "AgentX answered with something this version of the CLI cannot read; upgrade it";

export function httpControlPlaneClient(options: {
  session(): Promise<ControlPlaneSession>;
  fetch: typeof fetch;
  traceId?(): string;
  sleep?(ms: number): Promise<void>;
  tries?: number;
}): ControlPlaneClient {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tries = options.tries ?? 3;

  async function session(): Promise<ControlPlaneSession> {
    try {
      return await options.session();
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof AgentXError && error.code === "AUTH_REQUIRED") {
        const message = plainText(error.message.replace(/^AUTH_REQUIRED: /, ""), "this computer is not signed in to AgentX");
        throw new ToolError("SIGN_IN_REQUIRED", message, signInStep(message, "npx @charterarc/agentx login <your AgentX URL>"));
      }
      const message = error instanceof AgentXError ? plainText(error.message.replace(/^[A-Z_]+: /, ""), "AgentX could not be reached") : "AgentX could not be reached";
      throw new ToolError("CONTROL_PLANE_UNAVAILABLE", message);
    }
  }

  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, authorized = true): Promise<T> {
    const current = await session();
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { "x-agentx-trace-id": options.traceId?.() ?? randomUUID() };
      if (authorized) headers.authorization = `Bearer ${current.accessToken}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await options.fetch(`${current.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
      } catch {
        if (attempt < tries) {
          await sleep(500 * attempt);
          continue;
        }
        throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `could not reach AgentX at ${current.baseUrl} after ${tries} tries`);
      }
      if (response.status >= 500 && attempt < tries) {
        await sleep(500 * attempt);
        continue;
      }
      const value: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = toolErrorFromResponse(response.status, value, current.signInCommand);
        // The access token never appears in what a tool returns, whatever the server echoed.
        throw new ToolError(error.code, error.message.split(current.accessToken).join("[REDACTED]"), error.nextStep);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ToolError("CONTROL_PLANE_UNAVAILABLE", UNREADABLE, NEXT_STEPS.UPGRADE_REQUIRED);
      return parsed.data;
    }
  }

  const task = (response: { task: DeveloperTaskView }) => response.task;
  const path = (taskId: string, rest = "") => `/v1/dev/tasks/${encodeURIComponent(taskId)}${rest}`;
  return {
    configuration: async () => {
      const current = await session();
      const value = await call(ConfigurationSchema, "GET", "/v1/auth/.well-known/agentx-configuration", undefined, false);
      return { env: value.env, apiVersion: value.apiVersion, baseUrl: current.baseUrl };
    },
    projects: () => call(DeveloperProjectsResponseSchema, "GET", "/v1/dev/projects"),
    startTask: async (request) => task(await call(DeveloperTaskResponseSchema, "POST", "/v1/dev/tasks", request)),
    getTask: async (taskId, events) => task(await call(DeveloperTaskResponseSchema, "GET", path(taskId, `?events=${events}`))),
    listTasks: async (query) => {
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.project !== undefined) search.set("project", query.project);
      if (query.status !== undefined) search.set("status", query.status);
      return (await call(DeveloperTaskListResponseSchema, "GET", `/v1/dev/tasks?${search.toString()}`)).tasks;
    },
    continueTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/continue"), request)),
    cancelTask: async (taskId, requestId) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/cancel"), { requestId })),
    closeTask: (taskId, requestId) => call(DeveloperCloseResponseSchema, "POST", path(taskId, "/close"), { requestId }),
    openPullRequest: (taskId, request) => call(DeveloperPullRequestResponseSchema, "POST", path(taskId, "/pull-requests"), request),
  };
}
```

```ts
// packages/mcp/src/index.ts
export * from "./client.js";
export * from "./errors.js";
```

- [ ] **Step 6: Run the tests and the gate's build**

Run: `npx vitest run tests/contract/mcp-client.test.ts tests/contract/workspace-packages.test.ts tests/contract/developer-task-reads.test.ts && npm run build && npm run typecheck && npm run lint`
Expected: PASS; `developer-task-reads.test.ts` now also checks `packages/mcp/src` for the
deployment mode.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp tsconfig.json environments/base/Dockerfile environments/slack/Dockerfile scripts/release-production.ts package-lock.json tests/contract/mcp-client.test.ts
git commit -m "feat(mcp): the @agentx/mcp package, its errors and control-plane client (spec 025 FR-027, FR-049)"
```

---
### Task 15: The developer tools, waits and the MCP server

FR-026 to FR-030 (developer tools), FR-048's MCP side, FR-049, US2, SC-004 and SC-010, and R19,
R21, R22 (the PR and close tools return at once), R23, R28.

**Files:**
- Create: `packages/mcp/src/compatibility.ts`, `packages/mcp/src/wait.ts`,
  `packages/mcp/src/tools.ts`, `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/index.ts`
- Test: `tests/contract/mcp-tools.test.ts`, `tests/contract/mcp-wait.test.ts`

**Interfaces:**
- Consumes: Task 14's `ControlPlaneClient`, `ToolError`; Task 2's constants and schemas.
- Produces:
  - `REQUIRED_SERVER_MINOR = 1`; `compatibilityChecker(client: ControlPlaneClient, options?: { now?(): number; cacheMs?: number }): () => Promise<{ env: string; apiVersion: string; notice?: string }>`
    (throws `ToolError("UPGRADE_REQUIRED")`, caches 10 minutes);
  - `waitForTask(options: { client; taskId: string; waitSeconds: number; events: number; signal: AbortSignal; progress?(elapsedSeconds: number, totalSeconds: number, message: string): Promise<void>; now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }): Promise<{ task: DeveloperTaskView; timedOut: boolean }>`;
  - `interface ToolContext { client: ControlPlaneClient; clientName: string | undefined; serverVersion: string; adminSignedIn(): Promise<boolean>; compatibility(): Promise<{ env: string; apiVersion: string; notice?: string }>; now(): number; sleep(ms: number, signal: AbortSignal): Promise<void>; newRequestId(): string }`;
  - `interface ToolCall { signal: AbortSignal; progress?(progress: number, total: number | undefined, message: string): Promise<void> }`;
  - `interface ToolDefinition` and `DEVELOPER_TOOLS: readonly ToolDefinition[]` (the ten tools, in the Global Constraints' order);
  - `createAgentXMcpServer(options: { version: string; context(clientName: string | undefined): ToolContext; log?(entry: Record<string, unknown>): void }): McpServer`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/mcp-wait.test.ts
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import { waitForTask, type ControlPlaneClient } from "../../packages/mcp/src/index.js";

const view = (status: DeveloperTaskView["status"]): DeveloperTaskView => ({
  taskId: "44444444-4444-4444-8444-444444444444", title: "Fix", project: "payments", status, startingRevision: 1, client: "Claude Code", shared: false,
  createdAt: "t", updatedAt: "t", events: [{ at: "t", kind: "progress", text: "npm test" }],
});

function clock() {
  let now = 0;
  return {
    now: () => now,
    // Each sleep moves the fake clock and yields a real tick, so an abort can arrive in between.
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      now += ms;
      const timer = setTimeout(resolve, 2);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
  };
}

describe("waits (US2, R21)", () => {
  it("returns the finished task when it ends before the wait does, with progress after each poll", async () => {
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("SUCCEEDED"));
    const progress = vi.fn(async () => undefined);
    const result = await waitForTask({ client: { getTask } as unknown as ControlPlaneClient, taskId: view("RUNNING").taskId, waitSeconds: 60, events: 10, signal: new AbortController().signal, progress, ...clock() });
    expect(result).toMatchObject({ timedOut: false, task: { status: "SUCCEEDED" } });
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(progress.mock.calls.every(([, total]) => total === 60)).toBe(true);
  });

  it("is not an error when the wait ends first: timed_out, and the task keeps running", async () => {
    const getTask = vi.fn(async () => view("RUNNING"));
    const result = await waitForTask({ client: { getTask } as unknown as ControlPlaneClient, taskId: view("RUNNING").taskId, waitSeconds: 60, events: 10, signal: new AbortController().signal, ...clock() });
    expect(result).toMatchObject({ timedOut: true, task: { status: "RUNNING" } });
  });

  it("never lets the gap between progress notifications reach 15 seconds", async () => {
    const times: number[] = [];
    const fake = clock();
    const getTask = vi.fn(async () => view("RUNNING"));
    await waitForTask({ client: { getTask } as unknown as ControlPlaneClient, taskId: view("RUNNING").taskId, waitSeconds: 120, events: 10, signal: new AbortController().signal, progress: async () => { times.push(fake.now()); }, ...fake });
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(Math.max(...gaps)).toBeLessThan(15_000);
  });

  it("stops polling when the call is cancelled (Review Focus 2)", async () => {
    const controller = new AbortController();
    const getTask = vi.fn(async () => view("RUNNING"));
    const waiting = waitForTask({ client: { getTask } as unknown as ControlPlaneClient, taskId: view("RUNNING").taskId, waitSeconds: 600, events: 10, signal: controller.signal, ...clock() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await waiting;
    const calls = getTask.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getTask.mock.calls.length).toBe(calls);
  });
});
```

```ts
// tests/contract/mcp-tools.test.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import { DEVELOPER_TOOLS, ToolError, createAgentXMcpServer, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";

const TASK = "44444444-4444-4444-8444-444444444444";
const PLANTED = "xoxb-3333333333-planted-secret";
const view = (status: DeveloperTaskView["status"], extra: Partial<DeveloperTaskView> = {}): DeveloperTaskView => ({
  taskId: TASK, title: "Fix the flaky retry test", project: "payments", status, startingRevision: 7, client: "Claude Code", shared: false,
  createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z", events: [], ...extra,
});

async function connect(client: Partial<ControlPlaneClient>, overrides: Partial<ToolContext> = {}, clientName = "claude-code") {
  let now = 0;
  const context = (name: string | undefined): ToolContext => ({
    client: client as ControlPlaneClient, clientName: name, serverVersion: "0.4.0",
    adminSignedIn: async () => false,
    compatibility: async () => ({ env: "staging", apiVersion: "1.1" }),
    now: () => now, sleep: async (ms) => { now += ms; await new Promise((resolve) => setTimeout(resolve, 1)); },
    newRequestId: () => "33333333-3333-4333-8333-333333333333",
    ...overrides,
  });
  const server = createAgentXMcpServer({ version: "0.4.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: clientName, version: "1.0.0" });
  await mcp.connect(clientSide);
  return mcp;
}

describe("the tool list (FR-027, FR-028, SC-010)", () => {
  it("lists exactly the module's developer tools, each with an output schema", async () => {
    const { tools } = await (await connect({})).listTools();
    expect(tools.map((tool) => tool.name)).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    expect(tools.map((tool) => tool.name)).toEqual([
      "agentx_whoami", "agentx_list_projects", "agentx_start_task", "agentx_get_task", "agentx_wait_for_task",
      "agentx_list_tasks", "agentx_continue_task", "agentx_cancel_task", "agentx_close_task", "agentx_open_pull_request",
    ]);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
    expect(JSON.stringify(tools)).not.toContain("\u2014");
  });
});

describe("agentx_start_task (US1, US2)", () => {
  it("hands off and answers at once, passing the client's name and a request ID", async () => {
    const startTask = vi.fn(async () => view("STARTING"));
    const mcp = await connect({ startTask });
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix the flaky retry test" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ task_id: TASK, status: "STARTING", project: "payments", starting_revision: 7, shared: false });
    expect(startTask).toHaveBeenCalledWith({ requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(TASK);
  });

  it("waits when asked, sending progress, and returns the finished task", async () => {
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("SUCCEEDED", { summary: "All tests pass." }));
    const mcp = await connect({ startTask: async () => view("STARTING"), getTask });
    const progress: unknown[] = [];
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "run the tests", wait_seconds: 60 } }, undefined, { onprogress: (update) => progress.push(update) });
    expect(result.structuredContent).toMatchObject({ status: "SUCCEEDED", summary: "All tests pass.", timed_out: false });
    expect(progress.length).toBeGreaterThan(0);
  });

  it("refuses instructions over 65,536 bytes as INVALID_REQUEST without calling AgentX", async () => {
    const startTask = vi.fn();
    const result = await (await connect({ startTask })).callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "\u20ac".repeat(21_846) } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "INVALID_REQUEST" });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("returns a control-plane refusal as a tool error with code, message and next step (FR-049)", async () => {
    const mcp = await connect({ startTask: async () => { throw new ToolError("PROJECT_ACCESS_DENIED", "you don't have access to `payments`: ask an admin"); } });
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: ask an admin", next_step: "join one of the project's Slack channels, or ask an admin for access" });
  });
});

describe("every tool result is redacted (FR-029, SC-004)", () => {
  it("removes a planted secret from the task's summary, events and failure", async () => {
    const leaky = view("FAILED", { summary: `used ${PLANTED}`, events: [{ at: "t", kind: "error", text: PLANTED }], failure: { category: "task_failed", message: PLANTED } });
    const result = await (await connect({ getTask: async () => leaky })).callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
  });

  it("removes a planted secret from an error message", async () => {
    const mcp = await connect({ getTask: async () => { throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `bad ${PLANTED}`); } });
    expect(JSON.stringify(await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } }))).not.toContain(PLANTED);
  });
});

describe("versions (FR-048, R23)", () => {
  it("answers UPGRADE_REQUIRED from every tool when the control plane is not compatible", async () => {
    const mcp = await connect({ projects: vi.fn() }, { compatibility: async () => { throw new ToolError("UPGRADE_REQUIRED", "AgentX answers API 2.0"); } });
    for (const name of ["agentx_whoami", "agentx_list_projects"]) {
      expect((await mcp.callTool({ name, arguments: {} })).structuredContent).toMatchObject({ code: "UPGRADE_REQUIRED" });
    }
  });

  it("shows the upgrade notice in agentx_whoami, with who the developer is", async () => {
    const projects = async () => ({ developer: { id: "d".repeat(64), name: "Maya Chen", provider: "slack" as const, slackUserId: "U0MAYA001" }, projects: [], notices: [] });
    const mcp = await connect({ projects }, { compatibility: async () => ({ env: "staging", apiVersion: "1.2", notice: "a newer AgentX CLI is available" }), adminSignedIn: async () => true });
    expect((await mcp.callTool({ name: "agentx_whoami", arguments: {} })).structuredContent).toEqual({
      environment: "staging", developer_name: "Maya Chen", sign_in_method: "slack", slack_user: "U0MAYA001", admin: true,
      server_version: "0.4.0", control_plane_api_version: "1.2", upgrade_notice: "a newer AgentX CLI is available",
    });
  });
});

describe("agentx_open_pull_request and agentx_close_task return at once (R22, Owner decision 6)", () => {
  it("opens a draft and answers with the started operation, calling AgentX once", async () => {
    const openPullRequest = vi.fn(async () => ({ task: view("RUNNING"), operationId: "55555555-5555-4555-8555-555555555555", operationStatus: "ACCEPTED" as const }));
    const result = await (await connect({ openPullRequest })).callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "Fix the retry test" } });
    expect(result.structuredContent).toMatchObject({ operation_id: "55555555-5555-4555-8555-555555555555", operation_status: "ACCEPTED", task: { task_id: TASK, status: "RUNNING" } });
    expect(result.structuredContent).not.toHaveProperty("timed_out");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(openPullRequest.mock.calls[0]?.[1]).toMatchObject({ requestId: "33333333-3333-4333-8333-333333333333", draft: true });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("agentx_get_task");
  });

  it("returns the PR's URL when a retried call finds it already published", async () => {
    const pullRequest = { repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", state: "open" as const };
    const openPullRequest = vi.fn(async () => ({ task: view("SUCCEEDED"), operationId: "55555555-5555-4555-8555-555555555555", operationStatus: "SUCCEEDED" as const, pullRequest }));
    const result = await (await connect({ openPullRequest })).callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "x", request_id: "66666666-6666-4666-8666-666666666666" } });
    expect(result.structuredContent).toMatchObject({ operation_status: "SUCCEEDED", pull_request: pullRequest });
  });

  it("starts the close and answers at once with closing, calling AgentX once", async () => {
    const closeTask = vi.fn(async () => ({ task: view("SUCCEEDED", { closing: true }), closed: false }));
    const result = await (await connect({ closeTask })).callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ task_id: TASK, closing: true, closed: false });
    expect(result.structuredContent).not.toHaveProperty("timed_out");
    expect(closeTask).toHaveBeenCalledTimes(1);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("agentx_get_task");
  });

  it("says why when a retried close finds unpublished work", async () => {
    const closeTask = vi.fn(async () => ({ task: view("SUCCEEDED"), closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] }));
    const result = await (await connect({ closeTask })).callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] });
  });

  it("shows a refused close in agentx_get_task", async () => {
    const getTask = async () => view("SUCCEEDED", { unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
    const result = await (await connect({ getTask })).callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
  });
});```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/mcp-wait.test.ts tests/contract/mcp-tools.test.ts`
Expected: FAIL, `waitForTask` and `createAgentXMcpServer` are not exported.

- [ ] **Step 3: Compatibility and waits**

```ts
// packages/mcp/src/compatibility.ts
// Spec 025 FR-048 and R23: the control plane's API version decides whether the tools work.
import { DEVELOPER_API_VERSION, apiVersionCompatible } from "@agentx/contracts";
import type { ControlPlaneClient } from "./client.js";
import { ToolError } from "./errors.js";

/** Developer tasks arrived in API 1.1; a 1.0 control plane has only GET /v1/dev/projects. */
export const REQUIRED_SERVER_MINOR = 1;

export function compatibilityChecker(client: ControlPlaneClient, options: { now?(): number; cacheMs?: number } = {}): () => Promise<{ env: string; apiVersion: string; notice?: string }> {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 600_000;
  let cached: { at: number; value: { env: string; apiVersion: string; notice?: string } } | undefined;
  return async () => {
    if (cached !== undefined && now() - cached.at < cacheMs) return cached.value;
    const configuration = await client.configuration();
    const { compatible, upgradeNotice } = apiVersionCompatible(configuration.apiVersion, DEVELOPER_API_VERSION);
    const minor = Number(/^\d+\.(\d+)$/.exec(configuration.apiVersion)?.[1] ?? "0");
    if (!compatible) throw new ToolError("UPGRADE_REQUIRED", `this CLI speaks AgentX API ${DEVELOPER_API_VERSION}, but AgentX at ${configuration.baseUrl} answers ${configuration.apiVersion}`);
    if (minor < REQUIRED_SERVER_MINOR) {
      throw new ToolError("UPGRADE_REQUIRED", `AgentX at ${configuration.baseUrl} is older than this CLI (API ${configuration.apiVersion}) and has no developer tasks yet`, "ask your AgentX admin to upgrade AgentX, or use an older CLI");
    }
    const value = {
      env: configuration.env,
      apiVersion: configuration.apiVersion,
      ...(upgradeNotice ? { notice: `a newer AgentX CLI is available for API ${configuration.apiVersion}; run npx -y @charterarc/agentx@latest mcp install --client <claude-code, codex or cursor>` } : {}),
    };
    cached = { at: now(), value };
    return value;
  };
}
```

```ts
// packages/mcp/src/wait.ts
// Spec 025 US2, D10, R21: waiting on a task. Ending first is not an error; a cancelled call stops at once.
import { ENDED_TASK_STATUSES, type DeveloperTaskView } from "@agentx/contracts";
import type { ControlPlaneClient } from "./client.js";

export async function waitForTask(options: {
  client: Pick<ControlPlaneClient, "getTask">;
  taskId: string;
  waitSeconds: number;
  events: number;
  signal: AbortSignal;
  progress?(elapsedSeconds: number, totalSeconds: number, message: string): Promise<void>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}): Promise<{ task: DeveloperTaskView; timedOut: boolean }> {
  const started = options.now();
  const deadline = started + options.waitSeconds * 1_000;
  let interval = 2_000;
  let task = await options.client.getTask(options.taskId, options.events);
  for (;;) {
    if (ENDED_TASK_STATUSES.has(task.status)) return { task, timedOut: false };
    const left = deadline - options.now();
    if (left <= 0 || options.signal.aborted) return { task, timedOut: true };
    await options.progress?.(Math.round((options.now() - started) / 1_000), options.waitSeconds, `${task.status}: ${task.events.at(-1)?.text ?? "working"}`);
    await options.sleep(Math.min(interval, left), options.signal);
    if (options.signal.aborted) return { task, timedOut: true };
    task = await options.client.getTask(options.taskId, options.events);
    interval = Math.min(interval + 1_000, 5_000);
  }
}
```

- [ ] **Step 4: The tools**

```ts
// packages/mcp/src/tools.ts
// Spec 025 FR-030: the developer tools, written against ControlPlaneClient so the stdio server
// now and the hosted endpoint later use the same definitions (FR-027).
import {
  DEVELOPER_EVENTS_DEFAULT, DEVELOPER_EVENTS_MAX, DEVELOPER_TASK_LIST_DEFAULT, DEVELOPER_TASK_LIST_MAX, DEVELOPER_WAIT_MAX_SECONDS,
  DeveloperInstructionsSchema, DeveloperTaskStatusSchema, type DeveloperTaskView,
} from "@agentx/contracts";
import { z } from "zod";
import type { ControlPlaneClient } from "./client.js";
import { ToolError } from "./errors.js";
import { waitForTask } from "./wait.js";

export interface ToolContext {
  client: ControlPlaneClient;
  clientName: string | undefined;
  serverVersion: string;
  adminSignedIn(): Promise<boolean>;
  compatibility(): Promise<{ env: string; apiVersion: string; notice?: string }>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  newRequestId(): string;
}
export interface ToolCall { signal: AbortSignal; progress?(progress: number, total: number | undefined, message: string): Promise<void> }
export interface ToolResult { structured: Record<string, unknown>; text: string }
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  handler(context: ToolContext, input: Record<string, unknown>, call: ToolCall): Promise<ToolResult>;
}

const taskIdInput = z.string().min(1).max(100).describe("the task ID agentx_start_task returned");
const requestIdInput = z.string().uuid().optional().describe("a UUID that makes a retried call safe; one is made when left out");
const waitInput = (min: number) => z.number().int().min(min).max(DEVELOPER_WAIT_MAX_SECONDS);

const TaskShape = {
  task_id: z.string(), title: z.string(), project: z.string(), status: DeveloperTaskStatusSchema,
  failure: z.object({ category: z.string(), message: z.string() }).optional(),
  starting_revision: z.number(), client: z.string(), shared: z.boolean(), share_mode: z.string().nullable(),
  closing: z.boolean().optional(), created_at: z.string(), updated_at: z.string(),
  events: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string() })),
  summary: z.string().optional(),
  changed_files: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number(), removed: z.number() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().optional() })).optional(),
  pull_requests: z.array(z.object({ repository: z.string(), number: z.number(), url: z.string(), state: z.string() })).optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  /** Only on start, continue and wait, which may wait (R21). */
  timed_out: z.boolean().optional(),
};

function taskOutput(task: DeveloperTaskView, timedOut?: boolean): Record<string, unknown> {
  return {
    task_id: task.taskId, title: task.title, project: task.project, status: task.status,
    ...(task.failure === undefined ? {} : { failure: task.failure }),
    starting_revision: task.startingRevision, client: task.client, shared: task.shared, share_mode: null,
    ...(task.closing === true ? { closing: true } : {}),
    created_at: task.createdAt, updated_at: task.updatedAt, events: task.events,
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    ...(task.changedFiles === undefined ? {} : { changed_files: task.changedFiles }),
    ...(task.artifacts === undefined ? {} : { artifacts: task.artifacts }),
    ...(task.pullRequests === undefined ? {} : { pull_requests: task.pullRequests }),
    ...(task.unpublished === undefined ? {} : { unpublished: task.unpublished }),
    ...(timedOut === undefined ? {} : { timed_out: timedOut }),
  };
}

function taskText(task: DeveloperTaskView, timedOut?: boolean): string {
  const failure = task.failure === undefined ? "" : ` (${task.failure.category}: ${task.failure.message})`;
  const waited = timedOut === true ? " The wait ended first; the task keeps running: check it later with agentx_get_task." : "";
  const summary = task.summary === undefined ? "" : ` Summary: ${task.summary}`;
  return `Task ${task.taskId} "${task.title}" on ${task.project} is ${task.status}${failure}.${waited}${summary}`;
}

function instructions(value: unknown): string {
  const parsed = DeveloperInstructionsSchema.safeParse(value);
  if (!parsed.success) throw new ToolError("INVALID_REQUEST", `instructions: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

async function withWait(context: ToolContext, call: ToolCall, task: DeveloperTaskView, waitSeconds: number, events: number): Promise<ToolResult> {
  if (waitSeconds === 0) return { structured: taskOutput(task), text: taskText(task) };
  const waited = await waitForTask({
    client: context.client, taskId: task.taskId, waitSeconds, events, signal: call.signal, now: () => context.now(), sleep: (ms, signal) => context.sleep(ms, signal),
    ...(call.progress === undefined ? {} : { progress: (elapsed: number, total: number, message: string) => call.progress!(elapsed, total, message) }),
  });
  return { structured: taskOutput(waited.task, waited.timedOut), text: taskText(waited.task, waited.timedOut) };
}

export const DEVELOPER_TOOLS: readonly ToolDefinition[] = [
  {
    name: "agentx_whoami",
    title: "Who am I in AgentX",
    description: "Shows the AgentX environment, who you are signed in as, how, your Slack link, whether this computer also has an admin sign-in, and the versions.",
    inputSchema: {},
    outputSchema: {
      environment: z.string(), developer_name: z.string(), sign_in_method: z.string(), slack_user: z.string().optional(), admin: z.boolean(),
      server_version: z.string(), control_plane_api_version: z.string(), upgrade_notice: z.string().optional(),
    },
    async handler(context) {
      const [compatibility, projects, admin] = await Promise.all([context.compatibility(), context.client.projects(), context.adminSignedIn()]);
      const { developer } = projects;
      return {
        structured: {
          environment: compatibility.env, developer_name: developer.name, sign_in_method: developer.provider,
          ...(developer.slackUserId === undefined ? {} : { slack_user: developer.slackUserId }), admin,
          server_version: context.serverVersion, control_plane_api_version: compatibility.apiVersion,
          ...(compatibility.notice === undefined ? {} : { upgrade_notice: compatibility.notice }),
        },
        text: `Signed in to AgentX ${compatibility.env} as ${developer.name} with ${developer.provider === "slack" ? "Slack" : "your company sign-in"}.${compatibility.notice === undefined ? "" : ` ${compatibility.notice}.`}`,
      };
    },
  },
  {
    name: "agentx_list_projects",
    title: "List AgentX projects",
    description: "Lists the AgentX projects you may hand tasks to, with their Slack channels and task policy. Use a project's name with agentx_start_task.",
    inputSchema: {},
    outputSchema: {
      projects: z.array(z.object({
        name: z.string(), access: z.string(),
        bound_channels: z.array(z.object({ id: z.string(), name: z.string().optional(), private: z.boolean().optional() })),
        tasks_enabled: z.boolean(), share_policy: z.string(), share_mode_policy: z.object({ default: z.string(), allow_continue: z.boolean() }),
      })),
      notices: z.array(z.string()),
    },
    async handler(context) {
      const response = await context.client.projects();
      const projects = response.projects.map((project) => ({
        name: project.name, access: project.access,
        bound_channels: project.channels.map((channel) => ({ id: channel.channelId, ...(channel.name === undefined ? {} : { name: channel.name }), ...(channel.isPrivate === undefined ? {} : { private: channel.isPrivate }) })),
        tasks_enabled: project.tasks?.enabled ?? true,
        share_policy: project.tasks?.share ?? "optional",
        share_mode_policy: { default: project.tasks?.shareMode.default ?? "view", allow_continue: project.tasks?.shareMode.allowContinue ?? true },
      }));
      const notice = response.notices.includes("slack_unavailable") ? " Slack could not be reached, so projects you use through a Slack channel may be missing." : "";
      return { structured: { projects, notices: response.notices }, text: `${projects.length === 0 ? "You cannot use any AgentX project yet." : `You can use: ${projects.map((project) => project.name).join(", ")}.`}${notice}` };
    },
  },
  {
    name: "agentx_start_task",
    title: "Hand a coding task to AgentX",
    description: "Starts a coding task on an AgentX project in a private remote workspace. Write complete instructions: AgentX's worker runs them exactly as written. Returns at once with a task ID; set wait_seconds (up to 600) to wait for a small task.",
    inputSchema: {
      project: z.string().min(1).max(200).describe("the project's name, from agentx_list_projects"),
      instructions: z.string().min(1).describe("what the remote worker should do, at most 65,536 bytes"),
      title: z.string().max(120).optional().describe("a short title; the first line of the instructions when left out"),
      share_to_channel: z.boolean().optional().describe("share the task to the project's Slack channel (not available yet)"),
      share_mode: z.enum(["view", "continue"]).optional(),
      channel: z.string().max(80).optional(),
      wait_seconds: waitInput(0).optional().describe("seconds to wait for the task to end, 0 to 600; 0 by default"),
      request_id: requestIdInput,
    },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      const task = await context.client.startTask({
        requestId: (input.request_id as string | undefined) ?? context.newRequestId(),
        project: input.project as string,
        instructions: instructions(input.instructions),
        ...(input.title === undefined ? {} : { title: input.title as string }),
        ...(context.clientName === undefined ? {} : { client: context.clientName.slice(0, 200) }),
        ...(input.share_to_channel === undefined ? {} : { shareToChannel: input.share_to_channel as boolean }),
        ...(input.share_mode === undefined ? {} : { shareMode: input.share_mode as "view" | "continue" }),
        ...(input.channel === undefined ? {} : { channel: input.channel as string }),
      });
      return withWait(context, call, task, (input.wait_seconds as number | undefined) ?? 0, DEVELOPER_EVENTS_DEFAULT);
    },
  },
  {
    name: "agentx_get_task",
    title: "Check an AgentX task",
    description: "Shows a task's status, latest progress and, once it ends, its summary, changed files, artifacts and pull requests.",
    inputSchema: { task_id: taskIdInput, events: z.number().int().min(0).max(DEVELOPER_EVENTS_MAX).optional().describe("how many recent events to show, 0 to 50; 10 by default") },
    outputSchema: TaskShape,
    async handler(context, input) {
      const task = await context.client.getTask(input.task_id as string, (input.events as number | undefined) ?? DEVELOPER_EVENTS_DEFAULT);
      return { structured: taskOutput(task), text: taskText(task) };
    },
  },
  {
    name: "agentx_wait_for_task",
    title: "Wait for an AgentX task",
    description: "Waits up to wait_seconds (1 to 600) for a task to end, with progress. If it is still running when the wait ends, that is not an error: the result says timed_out and the task keeps running.",
    inputSchema: { task_id: taskIdInput, wait_seconds: waitInput(1), events: z.number().int().min(0).max(DEVELOPER_EVENTS_MAX).optional() },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      const task = await context.client.getTask(input.task_id as string, (input.events as number | undefined) ?? DEVELOPER_EVENTS_DEFAULT);
      return withWait(context, call, task, input.wait_seconds as number, (input.events as number | undefined) ?? DEVELOPER_EVENTS_DEFAULT);
    },
  },
  {
    name: "agentx_list_tasks",
    title: "List my AgentX tasks",
    description: "Lists the tasks you started from AI tools, newest first.",
    inputSchema: { project: z.string().max(200).optional(), status: DeveloperTaskStatusSchema.optional(), limit: z.number().int().min(1).max(DEVELOPER_TASK_LIST_MAX).optional() },
    outputSchema: { tasks: z.array(z.object({ task_id: z.string(), title: z.string(), project: z.string(), status: z.string(), created_at: z.string(), updated_at: z.string(), shared: z.boolean() })) },
    async handler(context, input) {
      const tasks = await context.client.listTasks({
        limit: (input.limit as number | undefined) ?? DEVELOPER_TASK_LIST_DEFAULT,
        ...(input.project === undefined ? {} : { project: input.project as string }),
        ...(input.status === undefined ? {} : { status: input.status as DeveloperTaskView["status"] }),
      });
      return {
        structured: { tasks: tasks.map((task) => ({ task_id: task.taskId, title: task.title, project: task.project, status: task.status, created_at: task.createdAt, updated_at: task.updatedAt, shared: task.shared })) },
        text: tasks.length === 0 ? "You have no AgentX tasks." : tasks.map((task) => `${task.taskId} ${task.status} ${task.project}: ${task.title}`).join("\n"),
      };
    },
  },
  {
    name: "agentx_continue_task",
    title: "Continue an AgentX task",
    description: "Sends more instructions to a finished task. They run in the same workspace, on the same branch, exactly as written.",
    inputSchema: { task_id: taskIdInput, instructions: z.string().min(1), wait_seconds: waitInput(0).optional(), request_id: requestIdInput },
    outputSchema: TaskShape,
    async handler(context, input, call) {
      const task = await context.client.continueTask(input.task_id as string, { requestId: (input.request_id as string | undefined) ?? context.newRequestId(), instructions: instructions(input.instructions) });
      return withWait(context, call, task, (input.wait_seconds as number | undefined) ?? 0, DEVELOPER_EVENTS_DEFAULT);
    },
  },
  {
    name: "agentx_cancel_task",
    title: "Cancel an AgentX task",
    description: "Stops a task's running work. The workspace stays until you close it.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput },
    outputSchema: TaskShape,
    async handler(context, input) {
      const task = await context.client.cancelTask(input.task_id as string, (input.request_id as string | undefined) ?? context.newRequestId());
      return { structured: taskOutput(task), text: taskText(task) };
    },
  },
  {
    name: "agentx_close_task",
    title: "Close an AgentX task",
    description: "Starts closing a task, which releases its workspace so it stops counting against your limit. AgentX first checks for unpublished work and will not close a task that has some. Returns at once; check the outcome with agentx_get_task: status CLOSED, or unpublished listing each repository and why.",
    inputSchema: { task_id: taskIdInput, request_id: requestIdInput },
    outputSchema: { ...TaskShape, closed: z.boolean() },
    async handler(context, input) {
      const taskId = input.task_id as string;
      // R22: no wait. A repeated request_id returns the same close and its outcome.
      const answer = await context.client.closeTask(taskId, (input.request_id as string | undefined) ?? context.newRequestId());
      const unpublished = answer.unpublished ?? answer.task.unpublished;
      const task = unpublished === undefined ? answer.task : { ...answer.task, unpublished };
      const text = answer.closed
        ? `Task ${taskId} is closed; its workspace is released.`
        : unpublished !== undefined
          ? `Task ${taskId} was not closed: unpublished work in ${unpublished.map((entry) => `${entry.repository} (${entry.reasons.join(", ")})`).join("; ")}. Open a pull request first, or continue the task with instructions to discard the changes.`
          : `Closing task ${taskId}: AgentX is checking the workspace for unpublished work. Check with agentx_get_task; it shows CLOSED when done.`;
      return { structured: { ...taskOutput(task), closed: answer.closed }, text };
    },
  },
  {
    name: "agentx_open_pull_request",
    title: "Open a pull request from an AgentX task",
    description: "Starts opening a pull request with the task's changes through AgentX's publication path, as a draft unless draft is false. Returns at once with the operation; check with agentx_get_task, which lists the pull request's URL once it is published.",
    inputSchema: {
      task_id: taskIdInput, title: z.string().min(1).max(256), body: z.string().optional(),
      repository: z.string().max(63).optional().describe("needed only when the project has several repositories"),
      draft: z.boolean().optional().describe("true by default"), request_id: requestIdInput,
    },
    outputSchema: {
      operation_id: z.string(), operation_status: z.string(),
      pull_request: z.object({ repository: z.string(), number: z.number(), url: z.string(), state: z.string() }).optional(),
      task: z.object(TaskShape),
    },
    async handler(context, input) {
      const taskId = input.task_id as string;
      // R22: no wait. A repeated request_id returns the same operation, with the URL once published.
      const answer = await context.client.openPullRequest(taskId, {
        requestId: (input.request_id as string | undefined) ?? context.newRequestId(),
        title: input.title as string,
        draft: (input.draft as boolean | undefined) ?? true,
        ...(input.body === undefined ? {} : { body: input.body as string }),
        ...(input.repository === undefined ? {} : { repository: input.repository as string }),
      });
      return {
        structured: {
          operation_id: answer.operationId, operation_status: answer.operationStatus,
          ...(answer.pullRequest === undefined ? {} : { pull_request: answer.pullRequest }),
          task: taskOutput(answer.task),
        },
        text: answer.pullRequest !== undefined
          ? `Opened ${answer.pullRequest.url}.`
          : `Opening a pull request for task ${taskId} (operation ${answer.operationId}, ${answer.operationStatus}). Check with agentx_get_task; the URL appears there once it is published.`,
      };
    },
  },
];
```

- [ ] **Step 5: The server**

```ts
// packages/mcp/src/server.ts
// Spec 025 FR-026 to FR-029: registers the tools on an MCP server, checks the API version first,
// and passes every result, and every error, through redaction.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactSecrets, redactText } from "@agentx/contracts";
import { ToolError } from "./errors.js";
import { DEVELOPER_TOOLS, type ToolCall, type ToolContext } from "./tools.js";

export function createAgentXMcpServer(options: {
  version: string;
  context(clientName: string | undefined): ToolContext;
  log?(entry: Record<string, unknown>): void;
}): McpServer {
  const server = new McpServer({ name: "agentx", version: options.version });
  for (const tool of DEVELOPER_TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }, async (input: Record<string, unknown>, extra) => {
      const context = options.context(server.server.getClientVersion()?.name);
      const progressToken = extra._meta?.progressToken;
      const call: ToolCall = {
        signal: extra.signal,
        ...(progressToken === undefined ? {} : {
          progress: async (progress: number, total: number | undefined, message: string) => {
            await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, ...(total === undefined ? {} : { total }), message: redactText(message) } });
          },
        }),
      };
      try {
        await context.compatibility();
        const result = await tool.handler(context, input, call);
        return { content: [{ type: "text" as const, text: redactText(result.text) }], structuredContent: redactSecrets(result.structured) as Record<string, unknown> };
      } catch (error) {
        const failure = error instanceof ToolError ? error : new ToolError("CONTROL_PLANE_UNAVAILABLE", "the AgentX MCP server hit an unexpected problem");
        // The code and tool only: never the message, which can quote the developer's text.
        options.log?.({ event: "tool.failed", tool: tool.name, code: failure.code, ...(error instanceof ToolError ? {} : { error: error instanceof Error ? error.name : "unknown" }) });
        const structured = redactSecrets({ code: failure.code, message: failure.message, next_step: failure.nextStep }) as Record<string, unknown>;
        return { isError: true, content: [{ type: "text" as const, text: redactText(`${failure.code}: ${failure.message}. Next step: ${failure.nextStep}.`) }], structuredContent: structured };
      }
    });
  }
  return server;
}
```

Append to `packages/mcp/src/index.ts`:

```ts
export * from "./compatibility.js";
export * from "./server.js";
export * from "./tools.js";
export * from "./wait.js";
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/mcp-wait.test.ts tests/contract/mcp-tools.test.ts tests/contract/mcp-client.test.ts tests/contract/developer-task-reads.test.ts && npm run build && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src tests/contract/mcp-wait.test.ts tests/contract/mcp-tools.test.ts
git commit -m "feat(mcp): the developer tools, waits and the MCP server (spec 025 FR-026 to FR-030, FR-048)"
```

---
### Task 16: `agentx mcp`, and the developer flow end to end

FR-026 (stdio, stdout only for protocol, logs to stderr, no token logged), R24, and the Testing
section's contract test: the MCP SDK's client driving the server against the broker in process,
through User Stories 1 and 2, and one real stdio run of the CLI.

**Files:**
- Create: `packages/cli/src/mcp/serve.ts`
- Modify: `packages/cli/src/main.ts` (the `mcp` command; `CliDependencies` gains `stdin` and `mcpClock`)
- Modify: `packages/cli/package.json` (`"@agentx/mcp": "0.1.0"`, `"@modelcontextprotocol/sdk": "1.30.1"`), `packages/cli/tsconfig.json` (reference `../mcp`)
- Modify: `tests/support/developer-task-broker.ts` (export `bearerFor(who)`)
- Modify: `tests/contract/cli-main.test.ts` (the root command list gains `mcp`)
- Test: `tests/contract/mcp-developer-flow.test.ts`, `tests/contract/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: Tasks 14 and 15; 25a's `developerAccessToken`, `resolveDeveloperEnvironment`, `tokenStoreKey`.
- Produces:
  - `interface McpServeDeps extends DeveloperSessionDeps { env?: string; adminSignedIn(env: string | undefined): Promise<boolean>; stderr: { write(text: string): unknown }; clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> } }`;
  - `developerControlPlaneClient(deps: McpServeDeps): ControlPlaneClient`;
  - `agentxMcpServer(deps: McpServeDeps): McpServer`;
  - `runMcpServer(deps: McpServeDeps & { stdin: Readable; stdout: Writable }): Promise<void>` (resolves when the client closes stdin);
  - the command `agentx mcp [--env <name>]`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/mcp-developer-flow.test.ts
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { DEV_ISSUER, MAYA, OMAR, bearerFor, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";

const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

/** The control plane as the MCP server sees it: agentx-configuration, and /v1/dev/* on the broker. */
function brokerFetch(harness: Harness): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.1", issuer: DEV_ISSUER });
    const response = await harness.handler({
      version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1),
      headers: { authorization: new Headers(init?.headers).get("authorization") ?? "" },
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" } },
    });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
}

async function signedInClient(harness: Harness, who: Developer | undefined, onSleep: () => Promise<void> = async () => undefined) {
  const home = await mkdtemp(join(tmpdir(), "agentx-mcp-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: DEV_ISSUER, tokenEndpoint: `${DEV_ISSUER}/token`, revocationEndpoint: `${DEV_ISSUER}/revoke` });
  if (who !== undefined) await tokenStore.set(developerTokenKey(DEV_ISSUER), { accessToken: (await bearerFor(who)).slice("Bearer ".length), refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  let now = 0;
  const server = agentxMcpServer({
    home, tokenStore, fetch: brokerFetch(harness), adminSignedIn: async () => false, stderr: { write: () => true },
    clock: { now: () => now, sleep: async (ms) => { now += ms; await onSleep(); } },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, value: result.structuredContent as Record<string, unknown> };
  };
  return { tool, home };
}

const workspaceOf = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
const activeOf = (harness: Harness, workspaceId: string) => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

describe("hand off a task from an AI tool and move on (US1)", () => {
  it("lists projects, starts, reads, continues and opens a PR, with every action audited", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, MAYA);

    expect((await tool("agentx_list_projects")).value).toMatchObject({ projects: [{ name: "payments", tasks_enabled: true }] });

    const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix the flaky retry test in payments-api" });
    expect(started.value).toMatchObject({ status: "STARTING", client: "Claude Code" });
    const taskId = String(started.value.task_id);
    const workspaceId = workspaceOf(harness, taskId);

    await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");
    const operation = activeOf(harness, workspaceId);
    const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation)[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe("Fix the flaky retry test in payments-api");
    await harness.events(workspaceId, operation, [say("Fixed the retry test; 212 tests pass.")]);
    await harness.finish(workspaceId, operation, "SUCCEEDED");
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ status: "SUCCEEDED", summary: "Fixed the retry test; 212 tests pass." });

    expect((await tool("agentx_continue_task", { task_id: taskId, instructions: "Add a test for the timeout path." })).value).toMatchObject({ status: "RUNNING" });
    await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");

    const pr = await tool("agentx_open_pull_request", { task_id: taskId, title: "Fix the flaky retry test" });
    expect(pr.value).toMatchObject({ operation_status: "ACCEPTED", task: { task_id: taskId } });
    expect(pr.value).not.toHaveProperty("timed_out");
    const publication = harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${String(pr.value.operation_id)}`) as { publication: { body: string; draft: boolean } };
    expect(publication.publication).toMatchObject({ draft: true, body: "Requested by `Maya Chen` via AgentX, started from Claude Code" });

    const turns = harness.db.find((item) => item.pk === `TASK#${taskId}`).map((item) => `${String(item.action)}:${String(item.phase)}`).sort();
    expect(turns).toEqual(["continue:accepted", "continue:completed", "pull_request:accepted", "start:accepted", "start:completed"]);
    expect((await tool("agentx_list_tasks")).value).toMatchObject({ tasks: [{ task_id: taskId }] });
  });

  it("tells another developer the task was not found (US1 scenario 6)", async () => {
    const harness = await createDeveloperTaskBroker();
    const maya = await signedInClient(harness, MAYA);
    const taskId = String((await maya.tool("agentx_start_task", { project: "payments", instructions: "x" })).value.task_id);
    const omar = await signedInClient(harness, OMAR);
    expect(await omar.tool("agentx_get_task", { task_id: taskId })).toMatchObject({ isError: true, value: { code: "TASK_NOT_FOUND" } });
  });

  it("gives PROJECT_NOT_FOUND and PROJECT_ACCESS_DENIED their own codes (US1 scenario 7)", async () => {
    const harness = await createDeveloperTaskBroker();
    const omar = await signedInClient(harness, OMAR);
    expect((await omar.tool("agentx_start_task", { project: "nope", instructions: "x" })).value).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect((await omar.tool("agentx_start_task", { project: "payments", instructions: "x" })).value).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: ask an admin" });
  });

  it("answers SIGN_IN_REQUIRED with the exact command when this computer has no sign-in", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, undefined);
    expect(await tool("agentx_list_projects")).toMatchObject({ isError: true, value: { code: "SIGN_IN_REQUIRED", next_step: `run npx @charterarc/agentx login ${URL_BASE}` } });
  });
});

describe("wait for a small task (US2)", () => {
  it("returns the finished task when it ends inside the wait", async () => {
    const harness = await createDeveloperTaskBroker();
    let done = false;
    const { tool } = await signedInClient(harness, MAYA, async () => {
      // The worker prepares the workspace and finishes the task while the tool waits.
      const workspaceId = harness.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]?.workspaceId as string | undefined;
      if (workspaceId === undefined || done) return;
      done = true;
      await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");
      await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");
    });
    const result = await tool("agentx_start_task", { project: "payments", instructions: "run the payments test suite", wait_seconds: 60 });
    expect(result.value).toMatchObject({ timed_out: false, status: "SUCCEEDED" });
  });

  it("returns timed_out, not an error, when the task outlives the wait", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, MAYA);
    const taskId = String((await tool("agentx_start_task", { project: "payments", instructions: "long" })).value.task_id);
    const waited = await tool("agentx_wait_for_task", { task_id: taskId, wait_seconds: 5 });
    expect(waited).toMatchObject({ isError: false, value: { timed_out: true, status: "STARTING" } });
  });
});
```

```ts
// tests/contract/mcp-stdio.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("agentx mcp over stdio (FR-026)", () => {
  it("speaks only MCP on stdout, lists the tools, and answers SIGN_IN_REQUIRED when not signed in", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-mcp-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/cli/src/main.ts", "mcp"],
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const errors: unknown[] = [];
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    client.onerror = (error) => errors.push(error);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(10);
      const result = await client.callTool({ name: "agentx_whoami", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "SIGN_IN_REQUIRED" });
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 30_000);
});
```

Append `"mcp"` to the expected root command list in `tests/contract/cli-main.test.ts`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/mcp-developer-flow.test.ts tests/contract/mcp-stdio.test.ts tests/contract/cli-main.test.ts`
Expected: FAIL, `packages/cli/src/mcp/serve.ts` does not exist.

- [ ] **Step 3: Write the server glue**

```ts
// packages/cli/src/mcp/serve.ts
// Spec 025 FR-026: `agentx mcp`, a stdio MCP server for the developer signed in on this computer.
// stdout carries only MCP messages; logs go to stderr and never hold a token.
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { compatibilityChecker, createAgentXMcpServer, httpControlPlaneClient, type ControlPlaneClient } from "@agentx/mcp";
import { developerAccessToken, type DeveloperSessionDeps } from "../developer/session.js";
import { CLI_VERSION } from "../version.js";

export interface McpServeDeps extends DeveloperSessionDeps {
  env?: string;
  adminSignedIn(env: string | undefined): Promise<boolean>;
  stderr: { write(text: string): unknown };
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
}

/** Resolves after `ms`, or at once when the tool call is cancelled. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Each call reads the developer's current tokens, refreshing under 25a's lock (R19 of 25a). */
export function developerControlPlaneClient(deps: McpServeDeps): ControlPlaneClient {
  return httpControlPlaneClient({
    fetch: deps.fetch,
    session: async () => {
      const session = await developerAccessToken(deps, deps.env);
      return { baseUrl: session.entry.url, accessToken: session.accessToken, signInCommand: `npx @charterarc/agentx login ${session.entry.url}` };
    },
  });
}

export function agentxMcpServer(deps: McpServeDeps): McpServer {
  const client = developerControlPlaneClient(deps);
  const now = deps.clock?.now ?? Date.now;
  const compatibility = compatibilityChecker(client, { now });
  const log = (entry: Record<string, unknown>) => {
    deps.stderr.write(`${JSON.stringify({ component: "agentx-mcp", ...entry })}\n`);
  };
  return createAgentXMcpServer({
    version: CLI_VERSION,
    log,
    context: (clientName) => ({
      client,
      clientName,
      serverVersion: CLI_VERSION,
      adminSignedIn: () => deps.adminSignedIn(deps.env),
      compatibility,
      now,
      sleep: deps.clock?.sleep ?? abortableSleep,
      newRequestId: randomUUID,
    }),
  });
}

export async function runMcpServer(deps: McpServeDeps & { stdin: Readable; stdout: Writable }): Promise<void> {
  const server = agentxMcpServer(deps);
  const transport = new StdioServerTransport(deps.stdin, deps.stdout);
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    deps.stdin.once("end", () => resolve());
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
```

- [ ] **Step 4: The command**

In `main.ts`, add `stdin?: Readable;` and `mcpClock?: McpServeDeps["clock"];` to
`CliDependencies`, and after `whoami`:

```ts
  /** R24: whether this computer holds an unexpired admin sign-in for the developer's environment. */
  const adminSignedIn = async (env: string | undefined): Promise<boolean> => {
    try {
      const name = (await resolveDeveloperEnvironment(home, env)).env;
      const settings = await deploymentSettings({ ...globalOptions(program), env: name });
      const tokens = await services.tokenStore.get(tokenStoreKey(settings.auth));
      return tokens !== undefined && tokens.expiresAt > Date.now();
    } catch {
      return false;
    }
  };

  const mcp = program
    .command("mcp")
    .description("run the AgentX MCP server for your AI tool (stdio); add it with agentx mcp install")
    .action(async (_options: unknown, command: Command) => {
      await runMcpServer({
        ...developerSession(),
        ...(developerEnv(command) === undefined ? {} : { env: developerEnv(command)! }),
        adminSignedIn,
        stdin: dependencies.stdin ?? process.stdin,
        stdout: (dependencies.stdout ?? process.stdout) as Writable,
        stderr: services.stderr,
        ...(dependencies.mcpClock === undefined ? {} : { clock: dependencies.mcpClock }),
      });
    });
```

(`mcp` is kept in a variable because Task 17 adds `mcp install` to it.) Import `runMcpServer` and
`type McpServeDeps` from `./mcp/serve.js`, `resolveDeveloperEnvironment` from
`./developer/config.js`, and the `Readable`, `Writable` types from `node:stream`.

Add the two dependencies to `packages/cli/package.json` and `{ "path": "../mcp" }` to its
`tsconfig.json` references. Export `bearerFor = bearer` from the test support file.

- [ ] **Step 5: Run the tests, then build and pack**

Run: `npx vitest run tests/contract/mcp-developer-flow.test.ts tests/contract/mcp-stdio.test.ts tests/contract/cli-main.test.ts tests/contract/developer-cli.test.ts && npm run build && npm run typecheck && npm run lint`
Expected: PASS.

Run: `npm run release:pack-cli -- --version 0.0.0-check --out /private/tmp/claude-501/agentx-pack-check` then
`printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' | HOME=$(mktemp -d) node /private/tmp/claude-501/agentx-pack-check/package/bin/agentx.mjs mcp | head -c 200`
Expected: one JSON-RPC line naming `"name":"agentx"`, which shows the SDK is bundled into the
single-file CLI. Delete the scratch directory afterwards.

- [ ] **Step 6: Commit**

```bash
git add packages/cli tests/support/developer-task-broker.ts tests/contract/mcp-developer-flow.test.ts tests/contract/mcp-stdio.test.ts tests/contract/cli-main.test.ts package-lock.json
git commit -m "feat(cli): agentx mcp, the stdio MCP server (spec 025 FR-026, US1, US2)"
```

---
### Task 17: `agentx mcp install` and the install guide

FR-043, FR-047, US7 scenarios 1 and 2, R26, and Review Focus 5.

**Files:**
- Create: `packages/cli/src/mcp/install.ts`
- Modify: `packages/cli/src/main.ts` (`mcp install`)
- Create: `docs/mcp-install.md`
- Test: `tests/contract/mcp-install.test.ts`

**Interfaces:**
- Consumes: `RELEASE_VERSION` (`packages/cli/src/version.ts`).
- Produces:
  - `type McpClientKind = "claude-code" | "codex" | "cursor"`, `MCP_CLIENTS`;
  - `mcpEntry(version: string | undefined, env: string | undefined): { command: "npx"; args: string[] }`;
  - `codexToml(existing: string | undefined, entry): { text: string; action: "added" | "replaced" }`;
  - `cursorJson(existing: string | undefined, entry): { text: string; action: "added" | "replaced" }`;
  - `installMcp(kind: McpClientKind, options: { print: boolean; env?: string }, deps: { home: string; run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>; version?: string }): Promise<string>` (the text to print);
  - the command `agentx mcp install --client claude-code|codex|cursor [--print]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/mcp-install.test.ts
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexToml, cursorJson, installMcp, mcpEntry } from "../../packages/cli/src/mcp/install.js";

const entry = mcpEntry("0.4.0", undefined);
const home = () => mkdtemp(join(tmpdir(), "agentx-install-"));

describe("the server entry (FR-043, R26)", () => {
  it("runs the installed CLI's version, or latest for a CLI built from source, and names --env only when given", () => {
    expect(mcpEntry("0.4.0", undefined)).toEqual({ command: "npx", args: ["-y", "@charterarc/agentx@0.4.0", "mcp"] });
    expect(mcpEntry(undefined, undefined).args).toEqual(["-y", "@charterarc/agentx@latest", "mcp"]);
    expect(mcpEntry("0.4.0", "staging").args).toEqual(["-y", "@charterarc/agentx@0.4.0", "--env", "staging", "mcp"]);
  });
});

describe("Codex's config.toml", () => {
  it("adds the table to an empty or missing file", () => {
    expect(codexToml(undefined, entry)).toEqual({ action: "added", text: '[mcp_servers.agentx]\ncommand = "npx"\nargs = ["-y", "@charterarc/agentx@0.4.0", "mcp"]\n' });
  });

  it("appends after other entries, leaving them as they are", () => {
    const existing = 'model = "o4"\n\n[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    expect(codexToml(existing, entry).text).toBe(`${existing}\n[mcp_servers.agentx]\ncommand = "npx"\nargs = ["-y", "@charterarc/agentx@0.4.0", "mcp"]\n`);
  });

  it("replaces the agentx table and its sub-tables and keeps every other byte (Review Focus 5)", () => {
    const before = [
      "# servers", "[mcp_servers.linear]", 'command = "linear"', "",
      "[mcp_servers.agentx]", 'command = "npx"', 'args = ["-y", "@charterarc/agentx@0.1.0", "mcp"]', "",
      "[mcp_servers.agentx.env]", 'FOO = "bar"', "",
      "# keep this comment", "[mcp_servers.github]", 'command = "gh"', "",
    ].join("\n");
    const after = [
      "# servers", "[mcp_servers.linear]", 'command = "linear"', "",
      "[mcp_servers.agentx]", 'command = "npx"', 'args = ["-y", "@charterarc/agentx@0.4.0", "mcp"]', "",
      "# keep this comment", "[mcp_servers.github]", 'command = "gh"', "",
    ].join("\n");
    expect(codexToml(before, entry)).toEqual({ action: "replaced", text: after });
  });

  it.each([
    '[mcp_servers."agentx"]\ncommand = "x"\n',
    'mcp_servers.agentx = { command = "x" }\n',
    '[mcp_servers]\nagentx = { command = "x" }\n',
  ])("refuses a file that defines agentx another way, and shows the entry to add by hand: %j", (existing) => {
    expect(() => codexToml(existing, entry)).toThrow(/by hand[\s\S]*\[mcp_servers\.agentx\]/);
  });
});

describe("Cursor's mcp.json", () => {
  it("adds or replaces mcpServers.agentx and keeps every other server and key", () => {
    const existing = JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" }, agentx: { command: "old" } }, other: true });
    const result = cursorJson(existing, entry);
    expect(result.action).toBe("replaced");
    expect(JSON.parse(result.text)).toEqual({ mcpServers: { linear: { command: "linear-mcp" }, agentx: entry }, other: true });
    expect(cursorJson(undefined, entry)).toMatchObject({ action: "added" });
  });

  it("refuses a file that is not plain JSON", () => {
    expect(() => cursorJson('{ // comment\n "mcpServers": {} }', entry)).toThrow(/not plain JSON/);
  });
});

describe("installMcp (US7 scenarios 1 and 2)", () => {
  it("writes Codex's file, keeps a copy of the old one, and says what changed", async () => {
    const dir = await home();
    await mkdir(join(dir, ".codex"));
    await writeFile(join(dir, ".codex", "config.toml"), '[mcp_servers.linear]\ncommand = "linear-mcp"\n');
    const text = await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect(await readFile(join(dir, ".codex", "config.toml"), "utf8")).toContain('[mcp_servers.agentx]\ncommand = "npx"');
    expect(await readFile(join(dir, ".codex", "config.toml.agentx-backup"), "utf8")).toBe('[mcp_servers.linear]\ncommand = "linear-mcp"\n');
    expect(text).toContain(join(dir, ".codex", "config.toml"));
    expect(text).toContain("added");
  });

  it("writes Cursor's file when it does not exist yet", async () => {
    const dir = await home();
    await installMcp("cursor", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect(JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"))).toEqual({ mcpServers: { agentx: entry } });
  });

  it("runs claude mcp remove, then add, at user scope", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const text = await installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" });
    expect(run.mock.calls).toEqual([
      ["claude", ["mcp", "remove", "--scope", "user", "agentx"]],
      ["claude", ["mcp", "add", "--scope", "user", "agentx", "--", "npx", "-y", "@charterarc/agentx@0.4.0", "mcp"]],
    ]);
    expect(text).toContain("claude mcp add --scope user agentx -- npx -y @charterarc/agentx@0.4.0 mcp");
  });

  it("prints the command to run when Claude Code is not installed", async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); });
    await expect(installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" })).rejects.toThrow(/claude mcp add --scope user agentx -- npx -y @charterarc\/agentx@0\.4\.0 mcp/);
  });

  it("with --print, only prints the entry and changes nothing", async () => {
    const dir = await home();
    const run = vi.fn();
    const text = await installMcp("codex", { print: true }, { home: dir, run, version: "0.4.0" });
    expect(text).toContain("[mcp_servers.agentx]");
    await expect(readFile(join(dir, ".codex", "config.toml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the install guide (FR-047)", () => {
  it("covers install, manual setup, sign-in, a first task and removal for each client, in plain words", async () => {
    const guide = await readFile("docs/mcp-install.md", "utf8");
    for (const client of ["Claude Code", "Codex", "Cursor"]) expect(guide).toContain(`## ${client}`);
    for (const text of [
      "claude mcp add --scope user agentx -- npx -y @charterarc/agentx mcp",
      "npx @charterarc/agentx mcp install --client codex",
      "npx @charterarc/agentx mcp install --client cursor",
      "[mcp_servers.agentx]",
      "\"mcpServers\"",
      "npx @charterarc/agentx login",
      "claude mcp remove --scope user agentx",
      "agentx_start_task",
    ]) expect(guide).toContain(text);
    expect(guide).not.toContain("\u2014");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-install.test.ts`
Expected: FAIL, `install.ts` does not exist.

- [ ] **Step 3: Write the installer**

```ts
// packages/cli/src/mcp/install.ts
// Spec 025 FR-043: add the agentx MCP server to Claude Code, Codex or Cursor without touching
// any other entry, and say exactly what changed. --print only prints the entry.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentXError } from "@agentx/contracts";

export type McpClientKind = "claude-code" | "codex" | "cursor";
export const MCP_CLIENTS: readonly McpClientKind[] = ["claude-code", "codex", "cursor"];
export interface McpEntry { command: "npx"; args: string[] }
export interface RunResult { code: number; stdout: string; stderr: string }
export interface McpInstallDeps { home: string; run(command: string, args: readonly string[]): Promise<RunResult>; version?: string | undefined }

/** R26: the packed release's version, or latest for a CLI built from source. */
export function mcpEntry(version: string | undefined, env: string | undefined): McpEntry {
  return { command: "npx", args: ["-y", `@charterarc/agentx@${version ?? "latest"}`, ...(env === undefined ? [] : ["--env", env]), "mcp"] };
}

const tomlBlock = (entry: McpEntry) => ["[mcp_servers.agentx]", `command = ${JSON.stringify(entry.command)}`, `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`];
const OURS = /^\s*\[\s*mcp_servers\.agentx(\.[^\]]+)?\s*\]\s*(#.*)?$/;
const TABLE = /^\s*\[/;
const KEEP_WITH_NEXT = /^\s*(#.*)?$/;
const OTHER_FORMS = [
  /^\s*\[\s*mcp_servers\s*\.\s*["']agentx["']/m,
  /^\s*mcp_servers\s*\.\s*agentx\s*=/m,
];

/** Our table, and every sub-table of it, replaced in place; comments and blank lines that lead into the next table stay with it. */
export function codexToml(existing: string | undefined, entry: McpEntry): { text: string; action: "added" | "replaced" } {
  const byHand = () => agentXError("CONFIG_INVALID", `~/.codex/config.toml defines agentx in a form this command will not edit; add the entry by hand:\n${tomlBlock(entry).join("\n")}`);
  const lines = (existing ?? "").split("\n");
  const kept: string[] = [];
  let insertAt = -1;
  let buffer: string[] | undefined;
  const leaveOurs = () => {
    if (buffer === undefined) return;
    let cut = buffer.length;
    while (cut > 0 && KEEP_WITH_NEXT.test(buffer[cut - 1]!)) cut -= 1;
    kept.push(...buffer.slice(cut));
    buffer = undefined;
  };
  for (const line of lines) {
    if (OURS.test(line)) {
      if (insertAt === -1) insertAt = kept.length;
      buffer = [];
      continue;
    }
    if (buffer !== undefined && TABLE.test(line)) leaveOurs();
    if (buffer !== undefined) buffer.push(line);
    else kept.push(line);
  }
  leaveOurs();
  const rest = kept.join("\n");
  const inServersTable = /^\s*\[\s*mcp_servers\s*\]\s*$/m.test(rest) && /^\s*agentx\s*=/m.test(rest);
  if (OTHER_FORMS.some((pattern) => pattern.test(rest)) || inServersTable) throw byHand();
  if (insertAt !== -1) {
    kept.splice(insertAt, 0, ...tomlBlock(entry));
    return { text: kept.join("\n"), action: "replaced" };
  }
  const base = existing ?? "";
  const separator = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${base}${separator}${tomlBlock(entry).join("\n")}\n`, action: "added" };
}

export function cursorJson(existing: string | undefined, entry: McpEntry): { text: string; action: "added" | "replaced" } {
  const byHand = `add this under "mcpServers" by hand: "agentx": ${JSON.stringify(entry)}`;
  let document: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw agentXError("CONFIG_INVALID", `~/.cursor/mcp.json is not plain JSON, so this command will not edit it; ${byHand}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw agentXError("CONFIG_INVALID", `~/.cursor/mcp.json is not a JSON object; ${byHand}`);
    document = parsed as Record<string, unknown>;
  }
  const servers = document.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw agentXError("CONFIG_INVALID", `~/.cursor/mcp.json has an mcpServers that is not an object; ${byHand}`);
  const action = Object.hasOwn(servers, "agentx") ? "replaced" : "added";
  return { text: `${JSON.stringify({ ...document, mcpServers: { ...(servers as Record<string, unknown>), agentx: entry } }, null, 2)}\n`, action };
}

/** Writes the new file atomically, keeping the old one beside it as <file>.agentx-backup. */
async function replaceFile(path: string, text: string, previous: string | undefined): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (previous !== undefined) await writeFile(`${path}.agentx-backup`, previous);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const readIfPresent = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

const NEXT = "Start a new session of your AI tool, and sign in if you have not yet: npx @charterarc/agentx login <your AgentX URL>\n";

export async function installMcp(kind: McpClientKind, options: { print: boolean; env?: string }, deps: McpInstallDeps): Promise<string> {
  const entry = mcpEntry(deps.version, options.env);
  if (kind === "claude-code") {
    const add = ["mcp", "add", "--scope", "user", "agentx", "--", entry.command, ...entry.args];
    const command = `claude ${add.join(" ")}`;
    if (options.print) return `${command}\n`;
    const manual = `run this yourself once Claude Code is installed:\n  ${command}`;
    try {
      // A failed remove means there was no entry to replace.
      await deps.run("claude", ["mcp", "remove", "--scope", "user", "agentx"]);
      const result = await deps.run("claude", add);
      if (result.code !== 0) throw agentXError("CONFIG_INVALID", `claude mcp add failed (${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}); ${manual}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw agentXError("CONFIG_INVALID", `Claude Code's claude command was not found; ${manual}`);
      throw error;
    }
    return `Added agentx to Claude Code for your user:\n  ${command}\n${NEXT}`;
  }
  const path = kind === "codex" ? join(deps.home, ".codex", "config.toml") : join(deps.home, ".cursor", "mcp.json");
  const previous = await readIfPresent(path);
  const result = kind === "codex" ? codexToml(previous, entry) : cursorJson(previous, entry);
  const shown = kind === "codex" ? tomlBlock(entry).join("\n") : JSON.stringify({ mcpServers: { agentx: entry } }, null, 2);
  if (options.print) return `${shown}\n`;
  await replaceFile(path, result.text, previous);
  return `${result.action === "added" ? "Added" : "Replaced"} the agentx entry in ${path}${previous === undefined ? "" : ` (the old file is at ${path}.agentx-backup)`}:\n${shown}\n${NEXT}`;
}

/** The real runner: exit code and output, never a shell. */
export function runCommand(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
```

In `main.ts`, after the `mcp` command:

```ts
  mcp
    .command("install")
    .description("add the AgentX MCP server to Claude Code, Codex or Cursor")
    .addOption(new Option("--client <client>", "the AI tool").choices([...MCP_CLIENTS]).makeOptionMandatory())
    .option("--print", "only print the entry; change nothing", false)
    .action(async (options: { client: McpClientKind; print: boolean }, command: Command) => {
      const env = developerEnv(command);
      services.stdout.write(await installMcp(options.client, { print: options.print, ...(env === undefined ? {} : { env }) }, { home, run: dependencies.runCommand ?? runCommand, version: RELEASE_VERSION }));
    });
```

with `runCommand?: McpInstallDeps["run"]` added to `CliDependencies`, and the imports.

- [ ] **Step 4: Write the guide**

Create `docs/mcp-install.md`:

````markdown
# Use AgentX from Claude Code, Codex or Cursor

AgentX runs a small MCP server on your computer. Your AI tool uses it to hand AgentX a coding task
on a project you may use, check on it, continue it, and open a pull request. You need Node 22 and
the URL of your company's AgentX (ask your AgentX admin).

Sign in once, in any terminal:

```
npx @charterarc/agentx login https://agentx.example.com
```

Your browser opens. Sign in with Slack or with your company's sign-in. The terminal then shows who
you are and which projects you can use. You sign in again only when the sign-in ends (at most 7
days).

## Claude Code

Install:

```
claude mcp add --scope user agentx -- npx -y @charterarc/agentx mcp
```

or let AgentX run that for you, with the version you have: `npx @charterarc/agentx mcp install --client claude-code`.

Manual setup: the command above is the whole setup. To see the exact command without running it,
use `npx @charterarc/agentx mcp install --client claude-code --print`.

Remove it: `claude mcp remove --scope user agentx`.

## Codex

Install:

```
npx @charterarc/agentx mcp install --client codex
```

It adds this to `~/.codex/config.toml`, keeps every other entry, and saves the old file as
`config.toml.agentx-backup`. Manual setup: add it yourself:

```
[mcp_servers.agentx]
command = "npx"
args = ["-y", "@charterarc/agentx", "mcp"]
```

Remove it: delete the `[mcp_servers.agentx]` table from `~/.codex/config.toml`.

## Cursor

Install:

```
npx @charterarc/agentx mcp install --client cursor
```

It adds this to `~/.cursor/mcp.json`, keeps every other server, and saves the old file as
`mcp.json.agentx-backup`. Manual setup: add it yourself:

```
{
  "mcpServers": {
    "agentx": { "command": "npx", "args": ["-y", "@charterarc/agentx", "mcp"] }
  }
}
```

Remove it: delete the `agentx` entry under `"mcpServers"` in `~/.cursor/mcp.json`.

## Your first task

Start a new session of your AI tool and ask, for example:

> Have AgentX fix the flaky retry test in payments-api and tell me when it is done.

Your AI tool writes the instructions and calls `agentx_start_task`. AgentX answers at once with a
task ID and works in a private workspace of its own; you keep working. Ask "how is my AgentX task
doing?" to check on it, "continue it and add a test for the timeout" to send more instructions,
and "open a pull request" when it is ready. For a small task, ask your tool to wait: it can wait up
to 10 minutes.

Tasks from your AI tool are private: only you see them, and every action is recorded for your
admins. Each task keeps a workspace until you close it ("close my AgentX task"), and open tasks
count against the same limit as your Slack threads (3 at a time unless your admin changed it).

## When something goes wrong

Every AgentX error says what to do next. The common ones:

- `SIGN_IN_REQUIRED`: run `npx @charterarc/agentx login <your AgentX URL>`.
- `PROJECT_ACCESS_DENIED`: join one of the project's Slack channels, or ask an admin.
- `WORKSPACE_LIMIT`: close a task you no longer need.
- `UPGRADE_REQUIRED`: run `npx -y @charterarc/agentx@latest mcp install --client <your tool>`.
````

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/mcp-install.test.ts tests/contract/cli-main.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/mcp/install.ts packages/cli/src/main.ts docs/mcp-install.md tests/contract/mcp-install.test.ts
git commit -m "feat(cli): agentx mcp install and the install guide (spec 025 FR-043, FR-047)"
```

---
### Task 18: Record the rulings in the spec

This task changes no code. It writes the Owner decisions of 2026-09-28 into the spec, exactly as
recorded above (decision 6 as changed), so the spec and the code agree.

**Files:**
- Modify: `specs/025-mcp-server/spec.md`
- Modify: `specs/025-mcp-server/plans/README.md`

- [ ] **Step 1: Amend the spec with the Owner decisions of 2026-09-28**
  - FR-020 (decision 2): add "A task stores the counters it charged and its close releases those.
    An environment without a Slack team ID counts developer tasks on `DEVELOPER_LIMIT#ORGANIZATION`,
    with the same limit."
  - FR-030 (decisions 6, 7, 8): `agentx_list_projects` drops "description";
    `agentx_open_pull_request`'s output becomes "the publish operation's ID and status, at once;
    the PR URL appears in `agentx_get_task` once published"; `agentx_close_task`'s output becomes
    "the task with `closing` while AgentX checks for unpublished work, at once; `agentx_get_task`
    then shows `CLOSED`, or `unpublished` with each repository and why"; add "Only
    `agentx_start_task`, `agentx_continue_task` and `agentx_wait_for_task` wait"; `agentx_whoami`'s
    admin field is "whether this computer holds an unexpired admin sign-in for the environment".
  - FR-037 (decision 3): "Each action writes an `accepted` record in its own transaction, and each
    task or publish operation a `completed` record, holding the result summary, when it ends; a
    start refused after its request parses writes a `refused` record."
  - FR-049 (decision 4): add the row `INVALID_REQUEST` | the control plane refuses the input (a
    reused request ID, instructions over 65,536 bytes, a malformed ID) | fix the input the message
    names.
  - Add to the close edge cases (decision 5): "Closing a task with unpublished work is refused,
    naming each repository and why; there is no force flag."
  - FR-053 (decision 1): "The broker reads the setting from phase 25b on, for Slack threads and
    developer tasks; its fields are `perPerson` and `perOrganization`. Phase 25e adds the change
    tool that writes it."
  - SC-009 (decision 9): "The developer task contract tests pass with an `ec2-ebs` runtime binding,
    and no developer task code reads the deployment mode." Update Context item 11 ("`ec2-ebs` is
    the only worker mode since #118 and #134") and the Testing line "the same developer task flow
    with an AgentCore runtime binding and an `ec2-ebs` one".
  - SC-008 (decision 12): "no assertion removed or weakened; lists of commands, error codes and
    constants gain the new entries, and `DEVELOPER_API_VERSION` moves to 1.1".
  - Assumptions (decision 11): "Rolling back to a release before 25b needs a project revision
    without `developerTasks` first; the release notes say so."
  - Decisions: add **D18** (R2 and R3: three records beside an ordinary workspace, and the first
    task queued in the prepare's result transaction), **D19** (R12: the three audit stages) and
    **D20** (R22: the PR and close tools return at once; the AI tool checks back), each one
    paragraph, marked owner-confirmed, 2026-09-28.
- [ ] **Step 2: Update the phase README.** 25b's row: "Built, see PR #<n>." at the start of "What
  it delivers". (The 25e row, decision 1, and the 25c follow-up, decision 10, were amended with
  this plan.)
- [ ] **Step 3: Check the copy** with `grep -c "$(printf '\342\200\224')" specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md` (prints 0 for each), then commit:

```bash
git add specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md
git commit -m "docs(spec-025): record the phase 25b rulings"
```

---

### Task 19: Live check in a throwaway environment (owner present)

This task changes no code unless it finds a defect. A defect is fixed with a failing test first,
then reviewed. It tests the real flow: Claude Code, then `agentx mcp`, then a task on a test
project, then a reply. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for account 944937319445 (`aws login --profile agentx-admin`, driven from
  this session, or CloudShell), because the access stack creates IAM roles;
- a Slack workspace, a GitHub organization or account, and a test repository the owner names for
  testing. Never production's Slack app, GitHub App, stacks, secrets or `/agentx/production/*`;
- Claude Code on the owner's machine, and Codex or Cursor if the owner has them.

It uses a new environment, `live25b`, in `us-east-1`.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release and pack the CLI from this branch:
    `npm run release:build -- --version 0.0.4 --out <scratch>/rel` and
    `npm run release:pack-cli -- --version 0.0.4 --out <scratch>/cli`.
  - Read production's image digests, read-only, exactly as 25a's live check did.
  - Confirm `aws ssm get-parameters-by-path --path /agentx/live25b --recursive --region us-east-1`
    returns nothing, and that no EC2 instance or volume is tagged for `live25b`.
- [ ] **Step 2: Owner approval.** Tell the owner:
  - what it creates: six stacks, a GitHub App and a Slack app in their test organization and
    workspace, a KMS RSA key, the sign-in table, and EC2 worker instances and volumes while tasks
    run;
  - the cost while it exists: about $3 a day for the stacks (25a's figure), the KMS key at $1 a
    month prorated, and the EC2 time of each task (Step 8's 20 starts create 20 short-lived
    workspaces; the owner may choose fewer);
  - that everything is torn down in Step 12.
- [ ] **Step 3: Install with Slack sign-in.**
  `node packages/cli/dist/main.js --env live25b init --region us-east-1 --release <scratch>/rel --worker-image <worker digest ref> --slack-image <slack digest ref>`,
  taking Slack at the `developer-signin` step. Then, as admin (`agentx --env live25b login
  --admin` with a Cognito admin user), register a test project on the owner's test repository
  with an `ec2-ebs` binding and no `developerTasks` (the defaults), and bind a test channel with
  `agentx --env live25b admin slack bind`. The developer's Slack user joins that channel.
- [ ] **Step 4: Developer sign-in and Claude Code.** On a machine or profile without AWS
  credentials in the environment:
  - `node <scratch>/cli/package/bin/agentx.mjs login <ApiEndpoint>`; `whoami` lists the project
    "you are in its Slack channel";
  - add the server to Claude Code. The package is not published, so use the packed file in place
    of `npx`: `claude mcp add --scope user agentx-live25b -- node <scratch>/cli/package/bin/agentx.mjs mcp`.
    Also run `node <scratch>/cli/package/bin/agentx.mjs mcp install --client claude-code --print`
    and check that it prints the `npx -y @charterarc/agentx@0.0.4 mcp` form;
  - start a new Claude Code session: `/mcp` lists `agentx-live25b` with ten tools.
- [ ] **Step 5: Hand off, move on, come back (US1).** In Claude Code, ask:
  1. "list my AgentX projects": the test project, with its channel's name;
  2. "have AgentX add a line 'Checked by AgentX live check' to the README of <project>, run its
     tests, and tell me when it is done": `agentx_start_task` answers `STARTING` with a task ID in
     under 5 seconds (time it);
  3. keep working on something else for a minute, then "how is my AgentX task doing?":
     `agentx_get_task` shows `RUNNING` with progress, then `SUCCEEDED` with the summary and the
     changed file;
  4. "continue it: also add the date to that line": a second run in the same workspace;
  5. "open a draft pull request": `agentx_open_pull_request` answers at once with the started
     operation; a minute later, "is the PR ready?" makes Claude Code call `agentx_get_task`, which
     lists the PR's URL. On GitHub, the PR is a draft and its body ends "Requested by `<name>` via AgentX, started from Claude Code". If it
     says "an AI tool", Claude Code's `clientInfo.name` did not match R25's pattern: record the real
     name (from `claude --debug`), fix the pattern with a failing test, and rerun;
  6. "close the task": `agentx_close_task` answers at once with `closing`; checking back with
     `agentx_get_task` shows `CLOSED`, and the limit is back to 0 open workspaces for the developer.
     On a second task with uncommitted changes, the close is refused and `agentx_get_task` lists the
     repository and why.
- [ ] **Step 6: Wait (US2).** Ask for a small task with a wait ("have AgentX run the tests of
  <project> and wait for the result"): the call shows progress and returns the finished task. Then
  start a longer one and "wait 5 seconds for it": the result says the wait ended first, and the task
  keeps running. Close both.
- [ ] **Step 7: The errors, live.**
  - "start a task on project nope": `PROJECT_NOT_FOUND`.
  - With a second Slack test user who is not in the channel, signed in on another profile:
    `PROJECT_ACCESS_DENIED` naming the channel.
  - "start a task and share it to the channel": `CHANNEL_REQUIRED`, not yet available.
  - Start tasks until the fourth: `WORKSPACE_LIMIT`, listing the open tasks. Close them.
- [ ] **Step 8: SC-002, 20 starts.** Raise the limits for the measurement with the setting (R7),
  under the admin session:
  `aws dynamodb put-item --table-name <StateTableName> --item '{"pk":{"S":"SETTINGS"},"sk":{"S":"WORKSPACE_LIMITS"},"perPerson":{"N":"25"},"perOrganization":{"N":"30"},"updatedBy":{"S":"live-check"},"updatedAt":{"S":"<now>"}}' --region us-east-1`.
  Save this as `<scratch>/latency.mts` and run it with
  `node --import tsx <scratch>/latency.mts <scratch>/cli/package/bin/agentx.mjs <project>`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [cli, project] = process.argv.slice(2);
const client = new Client({ name: "claude-code", version: "live-check" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli!, "mcp"], stderr: "pipe" }));
const times: number[] = [];
const ids: string[] = [];
for (let index = 0; index < 20; index += 1) {
  const started = Date.now();
  const result = await client.callTool({ name: "agentx_start_task", arguments: { project, instructions: `Print the date. Live check ${index}.` } });
  times.push(Date.now() - started);
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  ids.push(String((result.structuredContent as { task_id: string }).task_id));
}
const sorted = [...times].sort((left, right) => left - right);
console.log(JSON.stringify({ p95: sorted[18], max: sorted[19], times }));
for (const task_id of ids) await client.callTool({ name: "agentx_cancel_task", arguments: { task_id } });
await client.close();
```

  Expected: `p95` under 5,000 ms. Then, once each workspace is prepared, close the 20 tasks
  (Claude Code: "close all my AgentX tasks"), and delete the setting item. The limits fall back to
  3 and 20 at once, with no stack update (FR-053).
- [ ] **Step 9: Codex and Cursor (US7), if the owner has them.** `agentx mcp install --client codex`
  and `--client cursor`: each prints what it changed, the other entries are untouched (compare
  with the `.agentx-backup` file), and "list my AgentX projects" works. Replace the `npx` command
  with the packed file in the written entry for this check, as in Step 4. Otherwise record that US7
  scenario 2 rests on the contract tests.
- [ ] **Step 10: Audit (SC-003).** `agentx --env live25b admin turns export --since <check start>`
  lists `origin: "ai_tool"` records for every start, continue, pull request, cancel and close, with
  `accepted` and `completed` phases and the client name, each within 60 seconds of its action.
- [ ] **Step 11: No secret leaked (SC-004).**
  - `grep -r` over `~/.agentx`, `~/.codex`, `~/.cursor`, the saved terminal log and the MCP
    server's stderr (captured by `latency.mts`; add `transport.stderr?.pipe(createWriteStream(...))`
    if needed) for `agxr_`, `xoxb-`, `Bearer ` and `eyJ`: nothing.
  - For each pattern, `aws logs filter-log-events --log-group-name <broker log group> --filter-pattern '"agxr_"' --region us-east-1`:
    no events. Repeat for the DeveloperIdentity log group.
- [ ] **Step 12: Tear down.** Give the owner these commands, run under the admin session:
  1. On this machine: `claude mcp remove --scope user agentx-live25b`; restore the Codex and
     Cursor files from their `.agentx-backup` copies; `agentx --env live25b logout`; delete the
     Keychain items the CLI stored (service `dev.agentx.cli`) for the `live25b` issuers.
  2. Close any task still open. Terminate every EC2 instance and delete every volume tagged for
     `live25b` (the environment tag the runtime stack sets), waiting until none is listed.
  3. Delete the stacks and what they retain exactly as 25a's Step 9 did (termination protection
     off; reverse order; the retained user pool, buckets, tables, log groups; the KMS keys'
     deletion scheduled).
  4. Force-delete the `agentx/live25b/*` secrets and the `/agentx/live25b/*` parameters, as in 25a.
  5. Close the test PR and delete its branch; delete the GitHub App and the Slack app.
  6. Confirm that no `agentx-live25b-*` stack is listed, `/agentx/live25b` is empty, and no
     `live25b` instance or volume remains.
- [ ] **Step 13: Record the evidence** in the PR description: the commands, outcomes and timings
  (SC-001's steps, SC-002's `p95`), the real `clientInfo.name` of each client used, each defect
  fixed, and any finding that changes a ruling above. Raise those with the owner before merge.

## Not in this phase

- **Phase 25c:** sharing: `share_to_channel` and `share_mode` taking effect, `agentx_share_task`,
  `POST /v1/dev/tasks/{taskId}/share`, the `DeveloperTaskNotifier`, the shared thread record, the
  ingress notice, continue-mode turns on the task's workspace, `TASK_BUSY` naming the teammate
  driving a task, `CHANNEL_AMBIGUOUS`, and the Slack limit reply counting AI-tool tasks (Owner
  decision 10). 25b leaves the `shared: false` fields and accepts the request fields, nothing more.
- **Phase 25d:** the admin read routes and tools, the admin token in the MCP server's tool list,
  `notifications/tools/list_changed`, and `agentx_admin_turns`'s `task_id` filter.
- **Phase 25e:** pending changes and confirmations; `agentx_admin_set_workspace_limits`, which
  writes the setting 25b reads; grants and revocations; the change audit with trace IDs through
  every step (25b already sends `x-agentx-trace-id` on every call).
- **Phase 15e:** `agentx doctor`, and `agentx config set limits.workspacesPerMember|limits.workspacesPerOrg`.
- **Later, by owner decision:** the hosted MCP endpoint; developer sign-in and tasks on the legacy
  production deployment; connector tools offered directly to AI tools.

## Self-review

- **Spec coverage.** FR-014: Tasks 1, 7. FR-016: Tasks 7, 8, 10, 11, 12 (`share` is 25c). FR-017:
  Tasks 4, 8. FR-018: Tasks 8, 9. FR-019: Tasks 6, 8, 9, 11 (each asserts the prompt byte for
  byte). FR-020: Tasks 5, 8, 12. FR-021: Tasks 6, 11, 12. FR-022: Tasks 1, 6. FR-023: Tasks 4, 6,
  11. FR-024: Task 10's check. FR-025: Tasks 2, 4, 10. FR-026: Task 16. FR-027: Tasks 14, 15.
  FR-028: Task 15 (developer tools only; the admin parts are 25d and 25e). FR-029: Task 15, plus
  broker-side redaction in Tasks 4 and 10. FR-030 (developer tools): Task 15, except
  `agentx_share_task` (25c). FR-033: Tasks 2, 8. FR-036: Tasks 8, 10. FR-037: Tasks 3, 4, 8, 11, 13.
  FR-043, FR-047: Task 17. FR-048 (MCP side): Task 15. FR-049: Tasks 7, 8, 14, 15. FR-053's read:
  Task 5. US1, US2: Task 16's flow and Task 19; US7 scenarios 1, 2 and 5: Tasks 15, 17, 19.
  SC-002 and SC-003: Task 19; SC-004: Tasks 10, 14, 15, 19; SC-009: Task 10's check (Owner decision
  9); SC-010: Task 15.
- **Placeholder scan.** No step says "handle errors" or "similar to"; every code step shows the
  code. The places that say "unchanged" name the exact lines they leave alone (Task 5 Step 4,
  Task 6 Step 6, Task 9 Step 3).
- **Type consistency.** `DeveloperTaskActions` (Task 6) is the only way the routes reach the
  handlers; its method names are used as defined in Tasks 8 to 12. `taskView(deps, task,
  { events, details })` is defined in Task 8 and extended in Task 10. `DeveloperTaskRecord`,
  `DeveloperTaskPointerRecord`, `WorkspaceCharge` and the key helpers are Task 4's, used unchanged
  after. The wire shapes (Task 2) are camelCase; the tool outputs (Task 15) are snake_case, and
  `taskOutput` is the one place that converts.
- **Review Focus.** Each of the five lines has its test in the owning task: 1 in Task 9, 2 in
  Task 15, 3 in Task 8 (and the MCP side in Task 15), 4 in Task 3, 5 in Task 17.
- **Owner decision 6, rechecked.** No tool but `agentx_start_task`, `agentx_continue_task` and
  `agentx_wait_for_task` waits or returns `timed_out`: `repeatUntil` and the 120-second constant are
  gone from Task 15; the PR and close tools call AgentX once, and their tests assert one call and no
  `timed_out`. Checking back works because Task 2's view carries `unpublished`, Task 12 fills it
  from the refused preflight (with a test through `GET /v1/dev/tasks/{taskId}`), Task 10 already
  lists `pullRequests`, and Task 15's `taskOutput` maps both. The idempotent repeat of the PR and
  close routes (Tasks 11 and 12) stays, as retry safety, not as a wait. Task 16's flow test and Task
  19's live steps check back with `agentx_get_task`. R21's task wait is unchanged.
