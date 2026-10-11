# Working in Slack

How the hosted orchestrator handles a Slack thread: connectors, confirmations, shared tasks, what a thread remembers, and diagnostics.

Rovara runs a hosted orchestrator for Slack in the environment's own AWS account, so no developer
machine has to stay online. Slack calls the Rovara Events API route; an ingress Lambda verifies
Slack's signature, acknowledges in the thread, and queues the request. An ECS Fargate service runs
the Pi orchestrator for that thread and posts the result back. It can call Rovara orchestration
tools and administrator-approved GitHub MCP tools; repository coding work runs in the remote Pi
worker.

Each Slack thread has its own workspace. The first request in a new thread that needs the remote
worker creates a workspace for the channel's bound project. Later mentions in that thread, by any
channel member, continue in the same workspace and Pi conversation. Requests in one thread run in
order; different threads run in parallel.

An administrator may add a `models` block to a project revision with a `default` model and up to
16 `approved` provider/model pairs. The default must be in the approved list; optional labels must
be unique. Verify that the worker role can use every approved model in the deployment account and
region before registering the revision. For example:

```yaml
models:
  default: { provider: amazon-bedrock, modelId: model-balanced, label: Balanced }
  approved:
    - { provider: amazon-bedrock, modelId: model-balanced, label: Balanced }
    - { provider: amazon-bedrock, modelId: model-fast, label: Fast }
```

In the bound Slack channel, `@agentx models` lists the choices and `@agentx use Fast` selects one.
The selection applies to every workspace in the project on its next coding turn, including existing
threads. A removed selection falls back to the latest revision's default with a diagnostic. Projects
without `models` continue to use the worker deployment's model settings. During a rolling release,
deploy worker support before the broker begins sending the optional resolved-model field.

## GitHub MCP through hosted Slack

The control plane connects to GitHub's hosted MCP server, discovers its tools with `tools/list`,
and exposes only tools approved in the registered project revision. The orchestrator sees each
approved tool once, as `github__<tool>`, with a `target` argument naming the repository when the
connector covers several. Its instructions open with a list of what the channel can do and which
integrations are not connected. Calls go orchestrator → control plane → GitHub MCP, without a
worker.

See [GitHub MCP setup and policy example](../specs/007-github-mcp/quickstart.md). The policy can be
written as `integrations.githubMcp` or, since feature 013, as a `github` entry in
`integrations.connectors`, which can also limit it to named repositories; a definition may use one
form, not both. Every GitHub write signs the `body` the model supplies (an update without a body
stays unsigned) with a footer naming the requesting Slack member and thread; set
`attribution: false` on the connector entry to turn it off (the legacy `githubMcp` form always
signs). This release uses
the existing GitHub App installation with repository-scoped **Issues** permissions. Tokens stay
in the control plane. Existing projects remain disabled until an administrator registers an
opt-in revision. Arbitrary endpoints, personal OAuth, and other GitHub permission families are
not included. Existing Rovara coding and validated PR-publication tools remain unchanged.
The hosted Slack service discovers tools from the project's latest registered revision on each
mention. Calls use its IAM service identity and carry the requesting Slack user; tokens remain in
the broker. Only a prepared thread's checkout (repositories, setup, environment) stays on the
revision it was prepared from.

## Connector credentials

Each connector type is one definition in the control plane. A new type is added to the config
schema and to the built-in type map. It supplies its scopes, its credential and its binder; the
routes, catalog cache, ledger and registration checks then work for it without further change.

A binder names the arguments the server fills in and the model never sees. Some are bound on
every tool, such as GitHub's owner and repository; a tool without them is not offered. Others
are bound only on the tools that have them, such as a Linear team; other tools are offered
unchanged. A request that supplies a bound argument itself is refused.

In an installed environment, `agentx --env <name> connector add linear|jira|asana` stores the
credential under `agentx/<env>/connectors/<type>` (for example `agentx/prod/connectors/linear`)
and registers it for you, so you can skip the manual steps below. `connector add mcp` does the same
for any other MCP server, under `agentx/<env>/connectors/mcp-<name>`, with the credential pinned to
the server's host. They are for the maintainers'
deployment, whose secrets use `agentx/connectors/<name>`.

Connectors other than GitHub read their credential from an AWS Secrets Manager secret named
`agentx/connectors/<name>`, registered once with the control plane:

```sh
pbpaste | tr -d '\n' | jq -Rc '{apiKey: .}' | aws secretsmanager create-secret \
  --name agentx/connectors/linear-payments --secret-string file:///dev/stdin

agentx admin credential register --ref linear-payments \
  --type static-secret --secret agentx/connectors/linear-payments
agentx admin credential list
```

The secret must use the default `aws/secretsmanager` key. If you encrypt it with a
customer-managed KMS key instead, grant the broker role `kms:Decrypt` on that key. An `oauth-refresh-token` secret is also written back when a refresh token rotates, so on a
customer-managed key the broker role also needs `kms:GenerateDataKey` (and `kms:Encrypt` if the key
policy requires it).

A secret is one of three shapes: `static-secret` is `{"apiKey": "..."}`; `oauth-client-credentials`
is `{"clientId", "clientSecret", "scopes": [...]}`; `oauth-refresh-token` is
`{"clientId", "clientSecret", "refreshToken"}`, written by `agentx admin credential authorize` after a
bot user signs in once in a browser. The broker may write a rotated refresh token back only to a
secret tagged `agentx-writable: refresh-token`. Registration reads the secret and checks its
shape but never echoes it back, and `list` never prints a secret value, only each reference, its
type, secret name, whether it is the built-in GitHub App entry, whether a token is cached, and (for
a registered entry) who registered it and when. Linear reads a registered `static-secret` API
key; see [docs/connectors/linear.md](connectors/linear.md). Jira reads a registered
`static-secret` API token; see [docs/connectors/jira.md](connectors/jira.md). Asana reads an
`oauth-refresh-token` credential for a bot user; see [docs/connectors/asana.md](connectors/asana.md). Any other remote MCP
server connects as a generic `mcp` connector, with an API key or an OAuth sign-in pinned to its host; see
[docs/connectors/custom-mcp.md](connectors/custom-mcp.md). Registering a
revision refuses a connector whose `credentialRef` is not registered or has a type the connector
does not accept.

Registering a project revision can ask the control plane to check each connector with its vendor
by sending `preflight: true` in the registration body (the current administration client always
does). Preflight never blocks registration on that check failing: it reports which approved tools
the vendor actually offers, which it could not present, and whether the connector is connected.
It runs only when asked, so an older administration client, or an existing test, never makes a
vendor call at registration. Separately, and regardless of preflight, a project that could expose
more than 40 tools to the model (six built-in plus every connector approval) refuses registration;
above 20 tools it registers with a warning, because the model's tool choice gets less reliable
past that point.

## One-time administrator setup

This section and [the maintainers' production release](maintainers-release.md) describe the maintainers' own production deployment, which uses fixed
stack names (`AgentXControlPlane` and so on) and the `release:prod` script. An environment installed
with `agentx init` needs none of it: `init` creates the Slack app, stores its secrets and deploys the
Slack service itself.

The production release creates the Slack ingress route, queue, and thread storage in
`AgentXControlPlane`. Create the orchestrator service once with the release command's
`--create-slack-orchestrator` flag; the release pipeline updates it after that. Every release
deploys the production runtime first, then the control plane, then the Slack orchestrator service,
so the control plane's `TurnRecordsTableName` output always exists before the service that writes
to it starts. The release script reads that output and passes it to the orchestrator service as
`TURN_RECORDS_TABLE_NAME`. Read the Slack outputs from the control plane stack:

```sh
AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1 aws cloudformation describe-stacks \
  --stack-name AgentXControlPlane \
  --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Slack')].[OutputKey,OutputValue]" \
  --output table
```

Store the Slack app's **Signing Secret** (under **Basic Information → App Credentials**) and its
`xoxb-` bot token (under **OAuth & Permissions**) in the `SlackSecretArn` secret. Until you do,
the secret holds a generated placeholder and every Slack request is rejected. The commands below
read both values without echoing them or writing them to shell history:

```sh
export AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1
SLACK_SECRET_ARN='<SlackSecretArn output>'
read -rs SLACK_SIGNING_SECRET   # paste the Signing Secret, then press Enter
read -rs SLACK_BOT_TOKEN        # paste the xoxb- bot token, then press Enter
export SLACK_SIGNING_SECRET SLACK_BOT_TOKEN
node -e 'process.stdout.write(JSON.stringify({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  botToken: process.env.SLACK_BOT_TOKEN,
}))' | aws secretsmanager put-secret-value \
  --secret-id "$SLACK_SECRET_ARN" --secret-string file:///dev/stdin
unset SLACK_SIGNING_SECRET SLACK_BOT_TOKEN
```

Both services cache the secret for up to five minutes, so allow that long after a change.

Then configure the Slack app:

- Turn **Socket Mode** off. While it is on, Slack delivers events over the socket instead of the
  request URL. The app-level `xapp-` token is no longer used and can be revoked.
- Under **Event Subscriptions**, enable events and set the request URL to the `SlackEventsUrl`
  output. Slack verifies the URL immediately, which succeeds only after the secret is stored.
- Subscribe to the bot events `app_mention`, `message.channels` and `message.groups`. The two
  message events deliver replies in the thread of a task started in Slack, which are saved as input
  for the task's next step; Rovara ignores, and does not store, any other channel message.
- Bot token scopes: `app_mentions:read`, `channels:history`, `groups:history`, `chat:write` and
  `users:read` (`channels:history` and `groups:history` go with the message events). The manifest
  `agentx init` generates (`packages/cli/src/init/slack-app.ts`) lists every scope and event AgentX
  uses; prefer it to setting them by hand. Rovara uses `users:read`
  to confirm that a mention posted through another app came from a person, and to show the
  requester's name in connector write footers. Without it, Rovara does not run mentions posted
  through other apps (it says it could not confirm the sender), and footers show the Slack member
  ID. Reinstall the app after changing scopes.
- Invite the app to the project channel with `/invite @AgentX`.

Finally, bind the channel to the project. Binding requires an administrator login:

```sh
agentx --project project-a admin slack bind --team T0123456789 --channel C0123456789
```

A channel is bound to one project, not to a revision. A thread's workspace is built from the
project's latest registered revision at the moment its compute is first prepared, which is the
first request that needs the worker, so registering a revision publishes it to every bound channel
without binding again. A thread that has only answered connector questions so far has no disk
yet, so it picks up a revision registered after its first message. `admin slack unbind` removes
the binding, so new mentions in that channel are ignored, but it keeps existing thread workspaces.

Once prepared, a thread's checkout stays on the revision it was prepared with: `repositories`,
`setup`, `devcontainer` and `environment` do not change under a running thread, and a failed
preparation is retried from that same revision. Everything else follows the project's
latest registered revision from the next mention onwards: the GitHub MCP policy and the
repositories it may address, `orchestratorInstructions`, `readiness` and each repository's
`codeBuildGates`. So enabling a tool, correcting a test command or withdrawing a write tool takes
effect in every thread without starting a new one, and the thread is told once that its settings
moved. Each operation and MCP call records the revision whose settings applied. A readiness
command whose directory the workspace does not have fails that check rather than being skipped.

## Working in a thread

Mention the app in the bound channel for every request, including follow-ups in a thread. A plain
top-level `@AgentX <request>` starts a task with the Quick or Full question (see
[Starting a task from Slack](project-configuration.md#starting-a-task-from-slack)); to reach the chat
agent described in this section, start a new request with `chat:`:

```text
@AgentX chat: inspect the project and implement the navigation fix. Run the relevant tests, but do not
create a pull request.
```

Follow-ups in a thread the chat agent is already answering need no `chat:`.

Rovara replies within a few seconds. If earlier requests in the thread are still running, it says
how many are ahead, and says "Working on it now" when it starts on the request. A request with
nothing ahead gets no separate "Working on it now" notice, unless it waits for workspace setup. A
message that is only an answer to a confirmation (`yes`, `yes to all`, `cancel` and their plain
synonyms) gets no "Got it" either, unless requests are queued ahead of it. An Approve or Cancel
button press is counted the same way, so with nothing ahead the button's own "Running it now" is
the only notice. A
new thread gets a coding workspace only when a request first needs the remote worker, for example to
read or change repository files or to run commands. Questions that connectors answer, such as issue
tracker questions, need no workspace. The first request that needs the worker prepares the workspace
in the same turn, which takes a few minutes, and Rovara says so in the thread. Messages without a
mention, edits, bot messages, Rovara's own messages, direct messages, and users from other Slack
organizations are ignored.

A person can also mention Rovara through another tool that posts with their own Slack user token,
such as Claude Code's Slack access or a script. Rovara checks with Slack that the sender is a
person, then treats the message exactly as if they had typed it. A message posted with a bot token
is ignored. To answer only typed mentions, set the `AgentXControlPlane` parameter
`SlackAppPostedMessages` to `ignore` (in an installed environment,
`agentx --env <name> config set slack.appPostedMessages ignore`). This also means a person's own
tool posting "@AgentX yes" counts as that person's confirmation, the same as typing it. The **Approve** button can only be
pressed in Slack, but a typed or tool-posted `@AgentX yes` still counts, so set
`SlackAppPostedMessages` to `ignore` if only typed confirmations should count.

A thread that sends Rovara more than 6 requests in a minute is paused: Rovara posts one notice and
runs nothing more in that thread until the next minute. This stops a tool that answers Rovara's
replies from looping. The `AgentXControlPlane` parameter `SlackThreadTurnsPerMinute` changes the
limit (in an installed environment, `agentx --env <name> config set limits.threadTurnsPerMinute
<n>`). A request that Rovara could not queue is not counted, so Slack's retry of it is not held
against the thread; in the rare case where that happens during a burst at the limit, the thread
can get a second pause notice in the same minute.

Rovara posts its replies in Slack formatting, with real line breaks and one Slack link per URL.
Text such as `<!channel>` in a reply is shown as text and never notifies anyone.

Pull requests created from a thread end with a link to the thread and the Slack members who made
requests in it. Every operation records the Slack member who requested it.

Workspaces are limited to protect cost. Threads whose workspace has been prepared count, and so
do open tasks from AI tools: both share the same limits. The member whose request first prepares
a thread's workspace is charged for it. Each member may hold at most 3 workspaces, and the
organization at most 20. When a request needs a workspace over either limit, Rovara prepares
nothing and says which limit was reached; for the member limit, it also links that member's
existing threads and gives their open task count. It still answers any part of the request that
connectors can answer. In the maintainers' deployment, an administrator changes the limits with the
`AgentXControlPlane` parameters `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`.
An installed environment starts from the same defaults, and `agentx --env <name> config get
limits.workspacesPerMember` (or `limits.workspacesPerOrg`) shows them. To change them, an
administrator signed in with `agentx --env <name> login --admin` runs `agentx --env <name> config
set limits.workspacesPerMember <n>` (1 to 50) or `limits.workspacesPerOrg <n>` (1 to 1000), or uses
the admin tool `agentx_admin_set_workspace_limits`. Either way the change goes through the admin
change path: Rovara shows who is at or over the new limit, asks "Apply this change?" (`--yes`
answers for you), and records the change. Workspaces already open keep running; the next creation
uses the new limit.

To stop the thread's running coding task, mention Rovara in the thread with just a stop request:

```text
@AgentX stop
```

`abort`, `halt`, `stop it`, `cancel the task` and `please stop` work too; only the whole message counts,
so `@AgentX stop using tabs` is an ordinary request. A bare `@AgentX cancel` still declines a pending
confirmation. Any member of the channel can stop the task. Rovara replies that it is stopping, and the
task ends as cancelled. When nothing is running, the message goes to Rovara like any other request.

In the thread of a task started in Slack, only the person who started the task can stop it, and the
stop must mention AgentX (`@AgentX stop`). A plain `stop` reply without the mention is saved as a reply
for the task's next step, like any other reply in that thread. A teammate's `@AgentX stop` gets a
private "Only the person who started this task can stop it."; when nothing is running, the sender is
told so privately. See
[Replies in a Slack task's thread](project-configuration.md#replies-in-a-slack-tasks-thread).

To release a thread workspace, mention Rovara in that thread with an explicit close request:

```text
@AgentX close this workspace
```

`close the workspace`, `please close this workspace` and `can you close the workspace?` work too; only
the whole message counts, so `@AgentX close the modal` is an ordinary request.

A thread that never needed the worker has no workspace. A close request there says so and changes
nothing.

Rovara first fences new work and checks every prepared repository. Uncommitted changes, untracked
files, an unpushed current commit, or commits on a local-only branch block closure; Rovara lists the
affected repositories in the thread and keeps the workspace intact. Publish or remove that work,
then retry the close request. A running preparation, task, publication, maintenance, resume, or
cancellation also blocks closure until it finishes.

For a clean production workspace, Rovara terminates its EC2 instance and deletes
the persistent EBS volume, and then confirms completion in the same Slack thread. It
retains the workspace and operation records as a closed tombstone for audit and retry safety, but
removes the hosted orchestrator conversation session and releases the organization's quota and that
of the member who prepared the workspace. Later mentions in the closed thread do not create another
workspace; start a new Slack thread for fresh work.

## Tasks shared from an AI tool

A developer can share a task they started from their AI tool into one of the project's bound
channels, with `agentx_share_task` or when starting it. Rovara posts a new thread that names who
started the task, from which tool, its title, the project and its status, and keeps the thread up
to date: when the workspace is ready or could not be set up, when the task ends (with the worker's
summary), when a pull request opens, when the mode changes, and when the task is closed. Rovara's
own messages in the thread do not include the developer's instructions. When the developer sends
more instructions from their AI tool, the thread gets that request's end message and the worker's
summary, but not the instructions themselves.

- **View only** (`view`): channel members follow the task, and the developer drives it from their
  AI tool. A mention in the thread gets a notice instead of running.
- **Continue** (`continue`): channel members can also mention Rovara in the thread to steer the
  task on the same workspace, one request at a time, each attributed to the member who sent it.

The project's `developerTasks` settings decide what is allowed: `share: required` shares every
task, `shareMode.default` picks the mode when none is asked for (`view` unless set), and
`shareMode.allowContinue: false` keeps every shared task view only. Sharing into a private channel
needs the developer to be a member of it. A shared task's channel cannot change, and a shared task
cannot be made private again. An administrator can switch a shared task's mode, within those
settings, with `agentx --env <name> admin task share-mode --task <task-id> --mode view|continue`.
Sharing is available only in environments installed with `agentx init`. The developer's side is in
[Use Rovara from Claude Code, Codex or Cursor](mcp-install.md#sharing-a-task-to-slack).

A task's workspace setup that is still running after 50 minutes is marked failed; the task then
reads `setup_failed`, and closing it frees its place in the workspace limits.

## Actions that need your confirmation

Before any tool runs, Rovara's action gate decides whether to run it, ask, or refuse. It uses
Rovara's own rules, the same for every connector:

- Reads run.
- A call that names no existing item creates one, and runs.
- A call that closes, deletes, archives, merges, reverts or cancels something, or that sets a
  status, state or resolution, or marks an item completed (`completed` set to true or false), is
  destructive and always asks.
- A call that changes an existing item runs when your messages in the thread clearly asked for
  that change on that item; otherwise Rovara asks. A small model makes that check. It sees only the
  members' messages, the call and the item's key, never what a tool returned, so text inside an
  issue cannot approve a change.
- A write whose arguments hold a list of more than 5 entries, such as 6 tasks, asks.

When Rovara asks, it posts one message listing every action it held back, with **Approve** and
**Cancel** buttons. That message is the reply: Rovara adds its own answer only when something else
happened in that turn (a call ran, even if it failed, or an action was refused or could not be
checked), and that answer does not repeat the question. Only the member who made the request can press them; anyone else is told so
privately. You can also reply `@AgentX yes` or `@AgentX cancel`. A confirmation counts once, only
after the question, and for 24 hours. Rovara then runs exactly the listed calls; a call with any
other arguments is checked afresh, as a new call. Any other message from you replaces the question.

After a press, the buttons are replaced by who answered and how ("Approved by ... Running it now."
or "Cancelled by ..."). A second press while the first is still being taken is answered privately
with "Already received. I'm on it." A `yes` to a question that has expired is told so for 24 hours after the expiry; after
that it is an ordinary request. If Slack redelivers an approval that an earlier attempt already
used, Rovara runs nothing again and says "An earlier attempt of this request already used that
confirmation": the calls may already have run, so ask it to check.

`@AgentX yes to all in this thread` stops the questions that come only from the model's doubt
(including when the model could not answer), for you, in that thread, for 24 hours; say it again to
renew it. If a question of yours is pending, it also approves that question. Destructive actions,
large changes and administrator rules still ask.

Coding work in a thread that has no workspace yet is checked the same way, once, before Rovara
prepares one. In a thread whose workspace is already prepared, starting or following up coding work
runs without a check and without a model call. A confirmed request to create a pull request in such a thread still answers that there are no
changes to publish: approval does not create a workspace.

Administrators add rules to the project file under `actionPolicy`:

```yaml
actionPolicy:
  rules:
    - { tool: agentx_create_pull_request, outcome: ask, reason: "Pull requests need a person." }
    - { connector: tracker, tool: "delete_*", outcome: deny, reason: "Deleting is turned off." }
    - { connector: tracker, tool: save_item, whenArguments: [assignee], treatAs: destructive }
```

A rule names a `tool`, where `*` matches anything. With `connector`, it is the connector's own tool
name; without it, the name the model sees, such as `jira__createJiraIssue`. `whenArguments` limits
the rule to calls that set one of those arguments, by top-level argument name only: a key inside an
object or a list, such as `fields.status`, does not match. A rule then either decides (`outcome`:
`allow`, `ask` or `deny`) or reclassifies the action (`treatAs`: `read`, `create`, `change` or
`destructive`). Deny rules win over ask rules, which win over allow rules. Only a rule that names
one exact tool, with no `*`, can waive the ask for a destructive or large call, with `outcome:
allow` or a `treatAs`; a rule with `*` allows or reclassifies reads, creates and changes only. Deny
and ask rules apply to every call they match, with or without `*`. Registration refuses a rule that
matches no tool, or names a connector the project does not configure. Register a policy only after
the control plane and the runtime of this release are both deployed, with this release's
administration client, and do not roll either back afterwards: older versions refuse a project that
has one.

What decides that a call is destructive or changes an item, so you can approve tools deliberately:

- A connector declares where its tools name an existing item, such as Linear's `id`, Jira's
  `issueIdOrKey` or Asana's `tasks[].task`. A call that fills one changes that item; a call that
  fills none creates.
- A tool that offers no such argument always runs as a create, whatever it writes. GitHub
  `push_files` and Jira `executeWrite` are examples. Approve such tools only if you accept that
  they run without asking, or add an `ask` or `deny` rule for them.
- For a tool that offers an item argument, Rovara looks for a status, state, resolution,
  `completed` or similar key anywhere in the arguments, up to level 4. The arguments themselves are
  level 1, and each object or list inside adds one level, so `tasks[].completed` is at level 3 and
  found. For a tool that offers none, only top-level arguments and keys directly inside an object
  argument (such as `fields.status`) are read, so a create of tasks that are already complete stays
  a create.
- A vendor's own `destructiveHint` makes a call ask only when the connector declares no item
  arguments. Vendors mark ordinary edits destructive, so where Rovara can see the item a call names,
  its own rules decide. The built-in GitHub, Linear, Jira and Asana connectors all declare them.

The model that checks changes is a deployment setting: the `AgentXSlackOrchestrator` parameter
`GateClassifierModelId`, default Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`),
which needs the one-time Anthropic use-case form in the Bedrock console. In an installed environment,
`agentx init` asks for it (`--classifier-model`), and `agentx --env <name> config set
models.classifier <id>` changes it later, after testing the model with one call. If the model is
unavailable, errors, gives an answer that is not a plain verdict, or does not answer in time, Rovara asks. The time limit is 8
seconds unless the service's `AGENTX_GATE_CLASSIFIER_TIMEOUT_MS` is a whole number of milliseconds
from 1 to 60,000; the gate then waits exactly that long. Any other value, including a larger one,
means 8 seconds. A model ID the
runtime does not know is reported at start: the service logs `gate.classifier_unavailable` and its
start line says `classifierAvailable: false`, and every change then asks. A turn makes at most 8
model checks; later changes in that turn ask. The model's full prompt holds the members' own words,
so it is never logged or kept in a turn record.

The buttons need the Slack app's **Interactivity** turned on, with the Request URL set to the
`AgentXControlPlane` output `SlackInteractivityUrl`. A button this release does not know, for
example after a rollback, tells the member who pressed it that it is no longer available.

Every decision is logged as `gate.decision` and kept with its call in the turn record: the outcome,
what decided it (a rule, a default, the model check, a confirmation) and a short reason. The
reasons Rovara writes name at most an argument, never its value; the model check writes its own
one-sentence reason and is told not to quote the messages.

## What a thread remembers

Each Slack thread owns one conversation, and every request in it continues that conversation. The
transcript lives on the thread's workspace volume next to its files, so a follow-up sees both the
earlier discussion and the earlier edits. It survives a client disconnect and reconnect, and the
replacement of the worker process, because neither touches the volume.

It does not survive losing the volume. If the workspace is replaced, the next request in the thread
fails with `CONVERSATION_STATE_LOST` rather than starting the thread over on top of files it has no
memory of. Start a new thread to continue. There is no promised retention period beyond the life of
the workspace's EBS volume.

A conversation that was created before Rovara recorded this state has no transcript to reopen, so
its next request starts one. If the deployed model changes between turns, the thread keeps its
transcript and Rovara says which model it continues on. Closing a thread's workspace ends its
conversation with it.

## Diagnostics

The ingress Lambda and the orchestrator service write JSON log lines to CloudWatch Logs, with the
components `slack-ingress` and `slack-orchestrator`. They record event IDs, decisions such as
`event.ignored` with a reason, and failures by error type. Tokens, request text, and response text
are never written to CloudWatch Logs. `event.ignored reason="channel_not_bound"` means the channel
has no binding, and `request.rejected reason="invalid_signature"` usually means the stored signing
secret is wrong.
`event.ignored reason="member_check_failed"` with `slackError="missing_scope"` means the bot token
lacks `users:read`. `reason="not_a_person"` means a bot posted the mention, `reason="own_message"`
that Rovara did, and `reason="app_posted_disabled"` that `SlackAppPostedMessages` is `ignore`.
`reason="no_user"` means the event named no Slack user; every other unparseable event still logs
`reason="malformed_event"`. A bot's mention used to log `reason="bot_or_edited_message"` no matter
what; now that reason only covers an edited message, or app-posted messages that are off or not
configured, and a bot's mention is checked like any other app-posted message, logging
`reason="not_a_person"` instead. `thread.paused` records each request the per-thread limit refused.
`turn_limit.failed` is a 500 that Slack retries, logged when the turn itself could not be counted.
`member_check.notice_failed` and `thread_paused.notice_failed` mean the fail-closed notice or the
pause notice could not be posted; the event is still handled and Slack is not asked to retry it.
`turn_limit.release_failed` and `enqueue.release_failed` mean the claimed event's release itself
failed, after a turn-count or enqueue failure that had already answered 500; `turn_limit.decrement_failed`
means the turn count's own undo, on the enqueue-failure path, failed. All three are logged, not
thrown, and only leave the retried event's claim, or its turn count, briefly stale, not lost.
`connector.discovery_failed` means a connector's tools were left out of a turn: `cause="transient"`
is an outage the next turn may clear, and `cause="setup"` (with its error `code`) needs an
administrator, for example `FORBIDDEN` when the connector is no longer enabled for the project.
Failures inside the control plane's own vendor discovery, including a GitHub App that is not
installed on a scoped repository, still arrive as `RUNTIME_UNAVAILABLE` and are logged as
`transient`; check the broker's `connector.tools_skipped` and error logs when one persists.
The broker logs `connector.attribution_dropped` (project, revision, connector, scope, tool and
request ID, never the request's text) when a write went out without its attribution footer because
the signed arguments would have broken the vendor's schema, for example a `body` length limit.
`connector.not_connected` means a connector's credential is missing or was rejected by its vendor;
the connector reports itself not connected instead of failing the call. `connector.token_cache_failed`
means a shared token-cache read, write or delete failed; it names the operation and the error's
class name, never the token, and the provider simply mints again.
`connector.type_unknown` means a stored connector's type is not one this deployment knows, for
example a newer type left over after a rollback; it is skipped, not served. `connector.unusable`
means a stored connector's configuration failed to parse for its own type; it is skipped too, and
the log line names the reason. Both name the project, revision, connector and type, never a secret.

Each Slack request that reaches the orchestrator service leaves one turn record in the
`TurnRecords` table for 30 days, once it finishes. That covers every `disposition`: `answered` and
`failed` turns that ran the orchestrator, `abandoned` requests whose final attempt failed, and
requests the service settled without running the orchestrator: a close command
(`workspace_close`), the workspace limit (`workspace_limit`), a closed workspace
(`workspace_closed`), a workspace that could not be set up or is not runnable
(`workspace_unavailable`), and an answer to a confirmation that could not be used because it was
another member's, no longer pending, expired or already used (`confirmation_refused`), a cancel of a
pending confirmation (`confirmation_cancelled`), and a "yes to all" that only granted it because no
confirmation was pending (`yes_to_all_granted`). An attempt that fails and is retried leaves no record; the attempt that
finishes writes the one record. A record holds the request and response text (each at most 40,000 characters), the tools the
orchestrator was offered, each tool call with its redacted arguments, validation result,
outcome and action gate decision (`gate`: outcome, source, kind, rule and a short reason), the stop reason, the orchestrator's token usage, and the worker operations it started.
Known credential shapes are replaced with `[REDACTED]` before a record is written; this is
best-effort pattern redaction, not a guarantee that no secret survives, and tool results are never
stored. A mention with no text after `@AgentX` is answered by the ingress Lambda directly and never
reaches the orchestrator, so it leaves no turn record. `recordingErrors` on a record lists fixed
category strings, never message text, when part of the recording itself failed, for example
`handler_failed:tool_execution_end`; the turn's own answer to the member is unaffected either way.
An administrator exports records with `agentx admin turns export --since <duration> [--output
<file>]`, for example `agentx admin turns export --since 7d --output turns.jsonl`; with `--output`
the file is written at mode `0600` through a `.partial` file renamed into place only on success,
and the output holds request text, so keep it private. The summary on stderr gives the count
exported, plus `skipped` when the control plane left out stored records that failed the record
schema. `turn_record.write_failed` means a record
was lost (the member still got the reply), and `turn_record.duplicate` means SQS redelivered a
request that was already recorded.

A reply that follows tool calls carries a **Details** button. It opens a Slack view that only the
member who clicked can see. The view is built from that turn's record: who asked and when, the
outcome, the model, how many tools were offered, each call's tool, redacted arguments, outcome and
reason, any action gate decision, and token usage. Any member who can see the reply can open it,
and each opening is logged as `interaction.details_opened` with the viewer's Slack user ID. The
view never shows the request or response text, which are already in the thread. The ingress
Lambda's IAM grant cannot read them: it may `GetItem` one record by key, and only the attributes
the view shows. Nothing is posted to the thread. If the record is more than 30 days old, was never
saved, is still being saved, or cannot be read, the view says so. If the view cannot open in time,
Rovara tells the member privately. Long arguments are cut to fit Slack's limits and end with
`… [cut to fit]`; `agentx admin turns export` has the full record. The button needs Slack
Interactivity, which the action gate's confirmation buttons already turned on; it needs no new
scope.

Connector and turn metrics go to the `AgentX` CloudWatch namespace (`AgentX/<env>` in an
installed environment); see
[contracts/metrics.md](../specs/013-connector-gateway/contracts/metrics.md) for the full list. The
names below are the maintainers' deployment's. An installed environment has the same alarms named
`agentx-<env>-<Name>` (for example `agentx-<env>-ConnectorBroken`) on the topic
`agentx-<env>-alerts`, plus Slack service, session and shared-task notice alarms (such as
`agentx-<env>-TurnErrors` and `agentx-<env>-DeveloperNoticeDeadLetters`), and
`agentx-<env>-DispatchDeadLetters`. That last one fires when a worker dispatch job exhausts its
receives and lands in the dispatch dead-letter queue. To clear it, find the job's operation ID in
the dispatcher logs, then redrive or purge the `DispatchDeadLetterQueueUrl` queue. An installed
environment also has `agentx-<env>-StuckCancels`: it fires when the session reconciler finds a task
whose cancel never reached its worker for 30 minutes, and queues the cancel again once or ends the
task (or fails to), or a task whose cancel failed while its worker still says it is busy (it keeps
its workspace until the worker is idle or gone). Look for `stuck_cancel` events in the reconciler's logs. `agentx init` subscribes
your alert address and sends a test alarm, and `agentx alerts test` sends another. Five
alarms ship in `AgentXControlPlane`: `AgentXConnectorBroken` (a connector's discovery failed or a
vendor changed an approved tool's schema), `AgentXConnectorNotConnected` (a connector's vendor
credential is missing, revoked or rejected), `AgentXEmptyResponses` (more than three turns in an
hour ended without text), `AgentXRecordingFailures` (a turn record or a turn's own metrics were
lost), and `AgentXSlackDeadLetters` (a Slack request exhausted its receives and landed in the
dead-letter queue). All five notify the SNS topic `AgentXOperatorAlerts`, which has no subscription
by default; subscribe an address after the first deploy, for example:
`aws sns subscribe --topic-arn <OperatorAlertsTopicArn output> --protocol email
--notification-endpoint you@example.com`. Confirm the subscription actually pages you with a smoke
test right after that first deploy: `aws cloudwatch set-alarm-state --alarm-name
AgentXConnectorBroken --state-value ALARM --state-reason test`, then clear it with the same command
and `--state-value OK`. If an alarm stays red, act on what it is telling you: purge the
`SlackRequestDeadLetterQueueUrl` queue once you have handled its requests to clear
`AgentXSlackDeadLetters`, and reconnect or disable the connector named in the broker logs to clear
`AgentXConnectorNotConnected` or a persistent `AgentXConnectorBroken`.

If the orchestrator's turn fails, Rovara posts the failure in the thread. Other failures, such as
workspace preparation or a Slack API error, are retried; on the fifth attempt Rovara posts the
failure and stops. A retry resumes the operations the earlier attempt started instead of starting
new ones. A request that the service could not finish handling five times, for example because it
restarted each time, moves to the `SlackRequestDeadLetterQueueUrl` queue.

## Retired local modes

The local Socket Mode bridge (`agentx slack run`, `slack configure`, `slack login`) and, since the
Slack-only retirement, the whole local development client are removed: `agentx --prompt`, the
interactive TUI, `status`, `conversation new`, `pr`, `cancel`, and `slack logout` no longer exist.
Delete any leftover `~/.agentx/state` directory and, if your OS credential store still holds
`dev.agentx.slack` entries from the bridge, remove them there.
