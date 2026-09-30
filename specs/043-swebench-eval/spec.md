# Feature Specification: Run SWE-bench Tasks from Slack

**Feature Branch**: `feat/043-swebench-eval`  
**Created**: 2026-09-30  
**Status**: Implemented; awaiting deployment (SC-002 agent run, SC-003)  
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
  `full`, mapped to `SWE-bench/SWE-bench_Verified`, `SWE-bench/SWE-bench_Lite` and `SWE-bench/SWE-bench`
  (the harness 5.x datasets, whose rows name each task's image, eval script and log parser). The pilot accepts
  exactly one instance ID.
- **FR-002**: Eval MUST be off unless an administrator enables it for a bound channel
  (`agentx admin eval enable --team <id> --channel <id> [--max-cost-usd <n>]`, `show`, `disable`). The cost ceiling defaults to
  10 USD per run and MUST be between 1 and 100. Any member of an enabled channel MAY start a run. A channel that
  is not enabled MUST get a reply saying eval is not enabled there, and nothing is started.
- **FR-003**: `model <name>` MUST resolve against the channel project's approved models, as `use` does. Without
  it, the run uses the project's current model, or the worker settings' model when the project approves none.
  The chosen provider and model ID MUST be recorded on the run. A model whose cost the worker cannot estimate (an
  OpenRouter model without pricing) MUST NOT run past its first model turn, since the cost ceiling could not be
  enforced: pricing is known only to the worker's Pi model registry, so the runner stops it (`cost_unknown`).
- **FR-004**: An unknown dataset, a malformed instance ID, or a second run while one is active in the deployment
  MUST be refused in the thread with the reason. The pilot allows one active run per deployment. An instance ID
  that is well formed but not in the dataset is found by the runner, whose run fails with that reason within
  minutes.
- **FR-005**: `stop` in the run's thread MUST cancel the run (spec 039's stop path), terminate its instance and
  report it as cancelled.

### Control plane

- **FR-006**: The broker MUST record each run (`SWEBENCH_RUN#<id>`: dataset, instance ID, model, requester,
  thread, status, timings, result with token usage and cost), take the deployment's lock (`SWEBENCH#ACTIVE`) in
  the same transaction, write the run's launch file, and start it through a Step Functions state machine that
  launches one x86 instance from an eval launch template, polls the run, and terminates the instance on
  completion, failure, cancellation or a 2-hour ceiling. A run the machine ends it marks terminal and unlocks.
- **FR-007**: The runner MUST report through its own callback routes (`/v1/internal/evals/<run>/started|result`)
  with a capability bound to the run and signed with a key derived for evals, so neither an eval nor a workspace
  capability passes for the other. The runner never holds a Slack token, and neither does the broker (D11): the
  Slack service polls the run and posts to the thread (D-4).

### Eval runner

- **FR-008**: The runner MUST be a mode of the worker image (same Pi session code, tools and prompts,
  `swebench-main.js`), built for `linux/amd64` by `npm run swebench:runner-image`, which writes the eval
  runner-image parameter the broker reads per run. It is not part of the production release.
- **FR-009**: For the instance, the runner MUST pull the image its dataset row names, record the digest it
  resolved to in the result, copy `/testbed` to a host folder, and start the task container with that folder
  mounted at `/testbed`, so the image's editable install and compiled extensions see the agent's edits. Every
  shell command starts in the image's `testbed` conda environment.
- **FR-010**: Before the agent starts, the runner MUST leave the copy's HEAD where the image left it (the
  harness's "SWE-bench" setup commit on top of the base commit, which it checks), and remove every other ref,
  remote, tag, reflog and unreachable object, so the upstream fix cannot be found in history.
- **FR-011**: The agent MUST run through `createWorkspacePiSession` with `bashOperations` executing in the task
  container and `devcontainerPaths` mapping `/testbed` to the host folder. The task container MUST run with
  `--network none`, so shell commands cannot reach the upstream repository or the web.
- **FR-012**: The agent's prompt MUST be the instance's `problem_statement` plus a fixed preamble (work in
  `/testbed`, do not modify tests). The hidden tests (`test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`) MUST NOT be
  visible to the agent.
- **FR-013**: The agent MUST stop at 60 minutes, at the tool-loop guard (spec 033), or when the session's
  `costUsd` reaches the channel's cost ceiling after a model turn, whichever comes first. If `costUsd` is ever
  unknown, the agent MUST stop as if the ceiling were reached. What it has changed by then is the prediction, and
  it is graded; the result MUST say why the agent stopped (finished, time limit, cost ceiling, cost unknown, loop
  guard, model error).
- **FR-014**: The runner MUST grade the prediction (`git diff --binary` against the image's HEAD, with the files
  the agent created) with the official SWE-bench harness at a pinned version (5.0.2, installed with uv), for that
  one instance, from a local copy of its row, and report resolved or not with the `FAIL_TO_PASS` and
  `PASS_TO_PASS` counts. An empty prediction is reported unresolved without running the harness.
- **FR-015**: The runner MUST store the patch, the Pi transcript, the harness report and test log under
  `s3://<artifact bucket>/evals/<run id>/`, and report token usage and cost as tasks do (`usage.ts`).

### Infrastructure

- **FR-016**: The eval launch template, instance role, security group and state machine MUST live in a new
  optional stack (`agentx-<env>-eval`, legacy production name `AgentXEval`), not in the foundation, so the
  foundation-drift check stays unaffected. Instance type `m7i.xlarge` (4 vCPU, 16 GiB), 150 GiB gp3 root
  volume, in the production VPC's private subnets.
- **FR-017**: The instance role MAY read only `evals/*/launch.json` and write only under `evals/` in the artifact
  bucket, invoke Bedrock models (and read the OpenRouter key when one is configured), and write its log group.
  The run's capability reaches only its own callback routes. Outbound traffic is HTTPS through the NAT to ECR,
  Docker Hub, Hugging Face, PyPI, the model provider and the control plane.

## Out of Scope

Batches of instances and parallel fan-out (a follow-up once the pilot works), SWE-Bench Pro, Multimodal and Live
(different images or harnesses), leaderboard submission, and scoring the orchestrator end to end.

## Decisions

- **D-1** (2026-09-30): Any member of an enabled channel may start a run; there is no per-member allowlist.
- **D-2** (2026-09-30): Each run has a cost ceiling (10 USD by default, set per channel) in addition to the
  60-minute limit, because a looping agent on an expensive model can spend several times a typical task's
  1–3 USD within the hour. A run that hits it is still graded.
- **D-3** (2026-09-30): The broker writes the run's configuration and capability to `evals/<run>/launch.json`,
  and the eval launch template's fixed boot script reads it by the run ID in the instance's tags. The capability
  stays out of EC2 user data, and the broker bundles no boot script.
- **D-4** (2026-09-30): The broker cannot read the Slack token (D11), and production has no notifier, so the
  Slack service waits for the run in the thread, polling every 30 seconds, as it waits for a coding task. The
  thread's later messages queue behind it; `stop` is handled before the queue.

## Success Criteria

- **SC-001**: Unit tests cover the command parser (valid, unknown dataset, extra instances, model selection),
  the enablement and single-active-run refusals, the refusal of a model with unknown cost, the cost-ceiling
  range, run records and state transitions, each reason the agent stops (including the cost ceiling and an
  unknown `costUsd` mid-run), history stripping, and the grading report parser.
- **SC-002**: On an x86 machine with local Docker, the runner resolves `django__django-11099` end to end with the
  real worker image: the agent works in the task container with no network, and the official harness grades the
  patch as resolved. Checked on 2026-09-30 without a model (arm64 Mac, amd64 emulation): the row, image pull,
  history strip, no-network task container, conda shell, and the harness grading the gold patch as resolved
  (FAIL_TO_PASS 3/3, PASS_TO_PASS 19/19). The agent run itself remains, on the eval instance.
- **SC-003**: In production, from an enabled Slack channel, one Verified instance runs end to end: start notice,
  result with resolved status, duration and cost, artifacts in S3, and the instance terminated afterwards. `stop`
  during a run cancels it and terminates the instance.
- **SC-004**: Typecheck, lint and the full test suite pass.
