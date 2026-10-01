# Feature Specification: AgentX MCP Server

**Feature Branch**: `spec/025-mcp-server`
**Created**: 2026-09-27
**Status**: Approved (owner, 2026-09-27)
**Input**: The owner's decisions of 2026-09-27 (developer hand-off first, then admin tools; private
by default with share to channel; Sign in with Slack and company sign-in; confirmed admin changes),
the owner's later decisions on the laptop-first MCP server and the developer task flow, the owner's
review of this spec on 2026-09-27 (two confirmation methods with a full audit trail, view-only or
continue sharing, distinct project errors, admin-changeable workspace limits), and a code reading of
mainline at `6f6acf9`.
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
11. **`ec2-ebs` is the only worker mode since #118 and #134** (owner decision, 2026-09-28). Issue
    #88's plan to remove AgentCore has landed.

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
   `agentx_open_pull_request`, **Then** AgentX answers at once with the started publish operation;
   `agentx_get_task` gives the PR URL once it is published (owner decision, changed, 2026-09-28).
5. **Given** a finished task, **When** the developer calls `agentx_continue_task` with more
   instructions, **Then** they run in the same workspace, on the same branch.
6. **Given** another developer, **When** they ask for this task by ID, **Then** they are told the
   task was not found.
7. **Given** a project name that does not exist, **When** the developer starts a task, **Then** they
   get `PROJECT_NOT_FOUND`; **given** a project that exists but that they may not use, **Then** they
   get `PROJECT_ACCESS_DENIED`, which says how to get access (FR-049).

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

### User Story 3 - Share a Task to the Channel, View Only or Open to the Channel (Priority: P2)

A developer starts a task with `share_to_channel: true`. AgentX posts in the project's Slack
channel: "@Maya started a task from Claude Code: Fix the flaky retry test". It adds replies as the
task runs, ends, and opens a PR. When sharing, the developer picks **view only** (the channel
watches) or **continue** (teammates may mention AgentX in the thread to steer the task). For the
`ledger` project, the admin has turned on required sharing for compliance and allowed view only, so
every task started from an AI tool is shared read-only, whatever the developer asks.

**Why this priority**: Tasks are private by default (owner decision 3), so sharing is what keeps the
team aware, and "continue" lets a teammate pick up a task without a new hand-off. Required sharing
and the view-only limit are compliance needs, but only for some projects.

**Independent Test**: With a fake Slack API, start a shared task in each mode and check the thread's
messages through the task's life. In continue mode, post two mentions from two teammates while the
task runs and check that they run one at a time, in order, each attributed to its author. Register a
revision with required sharing and view only, start a task with `share_to_channel: false` and
`share_mode: continue`, and check that it is shared view only and that the result says why.

**Acceptance Scenarios**:

1. **Given** `share_to_channel: true` and a project with one bound channel, **When** the task
   starts, **Then** AgentX posts the start message in that channel within 10 seconds, says which
   mode the thread is in, and replies in its thread at each status change listed in FR-032.
2. **Given** a project with required sharing, **When** a developer starts a task without asking to
   share, **Then** the task is shared, and the result says `shared: true` with the reason
   `required by project`.
3. **Given** a private task, **When** it runs, **Then** nothing is posted in Slack, and the task
   still has a turn record admins can read.
4. **Given** a view-only thread, **When** someone mentions AgentX in a reply there, **Then** AgentX
   answers with a fixed notice (at most once an hour per thread) that the task is driven from the
   developer's AI tool and that a new message in the channel starts a new thread workspace.
5. **Given** a continue thread, **When** a teammate mentions AgentX with a request, **Then** it runs
   as an ordinary Slack turn on the task's workspace, the reply names the teammate, and the
   operation and turn record name the teammate as requester.
6. **Given** a continue thread and two mentions while the task is busy, **When** they are handled,
   **Then** they run one at a time in the order Slack delivered them, each after the previous one
   and any worker operation it started have ended.
7. **Given** a continue thread, **When** the developer calls `agentx_get_task`, **Then** they see the
   channel's turns (author, time, request and outcome), and they can still continue, cancel, open a
   PR, switch the thread to view only, or close the task.
8. **Given** a project that does not allow continue, **When** a developer asks for continue, **Then**
   the thread is view only and the result says `share_mode: view` with the reason
   `continue not allowed by project`.
9. **Given** a private task, **When** the developer calls `agentx_share_task`, **Then** the thread is
   started with the current status and the chosen mode, and later updates follow.

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
(elicitation, Slack button) applies it exactly once; an expired, declined or reused confirmation is
refused; and every request, whatever its outcome, has a complete audit record.

**Acceptance Scenarios**:

1. **Given** a change tool call, **When** the control plane receives it, **Then** it stores a
   pending change with the exact effect, writes its audit record, and changes nothing yet.
2. **Given** an MCP client that declared the elicitation capability, **When** the change needs
   confirmation, **Then** the server shows the effect in an elicitation pop-up, and the change
   applies only if the person accepts.
3. **Given** a client without elicitation (or elicitation switched off) and an admin linked to a
   Slack user, **When** the change needs confirmation, **Then** AgentX sends that admin a Slack
   direct message with the effect and Confirm and Cancel buttons, and the change applies only when
   that same Slack user presses Confirm.
4. **Given** a session where neither method is available, **When** tools are listed, **Then** only
   the admin read tools are offered.
5. **Given** a pending change, **When** 10 minutes pass or the state it planned against changes,
   **Then** it can no longer be applied, and the admin is told to ask again.
6. **Given** any change request, **When** it ends confirmed, declined, expired or failed, **Then**
   its audit record shows who asked, from which client, the exact change, the method, the outcome
   with timestamps and the result, and `agentx_admin_changes` returns it.
7. **Given** an admin who asks to set the per-person workspace limit to 5, **When** they confirm,
   **Then** the next workspace creation uses 5, with no CloudFormation change.

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
  Slack thread; `agentx_continue_task` uses it too. Pull requests it opens list repositories from
  that same starting (pinned) revision, not the latest one (build ruling, 2026-09-28).
- **The worker is interrupted** (process loss, EC2 instance replaced). The task ends `INTERRUPTED`
  with the reason; `agentx_continue_task` resumes it through the existing recovery path.
- **The MCP client times out before `wait_seconds` ends.** The task keeps running; the developer
  reads it with `agentx_get_task`.
- **A pending admin change goes stale.** The state it was planned against changed (a newer project
  revision, a changed binding). Applying it is refused with `CHANGE_STALE`.
- **An admin presses a Slack Confirm button for another admin's change.** It is refused, recorded
  in the change's audit trail, and the change stays pending.
- **The admin's Slack Confirm button is pressed after the tool call stopped waiting.** The change
  still applies if it is within its 10 minutes; `agentx_admin_changes` shows the result.
- **The developer continues a task while a channel turn is running.** They get `TASK_BUSY`, naming
  the teammate driving it and how many channel messages are queued; they can wait, cancel the
  current operation, or switch the thread to view only.
- **The developer switches a continue thread to view only.** Channel messages already queued get
  the fixed notice instead of running.
- **A teammate in a continue thread is not a member of the bound channel** (for example, a Slack
  Connect guest). The ingress drops the message as it does today for any Slack turn.
- **An admin lowers a workspace limit below the current count.** Existing workspaces keep running;
  new ones are refused until the count is under the limit.
- **The same laptop is signed in to two environments.** Each environment keeps its own tokens; the
  MCP server uses the environment named by `--env` or the default set by `agentx login`.
- **Enterprise Grid.** A Slack sign-in whose team ID is another team in the same Grid organization is
  refused; only the environment's own team is accepted.
- **Closing a task with unpublished work.** The close is refused, naming each repository and why;
  there is no force flag (owner decision, 2026-09-28; FR-030, FR-037).
- **A developer continues a task or opens its pull request after losing project access, but still
  owns the task.** The action still succeeds: only ownership is checked, not project access
  (FR-013); a new task's start is the only place access is rechecked (build ruling, 2026-09-28;
  FR-021).

## Requirements *(mandatory)*

### Functional Requirements

**Developer sign-in (US4, US7)**

- **FR-001**: The control plane MUST act as the sign-in server for developers. It MUST offer an
  OAuth 2.1 authorization code flow with PKCE (`S256` only) to one public client, `agentx-cli`,
  whose only allowed redirect URIs are `http://127.0.0.1:<port>/callback` on any port. Routes:
  `GET /v1/auth/authorize`, `POST /v1/auth/token`, `GET /v1/auth/callback/slack`,
  `GET /v1/auth/callback/oidc`, `GET /v1/auth/.well-known/openid-configuration`,
  `GET /v1/auth/.well-known/jwks.json`, `GET /v1/auth/.well-known/agentx-configuration` and
  `POST /v1/auth/revoke` (RFC 7009), which `agentx logout` calls so a signed-out session cannot be
  refreshed again.
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
  - an **AgentX access token**: a JWT signed with RS256 by a KMS RSA key the control plane owns
    (RSA keeps the tokens verifiable by any standard JWT library; the broker verifies them itself,
    D17), issuer `<api-endpoint>/v1/auth`, audience `agentx-developer`, lifetime 1 hour, with claims
    `sub` (the developer ID, FR-008), `amr` (`slack` or `oidc`) and `env`;
  - a **refresh token**: an opaque random value, stored only as a SHA-256 hash, rotated on each use,
    valid for at most 7 days from the provider sign-in. A reused refresh token MUST revoke the whole
    sign-in session.
- **FR-006**: The environment MUST store its Slack team ID in its settings (`/agentx/<env>/slack/
  teamId`) and pass it to the control plane as the `SlackTeamId` stack parameter. `agentx init`
  MUST take it from the bot token's `auth.test`; `agentx doctor` MUST read it the same way for
  existing environments. `agentx env adopt` registers only the legacy deployment, which sign-in
  refuses, so it never reads that deployment's Slack secret. Slack sign-in MUST be refused while it
  is unset.
- **FR-007**: At each refresh of a Slack-signed-in developer, the control plane MUST check with
  `users.info` that the user still exists, is not deactivated and is in the team; otherwise the
  refresh MUST fail and revoke the session. Company-signed-in developers are checked only at sign-in.
- **FR-008**: A developer's ID MUST be `sha256(provider issuer, provider subject)`, the same function
  as today's owner key (`ownerKeyForSubject`). The control plane MUST keep a developer record with
  the provider, display name, verified email if any, linked Slack user ID if any (FR-012), first and
  last sign-in times, and whether the developer is revoked.
- **FR-009**: The broker MUST verify AgentX access tokens itself on a new route
  `ANY /v1/dev/{proxy+}`, which has no API Gateway authorizer (D17): RS256 only, the key ID and
  signature against the control plane's published keys, issuer `<api-endpoint>/v1/auth`, audience
  `agentx-developer`, and `exp` and `nbf` with 30 seconds of leeway. Every failure MUST be the same
  401. The `/v1/auth/*` routes MUST have no authorizer. The existing JWT
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
  - `agentx login --admin`, or `agentx login` with no URL: today's admin PKCE login, unchanged.
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
  - `shareMode`, with `default` (`view` by default, or `continue`) and `allowContinue` (default
    true); with `allowContinue` false every shared task is view only;
  - `channelMembersMayUse` (default true).

  It is part of the revision, so changing it is a revision registration. A revision with no
  `developerTasks` field at all (every project registered before this phase) gets these same
  defaults, as if it had been written out: tasks enabled, optional sharing, view-only default
  sharing with continue allowed, and channel members may use it. An admin turns any of this off only
  by registering a revision that says so (build ruling, 2026-09-28).
- **FR-015**: Admin tools MUST need an admin token from the admin issuer (today's Cognito or OIDC)
  whose admin claim matches, as today. A Slack or company developer sign-in MUST never grant admin
  rights. Admin change tools on a project MUST also need the admin's `administrator` membership, as
  today, checked when the change is planned and again inside the handler when it applies. A change
  that is not about one project (a connector credential, ending a developer's sign-in, the
  workspace limits) needs the admin claim only, as `agentx admin credential register` does (owner
  decision, 2026-09-30; 25e Q7).

**Developer task API (US1, US2)**

- **FR-016**: Under `/v1/dev/`, the control plane MUST serve:
  - `GET projects`: the projects the developer may use, with their bound channels and task policy;
  - `POST tasks`: start a task;
  - `GET tasks` and `GET tasks/{taskId}`: list and read the developer's tasks;
  - `POST tasks/{taskId}/continue`, `POST tasks/{taskId}/cancel`, `POST tasks/{taskId}/close`,
    `POST tasks/{taskId}/share` and `POST tasks/{taskId}/pull-requests`;
  - `GET tasks/{taskId}/events`: the task's progress events.

  `GET tasks` MAY answer with an opaque `nextCursor` for paging past the first page: a sort-key
  value only, taken from the caller's own partition, validated on the next call, and never a signed
  token (build ruling, 2026-09-28).
- **FR-017**: Each task MUST own one workspace. The workspace's owner key MUST be
  `sha256("agentx-developer-task", "<developerId>/<taskId>")`, so each task has its own workspace,
  as each Slack thread does, and a developer can run several tasks at once. The control plane MUST
  keep a task index (`DEVELOPER#{developerId}` / `TASK#{createdAt}#{taskId}`) with the project,
  workspace ID, title, client name, status, share state and starting revision.
- **FR-018**: `POST tasks` MUST, in order: check the token; check that the project exists
  (`PROJECT_NOT_FOUND`), that the developer may use it (FR-013, `PROJECT_ACCESS_DENIED`) and that
  `developerTasks.enabled` is true (`PROJECT_TASKS_DISABLED`);
  check sharing (FR-031); check the workspace limit (FR-020); and, in one transaction, create an
  ordinary workspace plus three records beside it: the task index entry, a pointer record holding
  the pending instructions and the client's request ID for idempotency, and the workspace's
  `developer` membership for its owner key; and return `STARTING` with the task ID (D18). Preparing
  the workspace MUST then run through the existing prepare path unchanged; the same transaction that
  records a successful prepare MUST also create the conversation and queue the pending instructions
  as the task's first turn, so the client makes no further call. When preparing the workspace does
  not end by queuing the task, for any reason, the pending instructions held on the pointer record
  MUST be cleared, so none linger unqueued (build ruling, 2026-09-28).
- **FR-019**: The instructions MUST be sent to the worker as the task prompt, unchanged, with the
  existing 65,536-byte limit. No AgentX model reads, rewrites or plans them. The worker gets the same
  tools and limits as a Slack task's worker.
- **FR-020**: A developer task MUST count against the same workspace limits as Slack threads (by
  default 3 per person and 20 per organization, FR-053). A developer linked to a Slack user
  MUST share that user's counter; an unlinked developer MUST have their own counter with the same
  limit. A task stores the counters it charged, and its close releases those (owner decision,
  2026-09-28). An environment with no Slack team ID counts developer tasks on
  `DEVELOPER_LIMIT#ORGANIZATION`, with the same limit (owner decision, 2026-09-28). A prepare that
  fails MUST NOT release the charge; only closing the task releases it, and closing MUST release it
  exactly once (build ruling, 2026-09-28).
- **FR-021**: The task routes MUST reuse the existing handlers for operations, events, artifacts,
  pull requests, pull-request actions and cancellation, reached with the task's owner key. The
  broker's refusal message for other JWT routes (FR-006 of spec 008) MUST stay for everything that
  is neither `/v1/admin/*` nor `/v1/dev/*`. Continuing a task and opening its pull request MUST
  check only that the caller owns the task; they MUST NOT recheck project access (FR-013), which is
  checked again only when a new task starts (build ruling, 2026-09-28).
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
  `agentx login --admin`). The admin tools are offered only while the control plane also reports a
  fitting admin API version (`adminApiVersion` in `/v1/auth/.well-known/agentx-configuration`,
  `1.0` from phase 25d, `1.1` from phase 25e, which adds the change tools and
  `agentx_admin_changes`; a 25e server offers only the admin read tools against a `1.0` control
  plane); against a control plane without one, the developer tools keep working and
  `agentx_whoami` says an AgentX upgrade adds the admin tools. A direct call to a hidden admin tool
  answers `ADMIN_REQUIRED`, or `UPGRADE_REQUIRED` when AgentX is the older side (owner decision,
  2026-09-30; Q1, D28). The server does not renew an expired admin sign-in; the admin tools then
  go away until `agentx login --admin` runs again (owner decision, 2026-09-30; Q4).
- **FR-029**: Every tool result MUST pass through the contracts package's `redactSecrets` and
  `redactText` before it is returned. Tool results MUST never contain a token, a secret value or a
  secret's contents; a credential appears only as its reference, type and secret name. Redaction
  MUST also cover AgentX's own request and callback tokens (the `agxr_` and `agxc_` prefixes), and a
  task's title, since a title may be taken straight from the developer's own instructions (build
  ruling, 2026-09-28).
- **FR-030**: The tools are:

  **Developer tools**

  | Tool | Inputs | Output |
  |---|---|---|
  | `agentx_whoami` | none | environment, developer name, sign-in method, linked Slack user, admin (whether this computer holds an unexpired admin sign-in for the environment), server and control-plane versions, upgrade notice |
  | `agentx_list_projects` | none | per project: name, bound channels, `share` policy, `shareMode` policy, whether tasks are enabled |
  | `agentx_start_task` | `project`; `instructions` (up to 65,536 bytes); `title` (optional, up to 120 characters, else the first line of the instructions); `share_to_channel` (optional, default false); `share_mode` (optional, `view` or `continue`, else the project's default); `channel` (optional); `wait_seconds` (optional, 0 to 600, default 0); `request_id` (optional UUID, else generated) | task ID, status, project, starting revision, `shared`, `share_mode` and the reason for any policy override, thread link if shared; with a wait, the same as `agentx_get_task` plus `timed_out` |
  | `agentx_get_task` | `task_id`; `events` (optional, 0 to 50, default 10) | status, failure if any, title, project, times, latest events, and once ended: summary (up to 4,000 characters), changed files with line counts, artifacts (name, size), pull requests (URL, state); in continue mode, the channel's turns (author, time, request up to 300 characters, outcome) |
  | `agentx_wait_for_task` | `task_id`; `wait_seconds` (1 to 600) | as `agentx_get_task`, plus `timed_out` |
  | `agentx_list_tasks` | `project` (optional); `status` (optional); `limit` (1 to 50, default 20) | the developer's tasks, newest first: ID, title, project, status, times, shared |
  | `agentx_continue_task` | `task_id`; `instructions`; `wait_seconds` (optional) | as `agentx_start_task` |
  | `agentx_cancel_task` | `task_id` | status after the request |
  | `agentx_close_task` | `task_id` | the task with `closing` while AgentX checks for unpublished work, at once; `agentx_get_task` then shows `CLOSED`, or `unpublished` with each repository and why; an optional `message` gives more detail |
  | `agentx_share_task` | `task_id`; `share_mode` (optional); `channel` (optional) | the task, with the thread link once AgentX has posted it (`agentx_get_task` shows it within seconds), and its mode; on a task already shared, it changes the mode (within the project's policy) |
  | `agentx_open_pull_request` | `task_id`; `title`; `body` (optional); `repository` (optional when the project has one repository, else from the task's pinned starting revision); `draft` (optional, default true) | the publish operation's ID and status, at once; the PR URL appears in `agentx_get_task` once published |

  Only `agentx_start_task`, `agentx_continue_task` and `agentx_wait_for_task` wait; every other tool
  answers at once (owner decision, changed, 2026-09-28; D20). When a tool call omits `request_id`,
  the server derives one from a hash of the call's own content and remembers it for 15 minutes, so a
  client-level retry of the same call reuses the same ID instead of starting a second task or
  duplicate action, and returns the ID it used as `request_id` in the output; `agentx_cancel_task`
  and `agentx_close_task` instead take a fresh ID on every call, since repeating either is exactly
  what calling it again means (build ruling, 2026-09-28). A successful `agentx_share_task` forgets
  the remembered IDs of the other modes, so view, then continue, then view again within 15 minutes
  is three changes, not a replay of the first (build ruling, 2026-09-29).

  Only the developer who owns a task may share it; the developer or an AgentX admin may switch a
  shared task between view only and continue, within the project's `shareMode` policy, the admin
  through `POST /v1/admin/tasks/{taskId}/share-mode` or `agentx admin task share-mode --task <id>
  --mode view|continue`, audited with the admin's name (owner decision, changed, 2026-09-29; Q2,
  C25). The admin path changes the mode only: it cannot make the first share or change the channel,
  it refuses a closed task, and it answers only `{ taskId, share }` (the mode, channel and thread
  link), never the task's title or results (D22; build ruling F5, 2026-09-29). There is no MCP
  admin tool for it: phase 25e adds none, and the CLI command covers it (owner decision,
  2026-09-30; 25e Q10).

  **Admin read tools** (no confirmation)

  | Tool | Inputs | Output |
  |---|---|---|
  | `agentx_admin_health` | none | control-plane version; alarm states for the environment's alarms; dead-letter queue depths; Slack token check; GitHub App installation check; per worker mode: whether it is configured and its latest dispatch failure; open workspaces by status. A probe that is not set up or fails answers `unknown` with a reason, the dead-letter queues through their own `dead_letter_queues_check` like the alarms' (build ruling R18, 2026-09-30) |
  | `agentx_admin_failed_tasks` | `since` (default 24 hours ago); `until` (optional); `project` (optional); `limit` (1 to 100, default 25) | per failure: time, project, origin (`slack` or `ai_tool`), requester, workspace ID, operation kind, failure category, redacted error, turn record link: the thread subject or the task ID to pass to `agentx_admin_turns`; the CLI reads the category as any string, so one a newer AgentX adds does not fail the answer (build ruling R23, 2026-09-30) |
  | `agentx_admin_turns` | `since`; `until` (optional); `project` (optional); `origin` (optional); `thread` or `task_id` (optional; `task_id` matches the task's own records and the channel turns that carry its ID); `limit` (1 to 100); `cursor` (optional) | turn records as `GET /v1/admin/turns` returns them, plus the next cursor. With a filter, only records that pass every filter count toward `limit`, and one call reads at most 10 index pages before it answers with a cursor (build ruling R11, 2026-09-30); when a `project` filter's lookup of a record's project fails, the broker refuses with `RUNTIME_UNAVAILABLE` and the tool, after its retries, answers `CONTROL_PLANE_UNAVAILABLE` (FR-049), rather than silently dropping that record (build ruling R12, 2026-09-30) |
  | `agentx_admin_usage` | `since`; `until` (optional); `group_by` (`project`, `requester`, `origin` or `day`) | per group: `turns` (Slack turn records, with the orchestrator model's tokens and cost), `tasks` (worker tasks' usage records, spec 011), total task duration, model input and output tokens from both, cost in US dollars as the records carry it (the sum of known costs), and `cost_unknown` (how many entries carried no cost, counted apart rather than as zero) (owner decision, 2026-09-30; Q6). A turn with no model usage counts as zero; usage that cannot be read counts in `cost_unknown` (build ruling R14, 2026-09-30). One call reads at most 5,000 usage items and 5,000 Slack turns, and at most 100 turn record pages (AI-tool records the origin filter drops count toward the pages), then says `truncated`; a requester group is one developer or Slack user, keyed by ID as well as name |
  | `agentx_admin_list_projects` | none | per project: latest revision, registration time, repositories, runtime mode, connector names and types, `developerTasks` settings |
  | `agentx_admin_list_channels` | none | per binding: channel ID and name, project, updated time; a public channel's name always, a private channel's name only when the admin's linked Slack user is a member of it, else its ID (a failed or missing membership check shows the ID) (owner decision, changed, 2026-09-30; Q7). The environment's own Slack team only: `GET /v1/admin/slack/bindings` refuses `team=` with `CONFIG_INVALID` where the environment records its team, and needs it only in the legacy deployment, which records none (build ruling R24, 2026-09-30) |
  | `agentx_admin_list_credentials` | none | per credential: reference, type, secret name, registered time; the list is keyed `references`, since FR-029's redaction replaces anything under a `credentials` key (build ruling R20, 2026-09-30) |
  | `agentx_admin_list_workspaces` | `project` (optional); `status` (optional); `limit` (1 to 100) | per workspace: ID, project, origin, owner (thread link or developer name), status, last activity; the current workspace limits and counts (in the legacy deployment, which records no Slack team, the organization count is 0; build ruling R15, 2026-09-30); the CLI reads the status as any string, so one a newer AgentX adds does not fail the answer (build ruling R23, 2026-09-30) |
  | `agentx_admin_changes` | `since` (default 7 days ago); `until` (optional); `admin` (optional); `outcome` (optional); `limit` (1 to 100); `cursor` (optional) | admin change audit records (FR-051), newest first, plus the next cursor |

  **Admin change tools** (each call plans the change, gets the confirmation and, only when
  confirmed, applies it, all within the one call; FR-039 to FR-041)

  | Tool | Inputs | What the plan shows |
  |---|---|---|
  | `agentx_admin_register_project_revision` | `definition` (the project definition as an object) | the new revision number and a field-by-field difference from the latest revision, registration preflight findings (spec 013 FR-014) |
  | `agentx_admin_bind_channel` | `channel` (a channel ID, or a public channel's name with or without `#`); `project` | the channel, its current binding, the new project and the revision new threads will use |
  | `agentx_admin_unbind_channel` | `channel` | the channel, its project, and that new messages there will get no reply |
  | `agentx_admin_register_credential` | `ref`; `type`; `secret_name` (under `agentx/connectors/`) | the reference, type and secret name, whether the secret exists, and which projects name the reference. It MUST refuse any input that looks like a secret value. |
  | `agentx_admin_stop_workspace` | `workspace_id` | the workspace, its project, owner and status, and the running task that will be cancelled; its compute then stops on its own when idle |
  | `agentx_admin_grant_project_access` | `project`; `developer` (developer ID, an email they signed in with, or Slack user ID) | the developer (or that they have not signed in yet), the project and their current access |
  | `agentx_admin_revoke_project_access` | `project`; `developer` | the developer, the project, and that running tasks keep running |
  | `agentx_admin_revoke_signin` | `developer` | the developer, and that every sign-in session they have now ends at once; they may sign in again |
  | `agentx_admin_set_workspace_limits` | `per_person` (optional, 1 to 50); `per_organization` (optional, 1 to 1,000) | the current and new limits, the current counts, and which people or the organization are already at or over the new limit |

  Every change tool returns the change ID, the outcome (`applied`, or `awaiting_confirmation` when a
  Slack wait ended first), the effect and the handler's result. A declined, expired or stale change
  is not a result but FR-049's error (`CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`,
  `CHANGE_STALE`), and its message names the change ID, so the AI tool sees that nothing changed; a
  handler's own refusal keeps its own code and names the change ID too (owner decision,
  2026-09-30; 25e Q9).

  Notes on the change tools (phase 25e):
  - **A new revision** keeps its project's runtime binding (launch template, subnets, disk) from
    the latest revision, unchanged. A project with no revision yet is refused: its first revision
    needs `agentx admin project register` with its flags (owner decision, 2026-09-30; 25e Q5).
  - **Stopping a workspace** cancels the task running in it, through the existing admin cancel, and
    its compute then stops on its own when idle; there is no manual compute stop. A workspace with
    nothing running is refused at planning: "nothing is running in workspace <id>; its compute
    stops on its own when idle" (owner decision, 2026-09-30; 25e Q2).
  - **Revoking a sign-in** ends every session the developer has at once (the broker refuses any
    session that started before the admin's end time, and the token endpoint revokes it at its next
    refresh). It does not set the permanent `revoked` block, so the person may sign in again (owner
    decision, 2026-09-30; 25e Q3).
  - **Naming a developer:** a 64-hex developer ID as it is; a Slack user ID (`U...`) as the
    developer ID Slack sign-in gives it (FR-008), so a grant can come before their first sign-in; an
    email only once that person has signed in with it, through an email index that sign-in writes
    from this release on (owner decision, 2026-09-30; 25e Q4). A plan never shows the email.
  - **Naming a channel:** a channel ID as it is; a public channel's name (with or without `#`) is
    looked up in the environment's Slack workspace; a private channel must be given by its ID and is
    never found by name (owner decision, 2026-09-30; 25e Q8).
  - **A private channel in a confirmation** (the pop-up, the tool result and the Slack DM) is named
    only when the planning admin's linked Slack user is a member of it, else by its ID, as
    `agentx_admin_list_channels` does. The audit record, and any other admin's read of the change,
    always name a private channel by its ID, since every admin can read the audit (controller
    ruling, 2026-09-30, extending the owner's 25d Q7 answer).

- **FR-031**: Sharing: when `share_to_channel` is true or the project's `share` is `required`, the
  task MUST be shared. A shared task needs a bound channel: the named `channel`, or the only bound
  channel; otherwise the start MUST be refused (`CHANNEL_REQUIRED` or `CHANNEL_AMBIGUOUS`) before
  anything starts. The share mode is the developer's `share_mode`, else the project's
  `shareMode.default`; when `allowContinue` is false it MUST be `view`. When the policy forced
  sharing or view only, the result MUST say so (`required by project`, `continue not allowed by
  project`). Sharing into a private bound channel MUST need the developer to be a member of it;
  otherwise the start or share is refused with `CHANNEL_REQUIRED` and "you are not a member of that
  private channel; join it first, or share to one of the project's public channels" (owner
  decision, 2026-09-29; Q10). This fails closed: when AgentX cannot tell whether a channel is
  private (Slack's channel-info lookup did not answer, or is not set up in the environment), the
  channel is treated as private, so only a developer AgentX can confirm as a member may share into
  it. A developer with no linked Slack user then cannot share into it, and gets `SLACK_UNAVAILABLE`
  saying to try again, or, where channel-info is not set up, to ask the admin to finish the Slack
  setup (build ruling, 2026-09-29). A failed membership lookup refuses too.
- **FR-032**: A shared task's thread MUST show:
  - the start message: the developer (a Slack mention when linked, else their display name), the
    client name, the title, the project, and the mode: in view only, that follow-ups happen in the
    developer's AI tool; in continue, that channel members may mention AgentX here to steer it;
  - replies when the workspace is ready, when the workspace could not be set up ("The workspace
    could not be set up, so the task did not run: " and the redacted error; C8), when an operation
    the developer started ends (status, and the summary up to 1,500 characters, redacted and then
    fitted to 1,500 characters after Slack escaping; build ruling F21, 2026-09-29), when a pull
    request opens (its URL), when the mode changes, and when the task is cancelled or closed;
  - in continue mode, the ordinary Slack turn replies to teammates' mentions.

  The developer's instructions beyond the title, events, diffs and artifacts MUST NOT be posted.
  Each reply is dated by its change's own time, to the millisecond, so a task shared later posts its
  start message with the current status and none of the replies from before the share (US3 scenario
  9; build ruling F7, 2026-09-29).
- **FR-033**: The client name MUST come from the MCP `initialize` request's `clientInfo.name`,
  mapped to `Claude Code`, `Codex` or `Cursor` for their known names, and otherwise to "an AI tool".
  It MUST be at most 40 characters and cleaned like Slack display names.
- **FR-034**: Slack posts for shared tasks and admin confirmations MUST be sent by a new
  `DeveloperTaskNotifier` function, the only new role that may read the Slack secret, triggered by
  the task's status changes and by new pending changes. Failed posts MUST be retried for 1 hour and
  then counted in the failed Slack delivery metric (spec 015 FR-045). Replies to teammates' turns in
  continue mode are posted by the Slack service, as for every Slack turn. The notifier is triggered
  by the control plane's state table stream, filtered to task, pointer and developer-operation
  changes, and posts from its own queue; it is the stream's second and last reader (C7, D23). A
  later need (such as 25e's Slack Confirm DMs) adds a filter to that trigger, never a third reader.
- **FR-035**: The control plane MUST keep a record for each shared thread
  (`SHARED_TASK#{team}/{channel}/{threadTs}`) with the task, its workspace owner key and the mode.
  The Slack ingress MUST check it for every mention in a thread:
  - in view only, it MUST answer with one fixed notice per hour per thread, without creating a
    thread workspace or queueing a turn. The notice reads: "This thread follows a task that a
    developer is driving from their AI tool, so I don't act on messages here. To ask AgentX for
    something, post a new message in the channel; it starts its own thread workspace." (owner
    decision, 2026-09-29; Q1);
  - a closed task's thread gets a closed notice, at most once an hour, and runs nothing: "The task
    this thread followed is closed, so I don't act on messages here." followed by the same second
    sentence (owner decision, 2026-09-29; Q3, C24). The close itself posts "The task is closed, and
    its workspace is released. This thread no longer drives it." and the notifier posts nothing
    after it;
  - in continue, it MUST queue the message exactly as it queues any thread message today: on the
    Slack request FIFO queue, in the thread's message group, after the same checks (a person, a
    member of the bound channel, the thread's rate limit).

  The ingress and the Slack service claim the hourly notice with one shared conditional write, so a
  message queued before a switch to view only, or before a close, is answered by the same once an
  hour (build ruling F13, 2026-09-29).
- **FR-054**: In continue mode, the Slack service MUST handle a queued message as an ordinary Slack
  turn with the orchestrator model, the action gate and the thread's conversation, but acting on the
  task's workspace: the broker's service identity MUST resolve a shared thread in continue mode to
  the task's workspace owner key instead of the thread's own key, and record the teammate as the
  requester of every operation the turn starts. A turn MUST start only when the task's workspace has
  no active operation; it MUST wait up to 30 minutes for that, then answer that the task is still
  busy. No new workspace is created and no workspace limit is charged. The developer's own
  instructions still go straight to the worker (FR-019). A teammate's `stop` in a continue thread
  cancels the running task operation, whoever started it; `close this workspace` in a shared thread
  is refused (owner decision, 2026-09-29; Q8, C11). A stop stops nothing when the thread is view
  only or closed (those get their notice instead), or when the channel now serves another project
  (build ruling F16, 2026-09-29).

  The developer's own run stays private from the channel (D22; build rulings, 2026-09-29): while it
  runs, the broker tells the teammate's orchestrator only that the task is busy
  (`activeOperation: "developer"`, with no operation ID), and the service operation, events and
  artifact routes answer a developer-requested operation from a shared thread with 404, exactly as
  an unknown one. Operations a channel turn started stay readable. A teammate's operation writes an
  ordinary Slack turn record naming the teammate, never an AI-tool `completed` record under the
  developer's name (FR-037; build ruling F3, 2026-09-29). When the developer meets a channel turn,
  `TASK_BUSY` names the teammate and says "at least N more channel messages are waiting" only when
  there are any: the count is a floor (build ruling F18, 2026-09-29).

**Visibility and audit**

- **FR-036**: A developer task MUST be visible through `/v1/dev/*` only to the developer who started
  it. Any other caller MUST get `TASK_NOT_FOUND`.
- **FR-037**: Each action on a developer task (start, continue, a pull-request request, cancel or
  close, and a share or mode change, action `share`, owner decision 2026-09-29, Q9; an admin's mode
  change names the admin) MUST write an `accepted` record in its own transaction, and each task or publish operation
  MUST write a `completed` record, holding the result summary, when it ends; a start refused after
  its request parses MUST write a `refused` record (owner decision, 2026-09-28). The one exception:
  a cancel that finds nothing running has no action transaction to write the `accepted` record in,
  so it is written on its own (build ruling, 2026-09-28). The turn record schema MUST gain `origin`
  (`slack` or `ai_tool`, absent read as `slack`) and, for `ai_tool`, `taskId`, `developer`
  (`developerId`, provider, display name, linked Slack user if any) and `client` in place of the
  Slack event ID and requester. They MUST be keyed `TASK#{taskId}`, keep the 30-day retention, hold
  the instructions redacted and capped as
  request text and the result summary as response text, and appear in `GET /v1/admin/turns` and
  `agentx_admin_turns`. Teammates' turns in continue mode are ordinary Slack turn records that also carry
  `taskId`. A close's outcome gets its `completed` record (outcome `succeeded`, or `refused` with
  the repositories), phase 25e. A close whose check for unpublished work ends failed, interrupted
  or cancelled also gets its `completed` record, `refused`, with "Not closed: the check for
  unpublished work did not finish" (controller ruling, 2026-09-30).
- **FR-038**: The control plane MUST index each operation that ends `FAILED` or `INTERRUPTED`
  (`FAILURE#{yyyy-mm-dd}` / `{endedAt}#{operationId}`, 30-day expiry) for `agentx_admin_failed_tasks`.
  It MUST also serve `GET /v1/admin/projects`, `GET /v1/admin/slack/bindings`,
  `GET /v1/admin/workspaces`, `GET /v1/admin/failures`, `GET /v1/admin/usage`,
  `GET /v1/admin/health`, `GET /v1/admin/me` and `GET /v1/admin/changes` for the admin read tools,
  with the same admin check as today. The failure index, and a usage index of workers' usage
  events, are written by the outbox publisher from the state table's stream, best effort (a failed
  index write never delays dispatch), and expire 30 days on: by the State table's TTL on
  `indexExpiresAt` in installed environments, and by the session reconciler in the legacy
  deployment (owner decision, changed, 2026-09-30; Q5, D29). The admin project list is a project
  catalog written at each registration, together with the environment team's bound projects and
  the caller's own memberships; no route scans the table (owner decision, 2026-09-30; Q2, D30).
  `GET /v1/admin/me` names the admin's verified email from the token, or from the admin issuer's
  `userinfo` endpoint, and whether it matches one Slack user (owner decision, 2026-09-30; Q3, D31).

**Admin changes and confirmation (US6)**

- **FR-039**: Every admin change tool MUST call `POST /v1/admin/changes` with the change and the
  MCP session's details (FR-051's client fields). The control plane MUST check the admin's rights,
  compute the exact effect against current state, and store a pending change: its ID, the admin,
  the effect, a hash of the state it was planned against, the confirmation methods offered, and an
  expiry 10 minutes later. It MUST write the change's audit record at the same time. Nothing changes
  until the change is confirmed.

  The pending change is `ADMIN_CHANGE#<changeId>` / `META` in the State table: the kind, the input,
  the effect, the plan's details, the state hash, the planning admin (issuer, subject, owner key,
  display name) and their linked Slack user if any, the methods offered, the status (`pending`,
  `applying`, `applied`, `declined`, `expired` or `failed`), the times, and the trace ID. A request
  carries a `requestId`; a repeated `requestId` from the same admin answers the change it already
  made (`ADMIN_CHANGE_REQUEST#<ownerKey>` / `<requestId>`), so a retried tool call plans nothing
  twice; the same `requestId` with a different change is refused with `IDEMPOTENCY_CONFLICT`.
  Both items expire by the State table's TTL 30 days after the proposal. The pending change keeps
  the raw input only while it can still apply, since the apply needs it, and the step that ends
  the change (applied, declined, expired or failed) removes it; no log line, DM, tool result or
  audit record carries that input except through `redactSecrets` (FR-051, SC-004), and the audit
  record names a channel only by its ID, never by a name the admin typed (controller rulings,
  2026-09-30).
- **FR-040**: A confirmed change MUST be applied in one transaction that checks that the change is
  pending, unexpired, planned by the same admin, confirmed by an offered method, and that the state
  hash still matches; it MUST then apply the change through the existing admin handler and mark it
  used (see D32: the claim and its audit step commit in one transaction; the handler's write
  follows). A change MUST apply at most once. A declined change (the elicitation declined or cancelled,
  or the Slack Cancel button) MUST be marked declined through `POST /v1/admin/changes/{id}/decline`
  or the interactivity route.

  "Applied at most once" is built this way (D32): an apply (`POST /v1/admin/changes/{id}/apply`)
  or a Confirm press first re-plans the change and compares the new state hash; then one
  conditional update moves the change from `pending` to `applying`, only while it is unexpired,
  planned by the same admin, and confirmed by an offered method; only then does the existing handler
  run, and a last update records `applied` or `failed`. A change stuck in `applying` for over 2
  minutes (the apply did not finish) reads as `failed`. A re-plan that finds the state moved, or
  that the planner now refuses, fails the change as `CHANGE_STALE`. A transient failure (the state
  could not be read, or Slack could not be reached) applies nothing and leaves the change pending,
  with "try again"; a press then answers `unavailable` (controller ruling, 2026-09-30). The honest
  limit: the state can still change between the hash check and the handler's own write, a window of
  milliseconds that the handlers' own conditions (such as registration's immutable revisions)
  narrow further.
- **FR-041**: The confirmation methods, in order of preference:
  1. **MCP elicitation** (the client's pop-up), when the client declared the `elicitation`
     capability and the environment allows it (`mcp.confirm.elicitation`, default on; see the notes
     below). The server MUST send `elicitation/create` with the effect text and one boolean field,
     and call `POST /v1/admin/changes/{id}/apply` only on `accept` with the field true.
  2. **Slack Confirm button**, when the admin's verified email claim matches one Slack user of the
     environment's team (the lookup of FR-012). The notifier MUST send that user a direct message
     with the effect and Confirm and Cancel buttons. The Slack interactivity route MUST accept a
     press only from that Slack user; a press of Confirm applies the change at once, server side
     (FR-040). The tool call waits up to 5 minutes for the press, with progress notifications, and
     then returns `awaiting_confirmation` if none came.

  There is no other method. The control plane MUST report whether each method is enabled in
  `/v1/auth/.well-known/agentx-configuration` and whether the signed-in admin has a Slack link in
  `GET /v1/admin/me`; the MCP server combines them with the client's capabilities. When neither
  method is available, the change tools MUST not be listed, only the admin read tools, and a direct
  call MUST return `CONFIRMATION_UNAVAILABLE`.

  Notes on the confirmation methods (phase 25e):
  - **The elicitation switch.** `mcp.confirm.elicitation` is the control-plane stack parameter
    `McpConfirmElicitation` (`enabled` by default, or `disabled`), named environments only, changed
    with `agentx config set mcp.confirmElicitation enabled|disabled` like the other `agentx config`
    keys and kept across upgrades. When it is `disabled`, the broker neither offers nor accepts the
    pop-up, and `agentx-configuration` reports `confirm.elicitation` false (owner decision,
    2026-09-30; 25e Q1).
  - **Slack.** `confirm.slack` is true wherever the environment has a Slack team set up, whatever
    Slack sign-in says; the per-admin match of the verified email to one Slack user still decides,
    change by change, whether the Slack method is offered (controller ruling, 2026-09-30).
  - **The pop-up comes first.** A tool call cancelled while its pop-up is open declines the change
    (reason cancelled) and never starts the Slack step. When Slack is also offered, the pop-up
    closes at least 90 seconds before the change expires, so a pop-up that goes unanswered still
    leaves the Slack button its time (controller ruling, 2026-09-30).
  - **The Slack step** (D34). The MCP server starts it with `POST /v1/admin/changes/{id}/slack`
    only when the pop-up is not offered or did not work. The notifier's DM, with Confirm and
    Cancel buttons (action IDs `agentx_admin_change_confirm` and `agentx_admin_change_cancel`),
    comes from the state table's stream through a filter added to D23's trigger, never a third
    reader, and the notifier edits the DM to say how the change ended. The tool call waits up to 5
    minutes, with a progress notification every 15 seconds. A press reaches the ingress (the
    existing interactivity route), which checks the Slack signature, answers the presser at once
    ("Received. AgentX is applying the change; ..." or "Received. AgentX is dropping the change.")
    and hands the press to the broker asynchronously. The broker accepts it only from the change's
    own Slack user in the environment's team; any other press is refused, recorded as a refused
    attempt, and the change stays pending. A press after the tool stopped waiting still applies
    within the 10 minutes. The ingress takes these two buttons only where `ADMIN_CHANGES=enabled`
    (named environments, D14) (controller ruling, 2026-09-30).
  - **A typed `agentx` command** is the `cli` method: the CLI shows the effect, asks "Apply this
    change?" (or takes `--yes`), and applies with method `cli`, which the broker always accepts
    from the planning admin, as D12 accepts any command a person types (owner decision, 2026-09-30;
    25e Q6; D35). No AI tool can offer it.
- **FR-042**: The CLI's existing `agentx admin ...` commands MUST keep working unchanged, without
  this confirmation, because a person types them. The new `agentx admin project grant|revoke` and `agentx config set limits.*`
  go through the change path with the `cli` method and its audit (owner requirement, 2026-09-29).
- **FR-051**: Every admin change request MUST have one audit record, whatever its outcome, holding:
  - who asked: the admin's issuer, subject and display name;
  - the client: the AgentX CLI version running the MCP server, and the MCP client's
    `clientInfo.name` and version;
  - the exact proposed change: a field-level difference or a payload summary, passed through
    `redactSecrets` so it holds no secret value;
  - the confirmation method offered and the one used, with the Slack user who pressed a button;
  - the outcome (`confirmed`, `declined`, `expired` or `failed`) with the time of each step:
    proposed, confirmation requested, answered, applied or failed;
  - the result: what the admin handler returned, or the redacted error;
  - refused confirmation attempts (another person's press, a stale state hash);
  - a trace ID.

  An expired change MUST be recorded `expired` the next time it is touched, and every read after its
  expiry MUST show it as expired. Audit records MUST be kept for the turn records' retention (30
  days) and MUST NOT be changeable through any route.

  The audit record is `CHANGE#<changeId>` / `AUDIT` in the TurnRecords table, which already keeps
  records 30 days by TTL. It is listed newest first through the table's time index under its own
  export partition, `CHANGES`, apart from the turn export's `TURNS`, so the two never mix. At most
  20 refused attempts are recorded per change; later ones are not recorded one by one, and the
  change still refuses them (controller ruling, 2026-09-30). Only the broker writes it: one
  conditional put, then updates that only step it forward and never clear an outcome once set
  (D33). It holds the change's input and details only through `redactSecrets`, and names a private
  channel by its ID (FR-030's notes).
- **FR-052**: Admin change handling MUST be traceable end to end. The MCP server MUST send a trace
  ID (`x-agentx-trace-id`) with every control-plane call; the control plane, the notifier, the Slack
  interactivity route and the apply step MUST write it, with the change ID, in a structured log line
  at each step; and the control plane MUST emit a metric per outcome. Admins MUST be able to read
  the records through `GET /v1/admin/changes`, the `agentx_admin_changes` tool, and
  `agentx admin changes --since <duration> [--json]` (a duration such as `30m`, `12h` or `7d`, at
  most `30d`), which exports them like `agentx admin turns`: text lines, or JSON Lines of the
  records as stored with `--json`, and the count on stderr.
- **FR-053**: The per-person and per-organization workspace limits MUST be changeable without a
  CloudFormation change. The control plane MUST store them as a setting in its state table
  (`SETTINGS` / `WORKSPACE_LIMITS`, with the admin and time of the last change). Its fields are
  `perPerson` and `perOrganization`. The broker reads this setting from phase 25b on, for Slack
  threads and developer tasks alike; phase 25e adds the change tool that writes it (owner decision,
  2026-09-28). The broker MUST read
  the setting at each workspace creation, with a consistent read, and use it in the existing limit
  conditions; when the setting is absent it MUST use the stack parameters `SlackMemberWorkspaceLimit`
  and `SlackOrganizationWorkspaceLimit` (defaults 3 and 20), which stay as the install-time
  defaults. The per-person limit MUST NOT exceed the per-organization limit. Lowering a limit MUST
  NOT stop existing workspaces. The admin change tool `agentx_admin_set_workspace_limits` changes the
  setting with confirmation and audit (FR-039 to FR-052). From phase 25e, spec 015 phase 15e's
  `agentx config set limits.workspacesPerMember|limits.workspacesPerOrg` changes the same setting
  through the same change path, no longer refused "until 25e": it needs the admin sign-in
  (`agentx login --admin`), shows the effect (who is at or over the new limit), asks "Apply this
  change?" and is audited with the `cli` method (owner requirement, 2026-09-29; D35). The change
  writes `perPerson` and `perOrganization`, keeps an omitted value as it is, records the admin and
  the time (`updatedBy`, `updatedAt`), and refuses a per-person limit above the per-organization
  one with `CONFIG_INVALID`; the next workspace creation uses it (SC-013). It needs a person's
  yes: without a terminal to answer the prompt it refuses with `CONFIRMATION_UNAVAILABLE` unless
  `--yes` is given; in the legacy deployment, which has no change routes, it refuses and names the
  `AgentXControlPlane` stack parameter to change instead (`SlackMemberWorkspaceLimit` or
  `SlackOrganizationWorkspaceLimit`). Other `agentx config set` keys are unchanged (controller
  ruling, 2026-09-30).

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
  the change before applying it. Disabling a method MUST revoke its open sessions, and turning it back
  on MUST NOT revive them: each method records when it was last turned on, and a session started
  before that is refused and revoked.
- **FR-046**: `agentx doctor` (phase 15e) runs the checks of `agentx signin check`, which phase 25a
  ships: for each enabled method, the Slack client ID and secret are set, the Slack redirect URL is
  registered (by a test authorize request), the team ID is set, and the company issuer's discovery
  document is reachable. When Slack's answer to the test request neither confirms nor denies that the
  redirect URL is registered, the check MUST report the redirect URL as `warn` (ok, but not verified),
  not as failed.
- **FR-047**: The install guide MUST cover, for each of Claude Code, Codex and Cursor: the install
  command, the manual configuration for each, signing in, a first task, and how to remove it.
- **FR-048**: The control plane MUST report an API version in
  `/v1/auth/.well-known/agentx-configuration`. The MCP server MUST refuse with `UPGRADE_REQUIRED`
  when the major version differs, and show an upgrade notice in `agentx_whoami` when only the minor
  version differs. When the control plane's minor version is older than the tools' own (for example
  a `1.0` control plane, which has no developer task routes at all), every tool MUST also refuse
  with `UPGRADE_REQUIRED`, asking an admin to upgrade AgentX: a minor-version gap in that direction
  means routes this phase needs are simply missing, not merely different (build ruling, 2026-09-28).
  `DEVELOPER_API_VERSION` is `1.1` from phase 25b and moves to `1.2` in phase 25c, which adds the
  share route; an MCP server from 25c refuses a 25b control plane with `UPGRADE_REQUIRED` and "ask
  your AgentX admin to upgrade AgentX" (owner decision, 2026-09-29; Q7).
  `/v1/auth/.well-known/agentx-configuration` also reports `adminApiVersion` (`1.0` from phase
  25d; FR-028, D28). `ADMIN_API_VERSION` moves to `1.1` in phase 25e, which adds the change routes
  and `GET /v1/admin/changes`; `DEVELOPER_API_VERSION` stays `1.2` (owner decision, 2026-09-30;
  25e Q11).

**Errors**

- **FR-049**: Tool errors MUST be returned as tool results with `isError: true`, a stable `code`, a
  plain message, and a next step. The codes are:

  | Code | When | Next step in the message |
  |---|---|---|
  | `SIGN_IN_REQUIRED` | no token, refresh expired or revoked | run `npx @charterarc/agentx login <url>` |
  | `SIGN_IN_REJECTED` | wrong Slack team, missing group, deactivated user (at login) | contact an admin; names the reason |
  | `ADMIN_REQUIRED` | an admin tool without an admin token | run `npx @charterarc/agentx login --admin` |
  | `PROJECT_NOT_FOUND` | no project by that name exists | "project `x` doesn't exist in this AgentX"; run `agentx_list_projects` |
  | `PROJECT_ACCESS_DENIED` | the project exists, but the developer may not use it (FR-013) | "you don't have access to `x`: join one of its channels or ask an admin", naming only the bound channels the person can see (public channels, and private channels they are in); when they can see none, or `channelMembersMayUse` is false, just "ask an admin" |
  | `PROJECT_TASKS_DISABLED` | the project exists and the developer may use it, but `developerTasks.enabled` is false | use the project's Slack channel, or ask an admin |
  | `TASK_NOT_FOUND` | no such task for this developer | run `agentx_list_tasks` |
  | `CHANNEL_REQUIRED`, `CHANNEL_AMBIGUOUS` | sharing needs a bound channel, or one of several | names the bound channels, or asks an admin to bind one |
  | `WORKSPACE_LIMIT` | a workspace limit is reached | lists open tasks to close |
  | `TASK_BUSY` | continue or open a PR while the task runs, including a channel turn in continue mode | names who is driving it and the queued channel messages; wait, cancel, or switch to view only |
  | `SLACK_UNAVAILABLE` | Slack could not be reached for a membership check or sign-in | try again; explicit grants still work |
  | `CONFIRMATION_UNAVAILABLE` | no confirmation method in this session | use a client with elicitation, link a Slack user, or use the CLI |
  | `CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`, `CHANGE_STALE` | the change was declined, timed out, or state moved; the message names the change ID (25e Q9) | ask for the change again |
  | `INVALID_REQUEST` | the control plane refuses the input (a reused request ID, instructions over 65,536 bytes, a malformed ID) | fix the input the message names |
  | `UPGRADE_REQUIRED` | the client's major version differs from the control plane's, or the control plane's minor version is older than the tools need (FR-048) | run the install command again for the latest CLI; if the control plane is the older side, ask your AgentX admin to upgrade AgentX instead |
  | `CONTROL_PLANE_UNAVAILABLE` | network or 5xx after 3 tries | check the connection; `agentx_admin_health` for admins |

  A worker failure is not a tool error: the task's status and failure category (FR-025) carry it.
  A wait that ends first is not a tool error (US2).

**Governance**

- **FR-050**: Before any `/v1/dev/*` route is deployed, the constitution MUST be amended (version
  4.0.0; mainline had already taken 3.0.0 for the EC2-only runtime, spec 036):
  - **Principle I**: the hosted Slack orchestrator stays the only AgentX orchestrator model. A second
    client, the developer task API, may drive coding work, authenticated by a developer sign-in, with
    the developer's own AI tool writing the instructions. It MUST record the requesting developer
    with every operation.
  - **Principle II**: a developer selects a registered project in Slack, or by name through the
    developer task API when they may use it (FR-013).
  - **Principle III**: a workspace is owned by a Slack thread or by one developer task. A developer
    task's workspace is reachable only by the developer who started it, and, while the developer
    shares it in continue mode, by the members of the bound channel who post in its shared thread.
    Personal workspaces not tied to a task stay retired.

- **FR-055**: A developer task's workspace MUST NOT stay in setup forever. A sweep MUST mark failed
  any prepare still running 50 minutes after it started (owner decision, 2026-09-29, raised from 15
  minutes because the provisioner allows 45), whatever the instance's health, with a fixed message
  that setup did not finish ("setup did not finish within 50 minutes; close this task and start a
  new one"); the workspace then reads `setup_failed`, and closing the task frees its slot (FR-020),
  as with any other failed setup (build ruling F20, 2026-09-29). Only developer-task prepares are
  watched; the sweep runs in the session reconciler, every 10 minutes, so a stuck setup is failed
  between 50 and 60 minutes after it started (owner decisions, 2026-09-29; Q4, Q5, C17). The sweep
  also runs in the legacy deployment's reconciler, where it reads one empty partition per run and
  emits the `ReconcilerStuckSetups` metric as 0; this is accepted, and no template changes (build
  ruling F17, 2026-09-29). A failed sweep is logged and counted, the reconciler's other metrics are
  still emitted, and the run then fails so the existing reconciler error alarm sees it. Once the
  sweep exists, a temporary AWS error (throttling, or a 5xx) while queuing the task's first
  instructions MUST be retried rather than failing the start at once: the broker answers 503 and
  records nothing, and the worker sends its result again (D21). Phase 25c.

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
- **Share mode**: `view` or `continue`, chosen per shared task within the project's `shareMode`.
- **Shared task thread**: the Slack thread a shared task posts to, and its record (task, owner key,
  mode) for the ingress and the broker.
- **Pending admin change**: a planned change, its effect, state hash, offered methods, expiry and
  confirmation state (`ADMIN_CHANGE#<changeId>` in the State table, FR-039).
- **Admin change audit record**: one per change request: who asked, the client, the exact change,
  the method, the outcome with timestamps, the result and a trace ID (`CHANGE#<changeId>` in the
  TurnRecords table, FR-051).
- **Workspace limits setting**: the per-person and per-organization limits, when an admin has
  changed them from the stack parameters' defaults.
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
  every change tool with no confirmation, a declined one, an expired one, a reused one and another
  person's Slack press.
- **SC-006**: A shared task's start message appears within 10 seconds of the start, and its final
  update within 60 seconds of the task's end, in the live check.
- **SC-007**: 100% of sign-ins from a Slack team other than the environment's are refused, in the
  contract tests and once live.
- **SC-008**: The existing Slack, control-plane, ingress and CLI suites pass with no assertion
  removed or weakened; lists of commands, error codes and constants gain the new entries, and
  `DEVELOPER_API_VERSION` moves to `1.1` (owner decision, 2026-09-28). This covers updating
  `tests/contract/developer-identity-server.test.ts`'s expected `apiVersion` from `"1.0"` to `"1.1"`,
  the same kind of additive change as every other list here. In phase 25c it moves to `1.2`
  (owner decision, 2026-09-29; Q7), with the same kind of update to the expected version.
- **SC-009**: The developer task contract tests pass with an `ec2-ebs` runtime binding, and no
  developer task code reads the deployment mode (owner decision, 2026-09-28).
- **SC-010**: One tool definition module serves the stdio server, proved by a test that compares the
  listed tools with the module's exports.
- **SC-011**: 100% of admin change requests in the contract tests and the live check (applied,
  declined, expired and failed) have an audit record with every field of FR-051, and a trace ID that
  appears in the log lines of each step.
- **SC-012**: In continue mode, over a contract test of 20 mentions from 3 teammates sent in a burst,
  zero turns overlap, all 20 run in delivery order, and each turn record names its author.
- **SC-013**: A workspace limit changed with `agentx_admin_set_workspace_limits` takes effect on the
  next workspace creation, with zero CloudFormation stack updates.

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

Owner decisions from the review of this spec (binding, 2026-09-27):

- **Project access: channel members automatically, plus admin grants; an admin can switch off the
  automatic part per project** (the first draft's D2). FR-013 and `channelMembersMayUse`.
- **One workspace per task, counted against the same limits as Slack threads: 3 per person and 20
  per organization by default** (the first draft's D4 and D5). FR-017 and FR-020. Why one per task: a developer can
  hand off several tasks at once, where the existing one default workspace per owner key and project
  would block the second. Sharing the limits stops a person doubling their compute by using both.
- **Admin tools need the separate admin sign-in** (the first draft's D6). `agentx login --admin` is today's login;
  a Slack or company developer sign-in never grants admin.
- **Developers need no AWS login** (the first draft's D15). They set up with `agentx login <url>`.
- **Two confirmation methods only: MCP elicitation, then the Slack Confirm button by DM** (replaces
  the first draft's D7 and D8). The one-time code is removed. With neither available, admins get the read-only tools.
  Honest limit, kept on purpose: an elicitation answer is given in the client's own pop-up, which the
  model cannot answer, but the control plane trusts the local MCP server's report of it. A model with
  shell access and the admin's stored token could call the control plane directly; it can already
  run `agentx admin ...` today. An environment that wants only control-plane-checked confirmations
  sets `mcp.confirm.elicitation` off, which leaves the Slack button as the only method.
- **Every admin change request is logged and traced, and admins can read the records** (FR-051,
  FR-052). Records are kept like turn records (30 days).
- **Sharing has two modes: view only, or let the channel continue it** (replaces the first draft's D9). In continue
  mode teammates steer the task from the shared thread, one message at a time in order, each
  attributed to its author; the developer keeps control from their AI tool; an admin sets a
  per-project default and can force view only.
- **Distinct project errors: `PROJECT_NOT_FOUND` and `PROJECT_ACCESS_DENIED`** (replaces the first draft's D11). The
  owner chose clarity over hiding project names: a person learns that a project exists even when
  they cannot use it. Channel names are shown only when the person can already see those channels.
- **Admins can change the workspace limits without editing CloudFormation**, through an admin change
  tool with confirmation and audit (FR-053).

Owner decisions on the phase 25b build (binding, 2026-09-28). Building phase 25b (the developer
task API and the MCP server) raised 12 questions the spec had not settled; the owner answered each
one. Eleven were accepted as recommended; one (6) was changed:

1. **The limits setting (FR-053). Accepted.** The broker reads it from phase 25b on, for Slack
   threads and developer tasks alike; phase 25e adds the change tool that writes it.
2. **No Slack team ID (FR-020). Accepted.** Developers in an environment with no Slack team ID
   count on `DEVELOPER_LIMIT#ORGANIZATION`, with the same limit.
3. **Audit records (FR-037). Accepted.** Three stages: an `accepted` record in the action's own
   transaction, a `completed` record with the result summary when the operation ends, and a
   `refused` record for a start refused after its request parses.
4. **`INVALID_REQUEST` (FR-049). Accepted.** Added for input the control plane refuses: a reused
   request ID, instructions over 65,536 bytes, or a malformed ID.
5. **Closing with unpublished work. Accepted.** The close is refused, listing each repository and
   why. There is no force flag.
6. **Waiting for the PR URL and the close (FR-030, FR-049). Changed.** `agentx_open_pull_request`
   and `agentx_close_task` do not wait. They return at once with a started status and the
   operation or task reference, and the AI tool checks back with `agentx_get_task`. The task wait
   (off by default, at most 600 seconds) stays exactly as it is.
7. **`agentx_whoami`'s admin field (FR-030). Accepted.** It says whether this computer holds an
   unexpired admin sign-in for the environment.
8. **Project description (FR-030). Accepted.** `description` is dropped from
   `agentx_list_projects`.
9. **SC-009 and AgentCore. Accepted.** SC-009 becomes: the developer task contract tests pass with
   an `ec2-ebs` binding, and no developer task code reads the deployment mode. Context item 11 and
   the Testing section are updated to match.
10. **A Slack member at the limit because of AI-tool tasks. Accepted.** The Slack refusal lists
    only the member's open threads, so it undercounts when AI-tool tasks fill the limit. 25b
    accepts this; the fix is a known follow-up in 25c (see plans/README.md).
11. **Rolling back past 25b. Accepted.** The release notes say: before rolling back to a release
    before 25b, register a revision without `developerTasks`, since the strict schema of an older
    control plane cannot read it.
12. **SC-008 and the API version. Accepted.** The expected `DEVELOPER_API_VERSION` in
    `tests/contract/developer-contracts.test.ts` changes from `"1.0"` to `"1.1"`. SC-008 means no
    assertion is removed or weakened.

Owner decisions on the phase 25c build (binding, 2026-09-29). Building phase 25c (sharing, and the
stuck-setup sweep) raised ten questions (plans/phase-25c-questions.md); the owner answered all ten.
Q2 was changed, Q7 approved, Q10 raised during the build; the rest were accepted as recommended.
Separately, the owner raised the stuck-setup limit from 15 to 50 minutes, because the instance
provisioner allows 45 (FR-055, D21).

1. **The view-only notice's words (FR-035). Accepted.** The fixed text FR-035 gives; a closed
   task's thread gets its own first sentence and the same second one.
2. **Who may switch a shared task's mode (FR-030). Changed.** The owning developer or an AgentX
   admin, within the project's `shareMode` policy. The admin uses `agentx admin task share-mode` or
   `POST /v1/admin/tasks/{taskId}/share-mode`, changes the mode only, and is audited by name.
3. **A shared thread after the close (FR-035). Accepted.** The close posts "closed" and the thread
   stops: later mentions get the closed notice, at most once an hour, and nothing runs.
4. **Which setups the sweep covers (FR-055). Accepted.** Developer-task prepares only; Slack
   thread setups keep their existing handling.
5. **When the clock starts (FR-055). Accepted.** At the task's start (the prepare's creation). The
   limit itself is 50 minutes.
6. **Whether the start waits for the thread link (FR-030). Accepted.** No: the start and share
   answer at once with `share_posting: true`, and `agentx_get_task` shows the link within seconds.
7. **The developer API version (FR-048, SC-008). Approved.** `DEVELOPER_API_VERSION` moves to
   `1.2`.
8. **Stop in a continue thread (FR-054). Accepted.** A teammate's stop cancels the running task
   operation, whoever started it.
9. **Auditing a share (FR-037). Accepted.** A share or mode change writes an `accepted` record with
   the new action `share`.
10. **A private channel (FR-031). Refuse.** Sharing into a private bound channel needs the
    developer to be a member of it.

Owner decisions on the phase 25d plan (binding, 2026-09-30). Planning phase 25d (the admin read
tools and routes) raised seven questions (plans/phase-25d-questions.md); the owner answered all
seven. Q5 and Q7 were changed; the rest were accepted as recommended. Separately, the owner
deferred live testing until 25d, 25e and spec 040 phases 2 to 4 are built, for one combined final
live check.

1. **The admin API's version (FR-028, FR-048). Accepted.** Its own `adminApiVersion`, `1.0`;
   `DEVELOPER_API_VERSION` stays `1.2` (D28).
2. **The admin project list (FR-038). Accepted.** The project catalog, the bound projects and the
   caller's own; no scan (D30).
3. **The admin's email (FR-038, FR-041). Accepted.** From the admin issuer's `userinfo` endpoint
   when the token carries none, trusted only when verified (D31).
4. **Renewing the admin sign-in (FR-028). Accepted.** The MCP server does not renew it, the same as
   the CLI.
5. **How index records expire (FR-038). Changed.** DynamoDB TTL on `indexExpiresAt` in installed
   environments; the reconciler cleans up only in the legacy deployment (D29).
6. **What `agentx_admin_usage` counts (FR-030). Accepted.** Slack turns and worker tasks, with
   unknown costs counted apart.
7. **Private channel names for admins (FR-030). Changed.** Shown only when the admin's linked Slack
   user is a member of the channel; otherwise the ID.

Owner decisions on the phase 25e plan (binding, 2026-09-30). Planning phase 25e (admin changes
with confirmation and audit) raised eleven questions (plans/phase-25e-questions.md); the owner
accepted all eleven as recommended. A controller ruling of the same day applies the 25d Q7 rule to
change confirmations (FR-030's notes).

1. **Turning the pop-up off (FR-041). Accepted.** The stack parameter `McpConfirmElicitation`,
   changed with `agentx config set mcp.confirmElicitation`.
2. **Stopping a workspace (FR-030). Accepted.** Cancel the running task; its compute stops when
   idle.
3. **Revoking a sign-in (FR-030). Accepted.** End every session; the person may sign in again.
4. **Naming a developer (FR-030). Accepted.** By Slack user ID before their first sign-in, by an
   email they signed in with, or by developer ID.
5. **A new revision's worker setup (FR-030). Accepted.** Copied from the latest revision; a first
   revision goes through `agentx admin project register`.
6. **How the CLI confirms (FR-041, FR-042). Accepted.** The CLI shows the effect and asks "Apply
   this change?" (or `--yes`), audited as `cli`; `agentx config set limits.*` needs the admin
   sign-in (D35).
7. **Changes not about one project (FR-015). Accepted.** Any AgentX admin.
8. **Naming a channel (FR-030). Accepted.** A channel ID, or a public channel's name.
9. **Declined, expired and stale changes (FR-030, FR-049). Accepted.** Errors naming the change;
   `applied` and `awaiting_confirmation` are results.
10. **A share-mode change tool (FR-030). Accepted.** None in this phase; the CLI command covers it.
11. **The admin API version (FR-028, FR-048). Accepted.** It moves to `1.1`.

Decisions made in this spec, all owner-confirmed on 2026-09-27:

- **D1. The control plane issues its own developer tokens** (owner-confirmed, 2026-09-27). It exchanges the Slack or
  company code server side and issues a 1-hour AgentX JWT and a 7-day rotating refresh token,
  verified by the broker on `/v1/dev/*` (D17; at first a second JWT authorizer). Why: Slack's token exchange needs the client
  secret, which a laptop cannot hold; Slack's ID tokens live about five minutes; one issuer means one
  standard token check; revocation is in AgentX's hands; and the hosted MCP endpoint later needs an
  OAuth authorization server, which this already is. Rejected:
  - a Lambda authorizer that accepts Slack and company tokens directly: it still cannot do Slack's
    exchange from a laptop, and puts custom code in front of every admin route;
  - federating Slack and the company IdP into Cognito: it puts every developer in AgentX's user list,
    which the owner kept for admins and trials, does not work for environments that bring their own
    OIDC, and costs per federated user;
  - one route prefix and JWT authorizer per provider: Slack's exchange problem remains, and each new
    provider needs new routes.
- **D2. Company sign-in users are linked to Slack by verified email** (owner-confirmed, 2026-09-27), for
  channel-based access, the shared-thread mention, the Slack Confirm button and the shared limit
  counter. Rejected: asking each person to also sign in with Slack (two sign-ins), and no link
  (company users could use only granted projects, and company-signed-in admins would have no Slack
  button).
- **D3. Continue-mode messages go through the existing Slack thread machinery** (owner-confirmed, 2026-09-27): the
  ingress queues them on the Slack request FIFO queue in the thread's message group, and the Slack
  service runs an ordinary Slack turn with the orchestrator model, acting on the task's workspace
  (FR-035, FR-054). Why: it reuses the per-thread ordering, the person and channel checks, the rate
  limit, per-message attribution, the action gate, conversations and turn records as they are, and a
  teammate's plain-language message is exactly what the orchestrator model already interprets.
  Rejected: turning each mention into a direct follow-up to the worker (it would need a second
  ordering mechanism, and raw Slack text would reach the worker with no model to ask for missing
  details or refuse connector writes without confirmation). The owner's rule that AI-tool
  instructions skip the model still holds: only teammates' Slack messages use it.
- **D4. The developer's own follow-up does not queue behind channel turns** (owner-confirmed, 2026-09-27). While a
  channel turn holds the workspace, `agentx_continue_task` returns `TASK_BUSY`, naming who is
  driving and how many channel messages wait; the developer can wait, cancel the current operation,
  or switch the thread to view only. Channel turns wait for the workspace to be free (up to 30
  minutes). Why: the workspace already allows one active operation, so instructions cannot collide,
  and it avoids passing developer requests through the Slack service. Rejected: queueing developer
  follow-ups in the thread's FIFO group (the Slack service would carry AI-tool requests, which needs
  a new signed message type).
- **D5. Policy overrides downgrade instead of refusing** (owner-confirmed, 2026-09-27): required sharing shares a
  task that did not ask to be shared, and `allowContinue: false` makes a continue request view only;
  the result says which and why. Rejected: refusing the start (the AI tool would retry with other
  flags; refusing adds a round trip and no protection).
- **D6. The default share mode is view only** (owner-confirmed, 2026-09-27), so opening a task to the channel is a
  deliberate choice. Rejected: continue by default (a developer who shares to inform the team would
  hand the task to anyone in the channel).
- **D7. A Slack Confirm press applies the change server side at once** (owner-confirmed, 2026-09-27), even if the
  tool call has stopped waiting, within the 10-minute expiry. Why: the press is the confirmation, and
  the control plane checks it itself. Rejected: making the admin call a second tool to apply (an
  extra step the model would drive, and the button would not mean what it says).
- **D8. Workspace limits live in a control-plane setting that the broker reads, not in a stack
  update** (owner-confirmed, 2026-09-27). The stack parameters stay as install-time defaults (FR-053). Why: it is
  simpler (one DynamoDB item the broker already has access to, read in the same place the limits are
  checked), safer (no CloudFormation change set, no operator role, no chance of replacing a resource,
  takes effect at once, and is recorded in the change audit), and it works from an AI tool, which has
  no AWS credentials. Rejected: a parameter-only stack update (needs the operator role and
  CloudFormation rights the admin's AI tool does not have, and takes minutes), and SSM (adds an SSM
  read and IAM grant on the broker's hot path for no gain). Spec 015 FR-048 maps both limit keys
  to this setting.
- **D9. The turn record schema gains `origin`** (owner-confirmed, 2026-09-27), with the AI-tool fields in place of
  the Slack event and requester, and records keyed by task. Teammates' continue-mode turns are Slack
  records that also carry the task ID. Rejected: a separate table (admins would read two exports).
- **D10. Waits are capped at 600 seconds, default no wait** (owner-confirmed, 2026-09-27), with progress every 15
  seconds. Why: MCP clients time out long calls; a task that outlives the wait keeps running.
- **D11. A new notifier function posts to Slack for shared tasks and admin confirmations**
  (owner-confirmed, 2026-09-27), so the broker still cannot read the Slack secret. Rejected: giving the broker the
  Slack secret, and sending the developer's status posts through the Slack service's request queue
  (that service runs the orchestrator model, which the developer's own path must not use).
- **D12. Admin CLI commands keep working without the new confirmation** (owner-confirmed, 2026-09-27): a person types
  them, and changing them is outside this spec.
- **D13. Access tokens last 1 hour; refresh tokens rotate and end 7 days after sign-in; Slack users
  are rechecked at each refresh** (owner-confirmed, 2026-09-27). Rejected: 30-day sessions (a person who leaves keeps
  access too long for company sign-in, which is not rechecked).
- **D14. Sign-in exists only in named environments, until the owner decides about production**
  (owner-confirmed, 2026-09-27). Every resource, parameter and environment variable this phase adds
  is created only when the environment uses environment naming; the legacy templates, and so
  production, do not change. Bringing developer sign-in to production needs production moved to
  environment naming, or a separate owner decision; neither happens in this phase.
- **D15. Sign-in settings reach the control plane by a parameter-only stack update, with SSM as
  their source of truth** (owner-confirmed, 2026-09-27). The environment's Slack team ID and the
  sign-in settings of FR-010 are stored at `/agentx/<env>/signin` and `/agentx/<env>/slack/teamId`.
  `agentx init`'s `developer-signin` step and `agentx signin enable|disable` apply them with a
  CloudFormation change set that keeps the existing template and every other parameter unchanged,
  and every control-plane deploy reads the stored settings back, so a plain `agentx deploy` or a
  later `init` run never resets sign-in to the template's disabled default. When applying new Slack
  or company sign-in credentials, the previous secret is put back only once the stack update has
  settled as failed (a rollback or a failed update); a stack update that is still running, or a check
  that times out, keeps the new credentials in place and never restores the old ones, because the
  update may still succeed.
- **D16. Access tokens carry `sid`, and the broker checks the session on every request**
  (owner-confirmed, 2026-09-27). Alongside FR-005's `sub`, `amr` and `env`, the JWT also carries
  `sid`, the sign-in session's ID. The broker checks that session on every `/v1/dev/*` request, so a
  revoked or ended session (a reused refresh token, or a disabled sign-in method) stops access at
  once, instead of only once the access token next expires.

- **D17. The broker verifies developer tokens itself** (owner-approved, 2026-09-27). The broker
  verifies developer tokens itself, because API Gateway's JWT authorizer must reach the issuer's
  discovery document at creation time and our issuer lives on the same API; found in the live check
  on 2026-09-27. `ANY /v1/dev/{proxy+}` has no API Gateway authorizer and is throttled like
  `/v1/auth/*`. The broker reads the public keys by invoking DeveloperIdentity's JWKS route (it may
  not call `kms:GetPublicKey`), keeps them for the Lambda's lifetime, refetches at most once a minute
  on an unknown key ID, and answers 503 when the keys cannot be read.

- **D18. The start transaction writes three records beside an ordinary workspace, and the first
  task is queued inside the prepare's result transaction** (build ruling, 2026-09-28;
  owner-confirmed after the live check, 2026-09-29). FR-018's start transaction creates the task index entry, a
  pointer record holding the pending instructions and the idempotency key, and the workspace's
  `developer` membership, beside an ordinary workspace. Preparing the workspace runs through the
  existing prepare path unchanged; the transaction that records a successful prepare also creates
  the conversation and queues the pending instructions as the task's first turn, so the client
  never makes a second call. Why: this keeps FR-018's no-further-call promise true by reusing
  `recordTerminalResult`, which every prepare result already goes through, instead of adding a
  second operation path. This is the build's reading of FR-018's original "existing operation,
  outbox and dispatcher path" wording, which this same amendment replaces.
- **D19. Developer-task audit is three stages, with one exception** (owner decision, accepted,
  2026-09-28). An `accepted` record is written in the action's own transaction; a `completed`
  record, holding the result summary, is written when the task or publish operation ends; and a
  start refused after its request parses writes a `refused` record. The one exception: a cancel
  that finds nothing running has no action transaction to join, so its `accepted` record is written
  on its own. FR-037 carries this.
- **D20. `agentx_open_pull_request` and `agentx_close_task` return at once; the AI tool checks
  back** (owner decision, changed from the recommended 120-second wait, 2026-09-28). Both tools
  answer immediately with a started status and the operation or task reference; neither waits for
  the publish or the close's unpublished-work check to finish. The AI tool learns the outcome by
  calling `agentx_get_task` afterward. The task wait (`agentx_start_task`, `agentx_continue_task`
  and `agentx_wait_for_task`, off by default, at most 600 seconds) is the only wait and is
  unaffected. FR-030 and FR-049 carry this.
- **D22. A task's workspace shows in the project's workspace list, without its details** (owner
  decision, 2026-09-29). `GET /v1/dev/workspaces` and `agentx workspaces` (spec 041) list every
  workspace of a project the caller may use, AI-tool task workspaces included, with only the
  workspace ID, project revision, status, whether it is busy, and its times. A task's title,
  instructions, progress, events and results stay visible only to the developer who started it
  (FR-036). The install guide says so.
- **D21. A stuck task setup is ended by a sweep, not by a "last attempt" signal** (owner decision,
  2026-09-28). In 25b, a temporary AWS error while queuing a task's first instructions fails the
  start at once: the worker gives up after three silent callback attempts, and nothing else ends a
  prepare on a healthy instance, so retrying would leave the workspace stuck in setup with its slot
  taken. A sweep in the existing reaper or reconciler that fails any prepare older than 50 minutes
  (owner decision, 2026-09-29, raised from 15 minutes because the provisioner allows 45) covers this and every other cause (a lost callback, a hung worker), stays inside the control plane,
  and makes the retry safe. A "last attempt" field in the worker's callback was rejected: it covers
  only this one case and changes the worker contract. FR-055 carries this, in 25c. The worker
  retries a failed result callback three times after the first try, waiting about 2, 8 and 30
  seconds (about 40 seconds in all, instead of 250 and 500 milliseconds), so a throttled or briefly
  failing control plane has a real chance to accept the result before the 50-minute sweep ends the
  setup (build ruling, 2026-09-29). This needs a new worker image to reach an install.
- **D23. The notifier reads the state table's stream and posts from its own queue** (build
  ruling C7, owner-approved with the phase 25c plan, 2026-09-29). The `DeveloperTaskNotifier` is
  triggered by the state table's stream, filtered to task, pointer and developer-operation changes;
  it turns each change into a notice on its own queue and posts from there, retrying for an hour.
  Why not a send from the broker: the broker may not read the Slack secret (FR-034), a send inside
  the broker's request would add Slack's latency and failures to every developer call, and a send
  after the commit could be lost when the Lambda ends. The stream carries every committed change
  exactly as stored, so nothing is posted for a change that did not commit, and nothing committed is
  missed. It is the stream's second and last reader; later needs add filters.
- **D24. A task's share state lives on the task, replaced whole under `shareVersion`** (build
  ruling C1, owner-approved with the phase 25c plan, 2026-09-29). The share (mode, channel, reason,
  thread, times) is one field of the developer task record. Every writer (the start, the share
  route, the admin route, the notifier recording the thread, a close) replaces it whole on the
  condition that `shareVersion` has not moved, and retries from a fresh read when it has. The
  notifier records the thread on the task and writes the `SHARED_TASK` record in one transaction,
  and a close that meets a changed share re-reads it, so the thread record never misses the close
  (build ruling F4). Why: two writers merging parts of the share could leave a thread whose mode or
  close the ingress never sees.
- **D25. The broker resolves a continue thread to the task's owner key** (build ruling C11,
  owner-approved with the phase 25c plan, 2026-09-29). When the Slack service asks for a shared
  thread's workspace, the broker reads the `SHARED_TASK` record: in continue mode, on a channel that
  still serves the task's project, the service identity acts on the task's workspace with the
  task's owner key, and the teammate is the requester (FR-054). A view-only thread, a closed task's
  thread, and a thread whose channel now serves another project answer `VIEW_ONLY` (with `closed`
  set for a closed task), so no thread workspace is made for them and nothing runs. Why: the
  existing thread machinery (queue, gate, conversation) then serves continue turns unchanged, and
  the one place that decides who may act on the task is the broker.
- **D26. The developer's own run stays private from a shared thread** (build ruling, 2026-09-29,
  under D22). A teammate's orchestrator learns only that the task is busy, never the developer's
  operation ID, and gets 404 for the developer's operations, events and artifacts, exactly as for an
  unknown ID. The busy signal is still sent, so a teammate's turn waits for the developer's run
  instead of colliding with it. FR-054 carries this.
- **D27. A closing task still counts, and the Slack limit reply counts AI-tool tasks** (build
  ruling, 2026-09-29; the 25b follow-up from owner decision 10). A task holds its workspace slot
  until its close completes, so a closing task still counts toward the limit and toward the open
  task count the Slack limit reply gives. When a member reaches the per-person limit, the Slack
  reply also says how many of their workspaces are tasks started from an AI tool, and to close one
  there with `agentx_close_task`. Only the count reaches the channel, never a task's title or ID
  (D22).
- **D28. The admin API has its own version** (owner decision, 2026-09-30; Q1). The control plane
  reports `adminApiVersion` (`1.0` from phase 25d) beside `DEVELOPER_API_VERSION`, which stays
  `1.2`. The MCP server offers the admin tools only when the admin major matches and the admin
  minor is not older than the tools need; otherwise the developer tools keep working, the admin
  tools are not offered, `agentx_whoami` says an AgentX upgrade adds them, and a direct call answers
  `UPGRADE_REQUIRED`. Why not move `DEVELOPER_API_VERSION` to `1.3`: FR-048 then makes a new CLI
  refuse every tool, the developer ones included, until the admin upgrades AgentX, although the
  developer tools did not change. 25e moves only the admin version, to `1.1` (owner decision,
  2026-09-30; 25e Q11). FR-028 and FR-048 carry this.
- **D29. The failure and usage indexes are written by the outbox publisher, and expire by TTL
  where the table allows it** (owner decision, changed, 2026-09-30; Q5). The outbox publisher
  already reads every record of the state table's stream, the legacy deployment's included, and
  may write the table, so it derives each failure index item from the operation changes it reads
  and each usage index item from the usage events it sees inserted, with conditional puts so a
  replayed record writes nothing twice. A failed index write is logged and never fails the batch,
  and each index read and write is abandoned at the publisher's deadline, so dispatch is never
  delayed or repeated by it. Why not a third
  stream reader: the stream keeps two (FR-034, D23). Why not a write in every operation path: each
  path that ends an operation would need the same write and could miss one; the stream sees every
  committed change once. Each item carries `indexExpiresAt`, 30 days on; in installed environments
  the State table's TTL on that attribute deletes it, and in the legacy deployment, whose templates
  never change, each session reconciler run deletes the items of the days 31 to 45 back, at most
  500 a run. Every read also stops at 30 days and skips an expired item. FR-038 carries this.
- **D30. The admin project list comes from a project catalog, not a scan** (owner decision,
  2026-09-30; Q2). Each registration also writes a catalog entry for its project in its own
  transaction. The admin project list is the catalog's names, the environment team's bound
  projects, and the caller's own memberships (its `MEMBER#` rows), each counted only while it still
  has a revision. A project registered before this release that nobody binds and another admin
  registered appears after its next revision; the CLI still works on it by name. Why no scan: a
  scan gets slower and costlier as the table grows, and every admin read would pay for it. A
  one-time background fill for older projects can be added later without changing this. FR-038
  carries this.
- **D31. The admin's email comes from the admin issuer's `userinfo` endpoint** (owner decision,
  2026-09-30; Q3). `GET /v1/admin/me` takes the admin's name and email from the token's own claims
  when it carries them, else from the admin issuer's standard OIDC `userinfo` endpoint, called with
  the admin's own token (found through the issuer's discovery document, HTTPS only, 3-second
  timeout, cached per token for 5 minutes). The email counts only when it is marked verified; it
  then says whether it matches one Slack user (FR-012's lookup), which 25e's Slack Confirm button
  and audit name use. Why: Cognito's access tokens carry no email, and `userinfo` needs no setup.
  Rejected: sending the ID token with each admin call (more moving parts in the CLI, and it expires
  with the access token anyway), and a hand-made Slack link per admin (one more setup step, and a
  mistyped link would send Confirm buttons to the wrong person). An issuer without `userinfo`
  leaves the admin with no Slack link, and the pop-up confirmation still works. FR-038 carries
  this.
- **D32. A change applies at most once through a claim, not one transaction around the handler**
  (build ruling E5, 2026-09-30). An apply or a Confirm press re-plans the change and compares the
  state hash (`CHANGE_STALE` otherwise, and the change fails); then one conditional update moves
  it from `pending` to `applying` only while it is unexpired, planned by the same admin and
  confirmed by an offered method; only then does the existing admin handler run, and a last update
  records `applied` or `failed`. A change left in `applying` for over 2 minutes reads as `failed`
  ("the apply did not finish; check the state, then ask again"). A transient failure leaves the
  change pending to try again (controller ruling, 2026-09-30). Why not one DynamoDB transaction
  holding the claim and the change: the existing handlers (registration, binding, grants, cancel,
  sessions) each write in their own way, some outside the State table or through
  DeveloperIdentity, and rewriting every one as transaction items would change handlers that already
  work and are tested. The claim makes a second apply impossible; the honest limit is the window of
  milliseconds between the hash check and the handler's own write, which the handlers' own
  conditions (such as registration's immutable revisions) narrow further. FR-040 carries this.
- **D33. The audit record lives in the TurnRecords table and only steps forward** (build ruling
  E3, 2026-09-30). `CHANGE#<changeId>` / `AUDIT`, under its own export partition `CHANGES`, listed
  newest first through the table's time index, and kept 30 days by the table's TTL like the turn
  records (FR-051's retention). Only the broker writes it: one conditional put when the change is
  planned, then updates that move it forward (confirmation requested, answered, applied, failed or
  expired) and never clear an outcome once set; no route changes it. At most 20 refused attempts are
  kept per change. Why this table: it already has the retention, the time index and the admin
  export that `agentx admin changes` reuses; its own partition keeps the turn export (`TURNS`)
  unchanged. FR-051 carries this.
- **D34. The Slack step is started by the MCP server, the DM comes from the stream, and a press
  applies asynchronously** (build rulings E13 and E14, 2026-09-30). The MCP server calls
  `POST /v1/admin/changes/{id}/slack` only when the pop-up is not offered or did not work; the
  broker records the request, and the notifier, reading the state table's stream through a filter
  added to D23's trigger (never a third reader), sends the admin's Slack user the DM with Confirm
  and Cancel, and edits it when the change ends. A press reaches the ingress, which checks the
  Slack signature, answers the presser at once and invokes the broker asynchronously; the broker
  accepts it only from the change's own Slack user in the environment's team. Why asynchronous:
  Slack wants an answer within 3 seconds, and an apply can take longer. Honest limit (controller
  ruling, 2026-09-30): a press applies under the planning admin's stored identity, because a press
  carries no admin token; removal of that admin's admin claim within the 10 minutes is not checked
  again at press time, while project `administrator` membership is checked again inside the
  handler at apply. FR-041 carries this.
- **D35. A typed `agentx` command confirms with the `cli` method** (owner decision, 2026-09-30;
  25e Q6). `agentx admin project grant|revoke` and `agentx config set limits.*` plan through
  `POST /v1/admin/changes` with `methods: ["cli"]`, print the effect, ask "Apply this change?"
  (unless `--yes`), and apply with method `cli` or decline; the audit records `cli`. The broker
  always accepts `cli` from the planning admin, as D12 accepts any `agentx admin` command a person
  types. Why: the person typing the command is the confirmation, and a Slack press for a typed
  command would make an admin with no Slack link unable to use it. Honest limit: a model with shell
  access and the admin's sign-in could run `--yes`, as it can run any `agentx admin` command
  today. Every existing `agentx admin` command is unchanged. FR-042 and FR-053 carry this.

## Assumptions and Scope

- **Assumptions:**
  - The Slack app can add Sign in with Slack (user scopes `openid`, `email`, `profile`) and the extra
    bot scopes of FR-044. Workspaces that need admin approval for scope changes follow spec 015's
    approval handling.
  - The company's IdP can register a confidential OIDC client with the control plane's callback URL.
  - Claude Code supports MCP elicitation; Codex and Cursor may not, and the fallbacks cover them.
  - Phase 15d1 built `agentx init`; phase 25a added the `developer-signin` step.
  - Issue #88 may remove AgentCore. Nothing here depends on it staying (FR-024).
  - **F15.** An environment installed before phase 25a never reaches the new `developer-signin`
    `init` step on a later `agentx init` run, because `runInit` refuses to continue when the release
    it was installed with differs from the CLI's own release. Such environments turn sign-in on with
    `agentx signin enable` instead.
  - Rolling back to a release before 25b needs a project revision without `developerTasks` first,
    since an older control plane's strict schema cannot read it; the release notes say so (owner
    decision, 2026-09-28).
  - Carried forward from 25d, not built in 25e: the health route's state reads have no time bound
    and read every project at once (a deferred minor finding; 25e did not touch the health route).
- **In scope:** everything in the requirements above, delivered in the phases of
  [plans/README.md](plans/README.md).
- **Out of scope:**
  - The hosted MCP endpoint (`https://<agentx>/mcp` with OAuth). A later phase; FR-001 and FR-027
    are shaped so it needs no rework.
  - AgentX's Slack orchestrator model interpreting AI-tool requests. AI-tool instructions go
    straight to the worker.
  - Linear, Jira, Asana and GitHub connector tools offered directly to AI tools. A possible
    follow-up, which would reuse the gateway and its action policy.
  - The action gate for the developer's own instructions: they call no connector tools. Teammates'
    turns in continue mode are Slack turns, and the action gate applies to them as today.
  - Billing, and charging usage back to developers.
  - Tasks started from Slack becoming private, or being handed to an AI tool.
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
  - the confirmation flow: each method, each refusal of FR-040 and FR-041 (SC-005); the audit record
    for every outcome, redaction of the proposed change, and trace IDs in each step's logs (SC-011);
  - the workspace limits setting: fallback to the stack parameters, validation, lowering below the
    current count, and use in both Slack and developer limit checks (SC-013);
  - share rules, modes and policy overrides; the thread's messages; the ingress notice in view only;
    continue-mode routing to the task's workspace, ordering and attribution (SC-012);
  - the project errors: not found, access denied with and without visible channels, tasks disabled;
  - `mcp install` for each client against a temporary home directory, leaving other entries alone;
  - the turn record schema: old Slack records still parse; AI-tool records round-trip.
- **Contract tests (every PR, no network):**
  - the MCP server over stdio, driven by the MCP SDK's client, against the broker running in process
    with a fake DynamoDB, fake Slack, fake providers and a fake dispatcher, through every user story;
  - the developer task flow with an `ec2-ebs` runtime binding, and a source scan proving no
    developer task code reads the deployment mode (SC-009);
  - the existing Slack, control-plane, ingress and CLI suites, unchanged (SC-008);
  - `cdk synth` with the second authorizer, the new routes and the notifier's permissions; a test that
    only the notifier, the ingress, the orchestrator role and the `DeveloperIdentity` sign-in function
    can read the Slack secret.
- **Live check (once per phase that changes behavior, with the owner present):** in a throwaway
  environment, with a real Claude Code session:
  - sign in with Slack, and with a company OIDC test provider; a sign-in from another Slack team is
    refused;
  - hand off a task and move on; check status; open a PR; continue it;
  - wait for a small task; let a wait time out;
  - share a task view only and mention AgentX in its thread; share one in continue mode and steer it
    from the thread as a teammate, then continue it from Claude Code; require sharing on a project;
  - as admin: read health, failures, turns and usage; bind and unbind a channel with elicitation and
    with the Slack button; decline one change and let one expire; change a workspace limit; read all
    of them back with `agentx_admin_changes` and `agentx admin changes`; see the change tools
    disappear in a client with neither method;
  - measure SC-001, SC-002 and SC-006, and run on each worker mode the environment has.
