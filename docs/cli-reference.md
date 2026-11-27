# CLI reference

A short reference for the `agentx` command: how to point it at an environment, how to read its
output, and the flags of the commands people and AI agents run most. `agentx <command> --help`
prints every option. [Running Rovara](day-two.md) explains the commands in more depth.

<!-- Source: packages/cli/src/main.ts; packages/cli/src/setup/cli.ts; packages/cli/src/setup/command-context.ts; packages/cli/src/output.ts; packages/cli/src/init/prompts.ts; packages/cli/src/environments/cache.ts; packages/cli/src/setup/admin-session.ts; packages/cli/src/setup/project-add.ts; packages/cli/src/setup/channel-add.ts; packages/cli/src/setup/connectors/revision.ts; PrepLabsAI/Rovara#1594; PrepLabsAI/Rovara#1597. -->

## Install

The npm package is `@preplabsai/rovara-code`. It installs the command `rovara` and the alias
`agentx`, which run the same program; this page writes `agentx`, as the other guides do. Rovara
needs Node.js 22.19 or newer. See [npm package](npm-package.md).

```sh
npm install -g @preplabsai/rovara-code   # then: rovara --help (or agentx --help)
npx @preplabsai/rovara-code --help       # or run it without installing
```

## Choose the environment: `--env`

An environment is one Rovara install. You name it when you install, for example `prod` or
`staging`: lower-case letters, digits and hyphens. One AWS account can hold several environments,
and the name tells them apart in AWS, GitHub and Slack.

Pass `--env <name>` to every command. **Without it, `agentx` uses the environment named
`production`**, which is rarely what you want. Only `destroy` refuses to run without it.

```sh
agentx env list --region <region>      # the environments in this AWS account and region
agentx --env <name> env use            # rebuild this computer's settings cache for <name>
```

Commands that change an environment read its settings from AWS Systems Manager in `--region`,
which defaults to your AWS configuration's region. If the environment is not found there, the
error says so and suggests `--region` or `agentx env list`.

## Global options

| Option | Meaning |
|---|---|
| `--env <name>` | The environment. Default `production`. |
| `--project <name>` | The project a command acts on (`channel add`, `connector add`, `admin slack bind`). |
| `--json` | Print the result as one JSON document on stdout. |
| `--config-dir <dir>` | Where project files live. Default `~/.agentx/projects`. |
| `--accept-unchecked-model <reason>` | Register a project whose default model failed its check anyway, with the reason recorded. |

## Credentials

| Commands | Needs |
|---|---|
| `init`, `destroy` | AWS administrator credentials. |
| `doctor`, `upgrade`, `config`, `signin`, `env` | The operator role `init` created (`agentx-<env>-operator`). See [The operator role](day-two.md#the-operator-role). |
| `project`, `channel`, `connector`, `alerts` | AWS credentials that can read the environment's settings, plus an admin sign-in. |
| `login <url>`, `whoami`, `workspaces`, `sessions`, `session`, `mcp` | A developer sign-in; no AWS credentials. |

An admin sign-in is stored on this computer and reused until it expires. If there is none, the
command prints a sign-in address and opens a browser; a person has to finish that sign-in. Do it
once before running commands unattended:

```sh
agentx --env <name> login --admin
```

## Use an existing install from another computer

Use this on a computer that has never run `agentx` against the install, for example after an
install made with the Launch in AWS button. The button's defaults are the install name `prod` and
the region `us-east-1`; use your own if you changed them.

```sh
aws login                                     # AWS CLI credentials for the install's account
agentx env list --region us-east-1            # shows prod
agentx --env prod env use --region us-east-1  # saves prod's settings on this computer
agentx --env prod login --admin               # the admin email and the password from the setup page
agentx --env prod doctor --region us-east-1
```

1. **AWS CLI credentials** for the AWS account the install is in: `aws login`, or an SSO profile
   (`aws configure sso`, then `--profile` or `AWS_PROFILE`). See the AWS CLI guide,
   [Authentication and access credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html).
   If the install named an operator principal, assume the operator role as
   [The operator role](day-two.md#the-operator-role) shows.
2. **`env list`** shows the installs in that account and region. If it prints none, check the
   account and the region.
3. **`env use`** saves the install's settings on this computer, in `~/.agentx`. Admin sign-in reads
   them from there. Without this step, `login --admin` fails with
   `no settings for environment prod on this machine; run agentx --env prod env use`.
4. **`login --admin`** opens a browser on this computer. Sign in with the admin email given to the
   installer and the password chosen on the setup page. A person has to finish this sign-in. The
   sign-in is stored on this computer and reused until it expires.
5. **`doctor`** checks every part of the install and says how to fix what fails.

`project`, `channel` and `connector` commands read the install's settings from AWS, not from
`~/.agentx`, so they need only the AWS credentials and the admin sign-in. Pass `--region us-east-1`
to them too when your AWS configuration has another region.

`connector add` builds on the project's file in `~/.agentx/projects`, which only the computer that
ran `project add` (or `init`) has. On another computer, copy `<project>.yaml` into
`~/.agentx/projects`, or pass `--config-dir <the directory that holds it>`. The first project of a
Launch in AWS install was written by the installer job, so no computer has its file.

## Output, errors and exit codes

- Progress and questions go to **stderr**. The result goes to **stdout**.
- With `--json`, stdout is one line: `{"ok":true,"data":...}` on success, or
  `{"ok":false,"error":{"code":"...","message":"..."}}` on failure.
- Error messages name the fix, for example `--project is required; pass --project <name>`.

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Invalid input, including a question that needs a flag (see below). `doctor` also exits 2 when a check fails. |
| 3 | Login required |
| 4 | Forbidden or not found |
| 5 | The workspace is busy or not ready |
| 6 | The control plane is unavailable |
| 7 | Any other Rovara error |

## Running without a terminal

AI agents, CI and piped input usually run with no terminal. Then `agentx` never waits for an
answer:

- A question with a typed answer takes its default. If it has none, or it asks you to choose
  between several options (such as which repository to use), the command stops with exit code 2
  and a message naming the flag that answers it.
- A secret is never read from a prompt. Pass it as a file (`--<name>-file <path>`) or an
  environment variable (`--<name>-env <NAME>`), never as a value on the command line.
- `init` and `upgrade` stop unless you pass `--yes`.

**Yes/no questions in `project`, `connector`, `alerts` and `project model-check` are currently
answered yes with no terminal, even when their default is no**
([#1595](https://github.com/PrepLabsAI/Rovara/issues/1595)). Until that is fixed, give the answer
yourself with flags:

| Command | Answered yes with no terminal | Pass instead |
|---|---|---|
| `project add` | The detected setup and test commands, and the setup plan | `--setup-command` and `--test-command`, and read the plan it prints |
| `connector add mcp` | Approving write tools that no ownership rule limits | `--tools` with read tools only, or an ownership rule in `--config-file`; `--acknowledge-unscoped-writes` only on purpose |
| `connector add mcp --auth oauth` | Registering Rovara as the server's OAuth client | `--register-client`, or `--client-id` for your own app |
| `project model-check test` | Running the paid driving test | Run it only when you mean to |
| `alerts test` | "Did the test alarm arrive?" | Run it at a terminal |

## Steps that need a person

Some steps need a person in a browser, in GitHub or in Slack. An AI agent should stop and ask the
person to do them, then run the command again, instead of retrying.

- **Finishing the admin sign-in.** `login --admin`, or the first `project`, `channel` or
  `connector` command with no stored sign-in, prints a sign-in address and opens a browser. The
  person signs in there, on the same computer. Over SSH, forward the port first:
  `ssh -L 8765:127.0.0.1:8765 <that machine>`.
- **Giving Rovara's GitHub App access to a repository.** `project add` only sees the repositories
  the App's installation can see. For any other repository it stops with
  `the GitHub App cannot see <owner/name>`. The person adds the repository in the App's installation
  settings on GitHub.
- **Inviting the bot to a private Slack channel.** A bot cannot join a private channel by itself.
  `channel add` prints `/invite <@bot>` and waits up to 10 minutes for someone to type it in the
  channel. A public channel needs no invite: the bot joins it.
- **Mentioning the bot for the channel check.** After linking, `channel add` waits up to 10 minutes
  for someone to mention the bot in the channel, and checks for a threaded reply. Pass `--no-check`
  to link the channel without waiting.
- **Signing in as the bot user for an OAuth connector.** `connector add asana` and
  `connector add mcp --auth oauth` print an address. The person opens it on the same computer (or
  through the same SSH port forward), in a private window, and signs in with the bot user's account.

## Recipes

Add a repository as a project, then link a Slack channel to it:

```sh
agentx --env <env> project add --repository <owner/name> \
  --setup-command "npm ci" --test-command "npm test"
agentx --env <env> --project <project> channel add --channel <channel-name>
```

`channel add` invites the bot, then waits for someone to mention it in the channel and checks for a
threaded reply. Add `--no-check` to link the channel without waiting.

Add a connector:

```sh
agentx --env <env> --project <project> connector add linear \
  --linear-key-env LINEAR_API_KEY --linear-team <team>
agentx --env <env> --project <project> connector add mcp \
  --endpoint https://mcp.example.com/mcp --auth key --key-env VENDOR_KEY --tools "search:read"
```

Check an environment and read the result as JSON:

```sh
agentx --env <env> doctor --json
```

## Commands

### Projects and channels

| Command | What it does |
|---|---|
| `project add` | Register a project from a repository the GitHub App can see, and write its file to `~/.agentx/projects/<name>.yaml`. |
| `project setup-approve --project-name <name>` | Show a project's setup plan again and approve or decline it. |
| `project model-check discover` | List the models this account can use for AI navigation. |
| `project model-check test [--model <id>] [--yes]` | Run a small, real navigation test of a model. Shows the worst-case cost and asks first. |
| `channel add --channel <name> [--no-check]` | Link a Slack channel to `--project`, invite the bot and check for a reply. Linking another channel replaces the current one. |
| `admin slack bind --team <id> --channel <id>` / `unbind` | Link or unlink a channel by Slack IDs, for installs not made with `init`. |

`project add` options:

| Option | Meaning |
|---|---|
| `--repository <owner/name>` | The repository. Required when the GitHub App sees more than one. |
| `--project-name <name>` | The project's name. Default: the repository's name. |
| `--setup-command <command>` | The setup command, or `""` for none. Default: the detected one. |
| `--test-command <command>` | The test command, or `""` for none. Default: the detected one. |

### Connectors

All take `--project <name>`, test a read, and register the project's next revision.

| Command | Options |
|---|---|
| `connector add linear` | `--linear-key-file` or `--linear-key-env`, `--linear-team <id or key>` |
| `connector add jira` | `--jira-site <site>`, `--jira-project <key>`, `--jira-token-file` or `--jira-token-env` |
| `connector add asana` | `--asana-client-id`, `--asana-client-secret-file` or `-env`, `--asana-bot-email`, `--asana-project <gid>` |
| `connector add mcp` | `--endpoint <url>`, `--name`, `--auth key\|oauth`, `--key-file` or `--key-env`, `--tools <list>`, and more in [custom-mcp.md](connectors/custom-mcp.md) |

### Environment

| Command | What it does |
|---|---|
| `init` | Install an environment, step by step; running it again resumes. Every question has a flag. See [Installing Rovara](install.md). |
| `doctor` | Check every part of the environment and say how to fix what fails. |
| `upgrade [--to <version>] [--yes]` | Upgrade to a newer release. See [Upgrade](day-two.md#upgrade). |
| `config list` / `get <key>` / `set <key> [value] [--yes]` | Read and change settings: models, limits, Slack, alerts, budget. |
| `signin show` / `enable <method>` / `disable <method>` / `check` | Choose how developers sign in: `slack`, `oidc` or `github`. |
| `alerts test` | Send a test alarm and ask whether it arrived. |
| `env list` / `use` / `adopt` | List, re-cache or adopt environments. |
| `destroy [--keep-data]` | Remove an environment. Needs an explicit `--env`; you type its name to confirm. |

### Developers

| Command | What it does |
|---|---|
| `login <url>` / `logout` / `whoami` | Sign in to an environment, sign out, and see your projects. |
| `workspaces [--no-ui]` | Your projects and the workspaces in them. |
| `sessions [--mine\|--shared\|--project <name>]` | List sessions. |
| `session start <instructions> --project <name>` | Start work on a project and print the link to its page. |
| `session show\|watch\|comment\|tell\|answer\|stop\|retry\|share <session-id>` | Look at, steer or share a session. |
| `mcp install --client claude-code\|codex\|cursor` | Add Rovara's MCP server to your AI tool. See [mcp-install.md](mcp-install.md). |
| `chatgpt connect` / `status` / `disconnect` | Use your own ChatGPT plan. See [chatgpt.md](chatgpt.md). |

Other commands, for administrators of an install: `admin` (project registration, workspaces,
credentials, turn exports, task sharing), `adapter` ([channel adapters](channel-adapters.md)),
`loop` ([Rovara loop](loop.md)) and `deploy` (used by `init` and `upgrade`).
