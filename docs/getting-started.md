# Install and run Rovara: overview

A one-page tour of `agentx init`, the day-2 commands and developer sign-in. [Installing Rovara](install.md) and [Running Rovara](day-two.md) have the full detail.

`agentx init` installs a complete Rovara environment in your own AWS account, step by step: its
stacks, its own GitHub App and Slack app, developer sign-in, your first project and its Slack
channel, and, if you want them now, the Linear, Jira and Asana connectors (any other MCP server is
added afterwards with `connector add mcp`). It prints everything it
will create and an estimated monthly cost before it creates anything, and running it again resumes
where it stopped.

The usual way to start it is the Launch in AWS button in [Installing Rovara](install.md#install-with-the-launch-in-aws-button-recommended):
it runs `agentx init` in your own AWS account and asks everything on a setup page, so nothing is
installed on your computer. From a terminal, the whole install is one command:
`npx @preplabsai/rovara-code init --env <name>`.

On your own computer, `init` opens an install page in your browser, served only from this computer,
and asks everything there, from the AWS account to the first reply in Slack. Pass `--no-ui` to
answer in the terminal instead. SSH sessions, CloudShell, CI and `--yes` use the terminal on their
own. See [docs/install.md](install.md#the-install-page).

You need:

- AWS administrator credentials for the first run, ideally in an AWS account used only for
  Rovara (environments that share an account are not a security boundary against each other).
  Later day-2 commands use a narrower operator role that `init` creates.
- A GitHub organization or personal account to own Rovara's GitHub App.
- A Slack workspace where you can create and install apps.
- Model access: Amazon Bedrock (the default) in the chosen region, or your own OpenRouter, Anthropic or OpenAI API key.
- Node.js 22.19 or newer (Node 22 LTS recommended). AWS CloudShell comes with Node 20: see
  [Node 22 in AWS CloudShell](install.md#node-22-in-aws-cloudshell) for a one-line install.

```sh
export AWS_PROFILE=<an admin profile for the target account>
npx @preplabsai/rovara-code init --env <name>
```

To install with the CDK, through a platform team, or from a source checkout, see
[Other ways to install](install-advanced.md).

`init` asks its questions (every one has a flag, and `--yes` runs it unattended), then:

1. checks prerequisites: the region, model access and EC2 quota;
2. deploys every stack, unattended: access, foundation and identity, the control plane and runtime,
   and the Slack service;
3. creates the GitHub App from a pre-filled page (one click), and you choose its repositories;
4. creates the Slack app from Rovara's manifest; you install it and paste its tokens into hidden
   prompts;
5. checks that Slack can reach Rovara;
6. sets up developer sign-in: Slack, your company's sign-in (OIDC), or both;
7. creates your admin user and signs you in;
8. sets up your first project (on EC2 workers) and its Slack channel;
9. offers the Linear, Jira and Asana connectors (other MCP servers are added after the install);
10. subscribes alerts, sets the monthly budget and sends a test alarm;
11. ends once a person mentions the bot in the channel and gets a threaded reply, and prints the
    command developers use to sign in.

`init` deploys published CloudFormation templates by default; `--engine cdk --source <checkout>`
deploys with the CDK from a clean checkout of the release's tag instead. In a terminal on your own
computer, `init` asks every question on a page on `127.0.0.1` by default; `--no-ui` keeps it in
the terminal. `--stop-after <step>` runs the steps up to that one and
stops, for automated tests; running `init` again finishes.


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
  `agentx --env <name> connector add mcp` connects any other remote MCP server, such as Sentry or
  PagerDuty ([docs/connectors/custom-mcp.md](connectors/custom-mcp.md)), and
  `agentx --env <name> alerts test` sends another test alarm.
- `agentx --env <name> doctor` checks every part of the environment and says how to fix what is
  wrong.
- `agentx --env <name> config list`, `config get <key>` and `config set <key> <value>` read and
  change the models, the per-thread request limit, Slack settings, alerts and the budget. They show
  the workspace limits too, but cannot change them until spec 025 phase 25e (see [Working in a
  thread](slack.md#working-in-a-thread)).
- `agentx --env <name> upgrade` moves to a newer release, showing every change and asking first;
  `upgrade --export <dir>` writes the upgrade for a platform team's pipeline instead.
- `agentx --env <name> destroy` removes the environment. It needs admin credentials and an explicit
  `--env`, and asks you to type the environment's name; `--keep-data` keeps the tables, buckets,
  secrets, Cognito user pool and KMS keys.

Developers then sign in from their own machines with `agentx login <control plane URL>`, with no
AWS credentials; `agentx whoami` shows which projects they can use, and `agentx workspaces` opens a
page on `127.0.0.1` showing those projects and the workspaces in them (`--no-ui` prints the same
list in the terminal). To hand tasks to Rovara from Claude Code, Codex or Cursor, a developer runs
`agentx mcp install --client claude-code|codex|cursor` once.

The guides:

- [Installing Rovara](install.md): the install, the install page, resuming, unattended installs
  and the cost estimate. [Other ways to install](install-advanced.md) covers the CDK, a platform
  team and a source checkout.
- [Running Rovara](day-two.md): the operator role, `doctor`, `upgrade`, `config`, projects,
  channels, connectors and developer sign-in settings (`agentx signin`).
- [Removing an environment](teardown.md) and
  [moving Rovara to another AWS account](move-account.md).
- [Use Rovara from Claude Code, Codex or Cursor](mcp-install.md): the developer's guide to
  `agentx mcp`, including sharing a task to Slack.
- [Releases](releases.md): what a release contains, how one is cut, the owner setup still
  open, and the release test.
