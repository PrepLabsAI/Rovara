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
| `readiness` | yes | Up to 64 commands run in the workspace before any candidate is pushed. A failure opens a new pull request as a draft, with the failing checks listed in its description (spec 051); it still stops an update to an existing pull request. See [Checks](#checks-how-rovara-verifies-the-agents-work-spec-051). May be empty. |
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
| `codeBuildGates` | Optional. Up to 8 CodeBuild gates, each with a `name`, a `projectName` matching the deployment's allowed prefix, and `timeoutMinutes` from 5 to 420. The total timeout per repository is at most 420 minutes. See [Configure CodeBuild gates](pull-requests.md#configure-codebuild-gates). |

When AgentX itself runs Git in a workspace repository (to read the agent's changes, publish them or
update a pull request), it ignores what that repository's Git config asks Git to run:

- **Filters.** Only Git LFS filters (`filter=lfs`) are honoured, and only with the standard
  `git-lfs` commands. Every other filter is switched off, so files are staged exactly as they are
  on disk. An encryption filter such as git-crypt therefore stages **plaintext**: do not register
  a repository that relies on one.
- **Git LFS.** Git LFS repositories are not supported yet. Publishing a pull request, or appending
  to one, is refused when any file has `filter=lfs`, because AgentX runs no hooks and Git LFS's
  pre-push upload would not happen.
- **Hooks, signing and helpers.** Hooks, fsmonitor, commit signing, credential helpers, custom
  merge drivers (Git's own text merge is used) and diff `textconv` commands do not run.
- **Remotes.** Fetches and pushes go to the registered `url` over HTTPS only, and never through a
  proxy (including the worker's `HTTPS_PROXY`). A fetch or push is refused while the repository's
  config sets any `url.*`, `http.*` or `remote.*` key other than `remote.origin.url` and
  `remote.origin.fetch`, or `extensions.partialClone`. The refusal names the keys to unset.
- **Submodules and nested repositories.** AgentX tasks do not yet support projects whose `setup`
  initialises Git submodules (for example `git submodule update --init`), or a nested repository
  the agent creates and records. While a submodule is checked out, AgentX refuses to read the
  agent's changes, publish or update a pull request, and the error names the submodule's path.
  An uninitialised submodule (an empty directory) is fine.

Setup and readiness commands are the project's own code and run with the worker's normal Git
settings.

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
- Rovara refuses names it or the system relies on, in any letter case: `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `IFS`, `ENV`, `BASH_ENV`, and any name starting with
  `AGENTX_`, `AWS_`, `GIT_`, `LD_`, `DYLD_` or `PI_`. To use a tool that is not on the worker's
  `PATH`, give its full path as `executable`, or set `PATH` in the dev container's own
  configuration.
- Other names are allowed, including ones the worker image sets, such as `NODE_ENV` and `PORT`,
  and ones like `NODE_OPTIONS` or `HTTPS_PROXY`. They apply to that one command only.

**`env` is not for secrets.** A registered revision is stored and shown in full, and with a dev
container the values are on the `devcontainer exec` command line while a command runs. At
registration Rovara refuses:

- names whose last word marks a credential (`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`,
  `PWD`, `CREDENTIALS`, `CREDS`, `APIKEY`), names ending in `TOKEN`, `SECRET` or `PASSWORD` (such as
  `PGPASSWORD`), and names with `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY` or `SECRET_KEY` in them;
- values that hold a URL with a password (`postgres://user:password@host`) or look like a token.

A name that only mentions such a word earlier, such as `SECRET_NAME` or `SKIP_TOKEN_CHECK`, is
allowed. These checks are a guard, not a guarantee: keep every secret in a credential reference,
never in `env`. Rovara error messages name a variable, never its value.

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
or a pull request update, Rovara starts the dev container (this does nothing when it is already
running). If it does not start, nothing is pushed.

The dev container runs on the worker host's Docker, and its config is a file in your repository that
the agent can edit. So every time AgentX starts the container it checks the configuration first:
`devcontainer.json` itself, and the full configuration the devcontainer CLI would use, with the
settings of every feature and of the image's own `devcontainer.metadata` label merged in. Anything
below is refused, with a message naming the setting, before any container starts:

| Refused | Why |
|---|---|
| `initializeCommand` | It runs on the worker host itself, not in the container. |
| `dockerComposeFile` | The Compose services' settings cannot be checked. |
| `privileged: true`, `securityOpt`, or any `capAdd` other than `SYS_PTRACE` | They grant powers over the host. |
| `runArgs` with `--privileged`, `--pid`, `--ipc=host` or `container:…`, `--network=host` (or `--net`) or `container:…`, `--userns=host`, `--uts=host`, `--cgroupns=host`, `--cap-add` (other than `SYS_PTRACE`), `--security-opt`, `--device`, `--device-cgroup-rule`, `--gpus` or `--volumes-from` | They share the host's (or the worker's) processes, network, devices or files. |
| A bind mount (`mounts`, `workspaceMount`, or `-v`/`--volume`/`--mount` in `runArgs`) of `/`, `/var/run/docker.sock`, the workspace root itself, its `.docker` folder, or any path outside the workspace, including through a link (whether or not its target exists), or a path AgentX cannot check | They expose host files or the Docker socket. |
| A feature AgentX cannot pin to the content it checked (one fetched from a GitHub release) | Its content could change before the container is built. |
| A volume with `volume-opt` or `volume-driver` options | Such a volume can be a bind mount of any host path. |
| `build.context` or `build.dockerfile` outside the workspace | The build would read host files. |
| `build.options` with `--network=host` or `container:…`, `--output`/`-o`, `--iidfile`, `--metadata-file`, `--allow`, `--security-opt`, `--secret`, `--ssh`, `--build-context`, `--cache-to` or `--file`/`-f` | They reach the host's network, extra privileges, or files outside the build. |

Everything else is allowed: `image` or `build` (with options such as `--build-arg`, `--target`,
`--pull` or `--add-host`), `features`, `containerEnv`, `remoteUser`, lifecycle commands such as
`postCreateCommand`, `capAdd: ["SYS_PTRACE"]` or `--cap-add=SYS_PTRACE` (debuggers need it to trace
the container's own processes), `runArgs` such as `--env` or `--cpus`, named volumes, `tmpfs`
mounts, and bind mounts of folders inside the workspace (for example
`source=${localWorkspaceFolder}/.cache,target=/cache,type=bind`).

Features may come from an OCI registry (such as `ghcr.io/devcontainers/features/node:1`), a
tarball URL, or a folder in `.devcontainer`. The container is built from exactly the feature
content AgentX checked: AgentX gives the devcontainer CLI a lockfile of that content's digests and
starts the container with `--frozen-lockfile`, so content that changed since the check stops the
start before anything is built. While the container starts, AgentX's lockfile takes the place of
the repository's `devcontainer-lock.json`, which is put back afterwards; tag references resolve to
the version available when the check runs, not to the repository's lockfile.

After the container starts, AgentX checks it again as Docker ran it; a container that breaks the
rules is removed and the step fails. AgentX mounts the whole workspace into the container at the
same path, with the workspace's `.docker` folder (Docker's own data) hidden by an empty volume. A
container created before AgentX hid that folder is created again once. Before each publication
AgentX removes the dev container (see the security notes below), so the next step creates it again;
creating it reruns its creation commands, such as `onCreateCommand` and `postCreateCommand`.

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
names its type (`github`, `linear`, `jira`, `asana`, or `mcp` for any other MCP server), its scope and the tools the orchestrator
is offered. A `github` connector's `scopes` is `all-repositories` or a list of registered
repository names. Setup and examples for each vendor:

- [GitHub MCP through hosted Slack](slack.md#github-mcp-through-hosted-slack)
- [Linear](connectors/linear.md)
- [Jira](connectors/jira.md)
- [Asana](connectors/asana.md)
- [Any other MCP server](connectors/custom-mcp.md)

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
with Rovara's built-in confirmations is described in
[Actions that need your confirmation](slack.md#actions-that-need-your-confirmation).

### Developer tasks

```yaml
developerTasks:
  enabled: true
  share: optional          # or required
  shareMode:
    default: view          # or continue
    allowContinue: true
  channelMembersMayUse: true
  optionalWorkflowChecks:
    - id: coverage
      label: Coverage report
      command:
        cwd: repo/payments-api
        executable: npm
        args: [run, coverage]
        timeoutSeconds: 600
```

Every field is optional; the values above are the defaults, and a project without the block uses
them.

- `enabled`: whether developers may start tasks on this project from an AI tool or Slack workflow.
- `channelMembersMayUse`: whether members of the project's bound Slack channels may use it from
  an AI tool. With `false`, only people an admin granted access to the project directly may.
  Direct grants arrive with spec 025 phase 25e (the admin tool `agentx_admin_grant_project_access`);
  until then, channel membership is the only way in, so leave this `true`.
- `share`: with `required`, every task is shared into a bound channel when it starts.
- `shareMode.default`: the mode a shared task gets when none is asked for.
- `shareMode.allowContinue`: with `false`, every shared task is view only.
- `optionalWorkflowChecks`: up to 20 named, project-approved extra commands. In a Slack workflow,
  the task owner can choose among these when approving the plan. Project `readiness` checks are
  always included and cannot be turned off. The chosen optional IDs are saved with the plan
  decision, and a new plan starts with no optional checks selected.

See [Sharing a task to Slack](mcp-install.md#sharing-a-task-to-slack).

#### Starting a task from Slack

In every bound channel, a plain top-level `@AgentX <request>` starts a task on the channel's project.
AgentX asks in the thread how to handle it, with a button for each path:

- **Quick**: a short coding plan for the owner to approve, then coding, checks, reviews and a draft
  pull request.
- **Full**: requirements, then a design, then a coding plan, each approved by the owner before any
  code changes.

Only the person who asked can choose: they press a button, or reply `quick` or `full` in the thread
(with or without mentioning AgentX; loose answers such as `Quick please` or `let's do full` count).
A teammate's answer is ignored. The question waits for a day. A request that starts with `quick:` or
`full:` (or the older `workflow quick:` / `workflow full:`) skips the question and starts on that
path; `workflow:` asks it. A thread holds one waiting question at a time. In a thread with no
question waiting, a reply such as `@AgentX full please` goes to the chat agent like any other.

**Changed behavior:** a plain top-level mention used to go to the chat agent. To reach the chat agent
now, start the request with `chat:`, for example `@AgentX chat: what does retry.ts do?`. Mentions in
a thread the chat agent is already answering still go to it without `chat:`.

When a task cannot start, AgentX says why in the thread: the open-task limit, a thread that already
has a task, or a channel not connected to a project the person can use. Anything else gets a
reference to give an AgentX admin (the Slack event ID, or for a button press the choice's ID).
Starting tasks from Slack needs shared tasks (`SHARED_TASKS`) on
for the Slack ingress; without them AgentX answers every start with a message asking an admin to turn
them on.

#### Replies in a Slack task's thread

Every reply in the thread of a task started in Slack is saved as input for the task's next step,
whether or not it mentions AgentX and whoever posts it. The next plan or coding step sees the
replies no earlier step was given, marked as the owner's or a teammate's; each reply is given once.
Replies never move the task on: only the task owner's buttons do. An `@AgentX` reply gets a private
"Saved" acknowledgement; a plain reply gets no answer. AgentX keeps up to 200 replies per task, and
keeps the first 2,000 characters of a longer reply. When many replies arrive between two steps, only the
newest, about 8 KB of them, are passed to the next step. Text in a reply posted with a file is saved; the
file is not. To stop the task from its thread, its owner sends `@AgentX stop`: a plain `stop` without
the mention is saved as a reply like any other.

To receive replies that do not mention it, the Slack app needs the `channels:history` and
`groups:history` bot scopes and the `message.channels` and `message.groups` bot events. The app
manifest `agentx init` generates includes them. **An existing install must reinstall the Slack app**
(update the app from the new manifest, then reinstall it to the workspace) to receive thread replies;
until then only `@AgentX` replies are saved. AgentX reads channel messages only to find replies in
task threads: it ignores, and does not store, any channel message outside a task's thread.

#### From approval to a draft pull request

A task started in Slack can finish in its thread, with no MCP client and no admin help. Each
approval card is a short message: what is waiting, up to three summary lines and a link to the full
document (a Slack Canvas, or the AgentX task page when the workspace cannot create Canvases). Once
the owner decides, the card loses its buttons and says who decided.

After the coding plan is approved, AgentX codes it, runs the required checks and the selected
optional checks on that exact code, and then starts the code and security reviews by itself. Only
problems the change introduced block. An older problem outside the changed lines is noted but does
not block. When a review finds a problem, the thread lists it with **Send back to coding**, **Retry
reviews** and **Close task**. Send back gives the problems to the coding step, and the checks and
reviews run again on the new code. When the checks and reviews pass, AgentX opens a draft pull request
of exactly the checked code and posts the link in the thread. People review and merge it on GitHub.

#### Security notes: who can reach the push token

The coding, check and review runs never get a push token. Only the separate publish step does, and
it keeps the token away from code the agent or the project controls:

- A task's draft pull request runs no project command. Its checks already ran on the same code
  before its reviews, and the publish step confirms the code is still that code.
- Before every credential request (a fetch of the latest base for an ordinary pull request or a
  revert, and the push itself, which comes after the readiness checks), the publish step stops the
  processes and containers started by the task: every container on the worker other than the
  worker's own, and every process left running from the workspace. It repeats both until neither
  finds anything, checks for containers once more, and asks for nothing if it cannot confirm they are
  all gone. In the deployed worker that means every process in the worker container other than the
  worker itself and its parent; one it is not allowed to stop also blocks the publication. Run
  elsewhere (a developer machine), it means every process of the worker's user whose working
  directory is in the workspace, and no container is touched.
- The push runs from a temporary Git repository that AgentX makes for that push alone. It borrows
  the workspace's Git objects and reads nothing else from the workspace: not its `.git/config`,
  hooks or attributes. The commit is pushed by its ID to the repository's registered URL. GitHub
  checks every object it receives, so the borrowed objects cannot change what the commit holds.
- The token is never put in any process's environment, and is removed when the push ends.
- The published commit's parent is the base commit AgentX pinned for the task, never one the
  workspace reports. The broker checks the pull request's commit, its code and its parent on GitHub.

Known limitation: on EC2 workers, when a project has no dev container, the coding step currently runs
with the worker's Docker access. Before publishing, AgentX stops processes and containers started by
the task and pushes from an isolated repository, but that does not undo anything done earlier in the
task. With a dev container that follows the rules in "Dev container" above, the agent's shell and the
project's commands run in that container, without Docker access. Running AI-written code as a
separate user without Docker access is tracked in
[#325](https://github.com/PrepLabsAI/Rovara/issues/325).

#### Security follow-ups

Tracked in [#325](https://github.com/PrepLabsAI/Rovara/issues/325):

1. Run agent and project code as a separate operating-system user with no Docker access.
2. Dev-container-only Docker: only AgentX's own dev container launcher reaches Docker; projects
   without a dev container get no Docker access.
3. Apply the same process and container stop before the credential of a pull request update.

## Checks: how Rovara verifies the agent's work (spec 051)

The coding agent can say "all tests pass" when they do not. So Rovara does not take its word. When
the agent tries to finish a coding task, Rovara reruns the project's checks itself, compares each
with its earlier result, and reports its own result first. The agent's summary comes second.

### What you see in Slack

The reply starts with Rovara's verdict, then the label `*Agent's account:*`, then the agent's own
summary. The verdict lines, word for word:

| Situation | Line |
|---|---|
| A check passed before and fails now | `Not done: <check> passed before and fails now.` (one line per such check) |
| Every check Rovara reran passes | `Checks passed (<n> project check(s)).` or, for a project without readiness checks, `Checks passed (<n> of the agent's own test commands, rerun by AgentX).` |
| No regression, but a rerun check fails now | `Checks: <p> of <n> pass.` (then one line for each failing check, below). `Checks passed` is never used while a check fails |
| No regression, but nothing passes yet | `No regression found, but no check passes yet.` |
| Nothing was checked | `Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.` |
| The task was stopped, or errored, before the check, or Rovara had no time to rerun any of the project's checks | `Not verified: the task stopped before AgentX could check it.` (the advice to add readiness checks is only for a project that has none) |
| The pull request this turn opened is a draft | `Opened as a draft: AgentX's checks found failures.` (also when the turn ran no task, such as "open the PR" after an earlier task) |
| A check was already failing before the change | `Already failing before this change: <check>.` (added to any of the above) |
| A check fails and has no earlier result | `Fails now, with no earlier result: <check>.` (added to any of the above) |

A regression stays a regression: if the agent's one extra turn is stopped, cancelled or ends in a
model error, the report is still a regression, never "Not verified".

A reply from a task that produced no report (for example one run by a worker older than spec 051)
reads exactly as before.

### What you see in the pull request

- A pull request has a checks section in its description when there is something to report: a
  task report, or a failing check at publish. With no task report (for example a worker older
  than spec 051) and every check passing at publish, the description is exactly as before. The
  section shows each check with its result before and after, and the trimmed output of failures.
- **A pull request is a draft while a check fails.** That is: any readiness check fails when it is
  published (this relaxes an earlier rule, where publishing refused on a failing check), or a
  check still fails that an earlier task or the latest one found failing. The work stays visible
  and cannot be merged as finished by mistake. The publish result says `draft`, and the PR tool's
  description tells the assistant that Rovara opens a draft when a check fails.
- **A failing check is remembered across tasks.** The workspace keeps every check that fails now,
  until a later report shows it passing. So a follow-up task that runs no tests, or reruns a
  broken test and sees it "already failing", cannot hide an earlier regression. A task that ends
  without a report (failed, cancelled, interrupted) keeps what was known. The section lists a
  check from an earlier task under "Still failing from earlier tasks". A project check that
  publish reran and found passing does not stand, unless it was a regression; that one is listed
  as "regressed in the last task, passes at publish" and still makes a draft.
- **Clearing a failure from the agent's own commands.** A later task has to rerun the same command
  and see it pass. The match is on the exact command text, so `pytest tests/test_a.py -q` does not
  clear a failure recorded for `pytest tests/test_a.py`. The same goes for a test that was already
  failing before the agent started. This errs towards a draft.
- The section judges each check against the workspace's preparation: a command that passed at
  preparation and fails now reads "regression (passed at preparation, fails now)"; any other
  failing command reads "fails now, with no earlier result".
- If the latest task was not verified (it failed, was cancelled, was interrupted or produced no
  report), the section says "Not verified". For a failed task or a missing report that alone does
  not make a draft: earlier failures still do. A task that was cancelled or interrupted does make
  a draft ("Not verified: the last task was cancelled"), until a later task's report replaces it.
- Appending to an existing pull request, and syncing it, still refuse when a readiness check
  fails. CodeBuild gates are unchanged.

### How the checks work

1. **The agent is told the rules.** Rovara appends a fixed preamble to the agent's system prompt
   for every coding task and every eval run. Its SHA-256 is recorded with each result. Version 4:

   ```text
   AgentX checks your work after you finish. Work this way:
   1. Reproduce the problem before changing code, and say how you reproduced it.
   2. Run the relevant tests before and after your change.
   3. A test that passed before your change and fails after it is your own regression. Fix your change, not the test; never call it unrelated.
   4. The one exception is a test that checks the old behaviour the task asks you to change. Leave it as it is and name it in your final message, with the behaviour it checks. Never edit or delete a test to make it pass, unless the task explicitly asks you to change tests.
   5. Report the commands you ran and their results.
   6. You must never claim a test passed unless you saw it pass.
   End your final message with exactly one line: "AgentX result: done" if the work is complete and every test you ran passes, apart from tests you named under rule 4, otherwise "AgentX result: not done".
   ```

   Rule 4 came in version 3 (#290): without it, the agent reported correct work as "not done"
   whenever the task changed behaviour that existing tests still checked. Version 3 told the
   agent to update such tests, and it then edited tests even when told not to, once to cover a
   half-finished fix; version 4 has it leave them and name them. A task that changes tested
   behaviour can therefore end with a named failing test, which Rovara reports as a regression
   and the reviewer decides on.

   The text lives in `packages/contracts/src/checks.ts` (`AGENTX_PREAMBLE`). Changing it means a
   new `AGENTX_PREAMBLE_VERSION`. The agent's claim is read from that last line: `success`,
   `failure`, or `none` when the line is missing.

   Since version 2, Rovara's own worker prompt (`AGENTX_WORKER_PROMPT`, in the same file) also
   replaces Pi's built-in system prompt. Pi's is written for a person at a terminal and points at
   Pi's documentation. Rovara's tells the agent that it works alone and its changes may become a
   pull request, and covers how to work, which file tools to use, and what its final message must
   contain. The recorded SHA-256 covers both texts, so changing either means a new version.
2. **Rovara reruns the checks** when the agent tries to finish. A check that passed before and
   fails now is a regression. A check that failed before and still fails is "already failing" and
   is not the agent's regression.
3. **One extra try.** On a regression, the agent gets the failing output and exactly one more turn.
   Rovara then reruns the checks and reports that result. There is never a third round.
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
- Rovara reruns exactly them after the agent's change.

A project **without** readiness checks is checked by rerunning the agent's own simple test
commands instead. That is weaker: the agent chooses what to run, and may run nothing, in which
case the reply says "Not verified: no checks ran". For each such command, the "before" is the
agent's first run in that task, when no file had changed yet. When the agent changed files
first, Rovara measures the before itself (#290): it puts each repository's files back to the
commit the workspace was prepared at, runs the command, and restores the agent's files exactly.
Only the files are swapped: Git's index, HEAD, branches and stash are never touched, and ignored
files (built extensions, `node_modules`, virtual environments) stay as they are, so the command
runs in the same environment as the agent's. While the original code is shown, the agent's
files are kept under the ref `refs/agentx/agent-files`; if a worker stops mid-way, the next
task puts them back before it starts. The before runs use at most half of the round's budget.
A failure is remembered across tasks (above), so the next task cannot lose it.

In a project with a dev container, the agent's shell is the container's, so it writes
`cd /workspaces/<repo> && npm test`. Rovara reads every `cd` to that exact folder (or a
folder inside it), or to the same repository's folder on the worker, as the repository's folder
in the workspace, records it and replays it there, in the container. Any other absolute path, a `..`, a look-alike folder, and a link that leads out
of the workspace are still refused.

Only these commands count as tests, each with its arguments: `npm test`, `npm run test`, `pnpm test`,
`yarn test`, `pytest`, `python -m pytest`, `python3 -m pytest`, `jest`, `npx jest`, `yarn jest`,
`pnpm jest`, `vitest`, `npx vitest`, `yarn vitest`, `pnpm vitest`, `mocha`, `npx mocha`,
`yarn mocha`, `pnpm mocha`, `go test`, `cargo test`,
`make test`, `mvn test`, `gradle test`, `./gradlew test`, `bundle exec rspec`, `phpunit` and
`tox`. A test may start with `NAME=value` assignments, then an optional `timeout <n>`. An argument
may be quoted, with single or double quotes, as long as the quoted text holds no `$`, backtick or
backslash, so the shell reads it literally: `yarn jest --testPathPattern="RoomView|RoomViewStore"`
counts. Arguments that would change files or never end when replayed are refused: `-u`,
`--updateSnapshot`, `--update-snapshots`, `--update`, `--snapshot-update` and any `--watch` option.

Rovara finds a test inside a longer command too (#299). It splits the command at `&&`, `||`, `;`
and `|` outside quotes, and replays each test it finds as `cd <dir> && <test>`. Here `<dir>`
follows every relative `cd` before the test (no `..`, no absolute path): `cd a && cd b && pytest`
replays `cd a/b && pytest`. A test may be followed by `2>&1` and by `tail`, `head`, `grep`,
`egrep`, `sed` (not in place), `cut`, `sort`, `uniq`, `wc` or `cat`. The replay leaves those out.
So `go build ./... && go test ./scanner 2>&1 | tail -20` replays `go test ./scanner`, and
`pytest -q 2>&1 | grep -E "^E" | head` replays `pytest -q`. Rovara only ever replays the test
itself, never the rest of the command.

A whole command is never used when it holds something whose effect the bare replay would not
reproduce, or that Rovara cannot read safely:
- a subshell, `$(…)`, a backtick or a background `&`;
- a heredoc, or any redirection other than `2>&1`;
- a newline, an unquoted `$`, a glob, or `~`;
- `git stash`;
- a `cd` joined by `||`;
- a filter outside that list;
- before the test, a command that changes the shell's environment (`export`, `source`, `set`,
  `pushd`, a bare `NAME=value` and the like).

One part of this is stricter: the agent's own run counts as the "before" result only when the
command is just the test. That is the test, optionally after `cd <dir> &&` or `cd <dir>;`, and
optionally followed by `2>&1` and `| tail -N` (or `tail -n N`). Anywhere else, the command's exit
code is not the test's (it may be `head`'s, or the last command's in a chain), so Rovara measures
the before itself on the original code, as above. A pipeline's exit code is normally `tail`'s,
which is 0 even when the tests fail. So the agent's shell runs the `| tail -N` shape with
`set -o pipefail`, and the exit code is the test's.

### Rollout

The broker sends a worker the readiness commands and the draft-PR behaviour only when the worker's
`/ping` lists the feature, so each costs one extra `/ping` per delivery for readiness and publish.
A worker built before spec 051 has no verification at all: it adds no preamble, runs no checks
and reports none, so its replies and pull requests read as before, and it publishes as before. The
agent's own commands are the checks for a new worker under an older broker (one that sends no
readiness), and for a project without readiness.

A workspace prepared before spec 051 has no earlier result for its project checks until its first
task records one, so a regression the agent causes in such a task gets no extra try (its before is
unknown), and its reply leads with `Checks: <p> of <n> pass.`. Publish still makes the pull request
a draft, because any failing check there does.

## Register and bind

Registration needs the deployment's worker settings as well as the file (deployment mode, launch
template and subnets). The full command, and the channel binding that follows it, are in
[Register a project and bind its Slack channel](administration.md#2-register-a-project-and-bind-its-slack-channel).
For an environment installed with `agentx init`, add `--env <name>` to each command. The channel
binding names only the project, so a newly registered revision reaches every new thread without
binding again.
