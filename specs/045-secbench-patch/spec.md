# Feature Specification: Run SEC-bench Patch Tasks from Slack

**Feature Branch**: `feat/045-secbench-patch`  
**Created**: 2026-10-01  
**Status**: Implemented and released (SC-003 checked 2026-10-01)  
**Input**: Request to measure the AgentX coding agent on a security benchmark, after specs 043 and 044 put
SWE-bench and SWE-Bench Pro runs in Slack

## User Scenario

### A member scores the coding agent on fixing one real vulnerability (Priority: P1)

A member of an eval-enabled channel posts `@agentx eval secbench patch njs.cve-2022-32414`. AgentX runs the same
coding agent on SEC-bench's patch task for that CVE and posts the result in the thread, as a SWE-bench run does
(spec 043): fixed or not, at which step a failure happened, why the agent stopped, time, cost and where the
artifacts are.

### Why SEC-bench, and why the patch task first

SEC-bench (Lee et al., NeurIPS 2025, MIT licensed) holds 300 verified memory-safety vulnerabilities in C and C++
projects (gpac, mruby, ImageMagick, libxml2, njs, PHP and others): 200 CVEs and 100 OSS-Fuzz bugs. Each ships an
x86 Docker image on the OSS-Fuzz base with the project at the vulnerable commit and a `secb` script that builds it
under a sanitizer and runs the vulnerability's proof of concept (PoC). Frontier agents fix about a third of the CVE
set (34% best published, OpenHands with Claude 3.7 Sonnet), so unlike SWE-bench Verified it is far from saturated,
and a pass is checked by a sanitizer rather than a judge.

SEC-bench has two tasks: write a PoC that triggers the bug, and patch the bug. The patch task comes first: fixing
a reported vulnerability without breaking the build is what customers ask the coding agent to do, and it reuses
spec 043's runner almost whole (the agent writes a diff; a grader checks it in a fresh container). PoC generation
is a follow-up spec.

### What a pass means, and what it does not

SEC-bench grades a patch by applying it, rebuilding, and running the PoC: it passes when the build succeeds, the
PoC produces no sanitizer report, does not time out, and exits as the dataset expects. **It runs no project tests**,
so a patch that disables the crashing code path can pass. Published scores share this, so ours are comparable, but
every place a SEC-bench number is shown (thread, site, deck) MUST say "sanitizer-verified, no regression tests".

## Requirements

### Slack command

- **FR-001**: The Slack service MUST recognize `eval secbench patch <instance-id> [model <name>]` as a whole message,
  as it does `eval swebench`. It maps to a new dataset `secbench-patch` (Hugging Face `SEC-bench/SEC-bench`, config
  `default`, split `eval`, 300 rows) in family `secbench`. An instance ID MUST match the pattern SEC-bench writes
  (`^[a-z0-9][a-z0-9_+-]*\.(cve-\d{4}-\d{4,}|ossfuzz-\d+)$`, e.g. `njs.cve-2022-32414`,
  `libxml2.ossfuzz-417247563`; all 300 IDs of the `eval` split matched on 2026-10-01, and every `work_dir` is under
  `/src/`), and a test MUST check the pattern against that list. `eval secbench` without `patch`, or with `poc`, MUST be refused with the usage line
  (PoC is not built yet).
- **FR-002**: Everything else in spec 043 applies unchanged: channel enablement and its cost ceiling, model
  selection against the project's approved models, one active run per deployment (shared with SWE-bench runs),
  `stop`, the run record, the eval state machine and its two-hour ceiling.

### Task source

- **FR-003**: The runner MUST read the instance's row from the `eval` split. The dataset loader MUST take the split
  from the dataset table instead of assuming `test`, and MUST accept a SEC-bench row, which has no
  `problem_statement` or `image`: the image is `hwiwonlee/secb.eval.x86_64.<instance_id>:patch`, and the repository
  is at the row's `work_dir` (validated as an absolute path under `/src/`). The image digest and the Hugging Face
  dataset revision MUST be recorded in the result.

### Agent phase

- **FR-004**: The runner MUST copy `work_dir` out of the image and mount it back, as spec 043 does for `/testbed`,
  and strip history beyond HEAD (SEC-bench images already hold a single shallow commit at `base_commit`; the strip is
  a check). The image's `/testcase` (with the PoC) and `/usr/local/bin/secb` stay in place, so the agent can run
  `secb build` and `secb repro` as the benchmark intends. There is no conda activation.
- **FR-005**: The agent's prompt MUST be SEC-bench's own patch prompt (`src/smolagents/prompts/patch.j2` in
  `SEC-bench/smolagents` at a pinned commit, `a945dba9d6f2594cd94eb00d77f6b41a92fea88b` when written), rendered with
  the row's `work_dir`, `bug_description` and `sanitizer_report`, after a fixed preamble (where the repository is in
  the shell, no network). The template is bundled in the runner image with its SHA-256 recorded in the code, so a run
  does not fetch it. The gold `patch`, `bug_report` (which contains the original reporter's PoC and discussion) and
  `exit_code` MUST NOT be given to the agent.
- **FR-006**: The agent MUST run with no network (`--network none`) and stop at 60 minutes, the cost ceiling, an
  unknown cost, or the tool-loop guard at 200 calls, as on SWE-bench Verified (D-3).
- **FR-007**: The prediction MUST be built as SEC-bench's agents build it: every change against the image's HEAD,
  including new files, limited to `*.c *.cpp *.h *.hpp *.cc *.hh`. Build outputs the agent's `secb build` leaves in
  the repository are therefore not part of it.

### Grading

- **FR-008**: The runner MUST grade with SEC-bench's own evaluator (`secb/evaluator/eval_instances.py` in
  `SEC-bench/SEC-bench` at a pinned commit, `31eb43485a3de47da260be0f978528b1f2314415` when written), installed with
  uv into a virtualenv, with only the packages the evaluator imports, pinned (`datasets`, `docker`, `jinja2`,
  `loguru`, `rich`, `pydantic`), not the repository's `requirements.txt`, which pulls `smolagents@main` unpinned.
  The repository is not a Python package, so the runner fetches it at the pinned commit (git) and runs it from there.
  The runner writes the prediction as SWE-agent's `preds.json` (`{"<id>": {"model_patch": "<diff>"}}`) and runs
  `python -m secb.evaluator.eval_instances --type patch --agent swea --mode all --split eval --input-dir … --output-dir …`.
  The evaluator starts its own fresh container from the `:patch` image (with Docker's default network, as
  published), applies the patch, builds, and runs the PoC with a 10-second limit. It bind-mounts a Python temporary
  directory into that container, and the host's Docker resolves the path, so the runner MUST set `TMPDIR` to a folder
  under `RUN_ROOT` but outside the run's root (which the agent's container mounts); the runner container mounts
  `RUN_ROOT` at its own path (spec 043's arrangement); otherwise the grading container sees an empty `/tmp` and every
  patch fails to apply.
- **FR-008a**: Two evaluator failures look like an unresolved patch and MUST instead fail the run: a dataset that did
  not load (the evaluator logs and continues with no rows, which silently turns `medium` into `strict`; the runner
  requires its `Loaded 300 instances` log line, read as the output streams, with the evaluator at loguru's `INFO`
  level), and a container that could not be created or pulled (exit code `-1`, with a `Failed to` message in its
  logs). At the pinned commit a dataset that did not load also reports exit code `-1` with `Instance not found in
  dataset`, which the `-1` check catches too. A missing `report_medium.jsonl` or one without the instance also fails
  the run.
- **FR-009**: The run is resolved when the evaluator's `medium` report says success, which is the published default.
  The result MUST also record the `strict` and `generous` verdicts, the step that failed (apply, build, PoC), the PoC's
  exit code, and whether a sanitizer report or a timeout was seen. An empty prediction is reported unresolved without
  running the evaluator, as in spec 043.
- **FR-010**: The graded result schema MUST gain an optional `secbench` object for those fields, and the Slack result
  message MUST show them in place of the FAIL_TO_PASS/PASS_TO_PASS line, with the "no regression tests" note
  (see What a pass means). Because the broker's result schema is strict, the broker change MUST ship in a release
  before the runner image that sends the field.
- **FR-011**: The evaluator's reports (`report_strict.jsonl`, `report_medium.jsonl`, `report_generous.jsonl`) and its
  container log MUST be stored under the run's `harness/` artifacts, with `patch.diff`, `transcript.jsonl` and
  `result.json` as in spec 043.

### Limits and infrastructure

- **FR-012**: No new infrastructure. Images are 1 to 1.7 GB compressed, about 4 GB on disk, so one per run fits the
  150 GiB root volume (each run has its own instance). Docker Hub is already reachable over HTTPS.
  The run fits the two-hour ceiling: setup, the agent's 60 minutes, and grading capped by the evaluator at 10 minutes.

## Out of Scope

The PoC-generation task (next spec), the `poc-repo`/`poc-desc`/`poc-san` variants, SEC-bench Pro (V8, Firefox,
Linux), batches and repeats (the batch spec that SWE-bench also needs), and adding regression tests to SEC-bench's
grading.

## Decisions

- **D-1** (2026-10-01): Grade with SEC-bench's own evaluator rather than re-running its script templates, so a pass
  means what it means in the paper (as spec 044 D-2 does for Pro). Fallback, if the evaluator cannot be driven for one
  instance: render its `eval_patch_script.j2` at the pinned commit and apply its `medium` rule; only the grader file
  changes.
- **D-2** (2026-10-01): The agent gets the `:patch` image with the PoC in `/testcase`, as in the paper, so it can
  reproduce and verify. This is part of the benchmark's patch protocol, not a leak.
- **D-3** (2026-10-01): Keep AgentX's limits (60 minutes, 200 tool calls) rather than copy the paper's 75-iteration
  cap. The paper's agents (SWE-agent 1.0.1, OpenHands 0.33.0, at temperature 0) differ from ours anyway; the limits are
  recorded in `result.json` so a published comparison can state them.
- **D-4** (2026-10-01): Report `medium` as resolved, and record `strict` and `generous` too, so a stricter claim is
  available without rerunning.
- **D-5** (2026-10-01): Shared run lock and records with SWE-bench (`SWEBENCH#ACTIVE`, `SWEBENCH_RUN#`) rather than a
  second set, because only one eval instance runs per deployment either way. Renaming them to a generic `EVAL` prefix
  is not worth a migration now.

## Open Questions

- **Q-1** (answered 2026-10-01, SC-002): `secb build` succeeds with `--network none` for njs, gpac and ImageMagick, and
  the unpatched PoC fires the sanitizer in each.
- **Q-2** (answered 2026-10-01, SC-002): sanitizer builds on an `m7i.xlarge` took 12 s (njs), 84 s (gpac) and 44 s
  (ImageMagick), so the 60-minute limit stands.

## Success Criteria

- **SC-001**: Unit tests cover the command (valid, `poc` refused, missing `patch`, bad ID), the ID pattern against all
  300 IDs, the split-aware loader and the SEC-bench row, prompt rendering from the bundled template (and its checksum),
  hidden fields never reaching the prompt, the source-file-only prediction, the evaluator's three reports (resolved,
  build failure, sanitizer still fires, PoC timeout, patch that does not apply), the empty-prediction path, and the
  Slack result message.
- **SC-002**: Before any agent run, on an x86 machine with Docker, for one instance each of njs, gpac and ImageMagick:
  `secb build` and `secb repro` work in the task container with `--network none` (the unpatched PoC fires the
  sanitizer), build times are recorded, and the pinned evaluator, driven as FR-008 describes, resolves the gold patch
  and does not resolve an empty one.
  Checked on 2026-10-01 on an `m7i.xlarge` (AL2023, Docker, Python 3.11) in the eval subnet: all three built and
  reproduced offline (njs SEGV, gpac SEGV, ImageMagick heap-buffer-overflow), each image held one commit, and the
  pinned evaluator with the pinned packages loaded 300 instances and graded njs's gold patch resolved in all three
  modes (16 s) and an empty patch unresolved. Not covered: the evaluator driven from inside the runner container
  (FR-008's `TMPDIR` arrangement), which SC-003's first production run exercises.
- **SC-003**: In production, from the eval channel, one instance runs end to end on Sonnet 4.6, with the result in the
  thread, artifacts in S3, and the instance terminated afterwards.
  Checked on 2026-10-01 (run `deba2b61`, release `a4b862f`): `njs.cve-2022-32414` resolved on Sonnet 4.6 in all three
  modes; the agent finished after 27m 40s for $7.23 (17.2M tokens, 98% cache reads). The grading container's log shows
  the patch applied, the build passed and the PoC exited 0 with no sanitizer report, so FR-008's `TMPDIR` arrangement
  works from inside the runner container. All artifacts reached S3 and the instance terminated. The agent's fix (one
  line in `njs_vmcode.c`) differs from the reference patch (input checks in `njs_promise.c`), which is the "no
  regression tests" caveat in practice.
- **SC-004**: Typecheck, lint and the full test suite pass; SWE-bench and SWE-Bench Pro runs are unchanged.
