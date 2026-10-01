# Feature Specification: Run SWE-Bench Pro Tasks from Slack

**Feature Branch**: `feat/044-swebench-pro`  
**Created**: 2026-09-30  
**Status**: Implemented; awaiting release (SC-003)  
**Input**: Request to run SWE-Bench Pro after spec 043 (SWE-bench Verified from Slack) reached production

## User Scenario

### A member scores the coding agent on a hard, multi-language task (Priority: P1)

A member of an eval-enabled channel posts `@agentx eval swebench pro-hard instance_NodeBB__NodeBB-8168c6c…`.
AgentX runs the same coding agent on a SWE-Bench Pro task and posts the result in the thread, exactly as a
Verified run does (spec 043): resolved or not, the hidden tests' counts, why the agent stopped, time, cost and
where the artifacts are.

### Why Pro

On 2026-09-30 Sonnet 4.6 resolved every Verified task tried, including one rated over four hours, in under four
minutes. Verified is near saturation for frontier models and its 2019–2022 issues are public, so passes are
partly recall. SWE-Bench Pro V2 (Scale AI, released 2026-09-22) is harder and newer: 642 validated tasks in 11
repositories across Python, Go, JavaScript and TypeScript, with fuller task statements and hidden tests. Its
HARD-51 subset holds the tasks at least two of five frontier model families failed (among them Claude Opus 5
and GLM-5.3).

### How Pro differs from what spec 043 runs

| | SWE-bench Verified (043) | SWE-Bench Pro V2 |
|---|---|---|
| Rows | `SWE-bench/SWE-bench_Verified` | `ScaleAI/SWE-bench_Pro`, config `default` (642) or `hard` (51) |
| Instance IDs | `django__django-11099` | `instance_NodeBB__NodeBB-<sha>-v<hash>` |
| What the agent sees | `problem_statement` | the task's `instruction.md`: PR description, requirements and new interfaces |
| Image | Docker Hub `swebench/sweb.eval.x86_64.*`, repository at `/testbed` | `ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>`, repository at `/app` (a few at `/testbed`), git history already sanitised |
| Grading | the `swebench` harness | the task's own Harbor verifier: `tests/test.sh`, which applies the hidden test patch, runs `run_script.sh` and `parser.py`, and writes `/logs/verifier/reward.txt` (1 or 0) and `output.json` |
| Protocol | none enforced | agent phase offline; verifier never in the agent's sandbox; 50-minute agent budget |

The spec 043 runner already follows Pro's locked protocol: the agent works in a `--network none` container, and
grading runs in a fresh container from the pristine image.

## Requirements

### Slack command

- **FR-001**: `eval swebench <dataset> <instance-id> [model <name>]` MUST also accept `pro` (config `default`,
  642 tasks) and `pro-hard` (config `hard`, HARD-51). A Pro instance ID MUST match
  `instance_<owner>__<repo>-<40 hex>`, optionally followed by `-v<suffix>` (271 of the 642 have none);
  `verified`, `lite` and `full` keep spec 043's pattern, and an ID of the other family is refused.
  Everything else in spec 043 (enablement, cost ceiling, one active run, `stop`, the result message) is
  unchanged.

### Task source

- **FR-002**: The runner MUST read the row from `ScaleAI/SWE-bench_Pro` and the task directory
  (`instruction.md`, `task.toml`, `tests/`) from `scaleapi/SWE-bench_Pro-os` at a pinned commit
  (`66f92766bba642462d4bbe5479e83f91f9211862` when written), verifying each file against that commit's
  `v2/SHA256SUMS`. A task whose files do not verify MUST fail with that reason. The commit and the image digest
  MUST be recorded in the result.

### Agent phase

- **FR-003**: The agent's prompt MUST be the task's `instruction.md` verbatim, after spec 043's fixed preamble
  (where the repository is, do not change tests, no network). The hidden tests, `tests/` and the reference
  solution MUST NOT be visible to the agent.
- **FR-004**: The runner MUST find the repository at `/app`, else `/testbed`, copy it out and mount it back as
  spec 043 does, and still strip history beyond HEAD (a no-op on V2's sanitised images, and a check). The
  `testbed` conda activation MUST apply only where the image has it.
- **FR-005**: The agent MUST run with no network and stop at 50 minutes (Pro's budget), the cost ceiling, an
  unknown cost, or the tool-loop guard. For Pro runs the guard's total tool-call cap MUST be 400 instead of 200
  (D-3); its repeated-failure detection is unchanged.

### Grading

- **FR-006**: The runner MUST grade in a fresh container from the task image, with public network (Pro's
  verifier phase needs it for some Go modules): apply the prediction to the repository, mount the task's
  `tests/` at `/tests`, run `bash /tests/test.sh` with the `task.toml` verifier timeout, and read
  `/logs/verifier/reward.txt`. Reward `1` is resolved; `0`, a missing reward, a patch that does not apply, or a
  timeout is unresolved.
- **FR-007**: The FAIL_TO_PASS and PASS_TO_PASS counts MUST come from the verifier's `output.json` against the
  lists in `tests/config.json`. The verifier's `output.json` and its run-script stdout and stderr MUST be stored
  under the run's `harness/` artifacts.

### Limits and infrastructure

- **FR-008**: A Pro run keeps spec 043's two-hour instance ceiling: the agent's 50 minutes, setup, and a
  verifier that typically takes minutes fit within it (D-4), so the eval stack does not change.
- **FR-009**: No new infrastructure. The `m7i.xlarge` and its 150 GiB root volume cover Pro's tasks (each
  `task.toml` asks for 1 CPU, 4 GiB and 10 GiB); the security group's HTTPS egress covers GHCR and GitHub.

## Out of Scope

Pro v1 (the 731-task release and its Docker Hub images), running several tasks at once (a separate spec),
leaderboard submission, the private and held-out Pro sets, and a general Harbor task runner. A Harbor grader is
most of what Terminal-Bench would need, so this work should keep the verifier contract generic.

## Decisions

- **D-1** (2026-09-30): V2 only. Scale keeps v1 only to reproduce old numbers.
- **D-2** (2026-09-30): Grade with each task's own verifier, not a reimplementation, so a pass means what it
  means on Scale's leaderboard.
- **D-3** (2026-09-30): Pro tasks are long-horizon, so the 200-call backstop (spec 033) would stop sessions that
  are working. 400 keeps a backstop within the 50-minute budget.
- **D-4** (2026-10-01): Keep the two-hour ceiling rather than pass a per-run ceiling to the state machine. A
  run that a 50-minute verifier timeout would push past it is marked failed by the state machine, as any
  over-time run is; no eval-stack redeploy is needed.
- **D-5** (2026-10-01, was Q-1): Fetch each task's files per run from GitHub at the pinned commit, checked
  against `v2/SHA256SUMS`, rather than baking 642 task directories into the runner image. The hidden tests
  are written beside the run's root (`<root>/../.pro-tasks/<run>/`), never inside it, because the agent's
  container mounts the root; they are deleted when the run ends.
- **D-6** (2026-10-01): Apply a prediction as Scale's re-grader does (`git apply`, then `git apply --3way`,
  then `patch --fuzz=3 -p1`), and run the verifier without applying anything for an empty prediction.

## Success Criteria

- **SC-001**: Unit tests cover the Pro command and ID pattern, the task-file checksum check, the prompt built
  from `instruction.md`, repository discovery (`/app`, `/testbed`, neither), the verifier's reward and counts
  (resolved, unresolved, missing reward, patch that does not apply, timeout), and the Pro limits (50 minutes,
  400 calls).
- **SC-002**: Before any agent run, the runner's grader reproduces Scale's release gate on one task per language
  (Python, Go, JavaScript, TypeScript): the reference patch resolves each, and an empty patch resolves none.
  Checked on 2026-10-01 (arm64 Mac, amd64 emulation, real task images and verifiers): Go
  (`navidrome-0130c6dc…`) reference 1/1, empty 0/1; Python (`ansible-0ea40e09…`) reference 1/1 and 15/15,
  empty 0/1 and 15/15; JavaScript (`NodeBB-00c70ce7…`) reference 2/2, empty 0/2. TypeScript (tutanota, 4
  tasks, slow to evaluate) remains for the first production run.
- **SC-003**: In production, from `#swe-bench-evals`, one HARD-51 task runs end to end on Sonnet 4.6 with the
  result posted in the thread and the instance terminated afterwards.
- **SC-004**: Typecheck, lint and the full test suite pass; the Verified path is unchanged.
