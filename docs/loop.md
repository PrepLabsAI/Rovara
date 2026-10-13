# Rovara loop: Rovara's workflow, run locally by your own agent

`rovara loop` runs on your own computer. It turns comments on your GitHub issues into work for your own
**Claude Code**, and drives that work through a loop. It needs no Rovara install and no AWS account: only
the Rovara CLI, the GitHub CLI (`gh`, signed in), `tmux`, `git` and Claude Code.

> **Status:** the first loop, **Do**, is here. Quick and Full (with approval gates), reviews before a
> human is asked, and per-PR loops follow ([design, #354](https://github.com/PrepLabsAI/Rovara/issues/354)).

The idea is inspired by [the-loop](https://github.com/MadaraUchiha-314/the-loop) by Rohith Ramakrishnan:
an agent's work driven through a declared process, from your issue tracker. Rovara loop is Rovara's own
implementation, with Rovara's own loops and words.

## Set up a repository

In a checkout of the repository:

```bash
npx @preplabsai/rovara-code loop init     # writes .rovara/loop.yaml, with you as its one collaborator
git add .rovara/loop.yaml && git commit -m "chore: rovara loop config"
npx @preplabsai/rovara-code loop add      # lets the loop read this repository's issues
npx @preplabsai/rovara-code loop start    # runs the daemon in the background
```

`.rovara/loop.yaml` says who the loop obeys:

```yaml
version: 1
collaborators:      # the only GitHub logins whose comments start, steer or stop a loop
  - maya
  - sam
harness:
  name: claude-code
  args: []          # extra Claude Code arguments, such as a permission mode
```

Comments from anyone else are never read as instructions. Comments the loop posts carry a hidden marker,
so it never mistakes its own words for a command.

## The Do loop

Comment on an issue (or a pull request):

```text
/rovara do Fix the flaky retry test in the payments client
```

You can also start one from the terminal: `rovara loop do --issue 42 "Fix the flaky retry test"`.

| What happens | The issue shows |
|---|---|
| Claude Code starts in its own git worktree, on branch `rovara/<issue>`, in tmux session `rovara-<owner>_<repo>-<issue>` | `rovara:working`, and a comment saying how to watch it |
| When it's done, or needs you, it posts a summary | `rovara:waiting` |
| Every reply you post goes to it as its next instruction | `rovara:working` |
| Closing the issue, or `/rovara stop`, ends the loop and its session; the branch is kept | no label |

The Do loop has no gates, and it **never pushes or opens a pull request**: it commits on its branch, and
you take it from there.

## Watching and answering the agent

Claude Code runs interactively, in its **default permission mode**, so it asks before it edits files or
runs commands. `tmux attach -t =rovara-<owner>_<repo>-<issue>` shows it, and you answer it there. Detach
with `Ctrl-b d`; it keeps working. To let it work without asking, give it a permission mode in
`harness.args`, for example `[--permission-mode, acceptEdits]`. That's your decision, per repository.

If its session ends while it's working, the loop resumes it, up to three times in a row; then it says so
on the issue and waits for your next reply.

## Commands

| Command | Does |
|---|---|
| `rovara loop init [path]` | writes `.rovara/loop.yaml` |
| `rovara loop add [path]` · `remove <owner/name>` | starts or stops reading a repository's issues. A repository is read from the moment it's added; older comments are never replayed |
| `rovara loop start` · `stop` · `status` | the background daemon. Its log is `~/.rovara/loop/daemon.log`; `run` is the same daemon in the foreground |
| `rovara loop do --issue <n> <instruction>` | posts `/rovara do <instruction>` on the issue, as you |
| `rovara loop check <issue> [--repo owner/name]` | where an issue's loop stands, without running anything |

## What's kept where

- **On your computer:** under `~/.rovara/loop/`, each work item's state (a cache), its event log, its
  worktree, and the agent's MCP configuration. Nothing is written into your Claude Code settings: each
  session gets the loop's tools through its own `--mcp-config` file.
- **On GitHub:** the issue holds the truth, its comments and its `rovara:*` label. These are not
  the-loop's `loop:*` labels, so the two never mix.
- **Credentials:** the loop uses your own `gh` login, and stores no token.
