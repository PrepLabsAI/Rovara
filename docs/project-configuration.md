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
| `readiness` | yes | Up to 64 commands run in the workspace before any candidate is pushed. A failure opens a new pull request as a draft, with the failing checks listed in its description (spec 051); it still stops an update to an existing pull request. See [Checks](#checks-how-agentx-verifies-the-agents-work-spec-051). May be empty. |
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
    - { provider: amazon-bedrock, modelId: us.anthropic.claude-sonnet-4-6, label: Sonnet, thinkingLevel: medium }
```

`approved` lists 1 to 16 models with unique provider and model ID pairs and optional, unique labels.
The default must be one of them. In the bound channel, `@agentx models` lists the choices and
`@agentx use <label>` selects one for every workspace in the project from its next coding turn. The model IDs shown here are examples;
use the IDs your deployment can reach, and see [OpenRouter model access](openrouter.md) for
OpenRouter.

`thinkingLevel` (optional, on an `approved` entry or the `default`) sets how hard the model thinks:
`off`, `minimal`, `low`, `medium`, `high` or `xhigh`. Tasks and eval runs use the level on the
model's `approved` entry. Without one, a model that supports reasoning runs at `medium` and any
other model at `off`, on every provider; Pi raises a level the model does not support to the next
one it does. An explicit level the model does not support is refused when the definition is saved,
and the error lists the levels it supports, for example
`GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high`. A model
the catalog does not know is checked when it is first used instead. The `models` reply shows each
level that is set, for example `Sonnet (thinking: medium)`.

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

## Checks: how AgentX verifies the agent's work (spec 051)

The coding agent can say "all tests pass" when they do not. So AgentX does not take its word. When
the agent tries to finish a coding task, AgentX reruns the project's checks itself, compares each
with its earlier result, and reports its own result first. The agent's summary comes second.

### What you see in Slack

The reply starts with AgentX's verdict, then the label `*Agent's account:*`, then the agent's own
summary. The verdict lines, word for word:

| Situation | Line |
|---|---|
| A check passed before and fails now | `Not done: <check> passed before and fails now.` (one line per such check) |
| No regression, and some checks pass | `Checks passed (<n> project check(s)).` or, for a project without readiness checks, `Checks passed (<n> of the agent's own test commands, rerun by AgentX).` |
| No regression, but nothing passes yet | `No regression found, but no check passes yet.` |
| Nothing was checked | `Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.` |
| The task was stopped, or errored, before the check | `Not verified: the task stopped before AgentX could check it.` |
| A check was already failing before the change | `Already failing before this change: <check>.` (added to any of the above) |
| A check fails and has no earlier result | `Fails now, with no earlier result: <check>.` (added to any of the above) |

A reply from a task that produced no report (for example one run by a worker older than spec 051)
reads exactly as before.

### What you see in the pull request

- Every pull request AgentX opens has a checks section in its description: each check with its
  result before and after, and the trimmed output of failures.
- **Any failing readiness check when the pull request is published makes it a draft.** This
  relaxes an earlier rule, where publishing refused on a failing check. The work now stays visible
  and cannot be merged as finished by mistake. A draft is also opened when the workspace's latest
  task report found a regression.
- The section judges each check against the workspace's preparation: a command that passed at
  preparation and fails now reads "regression (passed at preparation, fails now)"; any other
  failing command reads "fails now, with no earlier result".
- If the latest task was not verified (it failed, was cancelled, was interrupted or produced no
  report), the section says "Not verified". That alone does not make a draft.
- Appending to an existing pull request, and syncing it, still refuse when a readiness check
  fails. CodeBuild gates are unchanged.

### How the checks work

1. **The agent is told the rules.** AgentX appends a fixed preamble to the agent's system prompt
   for every coding task and every eval run. Its SHA-256 is recorded with each result. Version 1:

   ```text
   AgentX checks your work after you finish. Work this way:
   1. Reproduce the problem before changing code, and say how you reproduced it.
   2. Run the relevant tests before and after your change.
   3. A test that passed before your change and fails after it is your own regression. Fix it; never call it unrelated.
   4. Report the commands you ran and their results.
   5. You must never claim a test passed unless you saw it pass.
   End your final message with exactly one line: "AgentX result: done" if the work is complete and every test you ran passes, otherwise "AgentX result: not done".
   ```

   The text lives in `packages/contracts/src/checks.ts` (`AGENTX_PREAMBLE`). Changing it means a
   new `AGENTX_PREAMBLE_VERSION`. The agent's claim is read from that last line: `success`,
   `failure`, or `none` when the line is missing.
2. **AgentX reruns the checks** when the agent tries to finish. A check that passed before and
   fails now is a regression. A check that failed before and still fails is "already failing" and
   is not the agent's regression.
3. **One extra try.** On a regression, the agent gets the failing output and exactly one more turn.
   AgentX then reruns the checks and reports that result. There is never a third round.
4. **Stopped tasks** (cancelled, or stopped by the loop guard or a limit) are reported "Not
   verified"; no checks run.

Each check has its own timeout (the command's `timeoutSeconds`, or 10 minutes for the agent's
commands), and one round has a total budget of 30 minutes. Checks the budget leaves unrun are
recorded as not run.

### Add readiness checks to your project

Add the commands that prove the project works to `readiness` (see [Commands](#commands)): the test
suite, a type check, a lint. They are the best checks, for three reasons:

- they are your commands, run the way you run them, in the dev container when there is one;
- they run when a workspace is prepared, so a failing project is caught before the agent starts;
- AgentX reruns exactly them after the agent's change.

A project **without** readiness checks is checked by rerunning the agent's own simple test
commands instead. That is weaker: the agent chooses what to run, and may run nothing, in which
case the reply says "Not verified: no checks ran". For each such command, the "before" is the
agent's first run, counted only if no file had changed yet; otherwise the before is unknown.

Only these commands count, each with its arguments: `npm test`, `npm run test`, `pnpm test`,
`yarn test`, `pytest`, `python -m pytest`, `go test`, `cargo test`, `make test`, `mvn test`,
`gradle test`, `./gradlew test`, `bundle exec rspec`, `phpunit` and `tox`. The command may start
with a relative `cd <path> &&` (no `..`, no absolute path), then `NAME=value` assignments, then an
optional `timeout <n>`. Anything else is never replayed, because replaying an arbitrary command
could change the workspace: pipes, `;`, `&&` chains, `||`, `&`, redirection, quotes,
`$`, backticks, globs, `~`, absolute paths and `..`. So `cd pkg && npm test -- -t foo` and
`FOO=1 python -m pytest -k x` count, while `pytest | tail -5` and `npm test; echo done` do not.

### Rollout

The broker sends a worker the readiness commands and the draft-PR behaviour only when the worker's
`/ping` lists the feature, so each costs one extra `/ping` per delivery for readiness and publish.
An older worker is checked with the agent's own commands, and an older worker publishes as before.

## Register and bind

Registration needs the deployment's worker settings as well as the file (deployment mode, launch
template and subnets). The full command, and the channel binding that follows it, are in
[Register a project and bind its Slack channel](../README.md#2-register-a-project-and-bind-its-slack-channel).
For an environment installed with `agentx init`, add `--env <name>` to each command. The channel
binding names only the project, so a newly registered revision reaches every new thread without
binding again.
