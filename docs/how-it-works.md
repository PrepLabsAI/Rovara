# How Rovara works

The request path, the two Pi roles, what the worker reads from your repositories, the check report, usage records, and how stacks are named.

> **Naming:** Rovara was called AgentX. Commands, AWS resource names, paths, tool names and the
> default Slack app name still use `agentx` or `AgentX` (for example `agentx init`,
> `AgentXControlPlane`, `~/.agentx` and `@AgentX`), so every command in these docs works as written.

```text
Slack thread -> hosted Pi orchestrator -> Rovara control plane -> remote Pi coding worker
                                                              -> approved GitHub MCP tools
AI tool (Claude Code, Codex, Cursor) -> agentx mcp -> Rovara developer task API -> remote Pi coding worker
```

The hosted Pi session is an orchestration-only client. It has Rovara control-plane and approved
MCP tools but no source, file-editing, or shell tools. The remote Pi session owns the coding loop
and exposes `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` inside that thread's
workspace.
Rovara wraps remote Pi only to provide authentication, workspace allocation, operation fencing,
durable callbacks, and Git/tool-evidence artifacts. The `agentx` executable administers
environments and projects. Its `agentx mcp` server also lets a signed-in developer's AI tool hand
coding tasks to Rovara through the developer task API. Every other coding operation must come from
the orchestrator's service identity; the control plane refuses it otherwise.

The remote session runs at the workspace root, above the repositories, so Pi's own context-file
discovery never reaches them. Rovara therefore adds its own workspace note first, listing each
prepared repository and where it is checked out, and telling the model to make each change inside
the repository it belongs to. For each prepared repository the worker then loads the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` that exists in the
repository root, and adds it to the session context labelled with that repository's name and
workspace path. The files are read again for every task, so an edited one applies to the next
task. A file that resolves outside its repository or exceeds 64 KiB is skipped and reported as a
progress event.

Every remote coding task also publishes a redacted `usage` operation event and private
`usage.json` artifact. They record the task outcome, actual Pi provider and model, prompt-cache
retention mode, input/output/cache token counts, cache-read ratio, and Pi's estimated cost. The
runtime stack (`AgentXProductionRuntime` in the maintainers' deployment, `agentx-<env>-runtime` in
an installed one) exposes `PromptCacheRetention` as a CloudFormation parameter with `short` and
`long` values; it defaults to `long` so Bedrock cache entries can survive normal gaps between
Slack turns.

Admin usage (`GET /v1/admin/usage` and `agentx_admin_usage`) includes uncached input, cache reads
and cache writes in its input-token total; output and provider cost stay separate. Existing Slack
turn records retain those categories and are counted in full. Worker usage index rows written
before the #220 fix retain their stored uncached-input count: the cache breakdown was discarded,
so historical worker totals can still undercount. No backfill or token estimate from cost is made.

Both roles currently use `@earendil-works/pi-coding-agent` 1.0.0. GitHub Spec Kit supplies the
specification workflow and demo repository; it is not the coding-agent runtime.

See the [production architecture](architecture-production.md) for the EBS-backed platform,
its request path, and how environments are installed and torn down.

## What the check report means

The worker installs Rovara's verification extension in both new and resumed coding sessions.
When the coding agent finishes normally, Rovara reruns configured project readiness checks; if
there are none, it may replay recognized test commands the agent ran. A regression can receive
one additional coding attempt. The report distinguishes checks that passed, failed, timed out, or
could not be verified. A task with no usable checks, or one that stops before reaching verification,
is not described as verified. This is a report about those checks, not proof that the change is
correct.

At pull-request creation, the current reporting-enabled broker path can include readiness results
and open a draft PR when checks fail. A broker that does not send the reporting flag still refuses
failed readiness checks before opening a PR. Configured CodeBuild gates run against the candidate
commit; this does not mean every task-time check is rerun against the exact PR commit. Rovara
cannot merge a pull request.

## Current status

Every new workspace uses `ec2-ebs`, including self-hosted installs. Each Slack thread gets an
isolated EC2 worker and encrypted EBS volume. The session manager provisions and resumes workers;
the idle reaper stops compute while preserving workspace files and conversation state.

Closed workspace and operation records and historical project revisions remain readable. Retired
deployment modes cannot register projects or execute work. Start a new Slack thread against an
EC2 project revision for new work.

What is built today:

- **The installer.** `agentx init` installs a complete environment in your own AWS account. Then
  `project add`, `channel add` and `connector add` add more projects, channels and connectors:
  Linear, Jira, Asana, or any other remote MCP server.
- **Day-2 commands.** `agentx config`, `doctor`, `upgrade` (and `upgrade --export` for a platform
  team's pipeline) and `destroy` run and remove an installed environment.
- **Developer sign-in.** Developers sign in with Slack, your company's sign-in, or both, with
  `agentx login <url>`. They need no AWS credentials.
- **Tasks from an AI tool.** `agentx mcp install` adds Rovara to Claude Code, Codex or Cursor, and
  `agentx mcp` gives that tool 11 Rovara tools. With them it lists the projects the developer may
  use, starts, checks, continues, shares, cancels and closes coding tasks, and opens pull requests.
- **Sharing to Slack.** A developer can share a task into the project's Slack channel, view only
  or open to the channel ("continue"). A project can require sharing, and an administrator can
  switch a shared task's mode with `agentx admin task share-mode`.

Not built yet:

- Admin tools for AI tools: reading Rovara's state (spec 025 phase 25d) and making confirmed
  changes (phase 25e).

No Rovara release is published yet; see [releases](releases.md).

## Stack names

An installed environment's stacks are named `agentx-<env>-access`, `-foundation`, `-identity`,
`-runtime`, `-control-plane` and `-slack`. Its alarms are named `agentx-<env>-<Name>`, and its
connector secrets live under `agentx/<env>/connectors/`. The maintainers' own deployment predates
the installer and keeps fixed names: `AgentXProductionFoundation`, `AgentXProductionRuntime`,
`AgentXControlPlane` and `AgentXSlackOrchestrator`, with no access or identity stack. Where these
docs name an `AgentX...` stack or a stack parameter, it means the maintainers' deployment; in
your environment, use the matching `agentx-<env>-...` stack, or `agentx config` where a key exists.
