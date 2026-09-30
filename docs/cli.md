# CLI reference

This page matches `agentx --help` for this release. The CLI is always the final word: run
`agentx <command> --help` to see the options your installed version accepts.

The `agentx` CLI does three jobs:

- **Developers** sign in, see which projects they can use and what is running in them, and add
  AgentX to their AI tool. `agentx mcp` then hands coding tasks to AgentX from Claude Code, Codex
  or Cursor. Developers need no AWS credentials.
- **Operators** install an environment in their own AWS account, check it, upgrade it, change its
  settings, add projects, channels and connectors, and remove it.
- **Administrators** register projects, bind Slack channels, stop idle workspaces, manage
  connector credentials, export turn records and switch a shared task's mode.

Coding work happens in Slack, or in a developer's AI tool through `agentx mcp`.

Pass `--env <env>` to every command for an environment installed with `agentx init`. Without it,
`agentx` means the environment named `production`. Before the first release is published, run the
CLI from a source checkout as `node packages/cli/dist/main.js`, or link it (see the
[README](../README.md#1-install-the-administration-client)).

## Exit codes

A command's exit code names the kind of failure:

| Exit code | Meaning |
| --- | --- |
| 1 | unexpected internal error |
| 2 | invalid input |
| 3 | login required |
| 4 | forbidden or not found |
| 5 | workspace busy or not ready |
| 6 | control plane unavailable |
| 7 | any other AgentX error |

`agentx doctor` exits 2 when any check fails. `agentx destroy` exits 2 when it finds nothing for
the environment. `agentx init` exits 0 with status "waiting" while the Slack app waits for an
admin's approval.

## Global options

These options go before the command, for example `agentx --env staging whoami`. `--json` also
gives `doctor` its whole report as one JSON document.

```text
Usage: agentx [options] [command]

AgentX: sign in, and administer AgentX; developers hand off tasks from their AI
tools or work in Slack

Options:
  -V, --version             output the version number
  --project <project-name>  select a locally configured AgentX project
  --config-dir <directory>  project configuration directory (default:
                            "~/.agentx/projects")
  --deployment-file <path>  AgentX deployment settings; defaults to this
                            environment's local cache, or, for production,
                            ~/.agentx/deployment.yaml
  --env <name>              AgentX environment (default: "production")
  --allow-loopback          allow loopback HTTP endpoints for local testing only
                            (default: false)
  --json                    emit stable machine-readable output (default: false)
  -h, --help                display help for command

Commands:
  login [options] [url]     sign in: agentx login <url> for developers; agentx
                            login --admin (or no URL) for administrators
  logout [options]          sign out of AgentX on this computer and end the
                            sign-in at the server; --admin signs out of the
                            admin sign-in
  whoami                    show who you are signed in as and which AgentX
                            projects you can use
  workspaces [options]      show your AgentX projects and the workspaces in
                            them, on a page served from 127.0.0.1; --no-ui
                            prints them instead
  signin                    choose how developers sign in: Slack, your company's
                            sign-in, or both (operator role)
  config                    list, read and change an environment's settings:
                            models, limits, Slack, alerts and the budget
                            (operator role)
  doctor [options]          check every piece of an environment and say what is
                            wrong and how to fix it; exits non-zero when a check
                            fails (operator role)
  upgrade [options]         upgrade an environment to a newer release: shows the
                            release notes and every change, stops on a data
                            replacement unless you name it, then runs doctor
                            (operator role; the cdk engine needs admin
                            credentials)
  destroy [options]         remove one named environment from this AWS account:
                            its stacks, workers, kept data, secrets and
                            settings, in order (admin credentials; you type its
                            name to confirm)
  admin                     administrator workflows
  project                   AgentX projects
  channel                   Slack channels bound to AgentX projects
  connector                 connect a project to Linear, Jira or Asana
  alerts                    AgentX alerts
  env                       AgentX environments in this AWS account and region
  deploy [options]          deploy or upgrade an environment from a release;
                            used by init and upgrade, and for automation
  init [options]            install AgentX in this AWS account, step by step,
                            resuming where it stopped; --export writes a bundle
                            for a platform team instead
  mcp                       run the AgentX MCP server for your AI tool (stdio);
                            add it with agentx mcp install
  help [command]            display help for command
```

## Developer commands

### agentx login

Signs you in. Developers pass their AgentX URL and sign in with Slack or their company's sign-in.
Administrators pass `--admin`, or no URL. The sign-in is kept in the operating system's credential
store.

```text
Usage: agentx login [options] [url]

sign in: agentx login <url> for developers; agentx login --admin (or no URL) for
administrators

Arguments:
  url                     your AgentX URL, for developer sign-in

Options:
  --admin                 sign in as an administrator with the admin identity
                          provider (the default when no URL is given) (default:
                          false)
  --no-browser            developer sign-in: print the sign-in link instead of
                          opening a browser
  --callback-port <port>  fixed loopback callback port registered with the OIDC
                          client (default: 8765)
  -h, --help              display help for command
```

### agentx logout

Signs you out on this computer and ends the sign-in at the server.

```text
Usage: agentx logout [options]

sign out of AgentX on this computer and end the sign-in at the server; --admin
signs out of the admin sign-in

Options:
  --admin     sign out of the administrator sign-in instead (default: false)
  -h, --help  display help for command
```

### agentx whoami

Shows who you are signed in as and which AgentX projects you can use.

```text
Usage: agentx whoami [options]

show who you are signed in as and which AgentX projects you can use

Options:
  -h, --help  display help for command
```

### agentx workspaces

Shows your AgentX projects and the workspaces in them, on a page served from `127.0.0.1`.
`--no-ui` prints the list in the terminal.

```text
Usage: agentx workspaces [options]

show your AgentX projects and the workspaces in them, on a page served from
127.0.0.1; --no-ui prints them instead

Options:
  --no-ui     print the list in the terminal instead of opening a browser
  -h, --help  display help for command
```

### agentx mcp

Runs the AgentX MCP server for your AI tool over stdio. It gives the tool 11 AgentX tools: list
the projects you may use; start, check, continue, share, cancel and close coding tasks; and open
pull requests. See [Use AgentX from Claude Code, Codex or Cursor](mcp-install.md).

```text
Usage: agentx mcp [options] [command]

run the AgentX MCP server for your AI tool (stdio); add it with agentx mcp
install

Options:
  -h, --help         display help for command

Commands:
  install [options]  add the AgentX MCP server to Claude Code, Codex or Cursor
```

### agentx mcp install

Adds the AgentX MCP server to Claude Code, Codex or Cursor. It writes the version of AgentX you
ran it with into the entry, and never writes a token into your AI tool's settings. Run it as
yourself, never with `sudo`. See [Use AgentX from Claude Code, Codex or Cursor](mcp-install.md).

```text
Usage: agentx mcp install [options]

add the AgentX MCP server to Claude Code, Codex or Cursor

Options:
  --client <client>  the AI tool (choices: "claude-code", "codex", "cursor")
  --print            only print the entry; change nothing (default: false)
  -h, --help         display help for command
```

## Installing an environment

These commands install AgentX in your AWS account. Start with the [quickstart](quickstart.md);
[Installing AgentX](install.md) is the full guide.

### agentx init

Installs AgentX in this AWS account, step by step. Before it creates anything, it prints what it
will create and an estimated monthly cost (see [costs](costs.md)). Running it again resumes where
it stopped. `--export` writes a bundle for a platform team instead, and `--resume --from-bundle`
continues once they deployed it. `--engine cdk --source <checkout>` deploys with the CDK from a
clean checkout of the release's tag. `--ui` asks every question on a page on `127.0.0.1`. See
[Installing AgentX](install.md).

```text
Usage: agentx init [options]

install AgentX in this AWS account, step by step, resuming where it stopped;
--export writes a bundle for a platform team instead

Options:
  --export <dir>                           write a self-contained bundle a platform team deploys to create the access stack
  --region <region>                        AWS region to deploy into
  --account <account>                      AWS account id; defaults to the caller's own account (sts GetCallerIdentity, read-only)
  --release <dir>                          release directory (agentx release build output); default: download the release matching this agentx
  --engine <engine>                        deploy engine: published CloudFormation templates, or cdk from a source checkout (choices: "templates", "cdk")
  --source <dir>                           git checkout of the release's source tag; required for --engine cdk
  --resume                                 only continue an install already under way; never start a new one (default: false)
  --from-bundle <dir>                      with --resume: continue an install whose access stack a platform team deployed from this export bundle
  --yes                                    answer every question with its default or its flag, without asking; the plan is still printed. Confirmations such as the Slack bot and workspace check and "Request URL Verified?" are answered yes, so check the printed summary afterwards (default: false)
  --no-browser                             print every address to open instead of opening a browser
  --ui                                     ask every question on a page on 127.0.0.1 instead of in the terminal
  --no-ui                                  ask every question in the terminal (the default in this release)
  --identity <mode>                        identity provider (choices: "cognito", "oidc", default: "cognito")
  --oidc-issuer <url>                      your OIDC provider's issuer URL (required with --identity oidc)
  --oidc-audience <audience>               your OIDC provider's audience (required with --identity oidc)
  --oidc-client-id <id>                    your OIDC provider's client id, needed for agentx login
  --admin-claim <claim>                    the OIDC claim that marks AgentX administrators
  --admin-values <values>                  comma-separated values of --admin-claim that mark an administrator
  --permission-boundary <arn>              IAM permissions boundary ARN applied to every role AgentX creates
  --operator-principal <arn>               IAM principal ARN allowed to assume the AgentX operator role
  --model-provider <provider>              model provider for the orchestrator, classifier and worker; a per-component provider flag wins over it (choices: "amazon-bedrock", "openrouter")
  --orchestrator-provider <provider>       amazon-bedrock (default) or openrouter
  --classifier-provider <provider>         amazon-bedrock (default) or openrouter
  --worker-provider <provider>             amazon-bedrock (default) or openrouter
  --openrouter-key-file <path>             file holding the OpenRouter API key; init stores it in agentx/<env>/openrouter
  --openrouter-key-env <NAME>              environment variable holding the OpenRouter API key; init stores it in agentx/<env>/openrouter
  --openrouter-secret-arn <arn>            a Secrets Manager secret you made yourself holding the raw OpenRouter key; init then asks for no key
  --openrouter-providers <slugs>           comma-separated OpenRouter provider allowlist
  --orchestrator-model <id>                Provider model id for the Slack orchestrator (default: "us.anthropic.claude-sonnet-4-6")
  --classifier-model <id>                  Provider model id for the gate classifier (default: "amazon.nova-lite-v1:0")
  --worker-model <id>                      Provider model id for the runtime worker (default: "us.anthropic.claude-sonnet-4-6")
  --alert-email <address>                  email address AgentX sends alerts to
  --alert-webhook-file <path>              file holding a PagerDuty or Opsgenie integration address (kept secret)
  --alert-webhook-env <NAME>               environment variable holding a PagerDuty or Opsgenie integration address (kept secret)
  --no-alerts                              send alerts nowhere for now
  --budget <usd>                           monthly AWS budget in whole US dollars; 0 for none (default 100)
  --budget-scope <scope>                   tag: costs tagged agentx:env; account: the whole account (choices: "tag", "account")
  --github-account <login>                 GitHub organization or user that will own the AgentX GitHub App
  --github-account-type <type>             whether --github-account is an organization or a personal account (choices: "organization", "user")
  --github-app-name <name>                 GitHub App name (unique on GitHub)
  --github-app-id <id>                     a GitHub App made beforehand: its app id
  --github-installation-id <id>            a GitHub App made beforehand: its installation id
  --github-private-key-file <path>         a GitHub App made beforehand: its private key .pem file
  --github-private-key-env <NAME>          a GitHub App made beforehand: environment variable holding its private key
  --slack-app-name <name>                  Slack app name
  --slack-app-posted-messages <mode>       answer mentions people post through other apps with their own Slack token (choices: "accept", "ignore")
  --slack-install <state>                  whether the Slack app is installed, or waits for an admin's approval (default with --yes: installed) (choices: "installed", "approval")
  --slack-bot-token-file <path>            file holding the Slack Bot User OAuth Token
  --slack-bot-token-env <NAME>             environment variable holding the Slack Bot User OAuth Token
  --slack-signing-secret-file <path>       file holding the Slack signing secret
  --slack-signing-secret-env <NAME>        environment variable holding the Slack signing secret
  --worker-image <digest-ref>              worker image by digest (testing only)
  --slack-image <digest-ref>               Slack service image by digest (testing only)
  --admin-email <email>                    Cognito: your email, for the AgentX admin user
  --repository <owner/name>                the first project's repository
  --project-name <name>                    the first project's name (default: the repository's)
  --setup-command <command>                the first project's setup command, or "" for none
  --test-command <command>                 the first project's test command, or "" for none
  --channel <name>                         the Slack channel for the first project
  --connectors <list>                      connectors to add now: comma-separated linear, jira, asana, or none
  --linear-key-file <path>                 file holding the Linear API key
  --linear-key-env <NAME>                  environment variable holding the Linear API key
  --linear-team <id or key>                the Linear team the first project may use
  --jira-site <site>                       the <site> in <site>.atlassian.net
  --jira-project <key>                     the Jira project key
  --jira-token-file <path>                 file holding the Jira service account's API token
  --jira-token-env <NAME>                  environment variable holding the Jira service account's API token
  --asana-client-id <id>                   the Asana MCP app's Client ID
  --asana-client-secret-file <path>        file holding the Asana app's Client secret
  --asana-client-secret-env <NAME>         environment variable holding the Asana app's Client secret
  --asana-bot-email <email>                the Asana bot user's email; a sign-in by any other account is refused
  --asana-project <gid>                    the Asana project's GID
  --slack-client-id <id>                   the Slack app's Client ID (Basic Information, App Credentials)
  --slack-client-secret-file <path>        file holding the Slack app's Client Secret
  --slack-client-secret-env <NAME>         environment variable holding the Slack app's Client Secret
  --signin-oidc-issuer <url>               company sign-in issuer URL, for example https://acme.okta.com
  --signin-oidc-client-id <id>             client ID of the company sign-in app
  --signin-oidc-client-secret-file <path>  file holding the company sign-in app's client secret
  --signin-oidc-client-secret-env <NAME>   environment variable holding the company sign-in app's client secret
  --signin-oidc-required-claim <claim>     claim a person must carry to use AgentX, for example groups; empty for none
  --signin-oidc-required-values <values>   comma-separated values of the required claim that may use AgentX
  --signin-oidc-display-name <name>        name on the sign-in button, for example Okta
  --signin <method>                        how developers sign in: Slack (default), your company's sign-in (oidc), or both (choices: "slack", "oidc", "both")
  --stop-after <step>                      run the steps up to and including this one, then stop; agentx init again finishes (for automated tests)
  -h, --help                               display help for command
```

For OpenRouter models, see [OpenRouter model access](openrouter.md).

### agentx deploy

Deploys or upgrades an environment from a release. `init` and `upgrade` use it, and you can use it
in automation. See [releases](releases.md).

```text
Usage: agentx deploy [options]

deploy or upgrade an environment from a release; used by init and upgrade, and
for automation

Options:
  --mode <mode>      install a fresh environment or upgrade an existing one
                     (choices: "install", "upgrade")
  --engine <engine>  deploy engine: pre-synthesized CloudFormation change sets,
                     or a real cdk deploy (choices: "templates", "cdk", default:
                     "templates")
  --release <dir>    release directory (agentx release build output)
  --answers <file>   deploy answers JSON file (see DeployAnswers)
  --parts <parts>    comma-separated subset of parts to deploy, in the mode's
                     order; default: the whole order
  --source <dir>     git checkout of the release's source tag; required for
                     --engine cdk
  --yes              execute without an interactive change-set confirmation;
                     required for --engine cdk (default: false)
  -h, --help         display help for command
```

### agentx env

Works with the AgentX environments in this AWS account and region.

#### agentx env list

Lists the environments installed in this AWS account and region.

```text
Usage: agentx env list [options]

list the environments installed in this AWS account and region

Options:
  --region <region>  AWS region to list environments in; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

#### agentx env use

Rebuilds the local settings cache for the selected `--env` from SSM.

```text
Usage: agentx env use [options]

rebuild the selected --env's local settings cache from SSM

Options:
  --region <region>  AWS region of the environment's SSM parameters; defaults to
                     your AWS configuration
  -h, --help         display help for command
```

#### agentx env adopt

Registers an existing deployment with fixed legacy stack names as the selected `--env`. It reads
the CloudFormation stacks and never changes them.

```text
Usage: agentx env adopt [options]

register the existing deployment (fixed legacy stack names) as the selected
--env, reading its CloudFormation stacks; never changes them

Options:
  --region <region>  AWS region of the existing deployment
  --client-id <id>   OIDC/Cognito app client ID; defaults to the control plane's
                     OidcAudience
  -h, --help         display help for command
```

## Running an environment

These commands run with the operator role, `agentx-<env>-operator`, unless noted.
[Running AgentX](day-two.md) is the full guide.

### agentx doctor

Checks every part of an environment and says what is wrong and how to fix it: stacks, secrets,
Slack, GitHub, connectors, models, alerts, capacity and sign-in. It exits 0 when no check failed
(warnings and skips are fine), and 2 when any check failed. See
[Check it](day-two.md#check-it).

```text
Usage: agentx doctor [options]

check every piece of an environment and say what is wrong and how to fix it;
exits non-zero when a check fails (operator role)

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

### agentx upgrade

Upgrades an environment to a newer release. It prints the release notes, then shows each stack's
changes and asks before deploying. It stops before any change that replaces or deletes stored data
unless you name it with `--allow-replace`. It refuses a release older than the one the environment
runs. When every stack is done, it runs `doctor`. A cdk environment upgrades with admin
credentials and `--source`. `--export` writes the upgrade for a platform team's pipeline instead.
See [Upgrade](day-two.md#upgrade).

```text
Usage: agentx upgrade [options]

upgrade an environment to a newer release: shows the release notes and every
change, stops on a data replacement unless you name it, then runs doctor
(operator role; the cdk engine needs admin credentials)

Options:
  --to <version>                the release to upgrade to; default: this
                                agentx's own release
  --release <dir>               a release directory (agentx release build
                                output) instead of downloading one
  --source <dir>                the cdk engine only: a clean checkout of the
                                target release's tag
  --allow-replace <logical-id>  accept replacing or deleting this table, user
                                pool, bucket, key or secret; repeat for each
                                (default: [])
  --export <dir>                write the upgrade for a platform team's pipeline
                                instead of deploying it
  --worker-image <digest-ref>   worker image by digest (testing only)
  --slack-image <digest-ref>    Slack service image by digest (testing only)
  --yes                         apply without asking; every change and the
                                release notes are still printed (default: false)
  --region <region>             AWS region of the environment; defaults to your
                                AWS configuration
  -h, --help                    display help for command
```

### agentx config

Lists, reads and changes an environment's settings: models, limits, Slack, alerts and the budget.
The keys, their defaults and where each lives are in [Change settings](day-two.md#change-settings).
`config list` and `config get` show the workspace limits, but `config set` cannot change them
until spec 025 phase 25e.

#### agentx config list

Shows every key, its value, and where it lives.

```text
Usage: agentx config list [options]

every key, its value, and where it lives

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

#### agentx config get

Shows one key's value.

```text
Usage: agentx config get [options] <key>

one key's value

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

#### agentx config set

Changes one key. It shows the change and asks first. A new model must answer a one-token call
before anything changes. A PagerDuty or Opsgenie alert address is a secret: pass it with
`--value-file` or `--value-env`, or leave the value out to be asked in a hidden prompt.

```text
Usage: agentx config set [options] <key> [value]

change one key: shows the change and asks first; model keys are tested first

Options:
  --value-file <path>  file holding the value (for a webhook alert address,
                       which is a secret)
  --value-env <NAME>   environment variable holding the value (for a webhook
                       alert address)
  --yes                apply without asking; the change is still printed
                       (default: false)
  --region <region>    AWS region of the environment; defaults to your AWS
                       configuration
  -h, --help           display help for command
```

### agentx destroy

Removes one named environment from this AWS account: its stacks, EC2 workers, kept data, secrets
and settings, in order. It needs admin credentials and an explicit `--env`, and asks you to type
the environment's name. `--keep-data` keeps the tables, buckets, secrets, Cognito user pool and
KMS keys. Nothing it removes can be brought back. See [Removing an environment](teardown.md).

```text
Usage: agentx destroy [options]

remove one named environment from this AWS account: its stacks, workers, kept
data, secrets and settings, in order (admin credentials; you type its name to
confirm)

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  --keep-data        keep the tables, buckets, secrets, Cognito user pool and
                     KMS keys; remove the rest (default: false)
  -h, --help         display help for command
```

### agentx signin

Chooses how developers sign in: Slack, your company's sign-in, or both.

#### agentx signin show

Shows which sign-in methods are on and what the control plane offers.

```text
Usage: agentx signin show [options]

show which sign-in methods are on and what the control plane offers

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

#### agentx signin enable

Turns on Slack sign-in or company sign-in. It shows the change to the control plane and asks
first.

```text
Usage: agentx signin enable [options] <method>

turn on Slack sign-in or company sign-in; shows the change to the control plane
and asks first

Arguments:
  method                                   slack or oidc

Options:
  --region <region>                        AWS region of the environment; defaults to your AWS configuration
  --yes                                    apply without asking; the change is still printed (default: false)
  --slack-client-id <id>                   the Slack app's Client ID (Basic Information, App Credentials)
  --slack-client-secret-file <path>        file holding the Slack app's Client Secret
  --slack-client-secret-env <NAME>         environment variable holding the Slack app's Client Secret
  --signin-oidc-issuer <url>               company sign-in issuer URL, for example https://acme.okta.com
  --signin-oidc-client-id <id>             client ID of the company sign-in app
  --signin-oidc-client-secret-file <path>  file holding the company sign-in app's client secret
  --signin-oidc-client-secret-env <NAME>   environment variable holding the company sign-in app's client secret
  --signin-oidc-required-claim <claim>     claim a person must carry to use AgentX, for example groups; empty for none
  --signin-oidc-required-values <values>   comma-separated values of the required claim that may use AgentX
  --signin-oidc-display-name <name>        name on the sign-in button, for example Okta
  -h, --help                               display help for command
```

#### agentx signin disable

Turns a sign-in method off. Everyone signed in with it is signed out at once.

```text
Usage: agentx signin disable [options] <method>

turn a sign-in method off; everyone signed in with it is signed out

Arguments:
  method             slack or oidc

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  --yes              apply without asking; the change is still printed (default:
                     false)
  -h, --help         display help for command
```

#### agentx signin check

Checks every piece developer sign-in needs, and says what to fix.

```text
Usage: agentx signin check [options]

check every piece developer sign-in needs, and say what to fix

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

### agentx project add

Registers a new project, on EC2 workers, from a repository the GitHub App can see. It writes the
project file to `~/.agentx/projects/<name>.yaml`.

```text
Usage: agentx project add [options]

register a new project from a repository the GitHub App sees, on EC2 workers

Options:
  --region <region>          AWS region of the environment; defaults to your AWS
                             configuration
  --repository <owner/name>  the repository
  --project-name <name>      the project's name (default: the repository's)
  --setup-command <command>  the setup command, or "" for none
  --test-command <command>   the test command, or "" for none
  -h, --help                 display help for command
```

### agentx channel add

Binds a Slack channel to the project named by `--project`, invites the bot, and waits for a mention
to get a threaded reply. `--no-check` skips the wait.

```text
Usage: agentx channel add [options]

bind a Slack channel to the --project, invite the bot, and check a mention gets
a threaded reply

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  --channel <name>   the channel's name
  --no-check         bind only; skip waiting for a reply
  -h, --help         display help for command
```

### agentx connector add

Connects a project to Linear, Jira or Asana. Each subcommand guides you through the setup, tests
the connection, and registers the project's next revision.

#### agentx connector add linear

Adds Linear to a project: guide, key, test read, team, new revision.

```text
Usage: agentx connector add linear [options]

add Linear to a project: guide, key, test read, team, new revision

Options:
  --region <region>          AWS region of the environment; defaults to your AWS
                             configuration
  --linear-key-file <path>   file holding the Linear API key
  --linear-key-env <NAME>    environment variable holding the Linear API key
  --linear-team <id or key>  the team the project may use
  -h, --help                 display help for command
```

#### agentx connector add jira

Adds Jira to a project: guide, service account token, project check, new revision.

```text
Usage: agentx connector add jira [options]

add Jira to a project: guide, service account token, project check, new revision

Options:
  --region <region>         AWS region of the environment; defaults to your AWS
                            configuration
  --jira-site <site>        the <site> in <site>.atlassian.net
  --jira-project <key>      the Jira project key
  --jira-token-file <path>  file holding the API token
  --jira-token-env <NAME>   environment variable holding the API token
  -h, --help                display help for command
```

#### agentx connector add asana

Adds Asana to a project: guide, app client, the bot user's sign-in, project check, new revision.
It opens no browser for the bot user's sign-in.

```text
Usage: agentx connector add asana [options]

add Asana to a project: guide, app client, the bot user's sign-in (no browser
opened here), project check, new revision

Options:
  --region <region>                  AWS region of the environment; defaults to
                                     your AWS configuration
  --asana-client-id <id>             the Asana MCP app's Client ID
  --asana-client-secret-file <path>  file holding the app's Client secret
  --asana-client-secret-env <NAME>   environment variable holding the app's
                                     Client secret
  --asana-bot-email <email>          the bot user's email; a sign-in by any
                                     other account is refused
  --asana-project <gid>              the Asana project's GID
  -h, --help                         display help for command
```

The connector guides are [Linear](connectors/linear.md), [Jira](connectors/jira.md) and
[Asana](connectors/asana.md).

### agentx alerts test

Sends a test alarm to the alert address and asks whether it arrived.

```text
Usage: agentx alerts test [options]

send a test alarm to the alert address and ask whether it arrived (FR-046)

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

## Administrator commands

Administrator commands start with `agentx admin`. Sign in first with
`agentx --env <env> login --admin`.

### agentx admin project register

Registers an immutable project revision and a trusted runtime binding. Pass the foundation's
`Ec2WorkerLaunchTemplateId` and `Ec2WorkerSubnets` outputs. In an installed environment,
`agentx project add` does this for you. The project YAML format is in
[project configuration](project-configuration.md).

```text
Usage: agentx admin project register [options]

register an immutable project revision and trusted runtime binding

Options:
  --file <path>              project YAML file
  --deployment-mode <mode>   ec2-ebs (default: "ec2-ebs")
  --launch-template-id <id>  EC2 worker launch template (ec2-ebs), the
                             foundation's Ec2WorkerLaunchTemplateId
  --subnets <pairs>          availabilityZone=subnetId pairs, comma-separated
                             (ec2-ebs), the foundation's Ec2WorkerSubnets
  --volume-size-gib <size>   workspace volume size in GiB (ec2-ebs) (default:
                             "20")
  --volume-type <type>       workspace volume type (ec2-ebs) (default: "gp3")
  -h, --help                 display help for command
```

### agentx admin workspace cancel

Cancels the workspace's running coding task. The task ends cancelled, and the workspace takes the
next request. Its conversation keeps what finished before.

```text
Usage: agentx admin workspace cancel [options]

cancel the workspace's running coding task; its conversation keeps what finished
before

Options:
  --workspace <workspace-id>  workspace whose task to cancel
  -h, --help                  display help for command
```

### agentx admin workspace stop

Stops idle compute and keeps the workspace storage.

```text
Usage: agentx admin workspace stop [options]

stop idle compute while retaining workspace storage

Options:
  --workspace <workspace-id>  workspace to stop
  -h, --help                  display help for command
```

### agentx admin slack bind

Binds a Slack channel to the project named by `--project` for the hosted orchestrator. New
threads use the project's latest registered revision.

```text
Usage: agentx admin slack bind [options]

bind a Slack channel to this project; new threads use its latest registered
revision

Options:
  --team <team-id>        Slack team ID, for example T0123456789
  --channel <channel-id>  Slack channel ID, for example C0123456789
  -h, --help              display help for command
```

### agentx admin slack unbind

Removes a Slack channel binding. Existing thread workspaces are kept.

```text
Usage: agentx admin slack unbind [options]

remove a Slack channel binding; existing thread workspaces are kept

Options:
  --team <team-id>        Slack team ID
  --channel <channel-id>  Slack channel ID
  -h, --help              display help for command
```

### agentx admin credential register

Registers or replaces a connector credential reference. The secret must already exist in Secrets
Manager under `agentx/connectors/` or `agentx/<env>/connectors/`. In an installed environment,
`agentx connector add` stores and registers the credential for you.

```text
Usage: agentx admin credential register [options]

register or replace a credential reference; the secret must already exist

Options:
  --ref <reference>  credential reference used by connectors' credentialRef
  --type <type>      static-secret, oauth-client-credentials or
                     oauth-refresh-token
  --secret <name>    Secrets Manager secret name, agentx/connectors/<name> or
                     agentx/<env>/connectors/<name>
  -h, --help         display help for command
```

### agentx admin credential authorize

Signs the connector's bot user in once in a browser, stores its refresh token in the secret, and
registers it as `oauth-refresh-token`.

```text
Usage: agentx admin credential authorize [options]

sign the connector's bot user in once in a browser, store its refresh token in
the secret, and register it as oauth-refresh-token

Options:
  --ref <reference>         credential reference used by connectors'
                            credentialRef
  --secret <name>           Secrets Manager secret holding the app's
                            {"clientId", "clientSecret"},
                            agentx/connectors/<name> or
                            agentx/<env>/connectors/<name>
  --provider <name>         whose sign-in page to use: asana
  --region <region>         AWS region of the secret; defaults to your AWS
                            configuration
  --no-browser              do not open a browser; only print the sign-in URL,
                            to open in a private window signed in as the bot
                            user
  --expect-account <email>  the bot user's email; refuse, storing nothing, when
                            another account signs in
  -h, --help                display help for command
```

### agentx admin credential list

Lists credential references, their types, their secret names and whether a token is cached. It
never shows secret values.

```text
Usage: agentx admin credential list [options]

list credential references, types, secret names and whether a token is cached;
never secret values

Options:
  -h, --help  display help for command
```

### agentx admin turns export

Writes turn records as JSON Lines, newest first. A turn record shows what each Slack turn was
offered, asked, chose and answered. Records are kept 30 days. They hold request and response text,
so keep the output private. The output also shows task IDs for `admin task share-mode`.

```text
Usage: agentx admin turns export [options]

write turn records as JSON Lines, newest first; they hold request and response
text, so keep the output private

Options:
  --since <duration>  how far back to export, such as 30m, 12h or 7d (at most
                      30d)
  --output <file>     write to this file with owner-only permissions instead of
                      stdout
  -h, --help          display help for command
```

### agentx admin task share-mode

Switches a task that a developer shared from an AI tool between view only and continue. The mode
stays within the project's `developerTasks` settings: with continue not allowed, the task stays
view only. An admin cannot share a private task or move a shared one to another channel. See
[Shared tasks](day-two.md#shared-tasks).

```text
Usage: agentx admin task share-mode [options]

switch a shared task between view only and continue, within its project's policy

Options:
  --task <task-id>  the task to change
  --mode <mode>     view or continue
  -h, --help        display help for command
```
