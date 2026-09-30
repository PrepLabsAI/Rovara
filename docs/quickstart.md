# Quickstart

This page is the short path from an empty AWS account to a first result: AgentX answering in a
Slack thread, then a first pull request. The full install guide is
[docs/install.md](install.md). For how the pieces fit together, read [concepts](concepts.md).

## What you need

- An AWS account, ideally used only for AgentX, and admin credentials in it for the first run.
  Later day-2 commands use the narrower operator role the install creates.
- Node 22.19 or later (Node 22 only).
- A GitHub organization or personal account to own the AgentX GitHub App.
- A Slack workspace where you can create apps.
- Model access: Amazon Bedrock (the default) in the chosen region, or an OpenRouter API key.
- An email address for alerts, or a PagerDuty or Opsgenie integration address.
- Room in the region's EC2 vCPU and Elastic IP quotas. `init` checks both before it creates
  anything.

[Before you start](install.md#before-you-start) has the details, including the quota codes.

Pick an environment name, such as `prod` or `staging`, and pass it to every command as
`--env <env>`. Without it, `agentx` means the environment named `production`.

## 1. Install

When a release is published, the install is one command:

```sh
npx @charterarc/agentx --env <env> init --region <region>
```

No AgentX release is published yet (see [releases](releases.md)). Until then, run `init` from a
source checkout with a release you build yourself and images you have pushed yourself:

```sh
npm ci && npm run build
npm run release:build -- --version <x.y.z> --out ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>

export AWS_PROFILE=<an admin profile for the target account>
node packages/cli/dist/main.js --env <env> init --region <region> --release ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>
```

`init` asks its questions first. Then it prints every stack, role, secret and app it will create,
with an estimated monthly cost, and asks before it creates anything. It runs its steps in order.
You click or paste only a few things: the GitHub App page, the Slack app page, the Slack bot token
and signing secret, the Slack Client ID and Client Secret for developer sign-in, the Verified
check, your admin sign-in, the alert email's confirmation link, and one Slack mention. `init` ends
when AgentX replies in the thread.

If `init` stops, run the same command again. It starts at the first step that is not done.

[docs/install.md](install.md) covers each step, installing with cdk, installing through a platform
team, unattended installs with `--yes`, and the cost estimate.

## 2. Check it

```sh
agentx --env <env> doctor --region <region>
```

`doctor` checks every part of the environment and says how to fix what is wrong. See
[Running AgentX](day-two.md#check-it).

## 3. Your first request in Slack

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

Messages without a mention, edits, bot messages, AgentX's own messages, direct messages, and users
from other Slack organizations are ignored.

Each member may hold at most 3 workspaces and the organization at most 20. Prepared thread
workspaces and open tasks from AI tools share these limits. When a request would go over a limit,
AgentX prepares nothing and says which limit was reached.

To stop a running task, send `@AgentX stop`. To release the thread's workspace when you are done,
send `@AgentX close this workspace`.

## 4. Your first pull request

AgentX never publishes on its own after a coding task. Ask for a pull request in the thread,
naming the repository by its project YAML `name`:

```text
@AgentX Create a pull request for the personal-website repository titled "Improve homepage navigation".
```

AgentX runs the project's `readiness` commands in the workspace first. It rejects an empty diff,
merge conflicts, or any failed or timed-out check. Any `codeBuildGates` run against the exact
pushed commit. AgentX then opens a ready-for-review pull request from an `agentx/<operation-id>`
branch against the repository's `defaultBranch`. The reply includes the pull request URL and
number, the commit, the branches and the check evidence. See
[How a pull request is made](concepts.md#how-a-pull-request-is-made).

## Or: hand a task over from your AI tool

Developers can also hand coding tasks to AgentX from Claude Code, Codex or Cursor. They need no
AWS credentials. Sign in once, add AgentX to the AI tool, then ask the tool for a task:

```sh
npx @charterarc/agentx login <control plane URL>   # Slack or your company's sign-in
npx @charterarc/agentx mcp install --client claude-code|codex|cursor
```

`agentx whoami` shows which projects you can use. `agentx workspaces` opens a page on `127.0.0.1`
with those projects and their workspaces (`--no-ui` prints the list instead). A task can also be
shared into the project's Slack channel. [Use AgentX from Claude Code, Codex or
Cursor](mcp-install.md) is the full guide.

## Next steps

- [Installing AgentX](install.md): every install path, resuming and unattended installs.
- [Running AgentX](day-two.md): the operator role, `doctor`, `upgrade`, `config`, more projects,
  channels and connectors, and developer sign-in settings.
- [Removing an environment](teardown.md) and [moving AgentX to another AWS
  account](move-account.md).
- [Concepts](concepts.md): the orchestrator and the worker, threads, tasks, workspaces and pull
  requests.
- [Project configuration](project-configuration.md): repositories, setup, readiness checks, models
  and `developerTasks`. Illustrative projects are in [`../examples/projects/`](../examples/projects/).
- [CLI reference](cli.md): every `agentx` command.
- [Security](security.md), [costs](costs.md) and [troubleshooting](troubleshooting.md).
- The full [README](../README.md).
