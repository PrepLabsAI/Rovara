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
  Slack thread; `agentx_continue_task` uses it too.
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
- **FR-018**: `POST tasks` MUST, in order: check the token; check that the project exists
  (`PROJECT_NOT_FOUND`), that the developer may use it (FR-013, `PROJECT_ACCESS_DENIED`) and that
  `developerTasks.enabled` is true (`PROJECT_TASKS_DISABLED`);
  check sharing (FR-031); check the workspace limit (FR-020); create the task index entry, the
  workspace with a `developer` membership for its owner key, and an idempotency record keyed by the
  client's request ID, in one transaction; and return `STARTING` with the task ID. Preparing the
  workspace, creating the conversation and accepting the task (the existing prepare, conversation
  and task handlers) MUST then run through the existing operation, outbox and dispatcher path, with
  no further call from the client.
- **FR-019**: The instructions MUST be sent to the worker as the task prompt, unchanged, with the
  existing 65,536-byte limit. No AgentX model reads, rewrites or plans them. The worker gets the same
  tools and limits as a Slack task's worker.
- **FR-020**: A developer task MUST count against the same workspace limits as Slack threads (by
  default 3 per person and 20 per organization, FR-053). A developer linked to a Slack user
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
  | `agentx_list_projects` | none | per project: name, description, bound channels, `share` policy, `shareMode` policy, whether tasks are enabled |
  | `agentx_start_task` | `project`; `instructions` (up to 65,536 bytes); `title` (optional, up to 120 characters, else the first line of the instructions); `share_to_channel` (optional, default false); `share_mode` (optional, `view` or `continue`, else the project's default); `channel` (optional); `wait_seconds` (optional, 0 to 600, default 0); `request_id` (optional UUID, else generated) | task ID, status, project, starting revision, `shared`, `share_mode` and the reason for any policy override, thread link if shared; with a wait, the same as `agentx_get_task` plus `timed_out` |
  | `agentx_get_task` | `task_id`; `events` (optional, 0 to 50, default 10) | status, failure if any, title, project, times, latest events, and once ended: summary (up to 4,000 characters), changed files with line counts, artifacts (name, size), pull requests (URL, state); in continue mode, the channel's turns (author, time, request up to 300 characters, outcome) |
  | `agentx_wait_for_task` | `task_id`; `wait_seconds` (1 to 600) | as `agentx_get_task`, plus `timed_out` |
  | `agentx_list_tasks` | `project` (optional); `status` (optional); `limit` (1 to 50, default 20) | the developer's tasks, newest first: ID, title, project, status, times, shared |
  | `agentx_continue_task` | `task_id`; `instructions`; `wait_seconds` (optional) | as `agentx_start_task` |
  | `agentx_cancel_task` | `task_id` | status after the request |
  | `agentx_close_task` | `task_id` | status `CLOSED`; the workspace is released and stops counting against limits |
  | `agentx_share_task` | `task_id`; `share_mode` (optional); `channel` (optional) | thread link and mode; on a task already shared, it changes the mode (within the project's policy) |
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
  | `agentx_admin_list_workspaces` | `project` (optional); `status` (optional); `limit` (1 to 100) | per workspace: ID, project, origin, owner (thread link or developer name), status, last activity; the current workspace limits and counts |
  | `agentx_admin_changes` | `since` (default 7 days ago); `until` (optional); `admin` (optional); `outcome` (optional); `limit` (1 to 100); `cursor` (optional) | admin change audit records (FR-051), newest first, plus the next cursor |

  **Admin change tools** (each call plans the change, gets the confirmation and, only when
  confirmed, applies it, all within the one call; FR-039 to FR-041)

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
  | `agentx_admin_set_workspace_limits` | `per_person` (optional, 1 to 50); `per_organization` (optional, 1 to 1,000) | the current and new limits, the current counts, and which people or the organization are already at or over the new limit |

  Every change tool returns the change ID, the outcome (`applied`, `declined`, `expired`, `failed`
  or `awaiting_confirmation` when a Slack wait ended first) and the result.

- **FR-031**: Sharing: when `share_to_channel` is true or the project's `share` is `required`, the
  task MUST be shared. A shared task needs a bound channel: the named `channel`, or the only bound
  channel; otherwise the start MUST be refused (`CHANNEL_REQUIRED` or `CHANNEL_AMBIGUOUS`) before
  anything starts. The share mode is the developer's `share_mode`, else the project's
  `shareMode.default`; when `allowContinue` is false it MUST be `view`. When the policy forced
  sharing or view only, the result MUST say so.
- **FR-032**: A shared task's thread MUST show:
  - the start message: the developer (a Slack mention when linked, else their display name), the
    client name, the title, the project, and the mode: in view only, that follow-ups happen in the
    developer's AI tool; in continue, that channel members may mention AgentX here to steer it;
  - replies when the workspace is ready, when an operation the developer started ends (status, and
    the summary up to 1,500 characters, redacted), when a pull request opens (its URL), when the
    mode changes, and when the task is cancelled or closed;
  - in continue mode, the ordinary Slack turn replies to teammates' mentions.

  The developer's instructions beyond the title, events, diffs and artifacts MUST NOT be posted.
- **FR-033**: The client name MUST come from the MCP `initialize` request's `clientInfo.name`,
  mapped to `Claude Code`, `Codex` or `Cursor` for their known names, and otherwise to "an AI tool".
  It MUST be at most 40 characters and cleaned like Slack display names.
- **FR-034**: Slack posts for shared tasks and admin confirmations MUST be sent by a new
  `DeveloperTaskNotifier` function, the only new role that may read the Slack secret, triggered by
  the task's status changes and by new pending changes. Failed posts MUST be retried for 1 hour and
  then counted in the failed Slack delivery metric (spec 015 FR-045). Replies to teammates' turns in
  continue mode are posted by the Slack service, as for every Slack turn.
- **FR-035**: The control plane MUST keep a record for each shared thread
  (`SHARED_TASK#{team}/{channel}/{threadTs}`) with the task, its workspace owner key and the mode.
  The Slack ingress MUST check it for every mention in a thread:
  - in view only, it MUST answer with one fixed notice per hour per thread, without creating a
    thread workspace or queueing a turn;
  - in continue, it MUST queue the message exactly as it queues any thread message today: on the
    Slack request FIFO queue, in the thread's message group, after the same checks (a person, a
    member of the bound channel, the thread's rate limit).
- **FR-054**: In continue mode, the Slack service MUST handle a queued message as an ordinary Slack
  turn with the orchestrator model, the action gate and the thread's conversation, but acting on the
  task's workspace: the broker's service identity MUST resolve a shared thread in continue mode to
  the task's workspace owner key instead of the thread's own key, and record the teammate as the
  requester of every operation the turn starts. A turn MUST start only when the task's workspace has
  no active operation; it MUST wait up to 30 minutes for that, then answer that the task is still
  busy. No new workspace is created and no workspace limit is charged. The developer's own
  instructions still go straight to the worker (FR-019).

**Visibility and audit**

- **FR-036**: A developer task MUST be visible through `/v1/dev/*` only to the developer who started
  it. Any other caller MUST get `TASK_NOT_FOUND`.
- **FR-037**: Every start, continue, pull-request request, cancel and close of a developer task MUST
  write a turn record. The turn record schema MUST gain `origin` (`slack` or `ai_tool`, absent read
  as `slack`) and, for `ai_tool`, `taskId`, `developer` (`developerId`, provider, display name,
  linked Slack user if any) and `client` in place of the Slack event ID and requester. They MUST be
  keyed `TASK#{taskId}`, keep the 30-day retention, hold the instructions redacted and capped as
  request text and the result summary as response text, and appear in `GET /v1/admin/turns` and
  `agentx_admin_turns`. Teammates' turns in continue mode are ordinary Slack turn records that also carry
  `taskId`.
- **FR-038**: The control plane MUST index each operation that ends `FAILED` or `INTERRUPTED`
  (`FAILURE#{yyyy-mm-dd}` / `{endedAt}#{operationId}`, 30-day expiry) for `agentx_admin_failed_tasks`.
  It MUST also serve `GET /v1/admin/projects`, `GET /v1/admin/slack/bindings`,
  `GET /v1/admin/workspaces`, `GET /v1/admin/failures`, `GET /v1/admin/usage`,
  `GET /v1/admin/health`, `GET /v1/admin/me` and `GET /v1/admin/changes` for the admin read tools,
  with the same admin check as today.

**Admin changes and confirmation (US6)**

- **FR-039**: Every admin change tool MUST call `POST /v1/admin/changes` with the change and the
  MCP session's details (FR-051's client fields). The control plane MUST check the admin's rights,
  compute the exact effect against current state, and store a pending change: its ID, the admin,
  the effect, a hash of the state it was planned against, the confirmation methods offered, and an
  expiry 10 minutes later. It MUST write the change's audit record at the same time. Nothing changes
  until the change is confirmed.
- **FR-040**: A confirmed change MUST be applied in one transaction that checks that the change is
  pending, unexpired, planned by the same admin, confirmed by an offered method, and that the state
  hash still matches; it MUST then apply the change through the existing admin handler and mark it
  used. A change MUST apply at most once. A declined change (the elicitation declined or cancelled,
  or the Slack Cancel button) MUST be marked declined through `POST /v1/admin/changes/{id}/decline`
  or the interactivity route.
- **FR-041**: The confirmation methods, in order of preference:
  1. **MCP elicitation** (the client's pop-up), when the client declared the `elicitation`
     capability and the environment allows it (`mcp.confirm.elicitation`, default on). The server
     MUST send `elicitation/create` with the effect text and one boolean field, and call
     `POST /v1/admin/changes/{id}/apply` only on `accept` with the field true.
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
- **FR-042**: The CLI's existing `agentx admin ...` commands MUST keep working unchanged, without
  this confirmation, because a person types them.
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
- **FR-052**: Admin change handling MUST be traceable end to end. The MCP server MUST send a trace
  ID (`x-agentx-trace-id`) with every control-plane call; the control plane, the notifier, the Slack
  interactivity route and the apply step MUST write it, with the change ID, in a structured log line
  at each step; and the control plane MUST emit a metric per outcome. Admins MUST be able to read
  the records through `GET /v1/admin/changes`, the `agentx_admin_changes` tool, and
  `agentx admin changes --since <time> [--json]`, which exports them like `agentx admin turns`.
- **FR-053**: The per-person and per-organization workspace limits MUST be changeable without a
  CloudFormation change. The control plane MUST store them as a setting in its state table
  (`SETTINGS` / `WORKSPACE_LIMITS`, with the admin and time of the last change). The broker MUST read
  the setting at each workspace creation, with a consistent read, and use it in the existing limit
  conditions; when the setting is absent it MUST use the stack parameters `SlackMemberWorkspaceLimit`
  and `SlackOrganizationWorkspaceLimit` (defaults 3 and 20), which stay as the install-time
  defaults. The per-person limit MUST NOT exceed the per-organization limit. Lowering a limit MUST
  NOT stop existing workspaces. The admin change tool `agentx_admin_set_workspace_limits` changes the
  setting with confirmation and audit (FR-039 to FR-052); spec 015 phase 15e's
  `agentx config set limits.workspacesPerMember|limits.workspacesPerOrg` covers the same setting from
  the CLI (spec 015 FR-048).

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
  version differs.

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
  | `CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`, `CHANGE_STALE` | the change was declined, timed out, or state moved | ask for the change again |
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
    task's workspace is reachable only by the developer who started it, and, while the developer
    shares it in continue mode, by the members of the bound channel who post in its shared thread.
    Personal workspaces not tied to a task stay retired.

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
  confirmation state.
- **Admin change audit record**: one per change request: who asked, the client, the exact change,
  the method, the outcome with timestamps, the result and a trace ID (FR-051).
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
- **SC-008**: The existing Slack, control-plane, ingress and CLI suites pass with no assertion removed
  or weakened; lists of commands, init steps and manifest scopes gain the new entries.
- **SC-009**: The developer task contract tests pass with both an AgentCore and an `ec2-ebs` runtime
  binding.
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
  - the same developer task flow with an AgentCore runtime binding and an `ec2-ebs` one (SC-009);
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
