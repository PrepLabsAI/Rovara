# Feature Specification: Run SWE-bench Tasks from Slack

**Feature Branch**: `feat/043-swebench-eval`  
**Created**: 2026-09-30  
**Status**: Draft  
**Input**: Request to measure the AgentX coding agent on SWE-bench (no issue yet)

## User Scenario

### A member scores the coding agent on one SWE-bench task (Priority: P1)

A member of an eval-enabled channel posts `@agentx eval swebench verified django__django-11099`. AgentX replies
in the thread that the run has started, and later posts whether the task was resolved, how long the agent took,
what it cost and where the patch and transcript are stored.

The product workflow (project revision, thread workspace, EBS volume, devcontainer, pull request) does not fit a
benchmark: each SWE-bench task ships its own x86 image with the repository at `/testbed`, checked out at the task's
base commit, with its dependencies installed. Production workers are arm64 (`m6g.medium`, arm64 AMI and worker
image), and SWE-bench publishes x86 images only. So an eval run skips workspaces and runs the same coding agent
directly against the task image on a separate x86 instance.

### What an eval measures

The coding agent: the worker's Pi session, tools, system prompt and model, as production runs them. It does not
measure the Slack orchestrator or the workspace lifecycle.

## Requirements

### Slack command

- **FR-001**: The Slack service MUST recognize `eval swebench <dataset> <instance-id> [model <name>]` as a whole
  message, before the orchestrator, as it does `models` and `use`. `<dataset>` is one of `verified`, `lite` or
  `full`, mapped to `princeton-nlp/SWE-bench_Verified`, `princeton-nlp/SWE-bench_Lite` and
  `princeton-nlp/SWE-bench`. The pilot accepts exactly one instance ID.
- **FR-002**: Eval MUST be off unless an administrator enables it for a bound channel
  (`agentx admin eval enable --channel <id> [--max-cost-usd <n>]` / `disable`). The cost ceiling defaults to
  10 USD per run and MUST be between 1 and 100. Any member of an enabled channel MAY start a run. A channel that
  is not enabled MUST get a reply saying eval is not enabled there, and nothing is started.
- **FR-003**: `model <name>` MUST resolve against the channel project's approved models, as `use` does. Without
  it, the run uses the project's current model. The chosen provider and model ID MUST be recorded on the run. A
  model whose cost the worker cannot estimate (an OpenRouter model without pricing) MUST be refused, since the
  cost ceiling could not be enforced.
- **FR-004**: An unknown dataset, an instance ID not in the dataset, or a second run while one is active in the
  deployment MUST be refused in the thread with the reason. The pilot allows one active run per deployment.
- **FR-005**: `stop` in the run's thread MUST cancel the run (spec 039's stop path), terminate its instance and
  report it as cancelled.

### Control plane

- **FR-006**: The broker MUST record each run (`EVAL#<id>`: dataset, instance ID, model, requester, thread,
  status, timings, token usage, cost, result) and start it through a Step Functions state machine that launches
  one x86 instance from an eval launch template, waits for its callback, and terminates it on completion,
  failure, cancellation or a 2-hour ceiling.
- **FR-007**: The runner MUST report through the existing worker callback path with a capability bound to the
  run. The broker posts every Slack message; the runner never holds a Slack token.

### Eval runner

- **FR-008**: The runner MUST be a mode of the worker image (same Pi session code, tools and prompts), built for
  `linux/amd64` by the release alongside the existing `linux/arm64` worker.
- **FR-009**: For the instance, the runner MUST pull the prebuilt image `swebench/sweb.eval.x86_64.<id>`
  (pinned by digest in the run record), copy `/testbed` to a host folder, and start the task container with that
  folder mounted at `/testbed`, so the image's editable install and compiled extensions see the agent's edits.
- **FR-010**: Before the agent starts, the runner MUST remove from the copy every git ref, remote, tag, reflog and
  unreachable object beyond the base commit, so the upstream fix cannot be found in history.
- **FR-011**: The agent MUST run through `createWorkspacePiSession` with `bashOperations` executing in the task
  container and `devcontainerPaths` mapping `/testbed` to the host folder. The task container MUST run with
  `--network none`, so shell commands cannot reach the upstream repository or the web.
- **FR-012**: The agent's prompt MUST be the instance's `problem_statement` plus a fixed preamble (work in
  `/testbed`, do not modify tests). The hidden tests (`test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`) MUST NOT be
  visible to the agent.
- **FR-013**: The agent MUST stop at 60 minutes, at the tool-loop guard (spec 033), or when the session's
  `costUsd` reaches the channel's cost ceiling after a model turn, whichever comes first. If `costUsd` is ever
  unknown, the agent MUST stop as if the ceiling were reached. What it has changed by then is the prediction, and
  it is graded; the result MUST say why the agent stopped (finished, time limit, cost ceiling, loop guard).
- **FR-014**: The runner MUST grade the prediction (`git diff` against the base commit) with the official
  SWE-bench harness at a pinned version, for that one instance, and report resolved or not with the
  `FAIL_TO_PASS` and `PASS_TO_PASS` counts.
- **FR-015**: The runner MUST store the patch, the Pi transcript, the harness report and test log under
  `s3://<artifact bucket>/evals/<run id>/`, and report token usage and cost as tasks do (`usage.ts`).

### Infrastructure

- **FR-016**: The eval launch template, instance role, security group and state machine MUST live in a new
  optional stack (`agentx-<env>-eval`, legacy production name `AgentXEval`), not in the foundation, so the
  foundation-drift check stays unaffected. Instance type `m7i.xlarge` (4 vCPU, 16 GiB), 150 GiB gp3 root
  volume, in the production VPC's private subnets.
- **FR-017**: The instance role MAY write only under `evals/` in the artifact bucket, invoke only the models the
  project approves, and call only the eval callback route. Outbound traffic goes through the NAT to Docker Hub,
  Hugging Face, PyPI and the model provider.

## Out of Scope

Batches of instances and parallel fan-out (a follow-up once the pilot works), SWE-Bench Pro, Multimodal and Live
(different images or harnesses), leaderboard submission, and scoring the orchestrator end to end.

## Decisions

- **D-1** (2026-09-30): Any member of an enabled channel may start a run; there is no per-member allowlist.
- **D-2** (2026-09-30): Each run has a cost ceiling (10 USD by default, set per channel) in addition to the
  60-minute limit, because a looping agent on an expensive model can spend several times a typical task's
  1–3 USD within the hour. A run that hits it is still graded.

## Success Criteria

- **SC-001**: Unit tests cover the command parser (valid, unknown dataset, extra instances, model selection),
  the enablement and single-active-run refusals, the refusal of a model with unknown cost, the cost-ceiling
  range, run records and state transitions, each reason the agent stops (including the cost ceiling and an
  unknown `costUsd` mid-run), history stripping, and the grading report parser.
- **SC-002**: On an x86 machine with local Docker, the runner resolves `django__django-11099` end to end with the
  real worker image: the agent works in the task container with no network, and the official harness grades the
  patch as resolved.
- **SC-003**: In production, from an enabled Slack channel, one Verified instance runs end to end: start notice,
  result with resolved status, duration and cost, artifacts in S3, and the instance terminated afterwards. `stop`
  during a run cancels it and terminates the instance.
- **SC-004**: Typecheck, lint and the full test suite pass.
