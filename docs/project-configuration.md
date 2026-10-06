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
| `codeBuildGates` | Optional. Up to 8 CodeBuild gates, each with a `name`, a `projectName` matching the deployment's allowed prefix, and `timeoutMinutes` from 5 to 420. The total timeout per repository is at most 420 minutes. See [Configure CodeBuild gates](pull-requests.md#configure-codebuild-gates). |

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
with AgentX's built-in confirmations is described in
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
| Every check AgentX reran passes | `Checks passed (<n> project check(s)).` or, for a project without readiness checks, `Checks passed (<n> of the agent's own test commands, rerun by AgentX).` |
| No regression, but a rerun check fails now | `Checks: <p> of <n> pass.` (then one line for each failing check, below). `Checks passed` is never used while a check fails |
| No regression, but nothing passes yet | `No regression found, but no check passes yet.` |
| Nothing was checked | `Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.` |
| The task was stopped, or errored, before the check, or AgentX had no time to rerun any of the project's checks | `Not verified: the task stopped before AgentX could check it.` (the advice to add readiness checks is only for a project that has none) |
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
  description tells the assistant that AgentX opens a draft when a check fails.
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

1. **The agent is told the rules.** AgentX appends a fixed preamble to the agent's system prompt
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
   behaviour can therefore end with a named failing test, which AgentX reports as a regression
   and the reviewer decides on.

   The text lives in `packages/contracts/src/checks.ts` (`AGENTX_PREAMBLE`). Changing it means a
   new `AGENTX_PREAMBLE_VERSION`. The agent's claim is read from that last line: `success`,
   `failure`, or `none` when the line is missing.

   Since version 2, AgentX's own worker prompt (`AGENTX_WORKER_PROMPT`, in the same file) also
   replaces Pi's built-in system prompt. Pi's is written for a person at a terminal and points at
   Pi's documentation. AgentX's tells the agent that it works alone and its changes may become a
   pull request, and covers how to work, which file tools to use, and what its final message must
   contain. The recorded SHA-256 covers both texts, so changing either means a new version.
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
agent's first run in that task, when no file had changed yet. When the agent changed files
first, AgentX measures the before itself (#290): it puts each repository's files back to the
commit the workspace was prepared at, runs the command, and restores the agent's files exactly.
Only the files are swapped: Git's index, HEAD, branches and stash are never touched, and ignored
files (built extensions, `node_modules`, virtual environments) stay as they are, so the command
runs in the same environment as the agent's. While the original code is shown, the agent's
files are kept under the ref `refs/agentx/agent-files`; if a worker stops mid-way, the next
task puts them back before it starts. The before runs use at most half of the round's budget.
A failure is remembered across tasks (above), so the next task cannot lose it.

In a project with a dev container, the agent's shell is the container's, so it writes
`cd /workspaces/<repo> && npm test`. AgentX reads every `cd` to that exact folder (or a
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

AgentX finds a test inside a longer command too (#299). It splits the command at `&&`, `||`, `;`
and `|` outside quotes, and replays each test it finds as `cd <dir> && <test>`. Here `<dir>`
follows every relative `cd` before the test (no `..`, no absolute path): `cd a && cd b && pytest`
replays `cd a/b && pytest`. A test may be followed by `2>&1` and by `tail`, `head`, `grep`,
`egrep`, `sed` (not in place), `cut`, `sort`, `uniq`, `wc` or `cat`. The replay leaves those out.
So `go build ./... && go test ./scanner 2>&1 | tail -20` replays `go test ./scanner`, and
`pytest -q 2>&1 | grep -E "^E" | head` replays `pytest -q`. AgentX only ever replays the test
itself, never the rest of the command.

A whole command is never used when it holds something whose effect the bare replay would not
reproduce, or that AgentX cannot read safely:
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
code is not the test's (it may be `head`'s, or the last command's in a chain), so AgentX measures
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
