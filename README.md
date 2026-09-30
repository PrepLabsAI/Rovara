# AgentX

A software factory with a hosted pi-based orchestrator in Slack and remote pi coding workers
on Amazon EC2 with persistent EBS storage. Administrators prepare shared product definitions and fixed
development images. Every Slack thread, and every task a developer hands to AgentX from an AI
tool, owns an isolated persistent workspace instance. A task from an AI tool can also be shared into
the project's Slack channel.

## Current status

Every new workspace uses `ec2-ebs`, including self-hosted installs. Each Slack thread gets an
isolated EC2 worker and encrypted EBS volume. The session manager provisions and resumes workers;
the idle reaper stops compute while preserving workspace files and conversation state.

Closed workspace and operation records and historical project revisions remain readable. Retired
deployment modes cannot register projects or execute work. Start a new Slack thread against an
EC2 project revision for new work.

What is built today:

- **The installer.** `agentx init` installs a complete environment in your own AWS account. Then
  `project add`, `channel add` and `connector add` add more projects, channels and connectors.
- **Day-2 commands.** `agentx config`, `doctor`, `upgrade` (and `upgrade --export` for a platform
  team's pipeline) and `destroy` run and remove an installed environment.
- **Developer sign-in.** Developers sign in with Slack, your company's sign-in, or both, with
  `agentx login <url>`. They need no AWS credentials.
- **Tasks from an AI tool.** `agentx mcp install` adds AgentX to Claude Code, Codex or Cursor, and
  `agentx mcp` gives that tool 11 AgentX tools. With them it lists the projects the developer may
  use, starts, checks, continues, shares, cancels and closes coding tasks, and opens pull requests.
- **Sharing to Slack.** A developer can share a task into the project's Slack channel, view only
  or open to the channel ("continue"). A project can require sharing, and an administrator can
  switch a shared task's mode with `agentx admin task share-mode`.

Not built yet:

- Admin tools for AI tools: reading AgentX's state (spec 025 phase 25d) and making confirmed
  changes (phase 25e).
- Phases 2 to 4 of the local install page (spec 040): its GitHub and Slack connect screens, the
  admin user, project and channel screens, and turning the page on by default. Today
  `init --ui` asks the same questions as the terminal, on a local page.

No AgentX release is published yet; see [releases](docs/releases.md).

## How AgentX is structured

```text
Slack thread -> hosted Pi orchestrator -> AgentX control plane -> remote Pi coding worker
                                                              -> approved GitHub MCP tools
AI tool (Claude Code, Codex, Cursor) -> agentx mcp -> AgentX developer task API -> remote Pi coding worker
```

The hosted Pi session is an orchestration-only client. It has AgentX control-plane and approved
MCP tools but no source, file-editing, or shell tools. The remote Pi session owns the coding loop
and exposes `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` inside that thread's
workspace.
AgentX wraps remote Pi only to provide authentication, workspace allocation, operation fencing,
durable callbacks, and Git/tool-evidence artifacts. The `agentx` executable administers
environments and projects. Its `agentx mcp` server also lets a signed-in developer's AI tool hand
coding tasks to AgentX through the developer task API. Every other coding operation must come from
the orchestrator's service identity; the control plane refuses it otherwise.

The remote session runs at the workspace root, above the repositories, so Pi's own context-file
discovery never reaches them. AgentX therefore adds its own workspace note first, listing each
prepared repository and where it is checked out, and telling the model to make each change inside
the repository it belongs to. For each prepared repository the worker then loads the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` that exists in the
repository root, and adds it to the session context labelled with that repository's name and
workspace path. The files are read again for every task, so an edited one applies to the next
task. A file that resolves outside its repository or exceeds 64 KiB is skipped and reported as a
progress event.

Every remote coding task also publishes a redacted `usage` operation event and private
`usage.json` artifact. They record the task outcome, actual Pi provider and model, prompt-cache
retention mode, input/output/cache token counts, cache-read ratio, and Pi's estimated cost. The
runtime stack (`AgentXProductionRuntime` in the maintainers' deployment, `agentx-<env>-runtime` in
an installed one) exposes `PromptCacheRetention` as a CloudFormation parameter with `short` and
`long` values; it defaults to `long` so Bedrock cache entries can survive normal gaps between
Slack turns.

Both roles currently use `@earendil-works/pi-coding-agent` 0.85.1. GitHub Spec Kit supplies the
specification workflow and demo repository; it is not the coding-agent runtime.

See the [production architecture](docs/architecture-production.md) for the EBS-backed platform,
its request path, and how environments are installed and torn down.

## Install AgentX in your AWS account

`agentx init` installs a complete AgentX environment in your own AWS account, step by step: its
stacks, its own GitHub App and Slack app, developer sign-in, your first project and its Slack
channel, and, if you want them now, the Linear, Jira and Asana connectors. It prints everything it
will create and an estimated monthly cost before it creates anything, and running it again resumes
where it stopped.

**Status:** no AgentX release is published yet (the public image registry and the npm package are
waiting on owner setup; see [releases](docs/releases.md)). Until the first release, an install runs
from a source checkout with a locally built release, and needs container images you have pushed
yourself. When a release is published, the whole install is one command:
`npx @charterarc/agentx init --env <name>`.

You need:

- AWS administrator credentials for the first run, ideally in an AWS account used only for
  AgentX (environments that share an account are not a security boundary against each other).
  Later day-2 commands use a narrower operator role that `init` creates.
- A GitHub organization or personal account to own AgentX's GitHub App.
- A Slack workspace where you can create and install apps.
- Model access: Amazon Bedrock (the default) in the chosen region, or an OpenRouter API key.
- Node.js 22.19 or newer within the Node 22 release line.

From a source checkout today:

```sh
npm ci && npm run build
npm run release:build -- --version <x.y.z> --out ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>

export AWS_PROFILE=<an admin profile for the target account>
node packages/cli/dist/main.js --env <name> init --region us-east-1 --release ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>
```

`init` asks its questions (every one has a flag, and `--yes` runs it unattended), then:

1. checks prerequisites: the region, model access and EC2 quota;
2. deploys the access, foundation and identity stacks;
3. creates the GitHub App from a pre-filled page (one click), and you choose its repositories;
4. deploys the control plane and runtime;
5. creates the Slack app from AgentX's manifest; you install it and paste its tokens into hidden
   prompts;
6. deploys the Slack service and checks that Slack can reach it;
7. sets up developer sign-in: Slack, your company's sign-in (OIDC), or both;
8. creates your admin user and signs you in;
9. sets up your first project (on EC2 workers) and its Slack channel;
10. offers the Linear, Jira and Asana connectors;
11. subscribes alerts, sets the monthly budget and sends a test alarm;
12. ends once a person mentions the bot in the channel and gets a threaded reply, and prints the
    command developers use to sign in.

`init` deploys published CloudFormation templates by default; `--engine cdk --source <checkout>`
deploys with the CDK from a clean checkout of the release's tag instead. `--ui` asks every question
on a page on `127.0.0.1` instead of in the terminal, with the plan to review and a checklist of
steps; the terminal is still the default. `--stop-after <step>` runs the steps up to that one and
stops, for automated tests; running `init` again finishes.

An installed environment's stacks are named `agentx-<env>-access`, `-foundation`, `-identity`,
`-runtime`, `-control-plane` and `-slack`. Its alarms are named `agentx-<env>-<Name>`, and its
connector secrets live under `agentx/<env>/connectors/`. The maintainers' own deployment predates
the installer and keeps fixed names: `AgentXProductionFoundation`, `AgentXProductionRuntime`,
`AgentXControlPlane` and `AgentXSlackOrchestrator`, with no access or identity stack. Where this
README names an `AgentX...` stack or a stack parameter, it means the maintainers' deployment; in
your environment, use the matching `agentx-<env>-...` stack, or `agentx config` where a key exists.

Secrets never go on the command line: each comes from a hidden prompt, a file you point to, or an
environment variable, and `init` stores it in AWS Secrets Manager, never in its own settings. A
platform team that must review IAM first can use `agentx --env <name> init --export <dir> --region
<region> --release <dir>` for a bundle they deploy themselves (`--env` must be given explicitly);
the operator then continues with `agentx --env <name> init --resume --region <region> --from-bundle
<dir>`.

After the install, day-2 work runs with the operator role that `init` created:

- `agentx --env <name> project add` and `agentx --env <name> channel add` add another project and
  channel (the worker image has Python 3 and uv for Python projects).
- `agentx --env <name> connector add linear|jira|asana` adds a connector later, and
  `agentx --env <name> alerts test` sends another test alarm.
- `agentx --env <name> doctor` checks every part of the environment and says how to fix what is
  wrong.
- `agentx --env <name> config list`, `config get <key>` and `config set <key> <value>` read and
  change the models, the per-thread request limit, Slack settings, alerts and the budget. They show
  the workspace limits too, but cannot change them yet (see "Working in a thread").
- `agentx --env <name> upgrade` moves to a newer release, showing every change and asking first;
  `upgrade --export <dir>` writes the upgrade for a platform team's pipeline instead.
- `agentx --env <name> destroy` removes the environment. It needs admin credentials and an explicit
  `--env`, and asks you to type the environment's name; `--keep-data` keeps the tables, buckets,
  secrets, Cognito user pool and KMS keys.

Developers then sign in from their own machines with `agentx login <control plane URL>`, with no
AWS credentials; `agentx whoami` shows which projects they can use, and `agentx workspaces` opens a
page on `127.0.0.1` showing those projects and the workspaces in them (`--no-ui` prints the same
list in the terminal). To hand tasks to AgentX from Claude Code, Codex or Cursor, a developer runs
`agentx mcp install --client claude-code|codex|cursor` once.

The guides:

- [Installing AgentX](docs/install.md): each way to install (published templates, cdk, or through
  a platform team), resuming, unattended installs and the cost estimate.
- [Running AgentX](docs/day-two.md): the operator role, `doctor`, `upgrade`, `config`, projects,
  channels, connectors and developer sign-in settings (`agentx signin`).
- [Removing an environment](docs/teardown.md) and
  [moving AgentX to another AWS account](docs/move-account.md).
- [Use AgentX from Claude Code, Codex or Cursor](docs/mcp-install.md): the developer's guide to
  `agentx mcp`, including sharing a task to Slack.
- [Releases](docs/releases.md): what a release contains, how one is cut, the owner setup still
  open, and the release test.

## Use AgentX

### 1. Install the administration client

Developers work in Slack, or from their AI tool through `agentx mcp`. They can also sign in from
their own machines (`agentx login <url>`, `agentx whoami`, `agentx workspaces`) to see which
projects they can use and what is running in them. Everything else the `agentx` executable does is
administration: installing, upgrading and removing environments, registering projects, binding
Slack channels, choosing how developers sign in, and stopping idle workspaces.

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

For an environment installed with `agentx init`, pass `--env <name>` to each command below and
skip the deployment file: `init` already wrote that environment's settings. The deployment file is
for the maintainers' own `production` deployment.

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
Registering a file that still has them fails with those field names. In an installed
environment, `agentx project add` writes this file for you. See
[project configuration](docs/project-configuration.md) and the illustrative files in
[`examples/deployment.yaml`](examples/deployment.yaml) and
[`examples/projects/`](examples/projects/).

Log in as an administrator, register the immutable revision, then bind the project's channel. For
an environment installed with `agentx init`, add `--env <name>` to each command:

```sh
agentx login --callback-port 8765

agentx admin project register \
  --file "$HOME/.agentx/projects/payments.yaml" \
  --deployment-mode ec2-ebs \
  --launch-template-id <Ec2WorkerLaunchTemplateId> \
  --subnets <Ec2WorkerSubnets>

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
configured on the control plane (the maintainers' deployment uses `github-agentx-sdlc`; in an
installed environment, `project add` fills in its own). The YAML still contains no private key or
installation token.

An administrator can release a thread workspace's idle compute without losing its files:

```sh
agentx admin workspace stop --workspace <workspace-id>
```

An administrator can also stop any workspace's running coding task. The task ends CANCELLED and the
workspace takes the next request:

```sh
agentx admin workspace cancel --workspace <workspace-id>
```

An administrator can also switch a task that a developer shared from an AI tool between view only
and continue, within the project's `developerTasks` settings:

```sh
agentx --env <name> admin task share-mode --task <task-id> --mode view|continue
```

Run `agentx --help` or `agentx <command> --help` for the complete surface: `init`, `deploy`,
`upgrade`, `config list|get|set`, `doctor`, `destroy`, `env list|use|adopt`,
`signin show|enable|disable|check`, `project add`, `channel add`,
`connector add linear|jira|asana`, `alerts test`, `login`, `logout`, `whoami`, `workspaces`,
`mcp`, `mcp install`, `admin project register`, `admin workspace cancel|stop`,
`admin slack bind|unbind`, `admin credential register|authorize|list`, `admin turns export`, and
`admin task share-mode`. Developer commands are `login <url>`, `whoami`, `workspaces`, `logout`,
`mcp` and `mcp install`. Coding work happens in Slack, or in a developer's AI tool through
`agentx mcp`.

A command's exit code names the kind of failure: 2 for invalid input, 3 when login is required, 4
for forbidden or not found, 5 when the workspace is busy or not ready, 6 when the control plane is
unavailable, 7 for any other AgentX error, and 1 for an unexpected internal error. `agentx doctor`
exits 2 when any check fails.

### 3. Work in the project's Slack channel

AgentX runs a hosted orchestrator for Slack in the environment's own AWS account, so no developer
machine has to stay online. Slack calls the AgentX Events API route; an ingress Lambda verifies
Slack's signature, acknowledges in the thread, and queues the request. An ECS Fargate service runs
the Pi orchestrator for that thread and posts the result back. It can call AgentX orchestration
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

In an installed environment, `agentx --env <name> connector add linear|jira|asana` stores the
credential under `agentx/<env>/connectors/<type>` (for example `agentx/prod/connectors/linear`)
and registers it for you, so you can skip the manual steps below. They are for the maintainers'
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
key; see [docs/connectors/linear.md](docs/connectors/linear.md). Jira reads a registered
`static-secret` API token; see [docs/connectors/jira.md](docs/connectors/jira.md). Asana reads an
`oauth-refresh-token` credential for a bot user; see [docs/connectors/asana.md](docs/connectors/asana.md). Registering a
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

This section and section 5 describe the maintainers' own production deployment, which uses fixed
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
latest registered revision from the next mention onwards: the GitHub MCP policy and the
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
how many are ahead, and says "Working on it now" when it starts on the request. A request with
nothing ahead gets no separate "Working on it now" notice, unless it waits for workspace setup. A
message that is only an answer to a confirmation (`yes`, `yes to all`, `cancel` and their plain
synonyms) gets no "Got it" either, unless requests are queued ahead of it. An Approve or Cancel
button press is counted the same way, so with nothing ahead the button's own "Running it now" is
the only notice. A
new thread gets a coding workspace only when a request first needs the remote worker, for example to
read or change repository files or to run commands. Questions that connectors answer, such as issue
tracker questions, need no workspace. The first request that needs the worker prepares the workspace
in the same turn, which takes a few minutes, and AgentX says so in the thread. Messages without a
mention, edits, bot messages, AgentX's own messages, direct messages, and users from other Slack
organizations are ignored.

A person can also mention AgentX through another tool that posts with their own Slack user token,
such as Claude Code's Slack access or a script. AgentX checks with Slack that the sender is a
person, then treats the message exactly as if they had typed it. A message posted with a bot token
is ignored. To answer only typed mentions, set the `AgentXControlPlane` parameter
`SlackAppPostedMessages` to `ignore` (in an installed environment,
`agentx --env <name> config set slack.appPostedMessages ignore`). This also means a person's own
tool posting "@AgentX yes" counts as that person's confirmation, the same as typing it. The **Approve** button can only be
pressed in Slack, but a typed or tool-posted `@AgentX yes` still counts, so set
`SlackAppPostedMessages` to `ignore` if only typed confirmations should count.

A thread that sends AgentX more than 6 requests in a minute is paused: AgentX posts one notice and
runs nothing more in that thread until the next minute. This stops a tool that answers AgentX's
replies from looping. The `AgentXControlPlane` parameter `SlackThreadTurnsPerMinute` changes the
limit (in an installed environment, `agentx --env <name> config set limits.threadTurnsPerMinute
<n>`). A request that AgentX could not queue is not counted, so Slack's retry of it is not held
against the thread; in the rare case where that happens during a burst at the limit, the thread
can get a second pause notice in the same minute.

AgentX posts its replies in Slack formatting, with real line breaks and one Slack link per URL.
Text such as `<!channel>` in a reply is shown as text and never notifies anyone.

Pull requests created from a thread end with a link to the thread and the Slack members who made
requests in it. Every operation records the Slack member who requested it.

Workspaces are limited to protect cost. Threads whose workspace has been prepared count, and so
do open tasks from AI tools: both share the same limits. The member whose request first prepares
a thread's workspace is charged for it. Each member may hold at most 3 workspaces, and the
organization at most 20. When a request needs a workspace over either limit, AgentX prepares
nothing and says which limit was reached; for the member limit, it also links that member's
existing threads and gives their open task count. It still answers any part of the request that
connectors can answer. In the maintainers' deployment, an administrator changes the limits with the
`AgentXControlPlane` parameters `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`.
An installed environment starts from the same defaults, and `agentx --env <name> config get
limits.workspacesPerMember` (or `limits.workspacesPerOrg`) shows them. `config set` cannot change
them yet: the admin tool that does (spec 025 phase 25e) is not built.

To stop the thread's running coding task, mention AgentX in the thread with just a stop request:

```text
@AgentX stop
```

`abort`, `halt`, `stop it`, `cancel the task` and `please stop` work too; only the whole message counts,
so `@AgentX stop using tabs` is an ordinary request. A bare `@AgentX cancel` still declines a pending
confirmation. Any member of the channel can stop the task. AgentX replies that it is stopping, and the
task ends as cancelled. When nothing is running, the message goes to AgentX like any other request.

To release a thread workspace, mention AgentX in that thread with an explicit close request:

```text
@AgentX close this workspace
```

A thread that never needed the worker has no workspace. A close request there says so and changes
nothing.

AgentX first fences new work and checks every prepared repository. Uncommitted changes, untracked
files, an unpushed current commit, or commits on a local-only branch block closure; AgentX lists the
affected repositories in the thread and keeps the workspace intact. Publish or remove that work,
then retry the close request. A running preparation, task, publication, maintenance, resume, or
cancellation also blocks closure until it finishes.

For a clean production workspace, AgentX terminates its EC2 instance and deletes
the persistent EBS volume, and then confirms completion in the same Slack thread. It
retains the workspace and operation records as a closed tombstone for audit and retry safety, but
removes the hosted orchestrator conversation session and releases the organization's quota and that
of the member who prepared the workspace. Later mentions in the closed thread do not create another
workspace; start a new Slack thread for fresh work.

#### Tasks shared from an AI tool

A developer can share a task they started from their AI tool into one of the project's bound
channels, with `agentx_share_task` or when starting it. AgentX posts a new thread that names who
started the task, from which tool, its title, the project and its status, and keeps the thread up
to date: when the workspace is ready or could not be set up, when the task ends (with the worker's
summary), when a pull request opens, when the mode changes, and when the task is closed. AgentX's
own messages in the thread do not include the developer's instructions.

- **View only** (`view`): channel members follow the task, and the developer drives it from their
  AI tool. A mention in the thread gets a notice instead of running.
- **Continue** (`continue`): channel members can also mention AgentX in the thread to steer the
  task on the same workspace, one request at a time, each attributed to the member who sent it.

The project's `developerTasks` settings decide what is allowed: `share: required` shares every
task, `shareMode.default` picks the mode when none is asked for (`view` unless set), and
`shareMode.allowContinue: false` keeps every shared task view only. Sharing into a private channel
needs the developer to be a member of it. A shared task's channel cannot change, and a shared task
cannot be made private again. An administrator can switch a shared task's mode, within those
settings, with `agentx --env <name> admin task share-mode --task <task-id> --mode view|continue`.
Sharing is available only in environments installed with `agentx init`. The developer's side is in
[Use AgentX from Claude Code, Codex or Cursor](docs/mcp-install.md#sharing-a-task-to-slack).

A task's workspace setup that is still running after 50 minutes is marked failed; the task then
reads `setup_failed`, and closing it frees its place in the workspace limits.

#### Actions that need your confirmation

Before any tool runs, AgentX's action gate decides whether to run it, ask, or refuse. It uses
AgentX's own rules, the same for every connector:

- Reads run.
- A call that names no existing item creates one, and runs.
- A call that closes, deletes, archives, merges, reverts or cancels something, or that sets a
  status, state or resolution, or marks an item completed (`completed` set to true or false), is
  destructive and always asks.
- A call that changes an existing item runs when your messages in the thread clearly asked for
  that change on that item; otherwise AgentX asks. A small model makes that check. It sees only the
  members' messages, the call and the item's key, never what a tool returned, so text inside an
  issue cannot approve a change.
- A write whose arguments hold a list of more than 5 entries, such as 6 tasks, asks.

When AgentX asks, it posts one message listing every action it held back, with **Approve** and
**Cancel** buttons. That message is the reply: AgentX adds its own answer only when something else
happened in that turn (a call ran, even if it failed, or an action was refused or could not be
checked), and that answer does not repeat the question. Only the member who made the request can press them; anyone else is told so
privately. You can also reply `@AgentX yes` or `@AgentX cancel`. A confirmation counts once, only
after the question, and for 24 hours. AgentX then runs exactly the listed calls; a call with any
other arguments is checked afresh, as a new call. Any other message from you replaces the question.

After a press, the buttons are replaced by who answered and how ("Approved by ... Running it now."
or "Cancelled by ..."). A second press while the first is still being taken is answered privately
with "Already received. I'm on it." A `yes` to a question that has expired is told so for 24 hours after the expiry; after
that it is an ordinary request. If Slack redelivers an approval that an earlier attempt already
used, AgentX runs nothing again and says "An earlier attempt of this request already used that
confirmation": the calls may already have run, so ask it to check.

`@AgentX yes to all in this thread` stops the questions that come only from the model's doubt
(including when the model could not answer), for you, in that thread, for 24 hours; say it again to
renew it. If a question of yours is pending, it also approves that question. Destructive actions,
large changes and administrator rules still ask.

Coding work in a thread that has no workspace yet is checked the same way, once, before AgentX
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
- For a tool that offers an item argument, AgentX looks for a status, state, resolution,
  `completed` or similar key anywhere in the arguments, up to level 4. The arguments themselves are
  level 1, and each object or list inside adds one level, so `tasks[].completed` is at level 3 and
  found. For a tool that offers none, only top-level arguments and keys directly inside an object
  argument (such as `fields.status`) are read, so a create of tasks that are already complete stays
  a create.
- A vendor's own `destructiveHint` makes a call ask only when the connector declares no item
  arguments. Vendors mark ordinary edits destructive, so where AgentX can see the item a call names,
  its own rules decide. The built-in GitHub, Linear, Jira and Asana connectors all declare them.

The model that checks changes is a deployment setting: the `AgentXSlackOrchestrator` parameter
`GateClassifierModelId`, default Amazon Nova Lite (`amazon.nova-lite-v1:0`). Claude Haiku 4.5
(`us.anthropic.claude-haiku-4-5-20251001-v1:0`) is an alternative. In an installed environment,
`agentx init` asks for it (`--classifier-model`), and `agentx --env <name> config set
models.classifier <id>` changes it later, after testing the model with one call. If the model is
unavailable, errors, gives an answer that is not a plain verdict, or does not answer in time, AgentX asks. The time limit is 8
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
reasons AgentX writes name at most an argument, never its value; the model check writes its own
one-sentence reason and is told not to quote the messages.

#### What a thread remembers

Each Slack thread owns one conversation, and every request in it continues that conversation. The
transcript lives on the thread's workspace volume next to its files, so a follow-up sees both the
earlier discussion and the earlier edits. It survives a client disconnect and reconnect, and the
replacement of the worker process, because neither touches the volume.

It does not survive losing the volume. If the workspace is replaced, the next request in the thread
fails with `CONVERSATION_STATE_LOST` rather than starting the thread over on top of files it has no
memory of. Start a new thread to continue. There is no promised retention period beyond the life of
the workspace's EBS volume.

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
AgentX tells the member privately. Long arguments are cut to fit Slack's limits and end with
`… [cut to fit]`; `agentx admin turns export` has the full record. The button needs Slack
Interactivity, which the action gate's confirmation buttons already turned on; it needs no new
scope.

Connector and turn metrics go to the `AgentX` CloudWatch namespace (`AgentX/<env>` in an
installed environment); see
[contracts/metrics.md](specs/013-connector-gateway/contracts/metrics.md) for the full list. The
names below are the maintainers' deployment's. An installed environment has the same alarms named
`agentx-<env>-<Name>` (for example `agentx-<env>-ConnectorBroken`) on the topic
`agentx-<env>-alerts`, plus Slack service, session and shared-task notice alarms (such as
`agentx-<env>-TurnErrors` and `agentx-<env>-DeveloperNoticeDeadLetters`); `agentx init` subscribes
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
registered project's `readiness` commands run inside the EC2 workspace before a candidate is
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
reopen it. The orchestrator makes all of these changes (append, sync, edit title/body, close,
reopen, replace, and revert) through one tool, `agentx_manage_pull_request`, choosing the action
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

Change them under **GitHub Settings → Developer settings → GitHub Apps → your AgentX app (the
maintainers' is AgentX SDLC; `init` names yours with `--github-app-name`) → Permissions & events →
Repository permissions**. After saving, the installation owner must approve the updated
permissions for the installation. The App private key stays in Secrets Manager; it is never sent to
the worker. AgentX mints short-lived, single-repository tokens separately for clone,
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
`StartBuild`/`BatchGetBuilds` permission scoped to `agentx-*` projects, while the worker receives no
CodeBuild AWS credentials. A failed new-PR build leaves its candidate branch for diagnosis but
creates no PR. A failed existing-PR build leaves the PR head unchanged.

This release gates one repository publication at a time. Testing unpublished frontend and backend
candidates together and creating multiple PRs as one unit requires a future multi-repository
change-set workflow; a CodeBuild project may use secondary sources, but AgentX does not yet bind
multiple candidate commits atomically.

### 5. Deploy and release (the maintainers' production deployment)

This section describes the maintainers' own deployment and its release pipeline. To move an
installed environment to a newer release, use `agentx --env <name> upgrade`; see
[Running AgentX](docs/day-two.md#upgrade).

Registering a project and binding its channel are covered in section 2. Workspaces are created by
Slack threads and by tasks from AI tools, never by an administrator.

For the production EBS-backed platform, preview the release without changing AWS:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1 --dry-run
```

The first real production release creates the protected foundation (dedicated two-AZ VPC, two NAT
gateways, KMS key, private worker security group, flow logs, and an EC2 worker launch template), then creates worker settings. Later releases refuse to modify that foundation
and update only the runtime and control plane:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1
```

The release updates worker settings and the control plane. Each workspace keeps its EBS volume;
a new image takes effect the next time its compute starts. Project registration and workspace
preparation are separate operations.

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
| Any other deployable package (`packages/broker`, `cli`, `gateway`, `mcp`, `orchestrator`, `slack-service`), `environments/` or `infra`, but no worker image input | Checks, then a control-plane deploy. The deployed worker digest is reused and the runtime is unchanged |
| A worker image input: `packages/worker`, `packages/contracts`, `packages/model-runtime`, the Dockerfile, `.dockerignore`, root `package.json`, `package-lock.json` or tsconfigs, or a workspace `package.json` | Checks, a new ARM64 image, a runtime update to `READY` on that digest, then a control-plane deploy |

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

Spec 014 phase 14c part 2 turns the action gate on. Operator notes:

- In the Slack app's **Interactivity & Shortcuts** settings, turn Interactivity on and set the
  Request URL to the `AgentXControlPlane` output `SlackInteractivityUrl`. Without it a button press
  reaches no one, and members must confirm by replying `@AgentX yes`.
- On Slack Enterprise Grid, the team ID in a button press may differ from the one in the thread's
  mention events. A press would then find no pending confirmation and answer that it is no longer
  pending. This has not been checked on a Grid workspace; there, a typed `@AgentX yes` still works.
- A confirming `yes` claims its confirmation only after the thread's conversation bookkeeping (the
  workspace check, the conversation record and any settings notice), just before the turn runs, so
  a request that stops early leaves the question pending. Two answers racing each other can both do
  that bookkeeping; only one claims and runs the calls, and the other is told the confirmation was
  already used.
- The part 1 rollback floor above still applies.
- Rolling the control plane back below this release does not break the turn record export, but
  `agentx admin turns export` then skips every record that has a call `gate` or one of the new
  dispositions: the older control plane's record schema refuses them, counts them as `skipped` and
  logs `turn_record.invalid`. The records stay in the table and export again after rolling forward,
  within their 30 days.
- Rolling the Slack service back below this release while confirmations are pending turns a
  button press (the control plane still queues it as "yes" or "cancel") or a typed `@AgentX yes`
  into an ordinary, ungated turn. The model may then re-issue the call it was holding back, and it
  runs without asking. Roll back only when no confirmation is pending, or tell members not to
  answer pending ones.
- Turn records gain a `gate` object on each call and the dispositions `confirmation_refused`,
  `confirmation_cancelled` and `yes_to_all_granted`. Only `answered` and `failed` count in turn
  metrics. The
  service logs `gate.decision` for each call, and `gate.confirmation_requested`,
  `gate.confirmation_approved`, `gate.confirmation_cancelled`, `gate.confirmation_refused` and
  `gate.yes_to_all` for answers. `gate.reply_withheld` means a turn's only reply was its
  confirmation; the turn record still keeps the model's text.
  `gate.confirmation_failed` means a question could not be saved or posted; the member is told
  that nothing it would list will run.

Spec 014 phase 14d adds the **Details** button. Operator notes:

- Only the last part of a reply gets the button, and only when that turn made at least one tool
  call and its turn record will be written. Replies without tool calls, confirmation questions and
  AgentX's own notices have no button. If Slack refuses the button (an API error such as
  `invalid_blocks`), the reply is posted as plain text and the Slack service logs
  `reply.details_failed` with Slack's error code as `slackError`. A network error or timeout is
  logged the same way without a code and is not followed by a text copy, since Slack may already
  have posted the reply; the request is retried like any failed post.
- Who can open it: any member who can see the reply, from the thread's own workspace. A member of
  another organization in a Slack Connect channel is told "AgentX couldn't find the details for
  this reply.", and nothing is read. So is a press whose payload carries no workspace team ID. On
  Enterprise Grid, a member of a sibling workspace in the same grid may open it when the press
  carries the same grid ID for the workspace and the member; the record's own team must still
  match the thread's. The Grid case has not been checked on a Grid workspace. Every refusal is
  logged as `interaction.details_refused` with a `reason` (for example `external_member`,
  `expired`, `not_found`) and the viewer's user ID. A sibling-workspace press that finds no record
  is told the details couldn't be found (`not_found_foreign_team`), never that saving failed.
- What it shows: a call's arguments are stored redacted and capped at 2,048 characters. The view
  shows at most 2,000 characters of each call's arguments, and less when a turn made many calls.
  Record text is escaped, so it cannot form a link, mention or alert in the view. The request and
  response text, the workspace and the worker operations are never read.
- Turn records are kept 30 days. After that the view says "AgentX keeps turn details for 30 days.
  The details for this reply, from <date>, are no longer kept." It says so from the button alone,
  without a read, and also for a record DynamoDB has not deleted yet.
- A press within 60 seconds of the reply, before the record is saved, says the details are still
  being saved. A record that was never saved points to `turn_record.write_failed`. A record that
  fails its schema (`interaction.details_invalid`) points to `agentx admin turns export`. A read
  that fails or takes more than 1 second (`interaction.details_read_failed`) says to press
  Details again. If the view cannot open (`interaction.details_open_failed`), the member gets
  "I couldn't open the details in time. Press Details again." privately.
- The control plane sets `TURN_RECORDS_TABLE_NAME` on the ingress Lambda. It is optional. Without
  it, the Lambda logs `interaction.details_not_configured` at the first button press after it
  starts, and every Details press says the details couldn't be loaded. Approve and Cancel keep working.
- The ingress Lambda's role gains one statement: `dynamodb:GetItem` on the `TurnRecords` table,
  not its index, and no Query or Scan. The partition key must start with `THREAD#`. The read must
  name only the attributes the view shows, plus the keys `pk`, `sk`, `exportPk` and `exportSk`
  (`TURN_DETAILS_READ_ATTRIBUTES` in `infra/lib/control-plane.ts`). A `Null` condition refuses a
  read that names no attributes, which would otherwise return the whole record, request text
  included. The Slack service still only puts turn records, and the broker still only queries them.
- Release in this order: runtime, then control plane, then Slack service. The control plane's
  Details handler stays dormant until the Slack service posts buttons. After the control plane
  deploys, and before the Slack service does, check the grant with the IAM policy simulator:

  ```bash
  FUNCTION=$(aws cloudformation describe-stack-resources --stack-name AgentXControlPlane \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'SlackIngress')].PhysicalResourceId" --output text)
  ROLE=$(aws lambda get-function-configuration --function-name "$FUNCTION" --query Role --output text)
  TURNS=$(aws cloudformation describe-stacks --stack-name AgentXControlPlane \
    --query "Stacks[0].Outputs[?OutputKey=='TurnRecordsTableName'].OutputValue" --output text)
  TABLE=$(aws dynamodb describe-table --table-name "$TURNS" --query Table.TableArn --output text)
  # The Details attributes: "allowed".
  aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
    --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
      "ContextKeyName=dynamodb:Attributes,ContextKeyValues=pk,sk,eventId,calls,ContextKeyType=stringList" \
    --query 'EvaluationResults[0].EvalDecision'
  # The request text: "implicitDeny".
  aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
    --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
      "ContextKeyName=dynamodb:Attributes,ContextKeyValues=pk,sk,requestText,ContextKeyType=stringList" \
    --query 'EvaluationResults[0].EvalDecision'
  # No attributes named at all: "implicitDeny".
  aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
    --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
    --query 'EvaluationResults[0].EvalDecision'
  ```

  Then confirm it live, with the ingress role's permissions (for example from a break-glass admin
  allowed to assume the role). A read with no projection must fail with `AccessDeniedException`:

  ```bash
  aws dynamodb get-item --table-name "$TURNS" --key '{"pk":{"S":"THREAD#x"},"sk":{"S":"TURN#x"}}'
  ```

  Then deploy the Slack service. In a bound channel, ask for something that calls a tool, and
  press **Details** as yourself and as a second member. Both see the view, and nothing new appears
  in the thread.
- Roll back the Slack service first: new replies lose the button, and buttons already posted keep
  working. Do not roll the control plane back below this release while replies with buttons are
  less than 30 days old. If you do, an old button tells the member "This button is no longer
  available." (`interaction.ignored`), and no longer opens anything.

## Implementation documents

- [Pull-request task list](specs/002-create-pull-request/tasks.md): implementation and validation
  status for explicit publication.
- [Safe PR lifecycle task list](specs/003-safe-pr-lifecycle/tasks.md): clean publication,
  append/sync, replacement, and revert progress.
- [Pull-request specification](specs/002-create-pull-request/spec.md): publication behavior,
  safety, and retry requirements.
- [Conversation continuity task list](specs/012-conversation-continuity/tasks.md): reopening a
  thread's saved session, and what is verified locally rather than on a deployment.
- [Task list](specs/001-agentx-foundation/tasks.md): the foundation's implementation tasks, in
  dependency order.
- [Specification](specs/001-agentx-foundation/spec.md): agreed workflows and acceptance criteria.
- [Plan](specs/001-agentx-foundation/plan.md): architecture, boundaries and delivery sequence.
- [Research](specs/001-agentx-foundation/research.md): decisions and primary sources.
- [Production AWS architecture](docs/architecture-production.md): EC2 workers and persistent EBS,
  per-session EBS, networking, release, isolation, and migration boundaries.
- [Contracts](specs/001-agentx-foundation/contracts/): project config, control API and worker protocol.
- [Validation guide](specs/001-agentx-foundation/quickstart.md).
- [Installer specification](specs/015-installer/spec.md) and
  [phase plans](specs/015-installer/plans/README.md): `agentx init`, `upgrade`, `config`, `doctor`
  and `destroy` (phases 15a to 15e built).
- [MCP server specification](specs/025-mcp-server/spec.md) and
  [phase plans](specs/025-mcp-server/plans/README.md): developer sign-in, tasks from AI tools and
  sharing (phases 25a to 25c built; 25d and 25e not yet).
- [Local install page specification](specs/040-install-ui/spec.md): `agentx init --ui` (phase 1
  built; phases 2 to 4 not yet).
- [Project configuration](docs/project-configuration.md): every field of a project file.
- [Constitution](.specify/memory/constitution.md): project principles, version 4.0.0.

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

The latest results are the CI runs on each pull request. Docker and AWS are not required for this
local suite.

For Bedrock/OpenRouter configuration, Slack model selection, and the live verification checklist, see [OpenRouter model access](docs/openrouter.md).
