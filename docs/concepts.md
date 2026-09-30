# Concepts

AgentX is source-available. You install it in your own AWS account. Developers use it from Slack,
or hand it tasks from their AI tool (Claude Code, Codex or Cursor). This page explains the parts
you meet when you use it. To install it, see the [quickstart](quickstart.md) and
[Installing AgentX](install.md).

```text
Slack thread -> hosted Pi orchestrator -> AgentX control plane -> remote Pi coding worker
                                                              -> approved GitHub MCP tools
AI tool (Claude Code, Codex, Cursor) -> agentx mcp -> AgentX developer task API -> remote Pi coding worker
```

## Environments

An **environment** is one AgentX install in an AWS account, made by `agentx init`. It has a name,
such as `prod`, and every command takes it as `--env <env>`. Its stacks are named
`agentx-<env>-access`, `-foundation`, `-identity`, `-runtime`, `-control-plane` and `-slack`.
AgentX recommends a dedicated AWS account for each install: environments that share an account
are not a security boundary against each other.

The install needs admin credentials. After that, day-2 commands such as `doctor`, `upgrade` and
`config` run with the narrower operator role the install created, `agentx-<env>-operator`.
Removing an environment needs admin credentials again. See [Running AgentX](day-two.md),
[Removing an environment](teardown.md) and [moving AgentX to another AWS account](move-account.md).

## The orchestrator and the worker

AgentX runs two Pi sessions with different jobs.

The **orchestrator** is hosted in your AWS account, so no developer machine has to stay online.
Slack calls the AgentX Events API route. An ingress Lambda verifies Slack's signature,
acknowledges in the thread and queues the request. An ECS Fargate service runs the orchestrator
for that thread and posts the result back. The orchestrator only orchestrates: it has AgentX
control-plane tools and administrator-approved MCP tools, but no source, file-editing or shell
tools.

The **worker** owns the coding loop. It runs on an EC2 instance with a persistent, encrypted EBS
volume, and exposes `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` inside that
workspace. AgentX wraps the worker only to provide authentication, workspace allocation,
operation fencing, durable callbacks, and Git and tool-evidence artifacts.

The worker session runs at the workspace root, above the repositories. AgentX first adds its own
workspace note. It lists each prepared repository and where it is checked out, and tells the model
to make each change inside the repository it belongs to. For each prepared repository the worker
then loads the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and
`CLAUDE.MD` found in the repository root, labelled with that repository's name and path. The files
are read again for every task, so an edited one applies to the next task. A file that resolves
outside its repository or exceeds 64 KiB is skipped and reported as a progress event.

Every coding task publishes a redacted `usage` event and a private `usage.json` artifact. They
record the outcome, the actual provider and model, token counts, the cache-read ratio and Pi's
estimated cost.

The `agentx` executable administers environments and projects. Its `agentx mcp` server also lets a
signed-in developer's AI tool hand coding tasks to AgentX through the developer task API. The
control plane refuses every other coding operation that does not come from the orchestrator's
service identity. See the [CLI reference](cli.md).

## Projects, revisions and channels

A **project** describes a product: its repositories, setup steps, readiness checks, CodeBuild
gates and orchestrator instructions. It can also name the models a channel may choose from, the
connectors the orchestrator may use, rules for which tool calls need confirmation, and how the
project treats tasks from AI tools (`developerTasks`). It lives in a YAML file and holds no
workspace ID, session ID, token or repository secret. In an installed environment,
`agentx project add` writes the file and registers it. See
[project configuration](project-configuration.md) and the examples in
[`../examples/projects/`](../examples/projects/).

An administrator registers the project as a **revision**. Revisions are immutable: increment the
YAML `revision` before registering a changed repository, setup or readiness definition.

A Slack **channel** is bound to one project, not to a revision. Each new thread uses the project's
latest registered revision at the moment its workspace is created. So registering a revision
publishes it to every bound channel without binding again. `admin slack unbind` removes the
binding: new mentions in that channel are ignored, but existing thread workspaces stay.

An existing thread's checkout stays on the revision it was prepared with. `repositories`, `setup`
and `environment` do not change under a running thread. Everything else follows the latest
revision from the next mention onwards: the GitHub MCP policy, `orchestratorInstructions`,
`readiness` and each repository's `codeBuildGates`. The thread is told once that its settings
moved, and each operation and MCP call records the revision whose settings applied.

## One thread, one workspace

Each Slack thread has its own isolated workspace: its own EC2 worker and encrypted EBS volume.
Later mentions in that thread, by any channel member, continue in the same workspace and the same
conversation. Requests in one thread run in order. Different threads run in parallel.

A thread gets a workspace only when a request first needs the worker, for example to read or
change repository files or to run commands. Questions that connectors answer need no workspace.
Preparing a workspace takes a few minutes, and AgentX says so in the thread.

The idle reaper stops compute while keeping the workspace files and conversation state. An
administrator can also stop idle compute with `agentx admin workspace stop`. The EBS volume
remains for the next session.

Workspaces are limited to protect cost. Threads whose workspace has been prepared count, and so do
open tasks from AI tools: both share the same limits. The member whose request first prepared a
thread's workspace is charged for it. Each member may hold at most 3 workspaces and the
organization at most 20. When a request needs a workspace over either limit, AgentX prepares
nothing and says which limit was reached. It still answers any part of the request that
connectors can answer. In an installed environment, `agentx --env <env> config get
limits.workspacesPerMember` (or `limits.workspacesPerOrg`) shows the limits. `config set` cannot
change them yet: spec 025 phase 25e adds the way to change them. See [costs](costs.md).

`@AgentX close this workspace` releases a workspace. AgentX first checks every prepared
repository. Uncommitted changes, untracked files, an unpushed current commit, or commits on a
local-only branch block closure, and AgentX lists the affected repositories. A running
preparation, task, publication, maintenance, resume or cancellation also blocks closure until it
finishes. A clean workspace has its EC2 instance terminated and its EBS volume deleted. The
workspace and operation records are kept as audit history. Later mentions in a closed thread do
not create another workspace: start a new thread for fresh work.

## Tasks from an AI tool

A developer signs in with Slack, your company's sign-in, or both, with `agentx login <url>`. They
need no AWS credentials. `agentx mcp install` adds AgentX to Claude Code, Codex or Cursor, and
`agentx mcp` gives that tool 11 AgentX tools. With them the tool lists the projects the developer
may use, starts, checks, continues, shares, cancels and closes coding tasks, and opens pull
requests.

Each task owns its own isolated, persistent workspace, the same kind a Slack thread gets. A task
keeps its workspace until the developer closes it, and open tasks count against the same limits
as Slack threads. A task's workspace setup that is still running after 50 minutes is marked
failed; the task then reads `setup_failed`, and closing it frees its place in the limits.

A task is private unless it is shared. For a private task, only the developer sees its title,
instructions, progress and results. Others who can use the project see only that a workspace
exists, with its status and times, in `agentx workspaces`. Every action is recorded for your
admins.

A project's `developerTasks` settings decide whether developers may start tasks on it from an AI
tool. Today a developer can use a project from an AI tool when they are a member of one of its
bound Slack channels. Direct grants by an admin arrive with spec 025 phase 25e. See
[Developer tasks](project-configuration.md#developer-tasks) and
[Use AgentX from Claude Code, Codex or Cursor](mcp-install.md).

## Sharing a task to Slack

A developer can share a task into one of its project's bound Slack channels, when it starts or
later. AgentX posts a new thread that names who started the task, from which AI tool, its title,
the project and its status. It then posts when the workspace is ready, when the task ends (with
the worker's summary), when a pull request opens, when the mode changes, and when the task is
closed. It never posts the developer's instructions.

There are two modes:

- **View only** (`view`): channel members follow the task, and the developer drives it from their
  AI tool. A mention in the thread gets a notice instead of running.
- **Continue** (`continue`): channel members can also mention AgentX in the thread to steer the
  task on the same workspace, one request at a time, each attributed to the member who sent it.

The project's `developerTasks` settings decide what is allowed: whether every task must be shared,
the default mode, and whether continue is allowed. A shared task's channel cannot change, and a
shared task cannot be made private again. An administrator can switch a shared task's mode,
within those settings, with `agentx --env <env> admin task share-mode`. Sharing is available only
in environments installed with `agentx init`. See
[Sharing a task to Slack](mcp-install.md#sharing-a-task-to-slack).

## What a thread remembers

Each Slack thread owns one conversation, and every request in it continues that conversation. The
transcript lives on the thread's workspace volume next to its files, so a follow-up sees both the
earlier discussion and the earlier edits. It survives a client disconnect and reconnect, and the
replacement of the worker process, because neither touches the volume.

It does not survive losing the volume. If the workspace is replaced, the next request fails with
`CONVERSATION_STATE_LOST` rather than starting over on top of files it has no memory of. Start a
new thread to continue. There is no promised retention period beyond the life of the workspace and
its EBS volume.

If the deployed model changes between turns, the thread keeps its transcript and AgentX says which
model it continues on. Closing a thread's workspace ends its conversation with it.

## Readiness checks and CodeBuild gates

Two kinds of check stand between a change and a pull request.

**Readiness checks** are the project's `readiness` commands. They run inside the workspace before
any candidate is pushed. A failure stops the publication. A readiness command whose directory the
workspace does not have fails that check rather than being skipped.

**CodeBuild gates** are optional, per repository. They run remotely in AWS CodeBuild against the
exact pushed commit. CodeBuild projects are administrator-owned infrastructure, and their names
must begin with `agentx-`. Unit tests, integration tests and Playwright commands belong in the
CodeBuild project's buildspec. AgentX supplies only the Git commit; the worker cannot override the
buildspec, image, role, environment, source or artifacts, and it receives no CodeBuild AWS
credentials.

A failed build for a new pull request leaves its candidate branch for diagnosis but creates no pull
request. A failed build for an existing pull request leaves its head unchanged. Gates cover one
repository publication at a time. See
[Configure CodeBuild gates](../README.md#configure-codebuild-gates).

## How a pull request is made

Pull-request creation is explicit. AgentX never publishes on its own after a coding task. In
Slack, you ask for it in the thread, naming the repository by its project YAML `name`. From an AI
tool, you ask the tool to open a pull request when the task is ready.

AgentX then:

1. runs the readiness checks in the workspace;
2. rejects an empty diff, merge conflicts, or any failed or timed-out check;
3. replays the intended workspace tree onto the latest remote default branch as exactly one
   commit, on a new `agentx/<operation-id>` branch;
4. pushes without force, and runs any CodeBuild gates against that commit;
5. creates a ready-for-review pull request against the repository's `defaultBranch`.

The result includes the pull request URL and number, the commit, the head and base branches and
the check evidence. Repeating the same accepted request reconciles the existing branch and pull
request rather than creating a duplicate. A pull request created from a thread ends with a link to
the thread and the Slack members who made requests in it.

From the same thread you can maintain an AgentX-owned pull request by naming the repository and
pull request number: append new commits, sync the base branch into it, edit its title or body,
close or reopen it, replace it with clean history, or ask for a revert pull request once it is
merged. Neither append nor sync rebases or force-pushes published history. Only pull requests with
durable AgentX ownership evidence are eligible.

The GitHub App private key stays in Secrets Manager and is never sent to the worker. AgentX mints
short-lived, single-repository tokens separately for clone, push and pull request operations. See
[security](security.md).

### What AgentX never does

AgentX does not merge, approve, delete branches, add reviewers or labels, or force-push. The worker
rejects force flags, force-with-lease flags and plus-prefixed refspecs at the credentialed Git
command boundary.
