# Security

This page collects how AgentX keeps code, credentials and data apart, and where it stops. The
details live in the [production architecture](architecture-production.md), the README and the
guides it links; this page links to them.

## Who can do what

```text
Slack thread -> hosted Pi orchestrator -> AgentX control plane -> remote Pi coding worker
                                                              -> approved GitHub MCP tools
AI tool (Claude Code, Codex, Cursor) -> agentx mcp -> AgentX developer task API -> remote Pi coding worker
```

- The hosted orchestrator only orchestrates. It has AgentX control-plane tools and approved MCP
  tools, but no source, file-editing or shell tools.
- The remote Pi worker owns the coding loop. Its `read`, `bash`, `edit`, `write`, `grep`, `find`
  and `ls` tools work only inside that thread's or task's workspace.
- The `agentx` executable administers environments and projects. Its `agentx mcp` server also lets
  a signed-in developer's AI tool hand coding tasks to AgentX through the developer task API. Every
  other coding operation must come from the orchestrator's service identity. The control plane
  refuses it otherwise.
- Developer commands are `login <url>`, `whoami`, `workspaces`, `logout`, `mcp` and `mcp install`.
  Everything else is administration. See the [CLI reference](cli.md).
- An administrator login must carry the configured administrator claim, such as membership in the
  Cognito `agentx-admin` group.

## Developer sign-in and tasks from an AI tool

### Signing in

Developers sign in from their own machines with their own identity, not an administrator's. An
environment offers Slack sign-in, your company's sign-in (any OIDC provider), or both. Developers
need no AWS credentials. They run `agentx login <control plane URL>`.

- Company sign-in can require a claim, such as a group. A person without it is refused with that
  reason.
- A developer signs in again when the sign-in ends, at most 7 days later.
- Tokens are kept in the operating system's credential store (the macOS keychain, or the Secret
  Service on Linux). `~/.agentx/developer.yaml` holds only addresses.
- `agentx mcp install` never writes a token into the AI tool's settings. The entry only runs
  `npx -y @charterarc/agentx mcp`, pinned to the version you ran it with.
- `agentx --env <env> signin disable slack|oidc` signs out everyone who used that method at once.
  Turning it back on does not bring those sessions back.

See [developer sign-in](day-two.md#developer-sign-in) and
[Use AgentX from Claude Code, Codex or Cursor](mcp-install.md).

### Which projects a developer may use

A developer may use a project when they are a member of one of its bound Slack channels. The
project's `developerTasks` settings control this:

- `enabled` decides whether developers may start tasks on the project from an AI tool at all.
- `channelMembersMayUse` (default `true`) lets members of the bound channels use the project. With
  `false`, only people an administrator granted access directly may use it.

Direct grants arrive with spec 025 phase 25e (the admin tool
`agentx_admin_grant_project_access`). Until then, channel membership is the only way in. See
[developer tasks](project-configuration.md#developer-tasks).

### What others can see

Tasks from an AI tool are private unless the developer shares them, or the project requires
sharing. For a private task, only the developer sees its title, instructions, progress and
results. Others who can use the project see only that a workspace exists, with its status and
times, in `agentx workspaces`. Every action is recorded for administrators.

Each task gets its own isolated workspace, which it keeps until the developer closes it. Open
tasks count against the same workspace limits as Slack threads.

### Sharing a task to Slack

A developer can share a task into one of the project's bound channels, with `agentx_share_task`
or when starting it. AgentX posts a new thread that names who started the task, from which tool,
its title, the project and its status, and keeps it up to date.

- AgentX's own messages in the thread do not include the developer's instructions. When the
  developer sends more instructions from their AI tool, the thread gets that request's end
  message and the worker's summary, but not the instructions themselves.
- **View only** (`view`): channel members follow the task. A mention in the thread gets a notice
  instead of running.
- **Continue** (`continue`): channel members can also mention AgentX in the thread to steer the
  task on the same workspace, one request at a time, each attributed to the member who sent it.

The project decides what is allowed: `share: required` shares every task, `shareMode.default`
picks the mode (`view` unless set), and `shareMode.allowContinue: false` keeps every shared task
view only. Sharing into a private channel needs the developer to be a member of it. A shared
task's channel cannot change. An administrator can switch a shared task's mode, within those
settings, with `agentx --env <env> admin task share-mode --task <task-id> --mode view|continue`.
An administrator cannot share a private task or move a shared one to another channel. Sharing is
available only in environments installed with `agentx init`.

## Credentials

### Where secrets are kept

Secrets never go on the command line. Each comes from a hidden prompt, a file you point to, or an
environment variable, and `agentx init` stores it in AWS Secrets Manager, never in its own
settings. An installed environment's secrets live under `agentx/<env>/`: the callback signing key,
the GitHub App, Slack (the bot token and signing secret, plus the client ID and secret when Slack
sign-in is on), a webhook alert address, the OpenRouter key when `init` stores it, and connector
credentials.

The callback signing key lives only in Secrets Manager. The templates engine passes it to
CloudFormation as a `NoEcho` parameter. The one exception: the `cdk` engine passes it as a
`cdk deploy --parameters` argument, so it is visible in the operator's own machine's process list
while that command runs. `agentx` itself redacts it everywhere it prints anything.

`agentx init --export` writes a bundle for a platform team that holds no secret. An
`upgrade --export` bundle holds no secret either: kept values are marked `UsePreviousValue`.
`agentx doctor` reads secrets only to check their shape, and never prints them.

### GitHub

The installed GitHub App needs two repository permissions for pull requests:

- **Contents: Read and write** for cloning and pushing the AgentX branch.
- **Pull requests: Read and write** for finding or creating the PR.

GitHub MCP tools use the same App's repository-scoped **Issues** permissions. The App private key
stays in Secrets Manager. It is never sent to the worker. AgentX mints short-lived,
single-repository tokens separately for clone, push and PR operations. Project YAML holds a
`credentialRef`, never a private key or installation token.

AgentX does not merge, approve, delete branches, add reviewers or labels, or force-push. The worker
rejects force flags, force-with-lease flags and plus-prefixed refspecs at the credentialed Git
command boundary. For GitHub MCP tools, tokens stay in the control plane, and only tools approved in
the registered project revision are exposed.

### Other connectors

Connectors other than GitHub read their credential from a Secrets Manager secret. In an installed
environment, `agentx --env <env> connector add linear|jira|asana` stores it under
`agentx/<env>/connectors/<type>` and registers it. The maintainers' deployment uses
`agentx/connectors/<name>`, registered once with `agentx admin credential register`. A secret has
one of three shapes:

- `static-secret`: `{"apiKey": "..."}`
- `oauth-client-credentials`: `{"clientId", "clientSecret", "scopes": [...]}`
- `oauth-refresh-token`: `{"clientId", "clientSecret", "refreshToken"}`, written by
  `agentx admin credential authorize` after a bot user signs in once in a browser.

Registration reads the secret and checks its shape, but never echoes it back. `agentx admin
credential list` never prints a secret value. The broker may write a rotated refresh token back
only to a secret tagged `agentx-writable: refresh-token`.

The secret must use the default `aws/secretsmanager` key. If you use a customer-managed KMS key,
grant the broker role `kms:Decrypt` on it. For an `oauth-refresh-token` secret on such a key, the
broker role also needs `kms:GenerateDataKey` (and `kms:Encrypt` if the key policy requires it).

A binder names the arguments the server fills in, such as GitHub's owner and repository or a
Linear team. The model never sees them. A request that supplies a bound argument itself is refused.

See [Linear](connectors/linear.md), [Jira](connectors/jira.md) and [Asana](connectors/asana.md) for
each connector's credential.

## Actions that need your confirmation

Before any tool runs in a Slack thread, AgentX's action gate decides whether to run it, ask, or
refuse. The rules are the same for every connector:

- Reads run.
- A call that names no existing item creates one, and runs.
- A call that closes, deletes, archives, merges, reverts or cancels something, or sets a status,
  state or resolution, or marks an item completed, is destructive and always asks.
- A call that changes an existing item runs when your messages in the thread clearly asked for that
  change on that item. Otherwise AgentX asks. A small model makes that check. It sees only the
  members' messages, the call and the item's key, never what a tool returned, so text inside an
  issue cannot approve a change.
- A write whose arguments hold a list of more than 5 entries asks.

When AgentX asks, it posts one message with **Approve** and **Cancel** buttons. Only the member who
made the request can press them. A confirmation counts once, only after the question, and for 24
hours. AgentX then runs exactly the listed calls. A call with any other arguments is checked again
as a new call.

`@AgentX yes to all in this thread` stops the questions that come only from the model's doubt, for
you, in that thread, for 24 hours. Destructive actions, large changes and administrator rules still
ask.

If the checking model is unavailable, errors, gives an answer that is not a plain verdict, or does
not answer in time, AgentX asks. A turn makes at most 8 model checks; later changes in that turn
ask. The model's full prompt holds the members' own words, so it is never logged or kept in a turn
record.

Administrators add `ask`, `deny` and `allow` rules under `actionPolicy` in the
[project configuration](project-configuration.md). Deny rules win over ask rules, which win over
allow rules. Only a rule that names one exact tool, with no `*`, can waive the ask for a
destructive or large call.

Every decision is logged as `gate.decision` and kept with its call in the turn record. The reasons
AgentX writes name at most an argument, never its value.

## Isolation in AWS

### One workspace per thread or task

Every Slack thread, and every task a developer hands to AgentX from an AI tool, owns an isolated
persistent workspace: its own EC2 worker and encrypted EBS volume. The dispatcher signs each
invocation for the workspace, generation, operation and fence, and the worker verifies the
signature before it accepts the invocation. Session generations fence stale workers.

The orchestrator calls the control plane through an `AWS_IAM` route that accepts only its task
role. The broker derives the workspace owner from the signed Slack thread headers and requires a
bound channel. Those owner keys are separate from administrator logins, so the service identity
cannot reach another thread's workspace, and the OIDC entry point serves administration only. Each
operation records the Slack member who requested it.

The ingress Lambda verifies Slack's signature and ignores anything that is not a human
`app_mention` in a bound channel of the same Slack organization. It can read only channel bindings
from the state table.

### Network and encryption

- The Fargate tasks run in private subnets with no public IP and outbound HTTPS only.
- EC2 workers run in private subnets and reach GitHub and package registries through NAT.
- Workspace EBS volumes are encrypted. A rotating customer-managed KMS key is retained for
  workspace recovery safety.
- The stacks have CloudFormation termination protection. The KMS key and flow-log group use
  retain policies.
- Release images are referenced only by digest, never by a tag. An installed environment pulls
  them through an ECR pull-through cache into private ECR in its own account. The maintainers'
  production ECR repository uses immutable tags and scan-on-push.

### IAM roles and the permission boundary

The access stack creates two roles. The `agentx-<env>-cloudformation` service role deploys every
other stack. The `agentx-<env>-operator` role runs day-to-day `agentx` commands in 1-hour sessions.
Only the principal named at install (`--operator-principal`) may assume the operator role. Every
other environment role lives under the IAM path `/agentx/<env>/`.

A permission boundary always applies. When you give no `PermissionsBoundaryArn`, the access stack
creates `agentx-<env>-boundary`, and every environment role carries it. The default boundary:

- allows the AWS services AgentX's roles use, and role actions and `PassRole` only for roles under
  `/agentx/<env>/`;
- denies Organizations and Account changes, anything on IAM users or groups, creating, versioning
  or deleting managed policies, and changing the boundary itself.

A company-supplied boundary replaces the default entirely, so it must allow every action AgentX's
roles need. The service role cannot create a role without the boundary, and cannot change or
remove a role's boundary once set.

The operator role may run change sets only on the five non-access stacks, by exact name. It may
pass only the service role, and only to CloudFormation. It can read and write its environment's
SSM settings and Secrets Manager secrets. It cannot change the access stack, delete the access
stack's IAM roles or the kept data, or start drift detection. Those need admin credentials.

### Upgrades and removal

- `agentx upgrade` shows every change set, lists IAM changes on their own, and asks before each
  stack. It stops before any change that replaces or deletes a table, user pool, bucket, KMS key,
  secret, queue or log group, unless you name it with `--allow-replace`.
- `upgrade` refuses a release older than the one the environment runs, and every prerelease.
- `agentx destroy` needs admin credentials and an explicit `--env`. It asks you to type the
  environment's name, and for `production` or an environment AgentX has no record of creating,
  the AWS account ID too. No flag skips either question. It touches only names that belong to the
  environment.

See [Running AgentX](day-two.md#upgrade) and [Removing an environment](teardown.md).

## Where data lives

| Data | Where | How long |
|---|---|---|
| Thread transcript | The thread's workspace EBS volume | The life of the workspace and its volume |
| Orchestrator session | S3, one per thread | Removed when the thread's workspace closes |
| Workspace and operation records | DynamoDB | Kept as a closed tombstone after the workspace closes, for audit and retry safety |
| Turn records | `TurnRecords` DynamoDB table | 30 days |
| VPC flow logs | CloudWatch Logs | 30 days |
| Developer sign-in records | DynamoDB tables | Until `agentx destroy` removes the tables |
| Connector and app secrets | Secrets Manager | Until you delete them, or `agentx destroy` does |

**CloudWatch Logs** record event IDs, decisions and failures by error type. Tokens, request text
and response text are never written to CloudWatch Logs.

**A turn record** holds the request and response text (each at most 40,000 characters), the tools
offered, each tool call with its redacted arguments, validation result, outcome and gate decision,
the stop reason, token usage and the worker operations started. Tool results are never stored.
`agentx admin turns export` writes a file that holds request text, so keep it private.

**The Details button** opens a view that only the member who clicked can see. Any member who can
see the reply can open it, and each opening is logged as `interaction.details_opened` with the
viewer's Slack user ID. The view never shows the request or response text. The ingress Lambda's
IAM grant can `GetItem` one record by key, and only the attributes the view shows.

**Closing a workspace** terminates its EC2 instance and deletes its EBS volume. **Removing an
environment** with `agentx destroy` deletes the buckets, tables, flow-log group and Cognito user
pool, deletes every secret under `agentx/<env>/` without recovery, and schedules each KMS key for
deletion in 7 days. `--keep-data` keeps the tables, buckets, secrets, Cognito user pool and KMS
keys.

## What AgentX does not protect against

These limits come from the sources above. Plan around them.

- **Environments that share an AWS account are not a security boundary against each other.** Names
  and IAM paths keep them apart for IAM, but resource policies and non-IAM access (S3, KMS, Secrets
  Manager, SQS and the like) can still reach across environments in the same account. Use a
  dedicated AWS account per install.
- **The operator role is powerful within the account.** It can deploy CloudFormation through the
  service role, so it can create and change any resource of the services AgentX uses. The boundary
  limits IAM, not those resources.
- **Without `--operator-principal`, any principal in the account that IAM allows may assume the
  operator role.** Name one at install to limit who can.
- **Channel membership is access.** With the default `channelMembersMayUse: true`, every member of
  a project's bound Slack channel can start coding tasks on that project from an AI tool. Direct
  grants, the only other way in, do not exist until spec 025 phase 25e.
- **A private task is not invisible.** Others who can use the project see that its workspace
  exists, with its status and times, in `agentx workspaces`.
- **Sharing cannot be undone.** A shared task cannot be made private again, and its channel cannot
  change.
- **Continue mode hands the task's workspace to the channel.** Any channel member can mention
  AgentX in the thread to steer the task on the developer's workspace. Use view only, or
  `shareMode.allowContinue: false`, if that is not wanted.
- **Turn-record redaction is best-effort.** Known credential shapes are replaced with `[REDACTED]`.
  This is pattern redaction, not a guarantee that no secret survives.
- **Tools with no item argument run as creates without asking.** GitHub `push_files` and Jira
  `executeWrite` are examples. Approve such tools only if you accept that, or add an `ask` or `deny`
  rule for them.
- **Coding work in a prepared workspace is not gated.** Starting or following up coding work in a
  thread whose workspace is already prepared runs without a check.
- **The worker is root on its instance when a devcontainer is used.** The Docker socket gives it
  that. Each instance serves one workspace, so it reaches only that workspace's volume and the
  instance role.
- **Tool-posted confirmations count.** A person's own tool posting `@AgentX yes` counts as that
  person's confirmation. Set `SlackAppPostedMessages` to `ignore` (`slack.appPostedMessages` in an
  installed environment) if only typed confirmations should count.
- **Rolling the Slack service back while confirmations are pending** turns a button press or typed
  `@AgentX yes` into an ordinary, ungated turn, and a held-back call may then run without asking.
  Roll back only when no confirmation is pending.
- **Slack Enterprise Grid is untested.** Button presses may carry a different team ID and fail to
  find the pending confirmation (a typed `@AgentX yes` still works). The Details button's
  sibling-workspace case has not been checked on a Grid workspace either.
- **A thread's transcript does not survive losing its volume.** There is no promised retention
  period beyond the life of the workspace and its EBS volume.
- **The `cdk` engine exposes the callback signing key** in the operator's local process list while
  `cdk deploy` runs.
