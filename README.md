# AgentX

A software factory with a hosted pi-based orchestrator in Slack and remote pi coding workers
on Amazon Bedrock AgentCore. Administrators prepare shared product definitions and fixed
development images. Every Slack thread owns an isolated persistent workspace instance.

## Current status

The VPC-free `demo-microvm` profile is deployed and has been validated end to end in `us-east-1`:
OIDC login, workspace preparation, control-plane dispatch, AgentCore managed session storage, Pi
tool use, Amazon Bedrock inference, GitHub App authentication for private repositories, and
result/artifact callbacks are working. Pull-request creation, safe existing-PR maintenance, clean
replacement, merged-PR revert, and administrator-configured CodeBuild gates are deployed. Gates
test the exact pushed candidate and block PR creation or PR-head advancement unless every gate
succeeds. The release workflow deploys the control plane and worker together to prevent protocol
version skew.
The current demo uses Amazon Nova Pro.

The production `instances-ebs` infrastructure is implemented and locally validated. It uses a
protected, retained capacity-provider foundation and a separately releasable runtime so routine
backend releases do not recreate or refresh developer workspaces. The existing demo workspaces
continue to serve traffic until the explicit one-time migration is performed. The existing
directory name `Pi-Bedrock` is retained, but the product is named AgentX.

## How AgentX is structured

```text
Slack thread -> hosted Pi orchestrator -> AgentX control plane -> remote Pi coding worker
                                                              -> approved GitHub MCP tools
```

The hosted Pi session is an orchestration-only client. It has AgentX control-plane and approved
MCP tools but no source, file-editing, or shell tools. The remote Pi session owns the coding loop
and exposes `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` inside that thread's
workspace.
AgentX wraps remote Pi only to provide authentication, workspace allocation, operation fencing,
durable callbacks, and Git/tool-evidence artifacts. The `agentx` executable administers projects;
it cannot submit coding work, and the control plane refuses developer operations that do not come
from the orchestrator's service identity.

The remote session runs at the workspace root, above the repositories, so Pi's own context-file
discovery never reaches them. For each prepared repository the worker loads the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` that exists in the
repository root, and adds it to the session context labelled with that repository's name and
workspace path. The files are read again for every task, so an edited one applies to the next
task. A file that resolves outside its repository or exceeds 64 KiB is skipped and reported as a
progress event.

Every remote coding task also publishes a redacted `usage` operation event and private
`usage.json` artifact. They record the task outcome, actual Pi provider and model, prompt-cache
retention mode, input/output/cache token counts, cache-read ratio, and Pi's estimated cost. The
production runtime exposes `PromptCacheRetention` as a CloudFormation parameter with `short` and
`long` values; it defaults to `long` so Bedrock cache entries can survive normal gaps between
Slack turns. Demo runtimes retain Pi's `short` fallback.

Both roles currently use `@earendil-works/pi-coding-agent` 0.85.1. GitHub Spec Kit supplies the
specification workflow and demo repository; it is not the coding-agent runtime.

See the [deployed demo architecture](docs/architecture-deployed-demo.md) for the current request
path and the [production architecture](docs/architecture-production.md) for the EBS-backed target.

## Use AgentX

### 1. Install the administration client

Developers install nothing: they work in Slack. The `agentx` executable is an administration
client for registering projects, binding Slack channels, and stopping idle workspaces.

AgentX requires Node.js 22.19 or newer within the Node 22 release line:

```sh
npm ci
npm run build
(cd packages/cli && npm link)
agentx --help
```

If you do not want a global link, replace `agentx` in the examples below with
`npm run agentx --`.

### 2. Register a project and bind its Slack channel

Two files configure the administration client. One describes the deployment, at
`~/.agentx/deployment.yaml`, and serves every project:

```yaml
controlPlaneUrl: https://agentx.example.test
auth:
  issuer: https://identity.example.test
  clientId: agentx-client
  audience: agentx-api
```

The other describes a product, at `~/.agentx/projects/<project-name>.yaml`, selected with
`--project`. It holds the repositories, setup steps, readiness checks, CodeBuild gates and
orchestrator instructions, and no workspace ID, session ID, token or repository secret. It no
longer carries `schemaVersion`, `controlPlaneUrl`, `auth` or `environment.image`: the first three
moved to the deployment file, and the worker image is pinned by the release, not by the project.
Registering a file that still has them fails with those field names. See
[project configuration](docs/project-configuration.md) and the illustrative files in
[`examples/deployment.yaml`](examples/deployment.yaml) and
[`examples/projects/`](examples/projects/).

Log in as an administrator, register the immutable revision, then bind the project's channel:

```sh
agentx login --callback-port 8765

agentx admin project register \
  --file "$HOME/.agentx/projects/payments.yaml" \
  --runtime-arn <agentcore-runtime-arn> \
  --deployment-mode instances-ebs \
  --endpoint-qualifier DEFAULT

agentx --project payments admin slack bind --team T0123456789 --channel C0123456789
```

`login` performs OIDC Authorization Code + PKCE, opens the managed login page, receives the
callback at `http://127.0.0.1:8765/callback`, and stores the token in the operating-system
credential store. It must be an account carrying the configured administrator claim, such as
membership in the Cognito `agentx-admin` group. Opening the bare Cognito domain directly is not a
login flow and can return `{"message":"Missing Authentication Token"}`; always start login through
the client. AWS credentials are needed only for deployment, never for these commands.

Project revisions and runtime bindings are immutable. Increment the YAML `revision` before
registering a changed repository, setup or readiness definition. The channel binding names
only the project, so a newly registered revision reaches every new thread without binding again.

For a private GitHub repository, set its `credentialRef` to the GitHub App credential reference
configured on the control plane (the deployed project uses `github-agentx-sdlc`). The YAML still
contains no private key or installation token.

An administrator can release a thread workspace's idle compute without losing its files:

```sh
agentx admin workspace stop --workspace <workspace-id>
```

Run `agentx --help` or `agentx <command> --help` for the complete surface: `login`,
`admin project register`, `admin workspace stop`, and `admin slack bind|unbind`. There is no
developer command; coding work happens only in Slack.

An admin command's exit code names the kind of failure: 2 for invalid input, 3 when login is
required, 4 for forbidden or not found, 6 when the control plane is unavailable.

### 3. Work in the project's Slack channel

AgentX runs a hosted orchestrator for Slack in the production AWS account, so no developer machine
has to stay online. Slack calls the AgentX Events API route; an ingress Lambda verifies Slack's
signature, acknowledges in the thread, and queues the request. An ECS Fargate service runs the Pi
orchestrator for that thread and posts the result back. It can call AgentX orchestration tools and
administrator-approved GitHub MCP tools; repository coding work runs in the remote Pi worker.

Each Slack thread has its own workspace. The first mention in a new thread creates a workspace
for the channel's bound project. Later mentions in that thread, by any channel member, continue
in the same workspace and Pi conversation. Requests in one thread run in order; different threads
run in parallel.

#### GitHub MCP through hosted Slack

The control plane connects to GitHub's hosted MCP server, discovers its tools with `tools/list`,
and exposes only tools approved in the registered project revision. The orchestrator sees each
approved tool once, as `github__<tool>`, with a `target` argument naming the repository when the
connector covers several. Its instructions open with a list of what the channel can do and which
integrations are not connected. Calls go orchestrator → control plane → GitHub MCP, without a
worker.

See [GitHub MCP setup and policy example](specs/007-github-mcp/quickstart.md). The policy can be
written as `integrations.githubMcp` or, since feature 013, as a `github` entry in
`integrations.connectors`, which can also limit it to named repositories; a definition may use one
form, not both. Every GitHub write signs the `body` the model supplies (an update without a body
stays unsigned) with a footer naming the requesting Slack member and thread; set
`attribution: false` on the connector entry to turn it off (the legacy `githubMcp` form always
signs). This release uses
the existing GitHub App installation with repository-scoped **Issues** permissions. Tokens stay
in the control plane. Existing projects remain disabled until an administrator registers an
opt-in revision. Arbitrary endpoints, personal OAuth, and other GitHub permission families are
not included. Existing AgentX coding and validated PR-publication tools remain unchanged.
The hosted Slack service discovers tools from the thread workspace's registered project revision.
Calls use its IAM service identity and carry the requesting Slack user; tokens remain in the broker.
Use a new thread after binding the channel to an enabled revision. Existing threads retain their
workspace revision.

#### Connector credentials

Each connector type is one definition in the control plane. A new type is added to the config
schema and to the built-in type map. It supplies its scopes, its credential and its binder; the
routes, catalog cache, ledger and registration checks then work for it without further change.

A binder names the arguments the server fills in and the model never sees. Some are bound on
every tool, such as GitHub's owner and repository; a tool without them is not offered. Others
are bound only on the tools that have them, such as a Linear team; other tools are offered
unchanged. A request that supplies a bound argument itself is refused.

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
customer-managed KMS key instead, grant the broker role `kms:Decrypt` on that key.

A secret is one of two shapes: `static-secret` is `{"apiKey": "..."}`; `oauth-client-credentials`
is `{"clientId", "clientSecret", "scopes": [...]}`. Registration reads the secret and checks its
shape but never echoes it back, and `list` never prints a secret value, only each reference, its
type, secret name, whether it is the built-in GitHub App entry, whether a token is cached, and (for
a registered entry) who registered it and when. Linear reads a registered `static-secret` API
key; see [docs/connectors/linear.md](docs/connectors/linear.md). Jira reads a registered
`static-secret` API token; see [docs/connectors/jira.md](docs/connectors/jira.md). Registering a
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

#### One-time administrator setup

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
- Subscribe to the bot event `app_mention`.
- Bot token scopes: `app_mentions:read`, `chat:write` and `users:read`. AgentX uses `users:read`
  to confirm that a mention posted through another app came from a person, and to show the
  requester's name in connector write footers. Without it, AgentX does not run mentions posted
  through other apps (it says it could not confirm the sender), and footers show the Slack member
  ID. Reinstall the app after changing scopes.
- Invite the app to the project channel with `/invite @AgentX`.

Finally, bind the channel to the project. Binding requires an administrator login:

```sh
agentx --project project-a admin slack bind --team T0123456789 --channel C0123456789
```

A channel is bound to one project, not to a revision. Each new thread uses the project's latest
registered revision at the moment its workspace is created, so registering a revision publishes it
to every bound channel without binding again. `admin slack unbind` removes the binding, so new
mentions in that channel are ignored, but it keeps existing thread workspaces.

An existing thread's checkout stays on the revision it was prepared with: `repositories`, `setup`
and `environment` do not change under a running thread. Everything else follows the project's
latest registered revision from the next mention onwards — the GitHub MCP policy and the
repositories it may address, `orchestratorInstructions`, `readiness` and each repository's
`codeBuildGates`. So enabling a tool, correcting a test command or withdrawing a write tool takes
effect in every thread without starting a new one, and the thread is told once that its settings
moved. Each operation and MCP call records the revision whose settings applied. A readiness
command whose directory the workspace does not have fails that check rather than being skipped.

#### Working in a thread

Mention the app in the bound channel for every request, including follow-ups in a thread:

```text
@AgentX inspect the project and implement the navigation fix. Run the relevant tests, but do not
create a pull request.
```

AgentX replies within a few seconds. If earlier requests in the thread are still running, it says
how many are ahead. The first request in a new thread also prepares the workspace, which takes a
few minutes. Messages without a mention, edits, bot messages, AgentX's own messages, direct
messages, and users from other Slack organizations are ignored.

A person can also mention AgentX through another tool that posts with their own Slack user token,
such as Claude Code's Slack access or a script. AgentX checks with Slack that the sender is a
person, then treats the message exactly as if they had typed it. A message posted with a bot token
is ignored. To answer only typed mentions, set the `AgentXControlPlane` parameter
`SlackAppPostedMessages` to `ignore`. This also means a person's own tool posting "@AgentX yes"
counts as that person's confirmation, the same as typing it. This lasts until confirmation buttons
ship in phase 14c part 2.

A thread that sends AgentX more than 6 requests in a minute is paused: AgentX posts one notice and
runs nothing more in that thread until the next minute. This stops a tool that answers AgentX's
replies from looping. The `AgentXControlPlane` parameter `SlackThreadTurnsPerMinute` changes the
limit. A request that AgentX could not queue is not counted, so Slack's retry of it is not held
against the thread; in the rare case where that happens during a burst at the limit, the thread
can get a second pause notice in the same minute.

AgentX posts its replies in Slack formatting, with real line breaks and one Slack link per URL.
Text such as `<!channel>` in a reply is shown as text and never notifies anyone.

Pull requests created from a thread end with a link to the thread and the Slack members who made
requests in it. Every operation records the Slack member who requested it.

Workspaces are limited to protect cost. The member who starts a thread may be the starter of at
most 3 thread workspaces, and the organization may have at most 20. A new thread over either limit
creates nothing, and AgentX replies with the limit that was reached; for the member limit, it also
links to that member's existing threads. An administrator can change the limits with the `AgentXControlPlane`
parameters `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`.

To release a thread workspace, mention AgentX in that thread with an explicit close request:

```text
@AgentX close this workspace
```

AgentX first fences new work and checks every prepared repository. Uncommitted changes, untracked
files, an unpushed current commit, or commits on a local-only branch block closure; AgentX lists the
affected repositories in the thread and keeps the workspace intact. Publish or remove that work,
then retry the close request. A running preparation, task, publication, maintenance, resume, or
cancellation also blocks closure until it finishes.

For a clean production workspace, AgentX deletes its AgentCore capacity-provider session, which
releases the persistent EBS volume, and then confirms completion in the same Slack thread. It
retains the workspace and operation records as a closed tombstone for audit and retry safety, but
removes the hosted orchestrator conversation session and releases the organization and original
starter's workspace quota. Later mentions in the closed thread do not create another workspace;
start a new Slack thread for fresh work.

#### What a thread remembers

Each Slack thread owns one conversation, and every request in it continues that conversation. The
transcript lives on the thread's workspace volume next to its files, so a follow-up sees both the
earlier discussion and the earlier edits. It survives a client disconnect and reconnect, and the
replacement of the worker process, because neither touches the volume.

It does not survive losing the volume. If the workspace is replaced, the next request in the thread
fails with `CONVERSATION_STATE_LOST` rather than starting the thread over on top of files it has no
memory of. Start a new thread to continue. There is no promised retention period beyond the life of
the workspace, and the storage mode a thread runs on is what bounds it: the demo deployment's
microVM storage is time-limited and is not production-durable.

A conversation that was created before AgentX recorded this state has no transcript to reopen, so
its next request starts one. If the deployed model changes between turns, the thread keeps its
transcript and AgentX says which model it continues on. Closing a thread's workspace ends its
conversation with it.

#### Diagnostics

The ingress Lambda and the orchestrator service write JSON log lines to CloudWatch Logs, with the
components `slack-ingress` and `slack-orchestrator`. They record event IDs, decisions such as
`event.ignored` with a reason, and failures by error type. Tokens, request text, and response text
are never written to CloudWatch Logs. `event.ignored reason="channel_not_bound"` means the channel
has no binding, and `request.rejected reason="invalid_signature"` usually means the stored signing
secret is wrong.
`event.ignored reason="member_check_failed"` with `slackError="missing_scope"` means the bot token
lacks `users:read`. `reason="not_a_person"` means a bot posted the mention, `reason="own_message"`
that AgentX did, and `reason="app_posted_disabled"` that `SlackAppPostedMessages` is `ignore`.
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
(`workspace_closed`), and a workspace that could not be set up or is not runnable
(`workspace_unavailable`). An attempt that fails and is retried leaves no record; the attempt that
finishes writes the one record. A record holds the request and response text (each at most 40,000 characters), the tools the
orchestrator was offered, each tool call with its redacted arguments, validation result and
outcome, the stop reason, the orchestrator's token usage, and the worker operations it started.
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

Connector and turn metrics go to the `AgentX` CloudWatch namespace; see
[contracts/metrics.md](specs/013-connector-gateway/contracts/metrics.md) for the full list. Five
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

If the orchestrator's turn fails, AgentX posts the failure in the thread. Other failures, such as
workspace preparation or a Slack API error, are retried; on the fifth attempt AgentX posts the
failure and stops. A retry resumes the operations the earlier attempt started instead of starting
new ones. A request that the service could not finish handling five times, for example because it
restarted each time, moves to the `SlackRequestDeadLetterQueueUrl` queue.

#### Retired local modes

The local Socket Mode bridge (`agentx slack run`, `slack configure`, `slack login`) and, since the
Slack-only retirement, the whole local development client are removed: `agentx --prompt`, the
interactive TUI, `status`, `conversation new`, `pr`, `cancel`, and `slack logout` no longer exist.
Delete any leftover `~/.agentx/state` directory and, if your OS credential store still holds
`dev.agentx.slack` entries from the bridge, remove them there.

### 4. Validate changes and create a pull request

Pull-request creation is explicit; AgentX never publishes automatically after a coding task. The
registered project's `readiness` commands run inside the AgentCore workspace before a candidate is
pushed. Optional repository `codeBuildGates` then run remotely against that exact pushed commit.
AgentX rejects an empty diff, merge conflicts, or any failed/timed-out check before creating a PR.

Ask for it in the thread, naming the repository by its project YAML `name`, for example:
`Create a pull request for the personal-website repository titled "Improve homepage navigation".`
The orchestrator then calls `agentx_create_pull_request`; ordinary coding requests expose no
implicit publish step.

AgentX creates `agentx/<operation-id>`, makes an AgentX-authored commit, pushes without force, and
creates a ready-for-review PR against the repository's configured `defaultBranch`. The terminal
result includes the PR URL and number, commit, head/base branches, and check evidence. Repeating the
same accepted request reconciles the existing branch and PR rather than creating a duplicate. When
CodeBuild gates are configured, the result also identifies each build and its resolved commit,
status, phase, timestamps, and CloudWatch logs link supplied by AWS.

New publication always captures the intended workspace tree and replays it onto the latest remote
default branch as exactly one commit. Earlier AgentX publication commits left in the persistent
workspace are not inherited by the new PR. A conflict or effective empty diff stops before push.

Maintain an AgentX-owned PR from the same thread by naming the repository and PR number: append
the workspace's new commits, sync the base branch into it, update its title or body, or close and
reopen it. The orchestrator makes all of these changes — append, sync, edit title/body, close,
reopen, replace, and revert — through one tool, `agentx_manage_pull_request`, choosing the action
that matches the request.

`append` runs readiness checks and accepts only workspace commits that descend from the recorded
PR head. With CodeBuild gates, append and sync first push an operation-specific validation branch;
the visible PR branch advances only after every build passes. `sync` merges the latest default
branch into the PR branch. Neither action rebases or
force-pushes published history. Remote Pi may rebase or amend commits that are still unpublished,
provided the resulting history remains a descendant of the published PR head; once published, use
another append, or ask to replace the PR with clean history. Replacement creates the new PR before closing the original and never changes the original branch.
For an already merged AgentX PR, ask for a reviewable revert PR instead of changing the default
branch directly.

Only PRs with durable AgentX ownership evidence are eligible. PRs created by an earlier AgentX
version are adopted only when their `agentx/<operation-id>` branch matches a successful publication
operation in the same thread workspace.

The installed GitHub App must have these repository permissions:

- **Contents: Read and write** for cloning and pushing the AgentX branch.
- **Pull requests: Read and write** for finding or creating the PR.

Change them under **GitHub Settings → Developer settings → GitHub Apps → AgentX SDLC → Permissions
& events → Repository permissions**. After saving, the installation owner must approve the updated
permissions for the installation. The App private key stays in Secrets Manager; it is never sent to
the AgentCore runtime. AgentX mints short-lived, single-repository tokens separately for clone,
push, and PR operations.

AgentX does not merge, approve, delete branches, add reviewers/labels, or force-push in this
workflow. The worker rejects force flags, force-with-lease flags, and plus-prefixed refspecs at the
credentialed Git command boundary.

#### Configure CodeBuild gates

CodeBuild projects are administrator-owned infrastructure. Create a project with a GitHub source
(use AWS CodeConnections for private repositories), a service role, compute image, and repository
`buildspec.yml`. Its name must begin with `agentx-`. Add the approved project to the repository in
the AgentX project YAML, increment `revision`, and register that immutable revision. New threads
then use it:

```yaml
repositories:
  - name: personal-website
    url: https://github.com/example/personal-website.git
    path: repo/personal-website
    defaultBranch: main
    credentialRef: github-agentx-sdlc
    codeBuildGates:
      - name: quality
        projectName: agentx-personal-website-quality
        timeoutMinutes: 30
      - name: browser
        projectName: agentx-personal-website-playwright
        timeoutMinutes: 45
```

Unit tests, backend integration tests, and Playwright commands belong in the CodeBuild project's
buildspec. AgentX supplies only the exact Git commit as `sourceVersion`; it does not allow the
worker to override the buildspec, image, role, environment, source, or artifacts. The broker owns
`StartBuild`/`BatchGetBuilds` permission scoped to `agentx-*` projects, while AgentCore receives no
CodeBuild AWS credentials. A failed new-PR build leaves its candidate branch for diagnosis but
creates no PR. A failed existing-PR build leaves the PR head unchanged.

This release gates one repository publication at a time. Testing unpublished frontend and backend
candidates together and creating multiple PRs as one unit requires a future multi-repository
change-set workflow; a CodeBuild project may use secondary sources, but AgentX does not yet bind
multiple candidate commits atomically.

### 5. Deploy and release

Registering a project and binding its channel are covered in section 2. Workspaces are created by
Slack threads, never by an administrator. A demo release is one command from a clean checkout:

```sh
npm run release:demo -- --profile agentx-deployer --region us-east-1
```

The command runs all quality gates, applies bounded ECR retention, builds and smoke-tests ARM64,
pushes an immutable digest, deploys both stacks, verifies AgentCore `READY`, and enforces 30-day
runtime-log retention. See the [VPC-free AWS runbook](docs/deployment-demo.md) for first-deployment
environment variables, rollback options, and the manual procedure.

For the production EBS-backed platform, preview the release without changing AWS:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1 --dry-run
```

The first real production release creates the protected foundation (dedicated two-AZ VPC, two NAT
gateways, KMS key, private worker security group, flow logs, and stable AgentCore capacity
provider), then creates the production runtime. Later releases refuse to modify that foundation
and update only the runtime and control plane:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1
```

This command does not register a project, create a workspace, rewrite a workspace record, stop a
demo session, or migrate data. Those are separate, explicit administrative operations. An
`instances-ebs` workspace is identified by the stable capacity provider plus its thread's runtime
session ID; updating the worker image on the production runtime does not change either
identifier and therefore does not require a workspace refresh.

#### Continuous production releases

`AgentXReleasePipeline` runs the same production release from AWS for every qualifying push to
`mainline`. It is a CodePipeline V2 pipeline with a native ARM CodeBuild project,
`release-agentx-production`, which runs:

```sh
npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation
```

| A push to `mainline` that changes | Result |
|---|---|
| Only docs, specs, top-level `tests/`, `scripts/` or `.github` | No pipeline execution |
| `packages/broker`, `infra` or other control-plane code, but no worker image input | Checks, then a control-plane deploy. The deployed worker digest is reused and the runtime is unchanged |
| A worker image input: `packages/worker`, `packages/contracts`, the Dockerfile, `.dockerignore`, root `package.json`, `package-lock.json` or tsconfigs, or a workspace `package.json` | Checks, a new ARM64 image, a runtime update to `READY` on that digest, then a control-plane deploy |

Whether the worker changed is judged against the deployed image. The pipeline reads the commit
from the image's `release-<time>-<commit>` tag and diffs the worker image inputs up to `HEAD`. So
a worker change from a failed or superseded execution is still released by the next one. If that
commit cannot be determined, the pipeline builds a new image. Any change under `infra/` that
alters `AgentXProductionFoundation` fails the release until an administrator reviews and deploys
the foundation manually. The pipeline never creates the foundation and never deploys itself.

One-time setup, with an administrator's credentials:

```sh
npm run build --workspace @agentx/infra
npx cdk deploy AgentXReleasePipeline --app 'node infra/dist/bin/agentx.js' \
  --profile agentx-deployer -c agentxRegion=us-east-1 \
  --parameters GitHubConnectionArn=arn:aws:codeconnections:us-east-1:944937319445:connection/7e76074b-e840-439f-b94c-6806a2bf9513
```

Protect `mainline` in GitHub. The build role can deploy through the CDK bootstrap roles, so push
access to `mainline` is deploy access. To roll back, revert the change on `mainline`, or run
`npm run release:prod -- --worker-image <digest>` locally with an earlier digest from
`agentx-worker-production`.

Spec 014 phase 14c part 1 adds an optional `actionPolicy` field to project definitions, ahead of
the gate that reads it in part 2. Its rollback floor (plan R6) starts the moment any project
revision stores `actionPolicy`, not once part 2 ships: a stored revision with the field fails the
strict parse of any component older than 14c, including the worker's `prepare` invocation and the
administration CLI's local project-file check. Before reverting 14c1, or rolling the control plane
or runtime back below it, confirm no stored project revision carries `actionPolicy`:

```sh
export AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1
STATE_TABLE_NAME=$(aws cloudformation describe-stacks --stack-name AgentXControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='StateTableName'].OutputValue" --output text)

aws dynamodb scan --table-name "$STATE_TABLE_NAME" --consistent-read \
  --filter-expression "#et = :project AND attribute_exists(#def.#ap)" \
  --expression-attribute-names '{"#et":"entityType","#def":"definition","#ap":"actionPolicy"}' \
  --expression-attribute-values '{":project":{"S":"PROJECT"}}' \
  --projection-expression "pk, sk"
```

This is read-only. Each item the scan returns is one offending revision: `pk` is
`PROJECT#<project-name>` and `sk` is `REV#<revision, zero-padded>`. If the response carries a
`LastEvaluatedKey`, repeat the scan with `--exclusive-start-key` set to it before treating an empty
page as clean. `actionPolicy` cannot be removed from a stored revision: project revisions are
immutable. Registering a new revision without the field only changes what a new thread, and an
existing thread's non-disk settings, read going forward; a thread whose workspace is still pinned
to an older revision that carries `actionPolicy` keeps reading that revision, so reverting stays
unsafe for it until that thread closes or the revision is otherwise no longer live.

## Implementation documents

- [Pull-request task list](specs/002-create-pull-request/tasks.md): implementation and validation
  status for explicit publication.
- [Safe PR lifecycle task list](specs/003-safe-pr-lifecycle/tasks.md): clean publication,
  append/sync, replacement, and revert progress.
- [Pull-request specification](specs/002-create-pull-request/spec.md): publication behavior,
  safety, and retry requirements.
- [Conversation continuity task list](specs/012-conversation-continuity/tasks.md): reopening a
  thread's saved session, and what is verified locally rather than on a deployment.
- [Task list](specs/001-agentx-foundation/tasks.md): 50 dependency-ordered implementation tasks.
- [Specification](specs/001-agentx-foundation/spec.md): agreed workflows and acceptance criteria.
- [Plan](specs/001-agentx-foundation/plan.md): architecture, boundaries and delivery sequence.
- [Research](specs/001-agentx-foundation/research.md): decisions and primary sources.
- [Deployed AWS architecture](docs/architecture-deployed-demo.md): current VPC-free demo resources
  and request flow.
- [Production AWS architecture](docs/architecture-production.md): stable AgentCore Instances,
  per-session EBS, networking, release, isolation, and migration boundaries.
- [Contracts](specs/001-agentx-foundation/contracts/): project config, control API and worker protocol.
- [Validation guide](specs/001-agentx-foundation/quickstart.md).
- [Constitution](.specify/memory/constitution.md): project principles, version 2.1.0.

## GitHub Spec Kit

Initialized with the official Specify CLI 1.0.7 and Codex skills integration:

```sh
uvx --from specify-cli==1.0.7 specify init --here --integration codex --integration-options="--skills" --script sh --ignore-agent-tools --non-interactive
```

Initialization has already run; do not rerun it over these artifacts unnecessarily.
The installed skills are in `.agents/skills/`, with templates/scripts under `.specify/`.

Spec Kit skills are agent instructions, not shell commands. No Git repository or branch was
created by this setup.

Validate the active feature now:

```sh
.specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks
```

## Local validation

Use Node 22.19 or newer within the Node 22 line:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run infra:synth
```

The latest observed results are recorded in
[docs/validation/agentx-foundation.md](docs/validation/agentx-foundation.md). Docker and AWS are
not required for this local suite.
