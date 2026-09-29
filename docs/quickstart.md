# Quickstart

This page takes you from an empty AWS account to your first pull request made from Slack. It
covers the install, developer sign-in, your first request in a Slack thread, and your first pull
request. For how the pieces fit together, read [concepts](concepts.md).

## What you need

- AWS administrator credentials for the first run, ideally in an AWS account used only for
  AgentX. Environments that share an account are not a security boundary against each other.
  Later day-2 commands use a narrower operator role that `init` creates.
- A GitHub organization or personal account to own AgentX's GitHub App.
- A Slack workspace where you can create and install apps.
- Model access: Amazon Bedrock (the default) in the chosen region, or an OpenRouter API key.
- Node.js 22.19 or newer within the Node 22 release line.

## Install AgentX

`agentx init` installs a complete AgentX environment in your own AWS account, step by step. It
prints everything it will create and an estimated monthly cost before it creates anything. If it
stops, run it again and it resumes where it stopped.

### Today: from a source checkout

No AgentX release is published yet. The public image registry and the npm package are waiting on
owner setup; see [releases](releases.md). Until the first release, you install from a source
checkout with a locally built release, and you need container images you have pushed yourself:

```sh
npm ci && npm run build
npm run release:build -- --version <x.y.z> --out ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>

export AWS_PROFILE=<an admin profile for the target account>
node packages/cli/dist/main.js --env <name> init --region us-east-1 --release ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>
```

### Once a release is published (not yet available)

When a release is published, the whole install is one command:

```sh
npx @charterarc/agentx init --env <name>
```

This does not work yet. Use the source checkout until [releases](releases.md) says a release is out.

## What init does

`init` asks its questions first. Every question has a flag, and `--yes` runs it unattended. Then it:

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

Secrets never go on the command line. Each one comes from a hidden prompt, a file you point to,
or an environment variable, and `init` stores it in AWS Secrets Manager, never in its own
settings. A platform team that must review IAM first can use `agentx init --export <dir>` for a
bundle they deploy themselves. The operator then continues with
`agentx init --resume --env <name> --region <region> --from-bundle <dir>`.

The full guide, including resuming, unattended installs, developer sign-in settings and tearing an
environment down, is in
[Installing with agentx init](architecture-production.md#installing-with-agentx-init).

## Sign in as a developer

Developers sign in from their own machines with their own identity. They need no AWS credentials:

```sh
agentx login <control plane URL>   # opens the browser: Slack or your company's sign-in
agentx whoami                      # who you are, and which projects you can use
agentx workspaces                  # a page on 127.0.0.1 with those projects and their workspaces
```

`agentx workspaces --no-ui` prints the same list in the terminal. Tokens are kept in the operating
system's credential store. A developer can use a project when an administrator granted access or
when they are a member of the project's bound Slack channel.

These commands only sign in and show access. Coding work happens in Slack.

## Your first request in Slack

Mention the app in the project's bound channel. Mention it for every request, including
follow-ups in a thread:

```text
@AgentX inspect the project and implement the navigation fix. Run the relevant tests, but do not
create a pull request.
```

What happens next:

- AgentX replies within a few seconds.
- A new thread gets a coding workspace only when a request first needs the remote worker, for
  example to read or change repository files or to run commands. Questions that connectors
  answer, such as issue tracker questions, need no workspace.
- The first request that needs the worker prepares the workspace in the same turn. This takes a
  few minutes, and AgentX says so in the thread.
- If earlier requests in the thread are still running, AgentX says how many are ahead, and says
  "Working on it now" when it starts on yours.

Messages without a mention, edits, bot messages, direct messages, and users from other Slack
organizations are ignored.

Each member may hold at most 3 prepared thread workspaces, and the organization at most 20. When a
request would go over a limit, AgentX prepares nothing and says which limit was reached.

To stop a running task, send `@AgentX stop`. To release the thread's workspace when you are done,
send `@AgentX close this workspace`.

## Your first pull request

AgentX never publishes automatically after a coding task. Ask for a pull request in the thread,
naming the repository by its project YAML `name`:

```text
@AgentX Create a pull request for the personal-website repository titled "Improve homepage navigation".
```

Before it pushes, AgentX runs the project's `readiness` commands in the workspace. It rejects an
empty diff, merge conflicts, or any failed or timed-out check. If the repository has
`codeBuildGates`, they run against the exact pushed commit before the pull request is created.

AgentX then creates an `agentx/<operation-id>` branch, makes one commit, pushes without force, and
opens a ready-for-review pull request against the repository's `defaultBranch`. The reply includes
the pull request URL and number, the commit, the branches and the check evidence. The pull request
ends with a link to the Slack thread and the members who made requests in it.

## Next steps

- [Concepts](concepts.md): the orchestrator and the worker, threads, workspaces and pull requests.
- [Project configuration](project-configuration.md): repositories, setup, readiness checks and
  models. Illustrative projects are in [`../examples/projects/`](../examples/projects/).
- [Production architecture](architecture-production.md#installing-with-agentx-init): resuming an
  install, day-2 commands and tearing down.
- [CLI reference](cli.md): every `agentx` command.
- [Security](security.md) and [costs](costs.md).
- [Troubleshooting](troubleshooting.md) when something does not work.
- The full [README](../README.md).
