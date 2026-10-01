# Project configuration

A project file describes one product: the repositories a thread works on, how to prepare and check
them, and what the orchestrator may use. It lives at `~/.agentx/projects/<project-name>.yaml` and
is registered with `agentx admin project register`. It holds no workspace ID,
session ID, token or repository secret.

The deployment itself (control-plane URL and sign-in settings) is a separate file,
`~/.agentx/deployment.yaml`; see [`examples/deployment.yaml`](../examples/deployment.yaml).
Illustrative projects are in [`examples/projects/`](../examples/projects/).

The schema is `ProjectDefinitionSchema` in
[`packages/contracts/src/project.ts`](../packages/contracts/src/project.ts). Registration rejects
unknown fields.

## A minimal project

```yaml
name: payments
revision: 1
repositories:
  - name: payments-api
    url: https://github.com/example/payments-api.git
    path: repo/payments-api
    defaultBranch: main
    credentialRef: github-agentx-sdlc
setup:
  - cwd: repo/payments-api
    executable: npm
    args: [ci]
    timeoutSeconds: 600
readiness:
  - cwd: repo/payments-api
    executable: npm
    args: [test]
    timeoutSeconds: 600
orchestratorInstructions: Delegate every repository read, edit, build, and test to the remote AgentX worker.
```

## Fields

| Field | Required | What it holds |
|---|---|---|
| `name` | yes | The project name. Channels are bound to it. |
| `revision` | yes | A positive whole number. Revisions are immutable: increase it before registering a changed file. New threads use the latest registered revision. |
| `repositories` | yes | 1 to 32 repositories (below). |
| `setup` | yes | Up to 64 commands run once when a workspace is prepared. May be empty. |
| `readiness` | yes | Up to 64 commands run in the workspace before any candidate is pushed. A failure stops the publication. May be empty. |
| `devcontainer` | no | Runs `setup`, `readiness` and the agent's shell inside a repository's dev container (below). |
| `orchestratorInstructions` | yes | Up to 32,768 characters of project guidance for the orchestrator. |
| `models` | no | The models a channel may choose from (below). |
| `integrations` | no | Connector tools the orchestrator may use (below). |
| `actionPolicy` | no | Rules that tighten or loosen which tool calls ask for confirmation (below). |
| `developerTasks` | no | How the project treats tasks started from an AI tool (below). |

A file that still has `schemaVersion`, `controlPlaneUrl`, `auth` or `environment` is refused, and
the error names those fields. The first three moved to the deployment file; the release pins the
worker image.

### Repositories

| Field | What it holds |
|---|---|
| `name` | Unique within the project. Used in requests such as "create a pull request for payments-api". |
| `url` | HTTPS clone URL. |
| `path` | Where the repository is checked out, relative to the workspace root. Paths may not overlap. |
| `defaultBranch` | The branch pull requests target. |
| `credentialRef` | The GitHub App credential reference configured on the control plane. The file never holds a key or token. |
| `codeBuildGates` | Optional. Up to 8 CodeBuild gates, each with a `name`, a `projectName` matching the deployment's allowed prefix, and `timeoutMinutes` from 5 to 420. The total timeout per repository is at most 420 minutes. See [Configure CodeBuild gates](../README.md#configure-codebuild-gates). |

### Commands

Each `setup` and `readiness` entry has `cwd` (relative to the workspace), `executable`, `args` (up
to 256 strings) and `timeoutSeconds` (up to 86,400).

An entry may also have `env`: environment variables for that command only. The next command does
not see them. On the worker they are added to the worker's own environment; with a dev container
they are set inside the container (`devcontainer exec --remote-env`).

```yaml
setup:
  - cwd: repo/payments-api
    executable: npm
    args: [ci]
    timeoutSeconds: 600
    env:
      NODE_ENV: test
      npm_config_fund: "false"
```

- Names follow POSIX rules: a letter or `_`, then letters, digits or `_`, at most 128 characters.
- Values are strings (quote `"false"` and numbers in YAML), at most 4,096 characters each, with no
  NUL byte.
- At most 64 entries and 32,768 bytes per command.
- AgentX refuses names it or the system relies on, in any letter case: `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `IFS`, `ENV`, `BASH_ENV`, and any name starting with
  `AGENTX_`, `AWS_`, `GIT_`, `LD_`, `DYLD_` or `PI_`. To use a tool that is not on the worker's
  `PATH`, give its full path as `executable`, or set `PATH` in the dev container's own
  configuration.
- Other names are allowed, including ones the worker image sets, such as `NODE_ENV` and `PORT`,
  and ones like `NODE_OPTIONS` or `HTTPS_PROXY`. They apply to that one command only.

**`env` is not for secrets.** A registered revision is stored and shown in full, and with a dev
container the values are on the `devcontainer exec` command line while a command runs. At
registration AgentX refuses:

- names whose last word marks a credential (`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`,
  `PWD`, `CREDENTIALS`, `CREDS`, `APIKEY`), names ending in `TOKEN`, `SECRET` or `PASSWORD` (such as
  `PGPASSWORD`), and names with `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY` or `SECRET_KEY` in them;
- values that hold a URL with a password (`postgres://user:password@host`) or look like a token.

A name that only mentions such a word earlier, such as `SECRET_NAME` or `SKIP_TOKEN_CHECK`, is
allowed. These checks are a guard, not a guarantee: keep every secret in a credential reference,
never in `env`. AgentX error messages name a variable, never its value.

A worker that predates `env` refuses a revision that uses it. Readiness at publish comes from the
latest revision, even for a workspace prepared from an older one, so a running workspace on an
old worker image cannot publish once such a revision is registered. Make sure every running
workspace runs the new worker image before registering a revision that uses `env`.

### Dev container

```yaml
devcontainer:
  repository: payments-api
  configPath: .devcontainer/devcontainer.json   # optional; this is the default
```

`repository` must name a registered repository. Dev containers run on EC2 workers.

`readiness` runs when the workspace is prepared and again before each pull request is published
or updated, each time inside the dev container when the workspace was prepared with one. A
workspace prepared without one runs its commands on the worker; adding a dev container in a later
revision does not move an existing workspace's checks into it. Before the checks run at publication
or a pull request update, AgentX starts the dev container (this does nothing when it is already
running). If it does not start, nothing is pushed.

### Models

```yaml
models:
  default: { provider: amazon-bedrock, modelId: us.anthropic.claude-sonnet-4-6 }
  approved:
    - { provider: amazon-bedrock, modelId: us.anthropic.claude-sonnet-4-6, label: Sonnet }
```

`approved` lists 1 to 16 models with unique provider and model ID pairs and optional, unique labels.
The default must be one of them. In the bound channel, `@agentx models` lists the choices and
`@agentx use <label>` selects one for every workspace in the project from its next coding turn. The model IDs shown here are examples;
use the IDs your deployment can reach, and see [OpenRouter model access](openrouter.md) for
OpenRouter.

### Integrations

Use either `integrations.githubMcp` or `integrations.connectors`, not both. Each connector entry
names its type (`github`, `linear`, `jira` or `asana`), its scope and the tools the orchestrator
is offered. A `github` connector's `scopes` is `all-repositories` or a list of registered
repository names. Setup and examples for each vendor:

- [GitHub MCP through hosted Slack](../README.md#github-mcp-through-hosted-slack)
- [Linear](connectors/linear.md)
- [Jira](connectors/jira.md)
- [Asana](connectors/asana.md)

### Action policy

```yaml
actionPolicy:
  rules:
    - tool: "*_delete_*"
      outcome: deny
      reason: Nothing is deleted from Slack.
```

Up to 64 rules. Each rule has a `tool` pattern (letters, digits, `_`, `-` and at most four `*`),
an optional `connector` and `whenArguments`, a `reason`, and exactly one of `outcome` (`allow`,
`ask` or `deny`) or `treatAs` (`read`, `create`, `change` or `destructive`). How rules combine
with AgentX's built-in confirmations is described in
[Actions that need your confirmation](../README.md#actions-that-need-your-confirmation).

### Developer tasks

```yaml
developerTasks:
  enabled: true
  share: optional          # or required
  shareMode:
    default: view          # or continue
    allowContinue: true
  channelMembersMayUse: true
```

Every field is optional; the values above are the defaults, and a project without the block uses
them.

- `enabled`: whether developers may start tasks on this project from an AI tool.
- `channelMembersMayUse`: whether members of the project's bound Slack channels may use it from
  an AI tool. With `false`, only people an admin granted access to the project directly may.
  Direct grants arrive with spec 025 phase 25e (the admin tool `agentx_admin_grant_project_access`);
  until then, channel membership is the only way in, so leave this `true`.
- `share`: with `required`, every task is shared into a bound channel when it starts.
- `shareMode.default`: the mode a shared task gets when none is asked for.
- `shareMode.allowContinue`: with `false`, every shared task is view only.

See [Sharing a task to Slack](mcp-install.md#sharing-a-task-to-slack).

## Register and bind

Registration needs the deployment's worker settings as well as the file (deployment mode, launch
template and subnets). The full command, and the channel binding that follows it, are in
[Register a project and bind its Slack channel](../README.md#2-register-a-project-and-bind-its-slack-channel).
For an environment installed with `agentx init`, add `--env <name>` to each command. The channel
binding names only the project, so a newly registered revision reaches every new thread without
binding again.
