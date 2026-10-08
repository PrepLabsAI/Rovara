<h1 align="center">Rovara</h1>

<p align="center">
  <strong>The open-source alternative to Claude Tag!</strong>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#documentation"><strong>Docs</strong></a> &middot;
  <a href="https://rovara-dev.github.io/docs/index.html"><strong>Field guide</strong></a> &middot;
  <a href="docs/how-it-works.md"><strong>How it works</strong></a> &middot;
  <a href="docs/releases.md"><strong>Releases</strong></a> &middot;
  <a href="CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-22.19%2B-339933" alt="Node 22.19+" />
  <img src="https://img.shields.io/badge/runs%20in-your%20AWS%20account-FF9900" alt="Runs in your AWS account" />
  <img src="https://img.shields.io/badge/agent-Pi%201.0-6f42c1" alt="Pi coding agent 1.0" />
</p>

<p align="center">
  <a href="https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate?templateURL=https%3A%2F%2Frovara-installer-us-east-1.s3.us-east-1.amazonaws.com%2Flatest%2Finstaller.template.json&amp;stackName=agentx-installer"><img src="docs/assets/launch-in-aws.svg" alt="Launch in AWS" width="232" height="52" /></a>
</p>

<br/>

# The open-source alternative to Claude Tag!

Start a task in Slack, or hand one over from Claude Code, Codex or Cursor. A remote
[Pi](https://github.com/earendil-works/pi) coding agent works on it in a persistent, isolated EC2
workspace in your AWS account. When it finishes, Rovara reports which checks passed, failed, or
could not be verified. When you're ready, it opens a pull request for a person to review and merge.
Rovara has no merge path.

**Your team delegates from where it already works. Your AWS account runs the work.**

> **Naming:** Rovara was called AgentX. Commands, AWS resource names, paths, tool names and the
> default Slack app name still use `agentx` or `AgentX` (for example `agentx init`,
> `AgentXControlPlane`, `~/.agentx` and `@AgentX`), so every command in these docs works as written.

|        | Step                    | Example                                                                                       |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------- |
| **01** | Install in your account | `agentx init` sets up the stacks, a GitHub App, a Slack app and your first project.           |
| **02** | Bind a project          | Point a Slack channel at a project: its repositories, setup steps and readiness checks.       |
| **03** | Delegate and review     | _"@AgentX fix the navigation bug."_ Pick Quick or Full, approve the plan, then review the draft PR. |

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Start tasks from</strong></td>
    <td align="center">Slack</td>
    <td align="center">Claude Code</td>
    <td align="center">Codex</td>
    <td align="center">Cursor</td>
  </tr>
  <tr>
    <td align="center"><strong>Connects to</strong></td>
    <td align="center">GitHub</td>
    <td align="center">Linear</td>
    <td align="center">Jira</td>
    <td align="center">Asana</td>
  </tr>
  <tr>
    <td align="center"><strong>Models from</strong></td>
    <td align="center">Amazon Bedrock</td>
    <td align="center">OpenRouter</td>
    <td align="center">Anthropic</td>
    <td align="center">OpenAI</td>
  </tr>
</table>

<em>Plus any other remote MCP server, such as Sentry or PagerDuty.</em>

</div>

<br/>

## Rovara is right for you if

- ✅ You want a coding agent your **whole team can use from Slack**, without anyone's laptop staying on
- ✅ You want every task to run on **its own isolated machine**, not on a developer's computer
- ✅ You want the agent, its code and its credentials **inside your own AWS account**
- ✅ You want a thread to **pick up where it left off**, with its files and conversation intact
- ✅ You want each run to end with a **check report**, not just the agent's word that it's done
- ✅ You use Claude Code, Codex or Cursor and want to **hand off long tasks** and share them with the team
- ✅ You want **a person to review and merge** every pull request

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🧵 One thread, one workspace</h3>
Each Slack thread owns its own EC2 worker and encrypted EBS volume. Threads run in parallel; requests in one thread run in order.
</td>
<td align="center" width="33%">
<h3>💾 Persistent workspaces</h3>
Files and conversation live on the thread's volume. The idle reaper stops compute and keeps the disk, so the next mention resumes.
</td>
<td align="center" width="33%">
<h3>📋 Check report</h3>
When the agent finishes, Rovara reruns the project's readiness checks, or the agent's own test commands, and <a href="docs/how-it-works.md#what-the-check-report-means">reports what passed, failed, or could not be verified</a>.
</td>
</tr>
<tr>
<td align="center">
<h3>🔀 Pull requests for review</h3>
Opens and maintains PRs. Configured <a href="docs/pull-requests.md#configure-codebuild-gates">CodeBuild gates</a> run against the candidate commit. A person merges; Rovara never force-pushes.
</td>
<td align="center">
<h3>🔒 Isolated coding worker</h3>
The Slack orchestrator has no shell or file tools. All coding happens in the remote worker, inside that thread's workspace.
</td>
<td align="center">
<h3>🛡️ Action gate</h3>
Reads run. Closing, deleting, merging and large changes ask first, with <strong>Approve</strong> and <strong>Cancel</strong> buttons. <a href="docs/slack.md#actions-that-need-your-confirmation">Administrators add their own rules.</a>
</td>
</tr>
<tr>
<td align="center">
<h3>🔌 Connectors</h3>
GitHub (through GitHub's MCP server), Linear, Jira, Asana, or <a href="docs/connectors/custom-mcp.md">any other remote MCP server</a>. Only the tools a project approves are offered.
</td>
<td align="center">
<h3>🤖 From your AI tool</h3>
<code>agentx mcp</code> gives Claude Code, Codex or Cursor <a href="docs/mcp-install.md">11 tools</a> to start, check, continue and share Rovara tasks.
</td>
<td align="center">
<h3>🧠 Your choice of model</h3>
Bedrock by default, or <a href="docs/openrouter.md">OpenRouter</a>, or <a href="docs/model-providers.md">your own Anthropic or OpenAI key</a>. <code>@agentx use Fast</code> switches models per project.
</td>
</tr>
<tr>
<td align="center">
<h3>🏗️ Guided install</h3>
<code>agentx init</code> shows what it will create and an estimated monthly cost first, and resumes where it stopped. <code>upgrade</code>, <code>doctor</code> and <code>destroy</code> handle day 2.
</td>
<td align="center">
<h3>📦 Dev containers</h3>
A project can name a devcontainer. It runs on the worker's own Docker, with the workspace mounted at the same path.
</td>
<td align="center">
<h3>🔎 Audit trail</h3>
Every turn leaves a record of the tools called and why. A <strong>Details</strong> button shows it in Slack; <code>agentx admin turns export</code> exports it.
</td>
</tr>
</table>

<br/>

## Problems Rovara solves

| Without Rovara                                                                                       | With Rovara                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ❌ A coding agent only runs while someone's laptop is open, and only that person can see it.          | ✅ It runs in your AWS account. Anyone in the channel can follow the thread and steer it.                            |
| ❌ Two tasks on one checkout trip over each other's changes.                                          | ✅ Every thread has its own machine and disk.                                                                        |
| ❌ Picking a task back up next week means rebuilding the context by hand.                             | ✅ The thread's files and conversation are still on its volume. Mention it again and it carries on.                  |
| ❌ The agent says "all tests pass" and you can't tell whether it ran any.                             | ✅ Rovara reruns the checks itself and reports what passed, failed, or could not be verified.                        |
| ❌ Handing an agent your GitHub token and hoping it doesn't close the wrong issue.                    | ✅ Tokens stay in the control plane, and destructive actions wait for the requester to approve them.                 |
| ❌ Idle cloud machines quietly run up the bill.                                                       | ✅ The idle reaper stops compute and keeps the disk. Per-member and per-organization limits cap open workspaces.     |

<br/>

## Why Rovara is different

|                                         |                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Check outcomes, stated plainly.**     | A run with no usable checks, or one that stops before verification, is reported as not verified, never as passing.                     |
| **A person merges.**                    | Rovara can open, update, replace and revert pull requests. It has no merge path.                                                        |
| **The orchestrator can't touch code.**  | The hosted Slack agent has orchestration and approved connector tools only. Source, edits and shell live in the remote worker.         |
| **Credentials never reach the worker.** | The GitHub App key stays in Secrets Manager. Rovara mints short-lived, single-repository tokens for each clone, push and PR.           |
| **Tool output can't approve itself.**   | The model that checks a change sees only the members' messages and the call, never what a tool returned.                                |
| **Memory fails closed.**                | If a thread's volume is lost, the next request fails with `CONVERSATION_STATE_LOST` instead of starting over on files it doesn't know. |
| **Fenced closure.**                     | Closing a workspace is refused while it holds uncommitted, untracked or unpushed work.                                                  |

<br/>

## What's under the hood

```
 Slack thread                         Claude Code · Codex · Cursor
      │                                          │  agentx mcp
      ▼                                          ▼
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│ Slack ingress (Lambda)  │        │            CONTROL PLANE             │
│   → SQS → Slack service │──────▶ │                                      │
│     (ECS Fargate)       │        │  ┌──────────┐ ┌──────────┐ ┌───────┐ │
│                         │        │  │  Broker  │ │Connector │ │  PRs  │ │
│  Hosted Pi orchestrator │        │  │   API    │ │ gateway  │ │& gates│ │
│  + action gate          │        │  └──────────┘ └──────────┘ └───────┘ │
│  no shell, no files     │        │  ┌──────────┐ ┌──────────┐ ┌───────┐ │
└─────────────────────────┘        │  │Dispatcher│ │ Session  │ │ Idle  │ │
                                   │  │  & queue │ │ manager  │ │reaper │ │
                                   │  └──────────┘ └──────────┘ └───────┘ │
                                   └──────────────────┬───────────────────┘
                                                      │ signed invocation
                        ┌─────────────────────────────┼─────────────────────────────┐
                        ▼                             ▼                             ▼
                 ┌─────────────┐               ┌─────────────┐               ┌─────────────┐
                 │ EC2 worker  │               │ EC2 worker  │               │ EC2 worker  │
                 │ Pi coding   │               │ Pi coding   │               │ Pi coding   │
                 │ agent       │               │ agent       │               │ agent       │
                 ├─────────────┤               ├─────────────┤               ├─────────────┤
                 │ EBS volume  │               │ EBS volume  │               │ EBS volume  │
                 └─────────────┘               └─────────────┘               └─────────────┘
                    thread A                      thread B                   task from Cursor
```

### The systems

<table>
<tr>
<td width="50%">

**Slack service** (`packages/slack-service`, `packages/orchestrator`): An ingress Lambda verifies
Slack's signature and queues the request. An ECS Fargate service runs the Pi orchestrator for the
thread, applies the action gate, and posts the reply. [Working in Slack](docs/slack.md)

</td>
<td width="50%">

**Control plane** (`packages/broker`): The API behind everything: projects and revisions,
workspaces, operations, callbacks, pull requests, CodeBuild gates and turn records, with state in
DynamoDB. [Production architecture](docs/architecture-production.md)

</td>
</tr>
<tr>
<td>

**Coding worker** (`packages/worker`): Runs the Pi coding agent on an EC2 instance with an
encrypted EBS workspace. Loads each repository's `AGENTS.md` or `CLAUDE.md`, runs the
verification extension that produces the check report, and records usage for every task.
[How Rovara works](docs/how-it-works.md)

</td>
<td>

**Session lifecycle**: The dispatcher signs each invocation; the session manager and Step
Functions provision, resume and delete workers; the idle reaper stops compute and keeps the volume;
the reconciler cleans up stuck cancels.

</td>
</tr>
<tr>
<td>

**Connector gateway** (`packages/gateway`): One definition per connector type (GitHub, Linear,
Jira, Asana and generic MCP). Discovers vendor tools, offers only approved ones, fills
server-bound arguments and keeps credentials out of the model's reach.
[Connector credentials](docs/slack.md#connector-credentials)

</td>
<td>

**Developer MCP server** (`packages/mcp`): `agentx mcp` lets a signed-in developer's AI tool list
projects, start and continue tasks, share them to Slack and open pull requests.
[Use Rovara from your AI tool](docs/mcp-install.md)

</td>
</tr>
<tr>
<td>

**CLI and installer** (`packages/cli`): `agentx init`, `upgrade`, `config`, `doctor`, `destroy`,
project, channel and connector setup, developer sign-in, and every admin command.
[Administration client](docs/administration.md)

</td>
<td>

**Infrastructure** (`infra`, `packages/model-runtime`, `packages/contracts`): CDK stacks and
published CloudFormation templates, the model catalog and provider settings, and the shared
contracts every component validates against.

</td>
</tr>
</table>

<br/>

## What Rovara is not

|                                       |                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Not proof that the code works.**    | The check report says what the available checks showed. It is not proof that a change is correct.       |
| **Not an auto-merger.**               | It opens and maintains pull requests. A person reviews and merges them.                                  |
| **Not a hosted service.**             | You install it in your AWS account. There is no Rovara account to sign up for.                           |
| **Not a local agent.**                | Nothing runs on a developer's machine except the CLI. The old local and Socket Mode modes are retired.   |
| **Not an agent framework.**           | It runs the Pi coding agent for you. It doesn't ask you to build one.                                    |

<br/>

## Quickstart

### What you need

- An AWS account where you can create IAM roles, ideally one used only for Rovara
- A GitHub organization or personal account to own Rovara's GitHub App
- A Slack workspace where you can create and install apps
- Model access: Amazon Bedrock in your region, or an OpenRouter, Anthropic or OpenAI API key

### Install

<p align="center">
  <a href="https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate?templateURL=https%3A%2F%2Frovara-installer-us-east-1.s3.us-east-1.amazonaws.com%2Flatest%2Finstaller.template.json&amp;stackName=agentx-installer"><img src="docs/assets/launch-in-aws.svg" alt="Launch in AWS" width="232" height="52" /></a>
</p>

Press the button, enter your email, your GitHub owner and an install name, and press Create stack.
An email with your temporary password and the setup page's address arrives in about five minutes.
The setup page asks everything else: it builds Rovara in your account, then connects GitHub and
Slack and ends at the bot's first reply in your channel. Nothing is installed on your computer.

To install from a terminal instead, with Node.js 22.19 or newer (Node 22 LTS recommended):

```bash
export AWS_PROFILE=<an admin profile for the target account>
npx @preplabsai/rovara-code init --env <name>
```

On your own computer, `init` opens an install page in your browser (served only from `127.0.0.1`).
Pass `--no-ui` to stay in the terminal. See [Installing Rovara](docs/install.md) for both ways, and
[Other ways to install](docs/install-advanced.md) for the CDK, a platform team, or a source checkout.

### Use it

In the bound channel:

```text
@AgentX Add password reset to the account page
```

A plain `@AgentX` request starts a task. AgentX asks in the thread how to handle it:

- **Quick**: AgentX writes a short coding plan for you to approve, then codes it, runs the checks
  and reviews, and opens a draft pull request.
- **Full**: AgentX writes requirements, then a design, then a coding plan, and you approve each one
  before any code changes.

Press a button, or reply `quick` or `full` in the thread (only the person who asked can choose). To
skip the question, start the request with the path: `@AgentX quick: fix the typo on the pricing page`
or `@AgentX full: add single sign-on`. When approving the coding plan, the task owner can choose
extra project-approved checks; required project readiness checks are always included.

To talk to the chat agent instead, start the request with `chat:`:

```text
@AgentX chat: inspect the project and implement the navigation fix. Run the relevant tests.
@AgentX chat: create a pull request for the personal-website repository titled "Improve navigation".
```

In a thread the chat agent is already answering, mention AgentX as before (no `chat:` needed), for
example `@AgentX stop` or `@AgentX close this workspace`.

> **Changed:** a plain top-level `@AgentX <request>` used to go to the chat agent. It now starts a
> task with the Quick or Full question in every bound channel. Add `chat:` to reach the chat agent.

Every reply in a task's thread, from the owner or a teammate, is saved for the task's next step.
Only the owner's buttons move the task on. After the coding plan is approved, the checks and reviews
run on their own. If a review finds a problem, the owner can press **Send back to coding**. When
everything passes, AgentX opens a draft pull request and posts the link in the thread.

> **Reinstall the Slack app on an existing install.** Saving replies that do not mention AgentX
> needs the `channels:history` and `groups:history` bot scopes and the `message.channels` and
> `message.groups` events. Update the app from the manifest `agentx init` generates, then reinstall
> it to the workspace. Until then only `@AgentX` replies are saved. AgentX ignores channel messages
> outside task threads. See [Replies in a Slack task's thread](docs/project-configuration.md#replies-in-a-slack-tasks-thread).

From your own machine (no AWS credentials needed):

```bash
agentx login <control plane URL>
agentx mcp install --client claude-code   # or codex, cursor
```

After the install, `agentx --env <name> project add`, `channel add` and
`connector add linear|jira|asana|mcp` add more, and `doctor`, `config`, `upgrade` and `destroy` run
the environment. See [the install overview](docs/getting-started.md) for the full tour.

<br/>

## FAQ

**Q: Does Rovara verify that the change is correct?**

**A:** No. It reruns the checks it has (the project's readiness commands, or recognized test
commands the agent ran) and reports what passed, failed, timed out, or could not be verified. A task
with no usable checks is reported as not verified. A person reviews the pull request.
[What the check report means](docs/how-it-works.md#what-the-check-report-means)

<br/>

**Q: Do developers need AWS access?**

**A:** No. Developers sign in with Slack, your company's sign-in (OIDC), or both. Only the
installer and day-2 operators use AWS credentials.

<br/>

**Q: What does it cost to run?**

**A:** AWS and model charges depend on your configuration and use. `agentx init` prints an
estimated monthly cost before it creates anything and sets a monthly budget with an alert. Idle
workspaces stop their compute and keep only their disk. By default each member can hold 3
workspaces and the organization 20.

<br/>

**Q: Where does my code go?**

**A:** Onto EBS volumes in your AWS account, attached to workers in private subnets. The model
provider you choose sees the prompts. Turn records keep redacted tool calls for 30 days; tokens,
request text and response text are never written to CloudWatch Logs.

<br/>

**Q: What happens when a thread goes quiet?**

**A:** The idle reaper stops the instance. The volume, with the thread's files and conversation,
stays. The next mention starts compute again and carries on.

<br/>

**Q: Can I use it without Slack?**

**A:** Developers can start and drive tasks from Claude Code, Codex or Cursor through
`agentx mcp`, and share them into Slack when they want the team to see. Administration happens in
the `agentx` CLI.

<br/>

## Documentation

| Guide                                                         | What it covers                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Install overview](docs/getting-started.md)                   | `init`, day-2 commands and developer sign-in on one page                       |
| [Installing Rovara](docs/install.md)                          | Published templates, CDK, platform-team export, CloudShell                     |
| [Running Rovara](docs/day-two.md)                             | The operator role, `doctor`, `upgrade`, `config`, projects and connectors      |
| [How Rovara works](docs/how-it-works.md)                      | Request path, the check report, context files, usage records, stack names     |
| [Production architecture](docs/architecture-production.md)    | EC2 workers, EBS, networking, devcontainers, isolation and release             |
| [Working in Slack](docs/slack.md)                             | Threads, connectors, confirmations, shared tasks, memory, diagnostics         |
| [Administration client](docs/administration.md)               | Registering projects, binding channels, the full command surface              |
| [Project configuration](docs/project-configuration.md)        | Every field of a project file, and how the checks work                         |
| [Pull requests](docs/pull-requests.md)                        | Publication, maintenance, GitHub App permissions, CodeBuild gates              |
| [Use Rovara from your AI tool](docs/mcp-install.md)           | `agentx mcp` for Claude Code, Codex and Cursor, and sharing to Slack           |
| [Model providers](docs/openrouter.md) · [your own key](docs/model-providers.md) | Bedrock, OpenRouter, Anthropic and OpenAI                     |
| Connectors: [Linear](docs/connectors/linear.md) · [Jira](docs/connectors/jira.md) · [Asana](docs/connectors/asana.md) · [any MCP server](docs/connectors/custom-mcp.md) | Credentials and setup per connector |
| [SWE-bench evals](docs/swebench-eval.md)                      | Running SWE-bench tasks against the coding agent from Slack                    |
| [Removing an environment](docs/teardown.md) · [Moving accounts](docs/move-account.md) | Teardown and migration                                 |
| [Releases](docs/releases.md) · [npm package](docs/npm-package.md) | What a release contains, how one is cut, and the published package         |
| [Maintainers' production release](docs/maintainers-release.md) | The maintainers' own deployment and release pipeline                         |

<br/>

## Development

```bash
npm ci
npm run build          # Build every package
npm run typecheck      # Type-check the packages
npm run typecheck:all  # Also tests/ and scripts/, against tests/typecheck-baseline.json
npm run lint           # ESLint
npm test               # Vitest (no Docker or AWS needed)
npm run infra:synth    # Synthesize the CDK app
```

See [Developing Rovara](docs/development.md) for the typecheck baseline, the spec documents and the
GitHub Spec Kit setup.

<br/>

## Roadmap

- ✅ Hosted Slack orchestrator with one workspace per thread
- ✅ EC2 workers with persistent EBS volumes, idle reaper and reconciler
- ✅ Check report: readiness checks or replayed test commands, rerun after the agent finishes
- ✅ Pull-request lifecycle: create, append, sync, replace and revert
- ✅ CodeBuild gates on the candidate commit
- ✅ GitHub MCP, Linear, Jira, Asana and generic MCP connectors
- ✅ Action gate with confirmations, rules and a **Details** view
- ✅ Conversation continuity across turns
- ✅ `agentx init` installer, with `upgrade`, `config`, `doctor` and `destroy`
- ✅ Developer sign-in and tasks from Claude Code, Codex and Cursor
- ✅ Sharing tasks into Slack, view only or open to the channel
- ✅ Dev containers
- ✅ Per-project model choice: Bedrock, OpenRouter, Anthropic and OpenAI
- 🟡 Install page in the browser (phase 1 built; phases 2 to 4 next)
- ⚪ Admin tools for AI tools: reading Rovara's state (spec 025 phase 25d) and confirmed changes (25e)
- ⚪ Multi-repository change sets that test and publish several repositories together
- ⚪ First public release on npm and a public image registry

<br/>

## Contributing and security

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

<br/>

## License

Licensed under the [MIT License](LICENSE). PrepLabsAI also preserves its prior Apache 2.0 grant for
PrepLabsAI-owned Rovara work, including earlier releases; see [RELICENSED.md](RELICENSED.md).
Third-party components retain their own licenses.
&copy; 2026 PrepLabs

---

<p align="center">
  <sub>The open-source alternative to Claude Tag!</sub>
</p>
