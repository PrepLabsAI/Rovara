# Rovara loop: Rovara's workflow, run locally by your own agent

`rovara loop` runs on your own computer. It turns comments on your GitHub issues into work for your own
**Claude Code**, and drives that work through a loop. It needs no Rovara install and no AWS account: only
the Rovara CLI, the GitHub CLI (`gh`, signed in), `tmux`, `git` and Claude Code.

> **Status:** **Do**, **Quick** and **Full** are here, with reviews before anything is published, feedback on the
> pull request, and one loop per pull request when a change spans repositories. The Review and Contribute loops, and
> Codex, follow ([design, #354](https://github.com/PrepLabsAI/Rovara/issues/354)).

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
checks:             # what the Quick loop runs before it opens a pull request, in order, as CI would
  - name: tests
    run: npm test
    timeoutSeconds: 600   # optional; 600 by default
reviews:            # the code and security reviews after the checks; see "Reviews" below
  enabled: true
  model: opus       # optional; the model the reviewers run on, so the critic can differ from the agent
  security: true    # false runs the code review only
  maxRounds: 3      # rounds in a row that still block before a person decides
  timeoutSeconds: 900
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

## The Quick loop

```text
/rovara quick Retry the payment call when the server answers 503
```

or `rovara loop quick --issue 42 "…"` from the terminal.

| Step | What happens | The issue shows |
|---|---|---|
| **Plan** | The agent writes `docs/rovara/<issue>/plan.md` with `## Summary`, `## Changes` and `## Testing`, and changes no code. A plan missing a section is refused, and the agent is told which | `rovara:planning` |
| **Plan review** | The plan is posted on the issue. A collaborator comments `/rovara approve`, or replies with what to change (`/rovara changes: …` works too). A change request is added to the plan under "Review feedback", and the plan goes back to the agent | `rovara:plan-review` |
| **Code** | The approval locks the plan. The agent codes it, commits, and reviews its own change (`evidence/self-review.md`); a claim with a changed plan, or without the self-review, is refused | `rovara:coding` |
| **Checks** | The loop runs the repository's `checks` in the agent's worktree. A failure goes back to the agent with the end of its output (secrets redacted), and the issue says so | `rovara:checking` |
| **Reviews** | A code review and a security review of the change (see [Reviews](#reviews)). A blocking finding goes back to the agent | `rovara:reviewing` |
| **Review blocked** | After `maxRounds` rounds that still block, or a review that couldn't be run or read, a person decides: `/rovara approve` publishes as it is, a reply goes back to the agent | `rovara:review-blocked` |
| **Publish** | The loop itself, never the agent, pushes `rovara/<issue>` and opens a pull request that closes the issue, with the plan, the checks and the reviews in its description | `rovara:publishing` |
| **Pull request open** | A reply on the issue, or on the pull request (see [Feedback on the pull request](#feedback-on-the-pull-request)), goes back to the agent; the loop runs the checks and reviews again and pushes to the same pull request. Merging closes the issue, which ends the loop | `rovara:pr-open` |

**Nothing is pushed before the plan is approved, the checks pass and the reviews pass (or a person accepts them).** A push git refuses (someone else pushed
to the branch) is said on the issue, and a reply tries again.

## The Full loop

```text
/rovara full Retry the payment call when the server answers 503
```

Full is Quick with two more documents before the plan, each written from the one before it, and each approved
before the next is written:

| Document | Sections | Says |
|---|---|---|
| `requirements.md` | `## What changes`, `## Not changing`, `## Risks` | what someone will be able to do or see; not how |
| `design.md` | `## How it works`, `## Risks` | how it works, derived from the approved requirements |
| `plan.md` | `## Summary`, `## Changes`, `## Testing` | where in the code, and how the change is proved |

Each document has its own gate (`rovara:requirements-review`, `rovara:design-review`, `rovara:plan-review`). A gate is
answered as in Quick: `/rovara approve`, or a reply with what to change, which is added to that document under
"Review feedback". An approval **locks** its document. A later claim that changed any approved document is refused,
naming it. Then code, checks and a pull request, as in Quick. The pull request says who approved each document.

**Declaring a phase away.** For a change too small for a design, start with
`/rovara full --skip design <instruction>` (or `--skip requirements`, or both: `--skip requirements,design`). The
start comment says who declared it, and so does the pull request. The plan can't be skipped; that's Quick.

**Evidence.** Before it publishes, the loop commits the checks report and the reviews report to
`docs/rovara/<issue>/evidence/` (`checks.md`, `reviews.md`), beside the agent's `self-review.md`, so the branch
carries what proved it.

## Reviews

Quick and Full review a change three times before it's published:

1. **The agent's own review.** Before it says its code is done, the agent reviews the change against the approved
   documents and writes `docs/rovara/<issue>/evidence/self-review.md` with `## Findings` and `## Fixed` ("None" where
   there is nothing). A claim without it is refused.
2. **A code review and a security review**, after the checks pass. Each is Claude Code run headless (`claude -p`) in
   the agent's worktree, read-only: plan mode, with only file reading and `git diff`, `git log` and `git show`
   allowed. Each sees the approved plan and the change from the default branch, and answers with findings in
   Rovara's own reviewer format, the same as Rovara's hosted reviews. Set `reviews.model` to run them on a different
   model from the agent's.
3. **The blocking rule.** A finding blocks when the change introduced it, and, for the code review, it isn't
   advisory (a remark about something the plan asks for, or about test coverage). A security finding is never
   advisory. What doesn't block is listed in the report as advice, or as already there.

A blocking finding goes back to the agent with the report, and the checks and reviews run again. After `maxRounds`
rounds in a row that still block, the issue asks a person. A review that couldn't be run (Claude Code isn't signed
in, it timed out) or whose answer couldn't be read, even when asked once more, never counts as a pass: a person
decides that too. Set `reviews.enabled: false` to publish without them.

## Feedback on the pull request

Once the loop has opened a pull request, what collaborators say on it reaches the issue's agent, like a reply on
the issue: comments on the pull request, inline review comments (with the file and line), and the text of a review
that asks for changes or comments. A `/rovara` command that starts a loop is only a reply there;
`/rovara stop`, `/rovara approve` and `/rovara changes` work as on the issue. An approving review is acknowledged on
the issue; merging closes the issue, which ends the loop. As on the issue, nobody else's words are read.

## Changes across repositories: one loop per pull request

When a change needs more than one repository, the plan says so in a `## Repositories` section, one repository per
line, with what changes there:

```markdown
## Repositories
- acme/payments: retry the call on a 503
- acme/web: show a "retrying" banner
```

Each repository listed must be added on the computer running the loop (`rovara loop add` in its checkout); a plan
naming one that isn't is refused, and the agent asks for it. A plan without the section, or naming only the issue's
own repository, makes one pull request as above.

When that plan is approved, the issue's loop waits (`rovara:pull-requests`) and starts one **per-PR loop** for each
repository: its own agent, worktree and branch, code → checks → reviews → publish → ✋ pull request approval.

- **Where it works.** In the issue's own repository, the per-PR loop carries on in the planning worktree, on
  `rovara/<issue>`. In another, it gets a worktree from that repository's default branch, on
  `rovara/<owner>-<name>-<issue>` (that repository's issue numbers mean something else), and its evidence goes in
  `docs/rovara/<owner>-<name>-<issue>/`.
- **Whose rules.** Each repository's own `.rovara/loop.yaml`: its checks, reviews and agent settings, and its
  collaborators for feedback on its pull request. The issue's collaborators approve the plan and steer from the issue.
- **What the issue shows.** Each per-PR loop says what it does on the issue, starting with its repository's name. Its
  pull request says `Part of owner/name#<issue>` in another repository, or `Closes #<issue>` in the issue's own.
- **Steering.** Feedback on a pull request goes to its loop. A reply on the issue goes to every per-PR loop still
  working (one whose pull request is open takes feedback on it), or to one when it starts with `owner/name:`. When a
  per-PR loop's reviews still block, `/rovara approve owner/name` on the issue publishes it as it is.
- **Approving.** A pull request is approved on itself: a GitHub approval from a collaborator, or `/rovara approve` on
  it. When every pull request is approved, the issue says so (`rovara:pulls-approved`), lists them, and waits for you to
  merge them. More feedback on an approved pull request sends its loop back to work, and the issue waits again.
- **Ending.** Closing the issue, or `/rovara stop` on it, ends every per-PR loop. `/rovara stop` on one pull request
  ends only its loop; the others carry on.

## Watching and answering the agent

Claude Code runs interactively, in its **default permission mode**, so it asks before it edits files or
runs commands. `tmux attach -t =rovara-<owner>_<repo>-<issue>` shows it, and you answer it there. Detach
with `Ctrl-b d`; it keeps working. To let it work without asking, give it a permission mode in
`harness.args`, for example `[--permission-mode, acceptEdits]`. That's your decision, per repository.

When the agent has been waiting on a permission prompt for a minute, the loop says so on the issue, with the
`tmux attach` command, so someone who only watches GitHub knows it needs them.

If its session ends while it's working, the loop resumes it, up to three times in a row; then it says so
on the issue and waits for your next reply.

## Commands

| Command | Does |
|---|---|
| `rovara loop init [path]` | writes `.rovara/loop.yaml` |
| `rovara loop add [path]` · `remove <owner/name>` | starts or stops reading a repository's issues. A repository is read from the moment it's added; older comments are never replayed |
| `rovara loop start` · `stop` · `status` | the background daemon. Its log is `~/.rovara/loop/daemon.log`; `run` is the same daemon in the foreground |
| `rovara loop do` · `quick` · `full` `--issue <n> <instruction>` | posts `/rovara do <instruction>` (or `quick`, `full`) on the issue, as you |
| `rovara loop check <issue> [--repo owner/name]` | where an issue's loop stands, without running anything; each document's state: not written, missing sections, written but not approved, locked, changed since approval, or declared away; and each per-PR loop's step, pull request and agent |

## What's kept where

- **On your computer:** under `~/.rovara/loop/`, each work item's state (a cache), its event log, its
  worktree, and the agent's MCP configuration. Nothing is written into your Claude Code settings: each
  session gets the loop's tools through its own `--mcp-config` file.
- **On GitHub:** the issue holds the truth, its comments and its `rovara:*` label. These are not
  the-loop's `loop:*` labels, so the two never mix.
- **Credentials:** the loop uses your own `gh` login, and stores no token.
