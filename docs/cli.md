# CLI reference

This page matches `agentx --help` for this release. The CLI is always the final word: run
`agentx <command> --help` to see the options your installed version accepts.

The `agentx` CLI does three jobs. Developers use it to sign in and see what they can use.
Operators use it to install and run an AgentX environment in their own AWS account.
Administrators use it to manage projects, workspaces, Slack bindings and connector credentials.

Developer commands (`login <url>`, `whoami`, `logout`) only sign in and show access. Coding work
happens in Slack.

## Exit codes

An admin command's exit code names the kind of failure:

| Exit code | Meaning |
| --- | --- |
| 2 | invalid input |
| 3 | login required |
| 4 | forbidden or not found |
| 6 | control plane unavailable |

## Global options

These options go before the command, for example `agentx --env staging whoami`.

```text
Usage: agentx [options] [command]

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
```

## Developer commands

### agentx login

Signs you in. Developers pass their AgentX URL. Administrators pass `--admin`, or no URL.

```text
Usage: agentx login [options] [url]

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

Options:
  --admin     sign out of the administrator sign-in instead (default: false)
  -h, --help  display help for command
```

### agentx whoami

Shows who you are signed in as and which AgentX projects you can use.

```text
Usage: agentx whoami [options]

Options:
  -h, --help  display help for command
```

### agentx workspaces

Shows your AgentX projects and the workspaces in them, on a page served from 127.0.0.1.

```text
Usage: agentx workspaces [options]

Options:
  --no-ui     print the list in the terminal instead of opening a browser
  -h, --help  display help for command
```

### agentx mcp

Runs the AgentX MCP server for your AI tool over stdio.

```text
Usage: agentx mcp [options] [command]

Options:
  -h, --help         display help for command

Commands:
  install [options]  add the AgentX MCP server to Claude Code, Codex or Cursor
```

### agentx mcp install

Adds the AgentX MCP server to Claude Code, Codex or Cursor. See [MCP install](mcp-install.md).

```text
Usage: agentx mcp install [options]

Options:
  --client <client>  the AI tool (choices: "claude-code", "codex", "cursor")
  --print            only print the entry; change nothing (default: false)
  -h, --help         display help for command
```

## Installing and operating an environment

These commands install AgentX in your AWS account and change how it runs. Start with the
[quickstart](quickstart.md).

### agentx init

Installs AgentX in this AWS account, step by step. Running it again resumes where it stopped.
`--export` writes a bundle for a platform team instead. Before it creates anything, `init` prints
what it will create and an estimated monthly cost. See [costs](costs.md).

```text
Usage: agentx init [options]

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
  -h, --help                               display help for command
```

For OpenRouter models, see [OpenRouter model access](openrouter.md).

### agentx deploy

Deploys or upgrades an environment from a release. `init` uses it, and you can use it in
automation. See [releases](releases.md).

```text
Usage: agentx deploy [options]

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

Works with the AgentX environments in this AWS account and region. It has three subcommands.

#### agentx env list

Lists the environments installed in this AWS account and region.

```text
Usage: agentx env list [options]

Options:
  --region <region>  AWS region to list environments in; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

#### agentx env use

Rebuilds the local settings cache for the selected `--env` from SSM.

```text
Usage: agentx env use [options]

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

Options:
  --region <region>  AWS region of the existing deployment
  --client-id <id>   OIDC/Cognito app client ID; defaults to the control plane's
                     OidcAudience
  -h, --help         display help for command
```

### agentx signin

Chooses how developers sign in: Slack, your company's sign-in, or both. It needs the operator
role.

#### agentx signin show

Shows which sign-in methods are on and what the control plane offers.

```text
Usage: agentx signin show [options]

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

Turns a sign-in method off. Everyone signed in with it is signed out.

```text
Usage: agentx signin disable [options] <method>

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

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

### agentx project add

Registers a new project, on EC2 workers, from a repository the GitHub App can see.

```text
Usage: agentx project add [options]

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

Binds a Slack channel to the project named by `--project`, invites the bot, and checks that a
mention gets a threaded reply.

```text
Usage: agentx channel add [options]

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  --channel <name>   the channel's name
  --no-check         bind only; skip waiting for a reply
  -h, --help         display help for command
```

### agentx connector add

Connects a project to Linear, Jira or Asana. Each subcommand guides you through the setup and
ends with a new project revision.

#### agentx connector add linear

Adds Linear to a project: guide, key, test read, team, new revision.

```text
Usage: agentx connector add linear [options]

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

Options:
  --region <region>  AWS region of the environment; defaults to your AWS
                     configuration
  -h, --help         display help for command
```

## Administrator commands

Administrator commands start with `agentx admin`. Sign in first with `agentx login --admin`.

### agentx admin project register

Registers an immutable project revision and a trusted runtime binding.

```text
Usage: agentx admin project register [options]

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

The project YAML format is in [project configuration](project-configuration.md).

### agentx admin workspace cancel

Cancels the workspace's running coding task. Its conversation keeps what finished before.

```text
Usage: agentx admin workspace cancel [options]

Options:
  --workspace <workspace-id>  workspace whose task to cancel
  -h, --help                  display help for command
```

### agentx admin workspace stop

Stops idle compute and keeps the workspace storage.

```text
Usage: agentx admin workspace stop [options]

Options:
  --workspace <workspace-id>  workspace to stop
  -h, --help                  display help for command
```

### agentx admin slack bind

Binds a Slack channel to this project for the hosted orchestrator. New threads use the project's
latest registered revision.

```text
Usage: agentx admin slack bind [options]

Options:
  --team <team-id>        Slack team ID, for example T0123456789
  --channel <channel-id>  Slack channel ID, for example C0123456789
  -h, --help              display help for command
```

### agentx admin slack unbind

Removes a Slack channel binding. Existing thread workspaces are kept.

```text
Usage: agentx admin slack unbind [options]

Options:
  --team <team-id>        Slack team ID
  --channel <channel-id>  Slack channel ID
  -h, --help              display help for command
```

### agentx admin credential register

Registers or replaces a connector credential reference. The secret must already exist in Secrets
Manager under `agentx/connectors/` or `agentx/<env>/connectors/`.

```text
Usage: agentx admin credential register [options]

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

Options:
  -h, --help  display help for command
```

### agentx admin turns export

Writes turn records as JSON Lines, newest first. A turn record shows what each Slack turn was
offered, asked, chose and answered. Records are kept 30 days. They hold request and response text,
so keep the output private.

```text
Usage: agentx admin turns export [options]

Options:
  --since <duration>  how far back to export, such as 30m, 12h or 7d (at most
                      30d)
  --output <file>     write to this file with owner-only permissions instead of
                      stdout
  -h, --help          display help for command
```
