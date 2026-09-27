# Feature Specification: AgentX MCP Server

**Feature Branch**: `spec/025-mcp-server`
**Created**: 2026-09-27
**Status**: Draft for review
**Input**: The owner's decisions of 2026-09-27 (developer hand-off first, then admin tools; private
by default with share to channel; Sign in with Slack and company sign-in; confirmed admin changes),
the owner's later decisions on the laptop-first MCP server and the developer task flow, and a code
reading of mainline at `6f6acf9`.
**Constitution**: Version 2.1.0. This feature needs an amendment to Principles I, II and III
(FR-050). The amendment ships in phase 25a, before any `/v1/dev/*` route is deployed.

## Context

Developers already work in AI coding tools: Claude Code, Codex and Cursor. Today they cannot reach
AgentX from there. To hand AgentX a task they switch to Slack, restate the context, and come back.
Admins also run AgentX from a terminal with `agentx admin ...` commands, and read turn records as
exported JSON.

This spec adds an MCP server so both can use AgentX from their AI tool:

- **Developers** hand off a coding task. The developer's own AI tool writes the instructions, and
  AgentX runs them in a remote workspace, without AgentX's Slack orchestrator model. The developer
  moves on, or waits for a small task, and opens a pull request when it is ready.
- **Admins** look at AgentX (health, failures, turn records, usage, projects, channels) and change
  it (project revisions, channel bindings, credentials, workspaces). Every change needs a
  confirmation that the AI model cannot give itself.

The MCP server runs on each developer's laptop first: `npx @charterarc/agentx mcp`, a stdio server
inside the existing CLI package, talking to the company's control plane. A hosted MCP endpoint on
the control plane comes in a later phase and uses the same tool definitions.

What the code does today, and what this spec has to change:

1. **The control plane serves only admins and the Slack orchestrator.** It is one API Gateway HTTP
   API (`infra/lib/control-plane.ts`). `ANY /{proxy+}` sits behind one JWT authorizer with a single
   issuer (the admin Cognito or OIDC issuer). `/v1/service/*` is behind IAM, and only the Slack
   orchestrator role may call it. `/v1/internal/*` and the Slack routes have no authorizer and check
   their own signatures.
2. **Developer routes are refused on purpose.** In `packages/broker/src/aws/broker.ts`, any JWT
   route other than `/v1/admin/*` is refused with "AgentX developer workflows run in the project's
   Slack channel". This is spec 008's Slack-only decision. The task, operation, event, artifact,
   pull-request and cancel handlers exist, but only behind `/v1/service/workspaces/{id}/...`.
3. **Workspaces are owned by an owner key.** The owner key is `sha256(issuer, subject)`. For Slack,
   the issuer is `slack-thread` and the subject is `team/channel/threadTs`. There is one default
   workspace per owner key and project (`OWNER#{ownerKey}` / `PROJECT#{project}`), so each Slack
   thread gets its own workspace.
4. **Project membership is checked on every task route.** `requireMembership` runs before tasks,
   operations, events, artifacts and connector calls. A thread's owner key gets a `developer`
   membership when its workspace is created. Admin routes need both the admin claim and an
   `administrator` membership on the project.
5. **Several records are Slack-shaped.** `Operation.requestedBy` is a Slack requester. A turn record
   needs a Slack event ID (`Ev...`) and a Slack `requestedBy`, and is keyed `THREAD#{subject}`. The
   connector attribution footer is built only from a Slack identity.
6. **The environment does not record its own Slack team.** Channel bindings carry a team ID, but no
   setting names the one Slack workspace the environment serves.
7. **Only the Slack ingress and the Slack orchestrator can read the Slack secret.** The broker cannot
   post to Slack.
8. **Sign in with Slack needs a server.** Slack's OpenID Connect token endpoint
   (`https://slack.com/api/openid.connect.token`) requires the app's client secret, and its ID
   tokens live about five minutes. A laptop CLI cannot hold the client secret, so it cannot sign in
   with Slack on its own.
9. **There are no list routes** for projects, channel bindings, workspaces or failed operations, and
   no health route. The CLI calls only `/v1/admin/*` and signs in with OIDC PKCE
   (`packages/cli/src/auth.ts`).
10. **There is no MCP server code.** `packages/gateway` and `packages/broker/src/github-mcp.ts` are
    MCP clients.
11. **Two worker modes run side by side.** AgentCore and Pratik's EC2 workers (`ec2-ebs`, specs 018
    to 024) are chosen by the project's runtime binding. Issue #88 plans to remove AgentCore.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hand Off a Task From Claude Code and Move On (Priority: P1)

A developer is in Claude Code, working on `payments-api`. They say "have AgentX fix the flaky retry
test in payments-api and open a PR when it passes". Claude Code writes clear instructions and calls
`agentx_start_task`. AgentX answers at once with a task ID. The developer keeps working. Later they
ask "how is my AgentX task doing?", see that it finished, read the summary, and ask for the PR.

**Why this priority**: It is the owner's first decision: developer hand-off comes first. Every other
story builds on the developer API, the sign-in and the MCP server it needs.

**Independent Test**: With a signed-in developer, a fake control plane and a fake worker, drive the
MCP server over stdio: start a task, read its status until it ends, read the result, and open a
pull request. Then do the same live against a throwaway environment (see Testing).

**Acceptance Scenarios**:

1. **Given** a signed-in developer with access to `payments-api`, **When** their AI tool calls
   `agentx_start_task` with the project and instructions, **Then** the call returns within 5 seconds
   with a task ID and status `STARTING`, and a private workspace starts preparing.
2. **Given** a started task, **When** the workspace is ready, **Then** the instructions go to the
   worker exactly as the developer's tool wrote them, with no AgentX model in between.
3. **Given** a running task, **When** the developer calls `agentx_get_task`, **Then** they see the
   status, the latest progress events and, once it ends, the summary and changed files.
4. **Given** a finished task with changes, **When** the developer calls
   `agentx_open_pull_request`, **Then** AgentX opens the PR through the existing publication path,
   and the result gives the PR URL.
5. **Given** a finished task, **When** the developer calls `agentx_continue_task` with more
   instructions, **Then** they run in the same workspace, on the same branch.
6. **Given** another developer, **When** they ask for this task by ID, **Then** they are told the
   task was not found.

---

### User Story 2 - Wait for a Small Task (Priority: P2)

A developer asks for something small: "have AgentX run the payments test suite and tell me what
fails". Their AI tool starts the task with `wait_seconds: 300`. The tool call stays open, shows
progress, and returns the result when the task ends.

**Why this priority**: The owner chose "hand off and move on" as the default, with waiting as an
option. It reuses everything in User Story 1.

**Independent Test**: With a fake worker that ends after 20 seconds, call `agentx_start_task` with
`wait_seconds: 60` and check that the result holds the final status and that progress notifications
were sent. With a worker that takes 90 seconds, check that the call returns at 60 seconds with
`timed_out: true` and the task still running.

**Acceptance Scenarios**:

1. **Given** `wait_seconds` of 1 to 600, **When** the task ends before that, **Then** the call
   returns the finished task.
2. **Given** the task is still running when the wait ends, **When** the call returns, **Then** it is
   not an error: it says `timed_out: true`, gives the task ID and current status, and the task keeps
   running.
3. **Given** the client sent a progress token, **When** the call is waiting, **Then** the server
   sends a progress notification at least every 15 seconds.
4. **Given** the client cancels the tool call, **When** the server sees the cancellation, **Then** it
   stops waiting and the task keeps running.

---

### User Story 3 - Share a Task to the Channel; Admins Can Require Sharing (Priority: P2)

A developer starts a task with `share_to_channel: true`. AgentX posts in the project's Slack
channel: "@Maya started a task from Claude Code: Fix the flaky retry test". It adds replies as the
task runs, ends, and opens a PR. For the `ledger` project, the admin has turned on required sharing
for compliance, so every task started from an AI tool is shared, whatever the developer asks.

**Why this priority**: Tasks are private by default (owner decision 3), so sharing is what keeps the
team aware. Required sharing is a compliance need, but only for some projects.

**Independent Test**: With a fake Slack API, start a shared task and check the thread's messages
through the task's life. Register a revision with required sharing, start a task with
`share_to_channel: false`, and check that it is shared and that the result says why.

**Acceptance Scenarios**:

1. **Given** `share_to_channel: true` and a project with one bound channel, **When** the task
   starts, **Then** AgentX posts the start message in that channel within 10 seconds and replies in
   its thread at each status change listed in FR-032.
2. **Given** a project with required sharing, **When** a developer starts a task without asking to
   share, **Then** the task is shared, and the result says `shared: true` with the reason
   `required by project`.
3. **Given** a private task, **When** it runs, **Then** nothing is posted in Slack, and the task
   still has a turn record admins can read.
4. **Given** a shared task's thread, **When** someone mentions AgentX in a reply there, **Then**
   AgentX answers with a fixed notice (at most once an hour per thread) that the task belongs to the developer's AI tool and that a new message in the
   channel starts a new thread workspace.
5. **Given** a private task, **When** the developer calls `agentx_share_task`, **Then** the thread is
   started with the current status, and later updates follow.

---

### User Story 4 - Sign In With Slack or the Company's Sign-In (Priority: P1)

A developer runs `npx @charterarc/agentx login https://agentx.example.com`. The browser opens a
page that offers the methods the company enabled: "Sign in with Slack" (the default) and "Sign in
with Okta". They pick one, approve, and return to the terminal, which says who they are and which
projects they can use. They never sign in again until the sign-in expires.

**Why this priority**: Nothing in User Stories 1 to 3 works without it.

**Independent Test**: Against fake Slack and fake OIDC providers, run the login flow end to end:
the control plane exchanges the provider's code, checks the Slack team, and issues AgentX tokens to
the CLI's loopback listener; the developer API accepts the token. A token from another Slack team is
refused.

**Acceptance Scenarios**:

1. **Given** Slack sign-in is enabled, **When** a member of the environment's Slack workspace signs
   in, **Then** the CLI stores an AgentX access token and refresh token, and `agentx whoami` shows
   their Slack name and the projects they can use.
2. **Given** a person signs in with Slack from another Slack workspace, **When** the control plane
   checks the ID token, **Then** it refuses the sign-in, and no token is issued.
3. **Given** company sign-in is enabled with a required group, **When** a person outside that group
   signs in, **Then** the sign-in is refused and says which group is required.
4. **Given** the access token has expired and the refresh token is valid, **When** the MCP server
   calls the control plane, **Then** it refreshes silently.
5. **Given** the refresh token is expired or revoked, **When** a tool is called, **Then** the result
   is `SIGN_IN_REQUIRED` with the exact command to run.
6. **Given** a Slack member who is in the bound channel of `payments-api`, **When** they sign in,
   **Then** they may use `payments-api` without any admin action.

---

### User Story 5 - An Admin Looks at AgentX From an AI Tool (Priority: P2)

An admin asks Claude Code "is AgentX healthy, and what failed yesterday?". The AI tool calls
`agentx_admin_health` and `agentx_admin_failed_tasks`. It shows that two tasks failed because
workspace preparation timed out on one project, and a third because a Linear credential was
rejected. The admin then asks for last week's usage by project and the turn records of one thread.

**Why this priority**: It is half of the admin decision, and it is safe: reads change nothing. It
comes after developer hand-off.

**Independent Test**: Against a fake control plane with seeded operations, turn records and alarms,
call each admin read tool and compare the result with a committed snapshot. Call each one with a
developer's token and check that it is refused.

**Acceptance Scenarios**:

1. **Given** a signed-in admin, **When** they call any admin read tool, **Then** it answers with no
   confirmation.
2. **Given** a developer who is not an admin, **When** the admin tools are listed, **Then** none are
   offered, and a direct call is refused with `ADMIN_REQUIRED`.
3. **Given** failures in the last 24 hours, **When** the admin calls `agentx_admin_failed_tasks`,
   **Then** each failure shows the project, origin (Slack or AI tool), who asked, when, the failure
   category and the redacted error text.
4. **Given** any admin read, **When** the result is built, **Then** it contains no secret value.

---

### User Story 6 - An Admin Changes AgentX From an AI Tool (Priority: P2)

An admin tells Codex "bind #ledger-dev to the ledger project". Codex calls
`agentx_admin_bind_channel`. Before anything changes, the admin sees exactly what will happen:
"Bind channel #ledger-dev (C0123) to project ledger. It is bound to nothing today. New threads in
#ledger-dev will use ledger revision 7." The admin confirms in a way the model cannot answer for
them, and only then does the change apply.

**Why this priority**: It completes the admin decision. Changes are riskier than reads, so they come
last and carry the confirmation machinery.

**Independent Test**: For each change tool, against a fake control plane: the call returns a plan
and changes nothing; applying without a valid confirmation changes nothing; each confirmation method
(elicitation, Slack button, one-time code) applies it exactly once; an expired or reused
confirmation is refused.

**Acceptance Scenarios**:

1. **Given** a change tool call, **When** the control plane receives it, **Then** it stores a
   pending change with the exact effect and changes nothing yet.
2. **Given** an MCP client that declared the elicitation capability, **When** the change needs
   confirmation, **Then** the server shows the effect in an elicitation form, and the change applies
   only if the person accepts.
3. **Given** a client without elicitation and an admin linked to a Slack user, **When** the change
   needs confirmation, **Then** AgentX sends that admin a Slack direct message with the effect and a
   Confirm button, and the change applies only when that same Slack user presses it.
4. **Given** neither of those, **When** the change needs confirmation, **Then** the tool result gives
   a confirmation link, the admin opens it and signs in again, the page shows the effect and a
   one-time code, and the change applies only when the admin types that code into the AI tool.
5. **Given** a session where no confirmation method is available, **When** tools are listed,
   **Then** only the admin read tools are offered.
6. **Given** a pending change, **When** 10 minutes pass or the state it planned against changes,
   **Then** it can no longer be applied, and the admin is told to ask again.

---

### User Story 7 - Install and Set Up (Priority: P1)

A developer adds AgentX to their AI tool with one command, and signs in once. An admin chooses,
during `agentx init` or later, whether developers sign in with Slack, the company's sign-in, or
both.

**Why this priority**: Without a short setup, developers will not try it.

**Independent Test**: On a clean machine with Node 22 and each AI tool installed, follow the install
guide for Claude Code, Codex and Cursor, then ask the tool to list AgentX projects.

**Acceptance Scenarios**:

1. **Given** Claude Code, **When** the developer runs
   `claude mcp add --scope user agentx -- npx -y @charterarc/agentx mcp` and
   `npx @charterarc/agentx login <url>`, **Then** the next Claude Code session lists the AgentX
   tools and `agentx_list_projects` answers.
2. **Given** Codex or Cursor, **When** the developer runs `npx @charterarc/agentx mcp install
   --client codex` (or `cursor`), **Then** the tool's MCP configuration gains an `agentx` entry, and
   the command prints what it changed.
3. **Given** `agentx init`, **When** it reaches the developer sign-in step, **Then** it asks which
   methods to enable (Slack by default), sets up Slack's redirect URL and scopes in the Slack app
   manifest, and for company sign-in asks for the issuer, client ID, client secret and optional
   required group.
4. **Given** an installed environment, **When** an admin runs `agentx signin enable oidc ...` or
   `agentx signin disable slack`, **Then** the change shows what it will do, applies after
   confirmation, and `agentx doctor` checks the enabled methods.
5. **Given** an MCP server whose version differs from the control plane's, **When** it starts,
   **Then** every tool still works if the API version is compatible, and `agentx_whoami` shows a
   notice to upgrade; if the API version is not compatible, every tool returns `UPGRADE_REQUIRED`
   with the command to run.

### Edge Cases

- **A developer with no Slack account signs in with the company's sign-in.** Their verified email
  matches no Slack user. They can use only projects an admin granted them. Shared threads name them
  by their display name, as plain text.
- **A developer leaves the bound channel.** Their next task start is refused for that project
  (membership is checked at each start, with a cache of at most 10 minutes). Tasks already running
  keep running, and the developer can still read them and open their PRs.
- **A Slack user is deactivated.** Their next token refresh fails, and their tasks keep running.
- **The Slack token is revoked or Slack is down.** Slack sign-in and channel-membership checks fail
  closed with `SLACK_UNAVAILABLE`. Explicit grants still work. A shared task still runs; its missing
  Slack posts are retried for 1 hour and then recorded as failed deliveries.
- **The project has several bound channels.** `share_to_channel` then needs `channel`; with one
  channel it is chosen. Channel-membership access counts any bound channel.
- **Required sharing, but the project has no bound channel.** The task start is refused with
  `CHANNEL_REQUIRED`, and nothing starts.
- **The developer reaches the workspace limit.** The start is refused with `WORKSPACE_LIMIT`,
  listing the developer's open tasks so they can close one.
- **Two starts with the same client request ID** (a retried tool call). The second returns the first
  task; nothing runs twice.
- **The project gets a new revision while a task runs.** The task keeps its starting revision, like a
  Slack thread; `agentx_continue_task` uses it too.
- **The worker is interrupted** (process loss, EC2 instance replaced). The task ends `INTERRUPTED`
  with the reason; `agentx_continue_task` resumes it through the existing recovery path.
- **The MCP client times out before `wait_seconds` ends.** The task keeps running; the developer
  reads it with `agentx_get_task`.
- **A pending admin change goes stale.** The state it was planned against changed (a newer project
  revision, a changed binding). Applying it is refused with `CHANGE_STALE`.
- **An admin presses a Slack Confirm button for another admin's change.** It is refused, and the
  change stays pending.
- **The same laptop is signed in to two environments.** Each environment keeps its own tokens; the
  MCP server uses the environment named by `--env` or the default set by `agentx login`.
- **Enterprise Grid.** A Slack sign-in whose team ID is another team in the same Grid organization is
  refused; only the environment's own team is accepted.

## Requirements *(mandatory)*

### Functional Requirements

**Developer sign-in (US4, US7)**

- **FR-001**: The control plane MUST act as the sign-in server for developers. It MUST offer an
  OAuth 2.1 authorization code flow with PKCE (`S256` only) to one public client, `agentx-cli`,
  whose only allowed redirect URIs are `http://127.0.0.1:<port>/callback` on any port. Routes:
  `GET /v1/auth/authorize`, `POST /v1/auth/token`, `GET /v1/auth/callback/slack`,
  `GET /v1/auth/callback/oidc`, `GET /v1/auth/.well-known/openid-configuration`,
  `GET /v1/auth/.well-known/jwks.json` and `GET /v1/auth/.well-known/agentx-configuration`.
- **FR-002**: `GET /v1/auth/authorize` MUST show a page with the enabled methods, or go straight to
  the only enabled one. It MUST send the browser to the chosen provider with its own state and
  nonce, and on the provider's callback MUST exchange the code server side, using the client secret
  held in Secrets Manager.
- **FR-003**: For Slack, the control plane MUST verify the ID token against issuer
  `https://slack.com`, the Slack app's client ID as audience, and Slack's published keys. It MUST
  refuse the sign-in unless the claim `https://slack.com/team_id` equals the environment's Slack
  team ID (FR-006). The developer's subject is the claim `https://slack.com/user_id`.
- **FR-004**: For company sign-in, the control plane MUST verify the ID token against the
  configured issuer and client ID. When a required claim and values are configured (for example
  `groups` contains `engineering`), it MUST refuse sign-ins without them. It MUST record the
  `email` claim only when `email_verified` is true.
- **FR-005**: After a successful provider sign-in, the control plane MUST issue:
  - an **AgentX access token**: a JWT signed with ES256 by a KMS key the control plane owns, issuer
    `<api-endpoint>/v1/auth`, audience `agentx-developer`, lifetime 1 hour, with claims `sub` (the
    developer ID, FR-008), `amr` (`slack` or `oidc`) and `env`;
  - a **refresh token**: an opaque random value, stored only as a SHA-256 hash, rotated on each use,
    valid for at most 7 days from the provider sign-in. A reused refresh token MUST revoke the whole
    sign-in session.
- **FR-006**: The environment MUST store its Slack team ID in its settings (`/agentx/<env>/slack/
  teamId`) and pass it to the control plane as the `SlackTeamId` stack parameter. `agentx init`
  MUST take it from the bot token's `auth.test`; `agentx env adopt` and `agentx doctor` MUST read
  it the same way for existing environments. Slack sign-in MUST be refused while it is unset.
- **FR-007**: At each refresh of a Slack-signed-in developer, the control plane MUST check with
  `users.info` that the user still exists, is not deactivated and is in the team; otherwise the
  refresh MUST fail and revoke the session. Company-signed-in developers are checked only at sign-in.
- **FR-008**: A developer's ID MUST be `sha256(provider issuer, provider subject)`, the same function
  as today's owner key (`ownerKeyForSubject`). The control plane MUST keep a developer record with
  the provider, display name, verified email if any, linked Slack user ID if any (FR-012), first and
  last sign-in times, and whether the developer is revoked.
- **FR-009**: The API MUST verify AgentX access tokens with a second API Gateway JWT authorizer
  (issuer `<api-endpoint>/v1/auth`, audience `agentx-developer`) on a new route
  `ANY /v1/dev/{proxy+}`. The `/v1/auth/*` routes MUST have no authorizer. The existing JWT
  authorizer and `ANY /{proxy+}` MUST stay as they are for admins. The broker MUST refuse an
  AgentX developer token on `/v1/admin/*` and an admin token on `/v1/dev/*` by checking the issuer
  and audience again.
- **FR-010**: Each environment MUST enable Slack sign-in, company sign-in, or both. Slack is the
  default. Settings: `signin.slack` (on or off) and `signin.oidc` (issuer, client ID, client secret
  reference, optional required claim and values, display name). The Slack app's client ID and client
  secret MUST be added to the existing `agentx/<env>/slack` secret; the company client secret MUST be
  stored in `agentx/<env>/developer-oidc`. Neither is ever printed.
- **FR-011**: The CLI MUST offer:
  - `agentx login <url>`: reads `/v1/auth/.well-known/agentx-configuration`, stores the
    environment's URL and name in `~/.agentx/developer.yaml`, runs FR-001 with a loopback listener,
    and stores the tokens in the existing system token store. It needs no AWS credentials.
  - `agentx login --admin`: today's admin PKCE login, unchanged.
  - `agentx logout [--admin]` and `agentx whoami`.
  - `--no-browser` on `login`, which prints the link and waits on the loopback listener.

**Project access (US1, US4)**

- **FR-012**: A developer is linked to a Slack user of the environment's team when they signed in
  with Slack, or when their verified email matches one Slack user by `users.lookupByEmail`. The link
  MUST be refreshed at each sign-in.
- **FR-013**: A developer MAY use a project when any of these holds, checked at every task start:
  1. an admin granted them access to the project (a `ProjectMembership` record for their developer
     ID with role `developer`);
  2. the project's `developerTasks.channelMembersMayUse` is true (the default), and their linked
     Slack user is a member of a channel bound to the project, checked with `conversations.members`
     and cached for at most 10 minutes.
- **FR-014**: The project definition MUST accept `developerTasks`, with:
  - `enabled` (default true): whether AI-tool tasks are allowed at all;
  - `share` (`optional` by default, or `required`);
  - `channelMembersMayUse` (default true).

  It is part of the revision, so changing it is a revision registration.
- **FR-015**: Admin tools MUST need an admin token from the admin issuer (today's Cognito or OIDC)
  whose admin claim matches, as today. A Slack or company developer sign-in MUST never grant admin
  rights. Admin change tools on a project MUST also need the admin's `administrator` membership, as
  today.

**Developer task API (US1, US2)**

- **FR-016**: Under `/v1/dev/`, the control plane MUST serve:
  - `GET projects`: the projects the developer may use, with their bound channels and task policy;
  - `POST tasks`: start a task;
  - `GET tasks` and `GET tasks/{taskId}`: list and read the developer's tasks;
  - `POST tasks/{taskId}/continue`, `POST tasks/{taskId}/cancel`, `POST tasks/{taskId}/close`,
    `POST tasks/{taskId}/share` and `POST tasks/{taskId}/pull-requests`;
  - `GET tasks/{taskId}/events`: the task's progress events.
- **FR-017**: Each task MUST own one workspace. The workspace's owner key MUST be
  `sha256("agentx-developer-task", "<developerId>/<taskId>")`, so each task has its own workspace,
  as each Slack thread does, and a developer can run several tasks at once. The control plane MUST
  keep a task index (`DEVELOPER#{developerId}` / `TASK#{createdAt}#{taskId}`) with the project,
  workspace ID, title, client name, status, share state and starting revision.
- **FR-018**: `POST tasks` MUST, in order: check the token; check FR-013 and `developerTasks.enabled`;
  check sharing (FR-031); check the workspace limit (FR-020); create the task index entry, the
  workspace with a `developer` membership for its owner key, and an idempotency record keyed by the
  client's request ID, in one transaction; and return `STARTING` with the task ID. Preparing the
  workspace, creating the conversation and accepting the task (the existing prepare, conversation
  and task handlers) MUST then run through the existing operation, outbox and dispatcher path, with
  no further call from the client.
- **FR-019**: The instructions MUST be sent to the worker as the task prompt, unchanged, with the
  existing 65,536-byte limit. No AgentX model reads, rewrites or plans them. The worker gets the same
  tools and limits as a Slack task's worker.
- **FR-020**: A developer task MUST count against the same workspace limits as Slack threads
  (`limits.workspacesPerMember` and `limits.workspacesPerOrg`). A developer linked to a Slack user
  MUST share that user's counter; an unlinked developer MUST have their own counter with the same
  limit.
- **FR-021**: The task routes MUST reuse the existing handlers for operations, events, artifacts,
  pull requests, pull-request actions and cancellation, reached with the task's owner key. The
  broker's refusal message for other JWT routes (FR-006 of spec 008) MUST stay for everything that
  is neither `/v1/admin/*` nor `/v1/dev/*`.
- **FR-022**: `Operation.requestedBy` MUST accept either a Slack requester or a developer requester
  (`{ kind: "developer", developerId, provider }`). Every operation of a developer task MUST record
  it.
- **FR-023**: Pull requests from a developer task MUST carry the attribution footer
  "Requested by <name> via AgentX, started from <client name>", where the client name follows
  FR-033. The existing Slack footer is unchanged.
- **FR-024**: Developer task routes MUST work the same for every worker mode. No code in this
  feature may branch on the runtime binding's deployment mode.
- **FR-025**: A task's status MUST be one of `STARTING` (workspace preparing), `RUNNING`,
  `SUCCEEDED`, `FAILED`, `CANCELLED`, `INTERRUPTED` or `CLOSED`. A failed or interrupted task MUST
  carry a failure category (`setup_failed`, `worker_unavailable`, `task_failed`, `timed_out`,
  `interrupted`, `publication_failed`) and a redacted message of at most 1,000 characters.

**The MCP server (all stories)**

- **FR-026**: `agentx mcp [--env <name>]` MUST run a stdio MCP server using the official MCP
  TypeScript SDK, pinned. It MUST write only protocol messages to stdout and its logs to stderr, and
  MUST never log a token.
- **FR-027**: The tool definitions (names, descriptions, input and output schemas, handlers written
  against a control-plane client interface) MUST live in one new package, `@agentx/mcp`, that the
  stdio server uses now and the hosted endpoint will use later. Every tool MUST declare an output
  schema and return `structuredContent` plus a short text summary.
- **FR-028**: The server MUST offer the developer tools to every signed-in developer; the admin read
  tools only when an admin token is present; and the admin change tools only when an admin token is
  present and at least one confirmation method is available (FR-041). It MUST send
  `notifications/tools/list_changed` when this changes during a session (for example after
  `agentx login --admin`).
- **FR-029**: Every tool result MUST pass through the contracts package's `redactSecrets` and
  `redactText` before it is returned. Tool results MUST never contain a token, a secret value or a
  secret's contents; a credential appears only as its reference, type and secret name.
- **FR-030**: The tools are:

  **Developer tools**

  | Tool | Inputs | Output |
  |---|---|---|
  | `agentx_whoami` | none | environment, developer name, sign-in method, linked Slack user, admin (yes or no), server and control-plane versions, upgrade notice |
  | `agentx_list_projects` | none | per project: name, description, bound channels, `share` policy, whether tasks are enabled |
  | `agentx_start_task` | `project`; `instructions` (up to 65,536 bytes); `title` (optional, up to 120 characters, else the first line of the instructions); `share_to_channel` (optional, default false); `channel` (optional); `wait_seconds` (optional, 0 to 600, default 0); `request_id` (optional UUID, else generated) | task ID, status, project, starting revision, `shared` and reason, thread link if shared; with a wait, the same as `agentx_get_task` plus `timed_out` |
  | `agentx_get_task` | `task_id`; `events` (optional, 0 to 50, default 10) | status, failure if any, title, project, times, latest events, and once ended: summary (up to 4,000 characters), changed files with line counts, artifacts (name, size), pull requests (URL, state) |
  | `agentx_wait_for_task` | `task_id`; `wait_seconds` (1 to 600) | as `agentx_get_task`, plus `timed_out` |
  | `agentx_list_tasks` | `project` (optional); `status` (optional); `limit` (1 to 50, default 20) | the developer's tasks, newest first: ID, title, project, status, times, shared |
  | `agentx_continue_task` | `task_id`; `instructions`; `wait_seconds` (optional) | as `agentx_start_task` |
  | `agentx_cancel_task` | `task_id` | status after the request |
  | `agentx_close_task` | `task_id` | status `CLOSED`; the workspace is released and stops counting against limits |
  | `agentx_share_task` | `task_id`; `channel` (optional) | thread link |
  | `agentx_open_pull_request` | `task_id`; `title`; `body` (optional); `repository` (optional when the project has one repository); `draft` (optional, default true) | operation status, then PR URL once published |

  **Admin read tools** (no confirmation)

  | Tool | Inputs | Output |
  |---|---|---|
  | `agentx_admin_health` | none | control-plane version; alarm states for the environment's alarms; dead-letter queue depths; Slack token check; GitHub App installation check; per worker mode: whether it is configured and its latest dispatch failure; open workspaces by status |
  | `agentx_admin_failed_tasks` | `since` (default 24 hours ago); `until` (optional); `project` (optional); `limit` (1 to 100, default 25) | per failure: time, project, origin (`slack` or `ai_tool`), requester, workspace ID, operation kind, failure category, redacted error, turn record link |
  | `agentx_admin_turns` | `since`; `until` (optional); `project` (optional); `origin` (optional); `thread` or `task_id` (optional); `limit` (1 to 100); `cursor` (optional) | turn records as `GET /v1/admin/turns` returns them, plus the next cursor |
  | `agentx_admin_usage` | `since`; `until` (optional); `group_by` (`project`, `requester`, `origin` or `day`) | per group: turns, tasks, total task duration, model input and output tokens, and cost in US dollars as the usage records carry it (spec 011) |
  | `agentx_admin_list_projects` | none | per project: latest revision, registration time, repositories, runtime mode, connector names and types, `developerTasks` settings |
  | `agentx_admin_list_channels` | none | per binding: channel ID and name, project, updated time |
  | `agentx_admin_list_credentials` | none | per credential: reference, type, secret name, registered time |
  | `agentx_admin_list_workspaces` | `project` (optional); `status` (optional); `limit` (1 to 100) | per workspace: ID, project, origin, owner (thread link or developer name), status, last activity |

  **Admin change tools** (each returns a plan, then applies only after confirmation, FR-039)

  | Tool | Inputs | What the plan shows |
  |---|---|---|
  | `agentx_admin_register_project_revision` | `definition` (the project definition as an object) | the new revision number and a field-by-field difference from the latest revision, registration preflight findings (spec 013 FR-014) |
  | `agentx_admin_bind_channel` | `channel` (ID or name); `project` | the channel, its current binding, the new project and the revision new threads will use |
  | `agentx_admin_unbind_channel` | `channel` | the channel, its project, and that new messages there will get no reply |
  | `agentx_admin_register_credential` | `ref`; `type`; `secret_name` (under `agentx/connectors/`) | the reference, type and secret name, whether the secret exists, and which projects name the reference. It MUST refuse any input that looks like a secret value. |
  | `agentx_admin_stop_workspace` | `workspace_id` | the workspace, its project, owner, status and any running operation that will be interrupted |
  | `agentx_admin_grant_project_access` | `project`; `developer` (developer ID, email or Slack user) | the developer, the project and their current access |
  | `agentx_admin_revoke_project_access` | `project`; `developer` | the developer, the project, and that running tasks keep running |
  | `agentx_admin_revoke_signin` | `developer` | the developer and their open sign-in sessions, which end at once |
  | `agentx_admin_apply_change` | `change_id`; `code` (optional, the one-time code) | the applied result, or why it was not applied |

- **FR-031**: Sharing: when `share_to_channel` is true or the project's `share` is `required`, the
  task MUST be shared. A shared task needs a bound channel: the named `channel`, or the only bound
  channel; otherwise the start MUST be refused (`CHANNEL_REQUIRED` or `CHANNEL_AMBIGUOUS`) before
  anything starts. When the policy forced sharing, the result MUST say so.
- **FR-032**: A shared task's thread MUST show, and nothing more:
  - the start message: the developer (a Slack mention when linked, else their display name), the
    client name, the title, the project, and a note that follow-ups happen in the developer's AI
    tool;
  - replies when the workspace is ready, when the task ends (status, and the summary up to 1,500
    characters, redacted), when a pull request opens (its URL), and when the task is cancelled or
    closed.

  The instructions beyond the title, events, diffs and artifacts MUST NOT be posted.
- **FR-033**: The client name MUST come from the MCP `initialize` request's `clientInfo.name`,
  mapped to `Claude Code`, `Codex` or `Cursor` for their known names, and otherwise to "an AI tool".
  It MUST be at most 40 characters and cleaned like Slack display names.
- **FR-034**: Slack posts for shared tasks MUST be sent by a new `DeveloperTaskNotifier` function,
  the only new role that may read the Slack secret, triggered by the task's status changes. Failed
  posts MUST be retried for 1 hour and then counted in the failed Slack delivery metric (spec 015
  FR-045).
- **FR-035**: The Slack ingress MUST recognise a shared task's thread (a `SHARED_TASK#{team}/
  {channel}/{threadTs}` record) and answer a mention in it with one fixed notice per hour per
  thread, without creating a thread workspace.

**Visibility and audit**

- **FR-036**: A developer task MUST be visible through `/v1/dev/*` only to the developer who started
  it. Any other caller MUST get `TASK_NOT_FOUND`.
- **FR-037**: Every start, continue, pull-request request, cancel and close of a developer task MUST
  write a turn record. The turn record schema MUST gain `origin` (`slack` or `ai_tool`, absent read
  as `slack`) and, for `ai_tool`, `taskId`, `developer` (`developerId`, provider, display name,
  linked Slack user if any) and `client` in place of the Slack event ID and requester. They MUST be
  keyed `TASK#{taskId}`, keep the 30-day retention, hold the instructions redacted and capped as
  request text and the result summary as response text, and appear in `GET /v1/admin/turns` and
  `agentx_admin_turns`.
- **FR-038**: The control plane MUST index each operation that ends `FAILED` or `INTERRUPTED`
  (`FAILURE#{yyyy-mm-dd}` / `{endedAt}#{operationId}`, 30-day expiry) for `agentx_admin_failed_tasks`.
  It MUST also serve `GET /v1/admin/projects`, `GET /v1/admin/slack/bindings`,
  `GET /v1/admin/workspaces`, `GET /v1/admin/failures`, `GET /v1/admin/usage`,
  `GET /v1/admin/health` and `GET /v1/admin/me` for the admin read tools, with the same admin check as today.

**Admin changes and confirmation (US6)**

- **FR-039**: Every admin change tool MUST call `POST /v1/admin/changes` with the change. The
  control plane MUST check the admin's rights, compute the exact effect against current state, and
  store a pending change: its ID, the admin, the effect text, a hash of the state it was planned
  against, the confirmation methods offered, and an expiry 10 minutes later. Nothing changes until
  `POST /v1/admin/changes/{id}/apply` succeeds.
- **FR-040**: `apply` MUST check, in one transaction, that the change is pending, unexpired, planned
  by the same admin, confirmed by an accepted method, and that the state hash still matches. It MUST
  then apply the change through the existing admin handler, mark it used, and write an audit record
  (admin, change, method, time) kept for 1 year. A change MUST apply at most once.
- **FR-041**: The confirmation methods, in order of preference:
  1. **MCP elicitation**, when the client declared the `elicitation` capability and the environment
     allows it (`mcp.confirm.elicitation`, default on). The server MUST send `elicitation/create`
     with the effect text and one boolean field, and call `apply` only on `accept` with the field
     true.
  2. **Slack Confirm button**, when the admin's verified email claim matches one Slack user of the
     environment's team (the lookup of FR-012). The notifier MUST
     send that user a direct message with the effect and Confirm and Cancel buttons. The Slack
     interactivity route MUST accept a press only from that Slack user, and it marks the change
     confirmed. The tool call waits up to 5 minutes for it, with progress notifications.
  3. **One-time code**, when the environment's `mcp.confirm.codePage` setting is on (default on;
     `agentx init` registers the page's redirect URI with the admin issuer, FR-046). The tool
     result MUST give a link to `GET /v1/confirm/{changeId}`. The page MUST make the admin sign in
     again at the admin issuer (`prompt=login`), check that the ID token's subject is the planning
     admin and its `auth_time` is under 5 minutes old, and then show the effect and a 6-digit code.
     The admin types the code in the AI tool, which passes it to `agentx_admin_apply_change`. The
     code MUST be stored only as a hash, work once, and allow 5 wrong tries before the change is
     cancelled. No route reachable with a bearer token may return it.

  The control plane MUST report which methods it offers in `/v1/auth/.well-known/agentx-configuration`
  and, for the signed-in admin, in `GET /v1/admin/me`; the MCP server combines them with the
  client's capabilities. When no method is available, the change tools MUST not be listed, and a direct call MUST return
  `CONFIRMATION_UNAVAILABLE`.
- **FR-042**: The CLI's existing `agentx admin ...` commands MUST keep working unchanged, without
  this confirmation, because a person types them.

**Install and setup (US7)**

- **FR-043**: `agentx mcp install --client claude-code|codex|cursor [--print]` MUST add an `agentx`
  server entry that runs `npx -y @charterarc/agentx@<version> mcp`, where `<version>` is the
  installed CLI's version: for Claude Code by running `claude mcp add --scope user`; for Codex in
  `~/.codex/config.toml` under `[mcp_servers.agentx]`; for Cursor in `~/.cursor/mcp.json` under
  `mcpServers.agentx`. It MUST not change other entries, MUST show what it changed, and with
  `--print` MUST only print the entry.
- **FR-044**: `agentx init` MUST add a developer sign-in step after the Slack app step: which
  methods to enable (Slack by default); for Slack, the redirect URL `<api>/v1/auth/callback/slack`,
  the user scopes `openid`, `email` and `profile`, and the bot scopes `users:read.email`,
  `channels:read`, `groups:read` and `im:write` in the manifest, and the client ID and secret read
  from hidden prompts; for company sign-in, the issuer, client ID, client secret, optional required
  claim and values, and a check that the issuer's discovery document is reachable.
- **FR-045**: `agentx signin enable slack|oidc`, `agentx signin disable slack|oidc` and
  `agentx signin show` MUST change and show the settings of FR-010 under the operator role, showing
  the change before applying it. Disabling a method MUST revoke its open sessions.
- **FR-046**: `agentx doctor` MUST check each enabled method: the Slack client ID and secret are set,
  the Slack redirect URL is registered (by a test authorize request), the team ID is set, and the
  company issuer's discovery document is reachable. The identity stack's app client MUST add the
  confirmation page's callback URL.
- **FR-047**: The install guide MUST cover, for each of Claude Code, Codex and Cursor: the install
  command, the manual configuration for each, signing in, a first task, and how to remove it.
- **FR-048**: The control plane MUST report an API version in
  `/v1/auth/.well-known/agentx-configuration`. The MCP server MUST refuse with `UPGRADE_REQUIRED`
  when the major version differs, and show an upgrade notice in `agentx_whoami` when only the minor
  version differs.

**Errors**

- **FR-049**: Tool errors MUST be returned as tool results with `isError: true`, a stable `code`, a
  plain message, and a next step. The codes are:

  | Code | When | Next step in the message |
  |---|---|---|
  | `SIGN_IN_REQUIRED` | no token, refresh expired or revoked | run `npx @charterarc/agentx login <url>` |
  | `SIGN_IN_REJECTED` | wrong Slack team, missing group, deactivated user (at login) | contact an admin; names the reason |
  | `ADMIN_REQUIRED` | an admin tool without an admin token | run `npx @charterarc/agentx login --admin` |
  | `PROJECT_NOT_AVAILABLE` | the project does not exist, or the developer may not use it, or its tasks are disabled | run `agentx_list_projects`; ask an admin or join the project's channel |
  | `TASK_NOT_FOUND` | no such task for this developer | run `agentx_list_tasks` |
  | `CHANNEL_REQUIRED`, `CHANNEL_AMBIGUOUS` | sharing needs a bound channel, or one of several | names the bound channels, or asks an admin to bind one |
  | `WORKSPACE_LIMIT` | a workspace limit is reached | lists open tasks to close |
  | `TASK_BUSY` | continue or open a PR while the task runs | wait, or cancel |
  | `SLACK_UNAVAILABLE` | Slack could not be reached for a membership check or sign-in | try again; explicit grants still work |
  | `CONFIRMATION_UNAVAILABLE` | no confirmation method in this session | use the CLI, or a client with elicitation |
  | `CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`, `CODE_INVALID`, `CHANGE_STALE` | the change was not confirmed, timed out, the code was wrong, or state moved | ask for the change again |
  | `UPGRADE_REQUIRED` | incompatible API version | the install command with the right version |
  | `CONTROL_PLANE_UNAVAILABLE` | network or 5xx after 3 tries | check the connection; `agentx_admin_health` for admins |

  A worker failure is not a tool error: the task's status and failure category (FR-025) carry it.
  A wait that ends first is not a tool error (US2).

**Governance**

- **FR-050**: Before any `/v1/dev/*` route is deployed, the constitution MUST be amended (version
  3.0.0):
  - **Principle I**: the hosted Slack orchestrator stays the only AgentX orchestrator model. A second
    client, the developer task API, may drive coding work, authenticated by a developer sign-in, with
    the developer's own AI tool writing the instructions. It MUST record the requesting developer
    with every operation.
  - **Principle II**: a developer selects a registered project in Slack, or by name through the
    developer task API when they may use it (FR-013).
  - **Principle III**: a workspace is owned by a Slack thread or by one developer task. A developer
    task's workspace is reachable only by the developer who started it. Personal workspaces not tied
    to a task stay retired.

### Key Entities

- **Developer**: a person signed in with Slack or the company's sign-in. ID, provider, display name,
  verified email, linked Slack user, sign-in times, revoked flag.
- **Sign-in session**: one provider sign-in and its rotating refresh token hash, with its expiry.
- **AgentX access token**: a 1-hour JWT the control plane issues to a developer.
- **Developer task**: one hand-off: ID, developer, project, title, client name, status, share state,
  starting revision, and its workspace.
- **Task workspace**: an ordinary workspace owned by the key of one developer task.
- **Project access grant**: a `ProjectMembership` record with role `developer` for a developer ID.
- **Developer task policy**: the project definition's `developerTasks` settings.
- **Shared task thread**: the Slack thread a shared task posts to, and its record for the ingress.
- **Pending admin change**: a planned change, its effect, state hash, offered methods, expiry,
  confirmation state and code hash.
- **Admin change audit record**: who applied what, when, and how it was confirmed.
- **AI-tool turn record**: a turn record with `origin: ai_tool`.

## Success Criteria *(mandatory)*

- **SC-001**: In the live check, a developer who has never used AgentX goes from nothing installed to
  a started task in under 5 minutes, with at most 3 commands typed plus the browser sign-in.
- **SC-002**: `agentx_start_task` without a wait returns in under 5 seconds at the 95th percentile
  over 20 live starts.
- **SC-003**: 100% of developer task actions in the contract tests and the live check have a turn
  record, readable by an admin within 60 seconds of the action.
- **SC-004**: Zero secret values appear in any tool result, log line or Slack post, over a contract
  test suite that plants known secret values in every source the tools read.
- **SC-005**: Zero admin changes apply without a valid confirmation, over contract tests that try
  every change tool with no confirmation, a declined one, an expired one, a reused one, another
  admin's Slack press and a wrong code.
- **SC-006**: A shared task's start message appears within 10 seconds of the start, and its final
  update within 60 seconds of the task's end, in the live check.
- **SC-007**: 100% of sign-ins from a Slack team other than the environment's are refused, in the
  contract tests and once live.
- **SC-008**: The existing Slack, control-plane, ingress and CLI suites pass with no change to their
  assertions.
- **SC-009**: The developer task contract tests pass with both an AgentCore and an `ec2-ebs` runtime
  binding.
- **SC-010**: One tool definition module serves the stdio server, proved by a test that compares the
  listed tools with the module's exports.

## Decisions

Owner decisions (binding):

- **Both developer hand-off and admin tools; hand-off first** (owner, 2026-09-27).
- **Hand off and move on by default, with an option to wait** (owner, 2026-09-27).
- **Private by default, share on request, admins can require sharing per project, and private tasks
  are still in the turn records** (owner, 2026-09-27). Tasks started in Slack stay in the channel.
- **Sign in with Slack and the company's sign-in; the company enables either or both; Slack is the
  default; AgentX's own user list is for admins and trials** (owner, 2026-09-27).
- **Admin tools look and change; every change shows its effect and needs a confirmation the model
  cannot answer; reads need none** (owner, 2026-09-27).
- **Laptop first, hosted later, one set of tool definitions** (owner, 2026-09-27). The stdio server
  is `npx @charterarc/agentx mcp`; the hosted endpoint at `https://<agentx>/mcp` with OAuth comes in
  a later phase.
- **The developer's AI tool writes the instructions, and AgentX runs them without the Slack
  orchestrator model** (owner, 2026-09-27), through the existing operation, outbox and dispatcher
  path, to either worker mode.
- **Spec 008's Slack-only decision is reversed for AI tools** (owner, 2026-09-27). Developers may
  drive coding work from their AI tools through the developer task API. Slack stays the way the
  team works together. Co-owner Pratik is being asked to confirm; FR-050's amendment waits for his
  answer.

Decisions made in this spec, **for the owner to confirm in review**:

- **D1. The control plane issues its own developer tokens** (recommended). It exchanges the Slack or
  company code server side and issues a 1-hour AgentX JWT and a 7-day rotating refresh token,
  verified by a second JWT authorizer on `/v1/dev/*`. Why: Slack's token exchange needs the client
  secret, which a laptop cannot hold; Slack's ID tokens live about five minutes; one issuer means one
  standard authorizer; revocation is in AgentX's hands; and the hosted MCP endpoint later needs an
  OAuth authorization server, which this already is. Rejected:
  - a Lambda authorizer that accepts Slack and company tokens directly: it still cannot do Slack's
    exchange from a laptop, and puts custom code in front of every admin route;
  - federating Slack and the company IdP into Cognito: it puts every developer in AgentX's user list,
    which the owner kept for admins and trials, does not work for environments that bring their own
    OIDC, and costs per federated user;
  - one route prefix and JWT authorizer per provider: Slack's exchange problem remains, and each new
    provider needs new routes.
- **D2. Project access: members of a bound channel, plus admin grants** (recommended). A developer
  may use a project if they are in one of its bound channels or an admin granted them, and a project
  can turn channel-based access off. Why: it matches who can already ask AgentX in Slack, so no new
  admin work is needed on day one. Rejected: admin grants only (every developer needs an admin
  action), and any signed-in person (too broad for private repositories).
- **D3. Company sign-in users are linked to Slack by verified email** (recommended), for
  channel-based access, the shared-thread mention, the Slack Confirm button and the shared limit
  counter. Rejected: asking each person to also sign in with Slack (two sign-ins), and no link
  (company users could use only granted projects).
- **D4. One workspace per task** (recommended), owned by a key derived from the developer and the
  task, like Slack threads. Why: a developer can hand off several tasks at once; the existing one
  default workspace per owner key and project would block the second task. Rejected: one workspace
  per developer and project (tasks queue behind each other and share a branch).
- **D5. Developer tasks share the Slack workspace limits and counters** (recommended). Rejected: a
  separate limit (a person could double their compute by using both).
- **D6. Admin tools need the admin sign-in, separate from the developer sign-in** (recommended).
  `agentx login --admin` is today's login. A Slack or company developer sign-in never grants admin.
  Why: admin rights stay tied to the admin claim, as today. When the admin issuer is also the company
  sign-in, the admin signs in through the same SSO twice, which is quick. Rejected: granting admin
  from a Slack workspace role (Slack admins are not AgentX admins).
- **D7. Confirmation order: elicitation, then Slack button, then one-time code** (recommended), as
  in FR-041, and read-only admin tools when none is available. Honest limit: an elicitation answer
  is given in the client's own window, which the model cannot answer, but the control plane trusts
  the local MCP server's report of it. A model with shell access and the admin's stored token could
  call the control plane directly; it can already run `agentx admin ...` today. The Slack button and
  the one-time code are checked by the control plane. An environment that needs server-checked
  confirmations only sets `mcp.confirm.elicitation` off. Rejected: code first (slower for the common
  case), and elicitation only (Codex and Cursor sessions without it would have no change tools).
- **D8. The one-time code is shown on a page that needs a fresh admin sign-in** (recommended), not in
  any API reachable with a bearer token and not on a local page, because an AI tool with shell access
  can read a local page or call the API with a stored token, but cannot complete a fresh browser
  sign-in. Rejected: a local page served by the MCP server, and a code sent by email (needs an email
  service AgentX does not run).
- **D9. A shared thread is a mirror** (recommended). The developer drives the task from their AI
  tool; a mention in the thread gets a fixed notice. Rejected: letting channel members continue the
  task from Slack (two drivers of one private workspace, and the Slack model would act on a task the
  developer owns).
- **D10. Required sharing forces sharing instead of refusing** (recommended), and the result says
  so. Rejected: refusing a start that did not ask to share (the AI tool would retry with the flag;
  refusing adds a round trip and no protection).
- **D11. One error for "no such project" and "no access"** (recommended): `PROJECT_NOT_AVAILABLE`.
  Why: it does not reveal which private projects exist, as the broker's `NOT_FOUND` does today.
- **D12. The turn record schema gains `origin`** (recommended), with the AI-tool fields in place of
  the Slack event and requester, and records keyed by task. Rejected: a separate table (admins would
  read two exports).
- **D13. Waits are capped at 600 seconds, default no wait** (recommended), with progress every 15
  seconds. Why: MCP clients time out long calls; a task that outlives the wait keeps running.
- **D14. A new notifier function posts to Slack for shared tasks and admin confirmations**
  (recommended), so the broker still cannot read the Slack secret. Rejected: giving the broker the
  Slack secret, and sending posts through the Slack service's request queue (that service runs the
  orchestrator model, which this flow must not use).
- **D15. Developers set up with `agentx login <url>`**, with no AWS credentials (recommended).
  Spec 015's `agentx env use` reads SSM, which developers cannot. Rejected: asking admins to hand out
  a deployment file.
- **D16. Admin CLI commands keep working without the new confirmation** (recommended): a person types
  them, and changing them is outside this spec.
- **D17. Access tokens last 1 hour; refresh tokens rotate and end 7 days after sign-in; Slack users
  are rechecked at each refresh** (recommended). Rejected: 30-day sessions (a person who leaves keeps
  access too long for company sign-in, which is not rechecked).

## Assumptions and Scope

- **Assumptions:**
  - The Slack app can add Sign in with Slack (user scopes `openid`, `email`, `profile`) and the extra
    bot scopes of FR-044. Workspaces that need admin approval for scope changes follow spec 015's
    approval handling.
  - The company's IdP can register a confidential OIDC client with the control plane's callback URL.
  - Claude Code supports MCP elicitation; Codex and Cursor may not, and the fallbacks cover them.
  - Spec 015 phase 15d (`agentx init`) is not built yet. Whichever of 15d and phase 25a merges second
    adds FR-044's step to `init`.
  - Issue #88 may remove AgentCore. Nothing here depends on it staying (FR-024).
- **In scope:** everything in the requirements above, delivered in the phases of
  [plans/README.md](plans/README.md).
- **Out of scope:**
  - The hosted MCP endpoint (`https://<agentx>/mcp` with OAuth). A later phase; FR-001 and FR-027
    are shaped so it needs no rework.
  - AgentX's Slack orchestrator model interpreting AI-tool requests. AI-tool instructions go
    straight to the worker.
  - Linear, Jira, Asana and GitHub connector tools offered directly to AI tools. A possible
    follow-up, which would reuse the gateway and its action policy.
  - The action gate for developer tasks. It confirms connector writes in Slack; developer tasks call
    no connector tools.
  - Billing, and charging usage back to developers.
  - Tasks started from Slack becoming private, or moving between Slack and an AI tool.
  - Multiple Slack workspaces per environment, and Slack Enterprise Grid organization-wide sign-in.
  - Changing the admin CLI's confirmation behavior.

## Testing

- **Unit tests (every PR, no network):**
  - the sign-in server: PKCE checks, state and nonce, loopback redirect rules, Slack team check,
    required group check, email verification rule, token issuing and signature, refresh rotation,
    reuse revoking the session, 7-day end, revocation; Slack and OIDC providers faked;
  - access resolution: grants, channel membership with the cache, the policy switch, a linked and an
    unlinked company user, Slack failures failing closed;
  - the task start sequence: every refusal before anything is written, the transaction, idempotent
    retries, workspace limits shared with Slack counters;
  - each MCP tool's input validation, output schema and error codes; the tool list for developer,
    admin, and admin without confirmation methods; `list_changed`;
  - waits: early end, timeout, progress notifications, client cancellation;
  - redaction: planted secret values in operation results, events, errors, turn records and project
    definitions never reach a tool result, log or Slack post (SC-004);
  - the confirmation flow: each method, each refusal of FR-040 and FR-041 (SC-005), code tries and
    hashing;
  - share rules and the thread's messages; the ingress notice for shared threads;
  - `mcp install` for each client against a temporary home directory, leaving other entries alone;
  - the turn record schema: old Slack records still parse; AI-tool records round-trip.
- **Contract tests (every PR, no network):**
  - the MCP server over stdio, driven by the MCP SDK's client, against the broker running in process
    with a fake DynamoDB, fake Slack, fake providers and a fake dispatcher, through every user story;
  - the same developer task flow with an AgentCore runtime binding and an `ec2-ebs` one (SC-009);
  - the existing Slack, control-plane, ingress and CLI suites, unchanged (SC-008);
  - `cdk synth` with the second authorizer, the new routes and the notifier's permissions; a test that
    only the notifier, the ingress and the orchestrator role can read the Slack secret.
- **Live check (once per phase that changes behavior, with the owner present):** in a throwaway
  environment, with a real Claude Code session:
  - sign in with Slack, and with a company OIDC test provider; a sign-in from another Slack team is
    refused;
  - hand off a task and move on; check status; open a PR; continue it;
  - wait for a small task; let a wait time out;
  - share a task; require sharing on a project; mention AgentX in the shared thread;
  - as admin: read health, failures, turns and usage; bind and unbind a channel with each
    confirmation method; see the change tools disappear in a client with none;
  - measure SC-001, SC-002 and SC-006, and run on each worker mode the environment has.
