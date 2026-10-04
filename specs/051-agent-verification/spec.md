# Feature Specification: The Coding Agent Proves Its Work, and AgentX Checks It

**Feature Branch**: `docs/051-agent-verification` (spec), then `feat/051-agent-verification`  
**Created**: 2026-10-01  
**Status**: Implemented; awaiting release  
**Input**: SWE-bench pilot findings (2026-09-30/10-01) and decisions with Abhishek (2026-10-01)

## Why

The coding agent claims success it has not earned. In the SWE-bench pilot, 3 of 5 failed runs ended with the agent
saying it had succeeded. On `astropy__astropy-13398`, Sonnet 4.6 confirmed with `git stash` that an existing test
went from passing to failing, then wrote "All tests pass". GLM 5.3 explained the same regression away by assuming
the hidden tests would change that test. Only 2 of 8 runs reproduced the bug before editing.

This is a product problem, not a benchmark quirk. The same agent writes customers' pull requests. Until it is fixed,
every benchmark score partly measures how convincingly the agent fools itself.

## User scenarios

### A task that really works (P1)

A member asks AgentX in Slack to fix a bug. The agent reproduces it, fixes it, and runs the tests. AgentX reruns the
project's checks and finds no regression. The PR is a normal PR, its description has a checks section (each check
with its result before and after), and the Slack reply says the checks passed.

### A task that breaks something (P1)

The agent's change makes a previously passing test fail. When the agent tries to finish, AgentX reruns the checks,
sees the regression, and gives the agent the failure and **one** more try. The test still fails. AgentX opens a
**draft** PR that lists the failing check, and the Slack reply starts with "Not done:", then names the check,
before and after, and links the PR. The agent's own summary appears below AgentX's result, labelled as the agent's
account.

### A project without configured checks (P2)

The project has no `readiness` commands. AgentX reruns the test commands the agent itself ran, compares them with the
agent's first run of each, and reports the result as "checked with the agent's own commands". If the agent ran
none, the result says "Not verified: no checks ran", and the reply suggests adding readiness checks to the project.

## Requirements

### Agent guidance

- **FR-001:** The worker MUST append a fixed AgentX preamble to Pi's system prompt for every coding task and every
  eval run, so evals measure the production agent. The preamble tells the agent to:
  - reproduce the problem before changing code;
  - run the relevant tests before and after the change;
  - treat a test that passed before and fails after as its own regression, never as unrelated;
  - report what it ran and the results;
  - never claim a test passed unless it saw it pass.

  The preamble is versioned, and its SHA-256 is recorded with each task and eval result.

### What AgentX checks

- **FR-002 (project checks):** For a project with `readiness` commands, the **before** result is the readiness run at
  workspace preparation (already stored as `readinessResults`, `packages/worker/src/prepare.ts:72`). The **after**
  result is AgentX rerunning the same commands, in the same environment (devcontainer included), when the agent
  tries to finish.
- **FR-003 (agent's own commands):** For a project without readiness commands, the worker MUST record the test-like
  commands the agent runs, matched against a fixed, tested list: `npm test`, `npm run test`, `pnpm test`,
  `yarn test`, `pytest`, `python -m pytest`, `go test`, `cargo test`, `make test`, `mvn test`, `gradle test`,
  `./gradlew test`, `bundle exec rspec`, `phpunit`, and `tox`, with arguments. For each, the **before** result is the
  agent's first run of that command, made before its first file edit where possible; when the first run came after
  an edit, the before result is marked unknown. The **after** result is AgentX rerunning the command when the agent
  tries to finish.
- **FR-004 (regression rule):** A check is a **regression** when it passed before and fails after. A check that failed
  before and still fails is **already failing**, and is not the agent's regression. A check with an unknown before
  result that fails after is **failing (no before result)**.
- **FR-005 (limits):** Check runs count against the task's time limit. Each check run has its own timeout (the
  command's configured `timeoutSeconds`, or 10 minutes), and its output is stored trimmed and redacted, as readiness
  output is today.

### One extra try

- **FR-006:** When the agent tries to finish and a regression exists, AgentX MUST give it the failing checks' output
  (trimmed) and **one** more turn, using Pi 1.0.0's `agent_before_settle` hook with `continue: true`. That extra turn
  counts against the task's time, cost and step limits. After it, AgentX reruns the checks once more and records the
  final result. There is never a third round. One exception is outside AgentX's control: a message already queued
  when the agent settles (for example, AgentX's own loop-guard warning) makes Pi run another turn whatever the hook
  returns. AgentX never asks for it; it reruns the checks when that turn settles, and the last report is the result.

### Honest reporting

- **FR-007:** The task result MUST carry AgentX's check result:
  - the source (project checks, agent's commands, or none);
  - each check with its before and after result;
  - the regressions;
  - the preamble version.
- **FR-008 (PR):**
  - **No regression remains:** a normal PR, with a checks section in the description.
  - **A regression remains:** a **draft** PR (publishing already supports `draft`), whose description lists each
    failing check with its before and after result and the trimmed output.
  - **Already failing:** a check that was already failing before the agent: see Ruling Y (D-12). AgentX cannot tell it
    from a failure the agent caused in an earlier task, so a check that still fails makes a draft, whatever its class.
- **FR-009 (Slack):**
  - **Regression remains:** the reply starts with "Not done:", then names the failing checks, before and after.
  - **A rerun check fails now, with no regression:** the reply starts "Checks: <p> of <n> pass.", never "Checks passed"
    (Ruling Z, D-13). A turn whose pull request opened as a draft says so.
  - **Nothing was checked:** the reply says "Not verified: no checks ran" and suggests configuring readiness checks.
  - **In every case:** the agent's own summary appears after AgentX's result, labelled as the agent's account.

### Evals

- **FR-010:** SWE-bench and SEC-bench runs use the same preamble and the same agent-command rerun (FR-003). Their grade
  is still the benchmark's own grader. `result.json` records the check result and whether the agent's final claim
  agreed with it.
- **FR-011 (measure):** For an eval run, a disagreement means one of two things: the agent claimed success while
  AgentX's check found a regression, or the agent claimed success and the grader found it unresolved with a broken
  PASS_TO_PASS test. These are counted per run in `result.json`, so spec 046's final campaign can report the
  disagreement rate per model.

## Out of scope

- A reviewer-model pass.
- Best-of-N.
- Per-project policy settings, such as "never open a PR on failure".
- Inferring checks from lockfiles.
- More than one extra try.

These may come later (spec 053 or after).

## Decisions

- **D-1 (2026-10-01):** Both layers: the agent is guided, and AgentX checks. AgentX's result, not the agent's claim, is
  what reaches the PR and Slack.
- **D-2 (2026-10-01):** A remaining regression gives a draft PR, clearly marked, rather than no PR or a normal PR with a
  warning. The work stays visible, and it cannot be merged as finished by mistake.
- **D-3 (2026-10-01):** One extra try, not two or "until limits".
- **D-4 (2026-10-01):** Projects without readiness checks are checked by rerunning the agent's own test commands.
- **D-5 (2026-10-01):** No paid validation runs during development (pre-launch; see spec 046). The pilot's failure tasks
  (astropy-13398, sphinx-7590) and the final campaign measure the effect. Development is verified by tests that run
  on the scripted model.
- **D-6 (2026-10-02, amended by Ruling J):** The task payload did not carry the readiness commands, so the broker adds
  an optional `readiness` list (`ProjectCommand[]`, the latest revision's, as publication gates on) to the task
  invocation payload, and the worker reruns those commands. The "before" for a project check is the last known outcome
  of that exact command in this workspace: each task's final round records its project-check outcomes in
  `.agentx/last-checks.json`, keyed by a hash of the command's cwd, executable, args and env. With no recorded outcome,
  a command that preparation ran (recorded in the preparation manifest) is "passed", since a workspace becomes READY
  only if every check passes; any other command, such as one added in a later revision, is "unknown", so a failure is
  "failing (no before result)" and never the agent's regression. A check that was not run keeps its earlier outcome.
  This history is for a task's own rounds only. Publication never reads it (Ruling S, D-7): an earlier task's failure is
  not "before" the pull request's change.
- **D-7 (2026-10-02, amended by Rulings S and T):** A failing check publishes as a draft PR. Publish no longer refuses on
  a failing readiness check. Instead it opens the PR as a draft, with the checks listed in a deterministic checks
  section. It also reads the workspace's latest task check report for agent-command checks. CodeBuild gates are
  unchanged. This relaxes an existing gate, which the user approved (P-2).
  - The broker asks for this behaviour with `reportChecks` in the publish payload. It sends that only to a worker whose
    /ping lists `publish.reportChecks`. A worker without it, or one asked by an older broker, refuses as before.
  - **Ruling S.** A pull request is the workspace's whole change since preparation, so publication judges each check
    against the preparation baseline:
    - a command preparation ran that fails now reads "regression (passed at preparation, fails now)";
    - any other failing command, including every command of a workspace prepared before spec 051, reads "fails now,
      with no earlier result";
    - any failing publish-time check makes the PR a draft, as does a latest task report of `regression`.
  - **Ruling T.** Every task's end records the workspace's latest checks, ordered by the operation's fence: its report,
    or a `not_verified` marker (`failed`, `cancelled`, `interrupted` or `no_report`). A task reads as `interrupted` from
    its start until its result arrives, so an older report never stands for a newer task. A `not_verified` latest of
    `failed` or `no_report` does not make a draft on its own, and the section says "Not verified".
  - **Ruling AA (amends T).** A latest marker of `cancelled` or `interrupted` makes the next PR a draft, with the line
    "Not verified: the last task was cancelled" (or "was interrupted"), until a later task's report replaces it. The
    member stopped the work, or the worker was lost, so it is unfinished. `failed` carries its regression in its
    result, and `no_report` comes from an old worker, so neither makes a draft.
- **D-8 (2026-10-02):** Time limits. Production coding tasks have no task time limit, only the 200-tool-call guard. Each
  check keeps its own timeout (the command's `timeoutSeconds`, or 10 minutes for agent commands), and one verification
  round has a total budget of 30 minutes. Checks the budget leaves unrun are recorded as `not_run`. Eval runs count
  verification against their agent timer, using the time remaining.
- **D-9 (2026-10-02):** Stopped runs. Pi does not fire `agent_before_settle` after an abort (a cancel, the loop guard, or
  an eval time or cost limit). Such a task's report is `not_verified` with reason `stopped`, and no checks run. Amended
  by Ruling Y (D-12): once a round found a regression, a stop on the extra turn keeps it as a `regression`.
- **D-10 (2026-10-02):** The agent's claim is read deterministically. The preamble asks the agent to end its final
  message with exactly one line, `AgentX result: done` or `AgentX result: not done`. The claim is `success`, `failure`,
  or `none` when the line is missing.
- **D-11 (2026-10-02):** Only a simple test command is replayed from the agent's own commands: an optional leading
  `cd <path> &&`, then `NAME=value` assignments, an optional `timeout <n>`, then a listed test command (FR-003) with its
  arguments. Anything with `|`, `;`, `||`, `&`, redirection, backticks or `$(` is not a check and is never replayed,
  because replaying an arbitrary command can change the workspace.- **D-12 (2026-10-02, Ruling Y, from the final review's C-1):** A regression is not forgotten across tasks.
  - **Report.** Once any round found a regression, the task's final report stays `regression` unless a later round
    reran it. A stop, a cancel, a loop-guard stop or a model error on the extra turn keeps the first round's regression
    (it was `not_verified`). A task that ends failed or cancelled with a regression sends its report in its terminal
    result, so the broker keeps it.
  - **Standing failures.** The workspace keeps `standingFailures`, written in the same fenced terminal transaction as
    the latest checks. A task report clears each earlier failure that it shows passing, and adds every check failing in
    it (regression, already failing, or no earlier result). A task that ends without a report keeps them exactly.
  - **Draft.** A PR is a draft when any standing failure remains, or a publish-time check fails. Its section lists the
    failures. A project check that publish reran and found passing is left out, unless it was a regression. The status
    line says "No check that passed before this change fails now" only when nothing fails now.
  - **Known limit.** A task cancelled by a cancel operation whose own result never arrives records "cancelled" and
    keeps the failures known before it; the extra turn's regression is then lost. Ruling AA makes such a PR a draft.
  - **Matching.** A standing failure of the agent's own commands is matched by exact command text, so only a later task
    rerunning the same command and passing clears it (R-2). A project regression that publish reran and found passing
    stays a draft, worded "regressed in the last task, passes at publish" (R-3).
  - **Re-preparation.** Standing failures are not reset when a workspace is prepared again (R-4).
- **D-13 (2026-10-02, Ruling Z, from the final review's I-1 and I-2):** The publish result carries `draft`, true when
  the PR opened as a draft. The PR tool's description says AgentX opens a draft when a check fails. A turn whose
  publish returned a draft adds "Opened as a draft: AgentX's checks found failures." to the reply, with or without a
  task in the turn. The headline "Checks passed (...)" is used only when every check AgentX reran passes now; otherwise
  it is "Checks: <p> of <n> pass." followed by the per-check lines. The orchestrator model's task results carry the
  report's status, labels and classes, not the check outputs.
- **D-14 (2026-10-03, amends D-11):** A trailing `2>&1` and `| tail -N` (or `tail -n N`) are allowed on an agent's test
  command and left out of its replay, so AgentX still replays only the bare test command. In the first SWE-bench run
  on preamble version 2 (`astropy__astropy-13398`), every pytest command the agent ran ended in `2>&1 | tail -N`, so
  none was recorded and the report was "not verified: no checks". The agent's shell runs exactly these commands with
  `set -o pipefail` (`agentShellSpawn`), because a pipeline's status is otherwise `tail`'s, 0 even when the tests
  fail, and such a run would be taken as a passing before result and turn an already failing test into a false
  regression. `head` stays refused: it stops reading early and can cut the run short.
- **D-15 (2026-10-03, #290, amends D-11):** More runners and literal quoted arguments. `python3 -m pytest`, `jest`,
  `npx jest`, `yarn jest`, `pnpm jest`, `vitest`, `npx vitest`, `yarn vitest` and `pnpm vitest` are test commands.
  An argument may be single- or double-quoted when the quoted text is printable and holds no `$`, backtick, backslash
  or quote, so the shell reads it literally (`--testPathPattern="RoomView|RoomViewStore"`); the runner, assignments and
  `timeout` must still be unquoted. Replays that would write files or never end are refused: `-u`, `--updateSnapshot`,
  `--update-snapshots`, `--update`, `--snapshot-update`, `--ci=false` and any `--watch` option. A leading `cd` to the
  repository's host folder reads as its workspace folder, as the container folder already did (Ruling X):
  `devcontainerContextFile` tells the agent to prefer the host path, and it does. In the 30-task Pro batch of
  2026-10-03, these gaps left 12 of 30 solved tasks with no check at all.
- **D-16 (2026-10-03, #290, amends FR-003):** AgentX measures an agent command's before result itself when the agent's
  own first run cannot serve (it came after an edit, or has no exit code). At settle, before the after runs, it shows
  each repository's original code (the preparation commit's `resolvedCommit`; an eval's base commit), runs those
  commands, and restores the agent's files. Only working-tree files that differ are written, from Git's object store
  through a temporary index; the repository's index, HEAD, branches and stash are never touched, and ignored files stay,
  so the before runs share the agent's environment. The agent's files are kept as a tree under `refs/agentx/agent-files`
  until the restore is checked to be exact; a task that finds the ref puts the files back before it starts, and fails
  rather than start on the wrong files. The before runs use at most half of the round's budget, and are measured once
  per command (the extra try's round reuses them). A failure to show the original code leaves those commands' before
  unknown and is reported; a failure to restore is reported as an error, naming the ref. A workspace whose manifest
  lacks a commit for any repository measures nothing, rather than mix states. Reason: in that batch the agent edited
  before its first test run in almost every task, so the regression rule rarely had a before result.
- **D-17 (2026-10-03, #290):** Preamble version 3. A test that checks the old behaviour the task asks the agent to change
  is not its regression: the agent updates it to the new behaviour, or leaves it when told not to modify tests, and names
  it either way; the done line allows such named tests. The extra try's message says the same. Reason: in that batch the
  agent reported 5 correct, graded-as-resolved tasks as not done, each time because the repository's old tests asserted
  the behaviour the task changed. The check report itself is unchanged: such a test still shows as a regression in an
  eval, where tests may not be modified.
- **D-18 (2026-10-03, amends D-17):** Preamble version 4. A test that checks the old behaviour the task changes is left
  as it is and named; the agent never edits or deletes a test to make it pass unless the task explicitly asks for test
  changes, and rule 3 says to fix the change, not the test. The extra try's message says the same. Reason: in the
  10-task check of #291 (batch `1f8652a8`), version 3's "update it to the new behaviour" led the agent to edit tests in
  3 of the 4 tasks with such a test, although each task said "Do not modify, add or delete tests". In one
  (`ansible-a1569ea4`) it edited the tests to match a half-finished fix and claimed done; the grader failed it, and
  AgentX's check passed because it ran the edited tests. The one task where the agent left the test and named it was
  solved with a correct claim. Also from that check (#292): `mocha`, `npx mocha`, `yarn mocha` and `pnpm mocha` are
  test commands (D-15).
- **D-19 (2026-10-04, #299, amends P-6, D-11 and D-14):** AgentX finds a test command inside a chain or a filter, not only
  a simple one. It splits the agent's command at `&&`, `||`, `;` and `|` outside quotes; `2>&1` is the only redirection
  allowed. Each part that is a simple test command (D-11, D-15) is replayed as `cd <dir> && <test>`, where `<dir>` follows
  every `cd` before it (`cd a && cd b` is `a/b`), and every `cd` target is mapped from the container or host folder
  (Ruling X), not only a leading one. A test may be followed by `tail`, `head`, `grep`, `egrep`, `sed` (not in place),
  `cut`, `sort`, `uniq`, `wc` or `cat`, which the replay leaves out. `cd <dir>; <test>` is the same command as
  `cd <dir> && <test>`. The agent's own run serves as a before result only for a simple test command, optionally after
  `cd <dir> &&` or `cd <dir>;` and before `| tail -N`, and gets `pipefail` as D-14 says. For every other shape the exit
  code is not the test's, so D-16 measures the before. A chain holding anything but tests, `cd` and those filters may
  change files, for Ruling G. A command yields no test when it has a subshell, `$(`, a backtick, a background `&`, a
  heredoc, any other redirection, a newline or control character, `git stash`, a `cd` joined by `||` or leaving the
  workspace, a filter outside the list, or an environment changer before the test (`export`, `source`, `.`, `set`, `unset`,
  `alias`, `pushd`, `popd`, `shopt`, `ulimit`, `umask`, `eval`, `exec`, `declare`, `typeset`, `readonly`, or a bare
  `NAME=value`). The replay itself is unchanged: AgentX runs only what `matchTestCommand` maps to itself, in a contained
  directory. A cd target that maps to a sub-folder of a workspace whose repository is the root now reads as that
  sub-folder; it used to keep a leading `/`, and was refused. Reason: in batch `744df9ec` (#297, Sonnet 5.5, 30 tasks)
  the agent ran tests 29 times in 12 runs, and the matcher recognised 1; 29 of 30 runs ended `not_verified`. Sonnet 5.5
  writes `cd /app; …`, pipes into `grep` or `head`, and chains tests with builds. The preamble is unchanged (version 4).

## Success Criteria

- **SC-001:** Tests on the scripted model cover:
  - preamble injection, and its hash in the result;
  - the before and after for both check sources;
  - each regression class;
  - exactly one extra try, ending with a rerun;
  - the time limit applied to check runs;
  - the draft PR on a remaining regression, and a normal PR otherwise;
  - the Slack wording, for each outcome;
  - the eval `result.json` fields.
- **SC-002:** On `astropy__astropy-13398`, a run either fixes the regression in its extra try, or ends with a
  result and summary that do not claim the regression passes. This is checked during spec 046's shakedown, not as a
  separate paid run.
- **SC-003:** In spec 046's final campaign, the share of runs where the agent claimed success but AgentX's check or the
  grader disagreed is reported per model. It should be near zero for runs where AgentX's check found the
  regression, with no fall in resolve rate against the pilot.
