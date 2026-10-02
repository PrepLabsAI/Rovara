# Feature Specification: The Coding Agent Proves Its Work, and AgentX Checks It

**Feature Branch**: `docs/051-agent-verification` (spec), then `feat/051-agent-verification`  
**Created**: 2026-10-01  
**Status**: Building on Pi 1.0.0  
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
  (trimmed) and **one** more turn, using Pi 0.99's `agent_before_settle` hook with `continue: true`. That extra turn
  counts against the task's time, cost and step limits. After it, AgentX reruns the checks once more and records the
  final result. There is never a third round.

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
  - **Already failing:** a check that was already failing before the agent does not make the PR a draft; the
    description notes it.
- **FR-009 (Slack):**
  - **Regression remains:** the reply starts with "Not done:", then names the failing checks, before and after.
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
- **D-6 (2026-10-02):** The "before" for project checks is always "passed at preparation": readiness runs once at
  workspace preparation, and a workspace becomes READY only if every check passes. The task payload did not carry the
  readiness commands, so the broker adds an optional `readiness` list (`ProjectCommand[]`) to the task invocation
  payload, and the worker reruns those commands.
- **D-7 (2026-10-02):** A remaining regression publishes as a draft PR. Publish no longer refuses on a failing readiness
  check: it opens the PR as a draft with the failing checks listed in a deterministic checks section, and it also reads
  the workspace's latest task check report for agent-command checks. CodeBuild gates are unchanged. This relaxes an
  existing gate and needs the user's approval.
- **D-8 (2026-10-02):** Time limits. Production coding tasks have no task time limit, only the 200-tool-call guard. Each
  check keeps its own timeout (the command's `timeoutSeconds`, or 10 minutes for agent commands), and one verification
  round has a total budget of 30 minutes. Checks the budget leaves unrun are recorded as `not_run`. Eval runs count
  verification against their agent timer, using the time remaining.
- **D-9 (2026-10-02):** Stopped runs. Pi does not fire `agent_before_settle` after an abort (a cancel, the loop guard, or
  an eval time or cost limit). Such a task's report is `not_verified` with reason `stopped`, and no checks run.
- **D-10 (2026-10-02):** The agent's claim is read deterministically. The preamble asks the agent to end its final
  message with exactly one line, `AgentX result: done` or `AgentX result: not done`. The claim is `success`, `failure`,
  or `none` when the line is missing.
- **D-11 (2026-10-02):** Only a simple test command is replayed from the agent's own commands: an optional leading
  `cd <path> &&`, then `NAME=value` assignments, an optional `timeout <n>`, then a listed test command (FR-003) with its
  arguments. Anything with `|`, `;`, `||`, `&`, redirection, backticks or `$(` is not a check and is never replayed,
  because replaying an arbitrary command can change the workspace.

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
