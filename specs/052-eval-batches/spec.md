# Feature Specification: Batches of Eval Runs, Several at Once

**Feature Branch**: `docs/052-eval-batches` (spec), then `feat/052-eval-batches`  
**Created**: 2026-10-01  
**Status**: Draft  
**Input**: Spec 046's final campaign needs dozens of (task, model, repeat) runs. Today each run is one Slack command,
and one run at a time is allowed per deployment.

## Why

Single runs say almost nothing on their own. On 2026-10-01, Sonnet 4.6 failed `sympy__sympy-13878`, which it had
solved the day before, while GLM 5.3 solved it. Spec 046 needs about 72 SEC-bench runs plus a SWE-bench part. Typed
by hand and run one at a time, that is 30 hours or more, during which nobody else can run an eval. Batches run the
campaign in hours, with one cost cap and one results file.

## User scenarios

### An administrator runs the final campaign from a file (P1)

They commit `batch.yaml` next to spec 046, then run `agentx admin eval batch start --file batch.yaml`. The file
lists the benchmark, the tasks, the models (each with thinking level and OpenRouter provider), the repeats, the
order, the concurrency and a cost cap. AgentX replies with the batch ID and opens a thread in the eval channel. The
thread updates as runs finish ("12/72 done, 7 resolved, $41.20 spent"). When the batch ends, the thread gets a
summary table per model, and the CSV is in S3.

### A member starts a small batch from Slack (P2)

`@agentx eval batch secbench patch njs.cve-2022-32414 gpac.cve-2023-5586 models GLM 5.3, MiniMax M3 repeats 2 cap $20`
runs those 8 runs in the thread, with the same progress and summary.

### Someone starts a single run while a batch is going (P2)

Pratik posts `@agentx eval swebench verified django__django-11099`. It starts as soon as a slot is free. Single runs
and batch runs share one limit on how many evals run at once, so nobody is locked out.

## Requirements

### Batch definition

- **FR-001:** A batch file (YAML, validated by a zod schema in `@agentx/contracts`) names:
  - `benchmark`: any dataset spec 043, 044 or 045 accept;
  - `tasks`: a list of instance IDs, or `sample: { count, seed, strata? }` drawn once and written into the batch
    record;
  - `models`: each a project-approved model, with an explicit `thinkingLevel` and, for OpenRouter, a pinned
    `provider`;
  - `repeats`;
  - `order`: `cheapest-first` (default, by an estimated cost per run) or `as-listed`;
  - `concurrency`;
  - `costCapUsd`;
  - `runnerImage`: optional, pinned by digest. Every run in the batch uses it; when absent, the current runner image
    is resolved once at start and pinned.
- **FR-002:** The Slack form `eval batch <benchmark> <dataset> <ids…> models <a, b…> [repeats N] [cap $X]` builds the
  same definition, at most 20 runs, with the defaults: `cheapest-first`, the deployment concurrency, and thinking
  level and provider from the project's model settings.
- **FR-003:** A batch is refused, with the reason, if:
  - a model is not approved for the project, or its cost cannot be estimated;
  - a task ID does not fit its dataset;
  - the cap is outside 1-1,000 USD;
  - the runs exceed 500.

### Scheduling

- **FR-004:** The broker MUST record the batch (`EVAL_BATCH#<id>`) with its queue of runs, and start runs through the
  **existing** per-run path: `startSwebenchRun`, the run record, `launch.json`, and the eval state machine. Each run
  record carries its `batchId`.
- **FR-005:** The single-run lock (`SWEBENCH#ACTIVE`, `packages/broker/src/aws/swebench.ts:60`) becomes a **slot
  counter**: at most `maxConcurrentEvals` runs at once per deployment (default 4, at most 6 under today's quota of 32
  vCPUs for standard On-Demand instances, with 4 vCPUs per `m7i.xlarge`). Single and batch runs share it, and taking
  a slot is atomic. A single run that finds no free slot is refused with "N eval runs are in progress; try again
  shortly", the same reply as today's `RUN_ACTIVE`, reworded.
- **FR-006:** When a run reaches a terminal state, the slot is released, and if its batch has queued runs and spend is
  below the cap, the next queued run starts. The batch also tops up its slots on a timer (every 2 minutes), so a
  missed event never stalls it.
- **FR-007 (cost cap):** A new run starts only while `spent + (inFlight + 1) × perRunCeiling × 1.1 ≤ costCapUsd`
  (D-6). Runs in flight finish, so the overshoot is bounded by the per-run reservations. The thread says when the cap stopped the batch, and
  how many runs did not start.
- **FR-008 (failures):** A run that ends `FAILED` for an infrastructure reason (instance lost, image pull, model access)
  is retried **once**, in its batch. A graded result is never retried. A run that fails twice is recorded as failed,
  and spec 046 counts it separately (R-4).

### Control and results

- **FR-009:** `stop` in the batch thread, or `agentx admin eval batch stop <id>`, cancels queued runs and stops runs in
  flight through spec 039's path. `agentx admin eval batch show <id>` prints progress.
- **FR-010:** Each finished run's measures are appended to the batch's results. The measures are:
  - instance, model, provider, thinking level, repeat;
  - outcome, resolved, and the SEC-bench verdict or the test counts;
  - stop reason, agent seconds, tool calls;
  - tokens by kind, cost;
  - image digest;
  - spec 051's claim-and-check fields when present.

  At the end, the batch writes `evals/batches/<id>/results.csv` and `summary.json` (per model: runs, resolved, resolve
  rate with a 95% Wilson interval, total cost, and cost per solved task), and posts the summary table in the thread.
  `agentx admin eval batch results <id> --csv` downloads the CSV.

### Infrastructure

- **FR-011:** No new stack. The eval stack's state machine is reused per run. The broker gains the batch routes, and
  the timer is an always-on EventBridge schedule in the control plane, every 2 minutes (D-9). An idle tick is a few
  cheap reads, plus a slot repair when a slot is held (Ruling 10).

## Out of scope

- Running across deployments.
- Raising the EC2 quota. A larger `maxConcurrentEvals` needs a quota request first.
- Spot instances.
- Automatic analysis beyond the per-model summary. Spec 046's report is written from the CSV.

## Decisions

- **D-1 (2026-10-01):** Both a CLI with a file (for campaigns) and a short Slack form (for small batches).
- **D-2 (2026-10-01):** A shared limit on concurrent eval runs replaces the one-run lock, so single runs are never
  locked out.
- **D-3 (2026-10-01):** The batch feeds the existing per-run machinery (one run path), rather than a Step Functions Map
  state or a client-side loop.
- **D-4:** Pratik owns the runner, broker and eval state machine, and reviews this change. Single-run behaviour and its
  tests stay unchanged, apart from the lock-to-counter wording.
- **D-5 (2026-10-02, Ruling 4):** A run that reports no cost is charged its per-run ceiling, the upper bound its runner
  enforces, and its row is marked estimated (`costUsd` null, `chargedUsd` the ceiling, `costEstimated`). Ends that
  provably used no tokens are charged nothing: the instance could not be launched or recorded, the run could not start,
  or it was cancelled before its runner started. A FAILED result's usage is kept on the run record, so its reported cost
  survives whichever path records the end. A reported cost is charged rounded to a millionth of a dollar, as spend is,
  so the rows' charges sum exactly to the batch's spend (Ruling 17). A runner that reports `started` after a stop is
  charged its ceiling. A `started` that arrives after the run has ended is refused with a final 409 (Ruling 16): the
  runner stops before its agent starts, and the run keeps the charge it already has. When the batch tick ends a run
  whose execution died, it terminates the run's instance first, if the run recorded it.
- **D-6 (2026-10-02, Ruling 5):** The runner halts only after a turn crosses its ceiling, so each run in flight, and the
  next start, reserves its ceiling plus 10%: a start fits while `spent + (inFlight + 1) × ceiling × 1.1 ≤ costCapUsd`.
- **D-7 (2026-10-02, Ruling 6):** A batch's models are checked against the project's approved list when the batch is
  created, not again at each start; the batch runs what it recorded.
- **D-8 (2026-10-02, Ruling 7):** A retry that the cap or a stop keeps from starting still ends its task's attempt chain
  with a FAILED row, charged $0, whose error names the cap or the stop. Every task in the batch therefore ends in a
  terminal row.
- **D-9 (2026-10-02, Rulings 10, 13, 14):** The batch timer runs every 2 minutes whether or not a batch is active,
  instead of being switched on with a batch: an idle tick reads the active list, the slot counter and at most one slot
  item, and repairs the slots when one is held, so a leaked slot never blocks single runs. The tick also ends a run
  whose execution died without ending it, found by DescribeExecution once the run is 10 minutes old (or, with no
  recorded execution, past its time limit plus 15 minutes), as an infrastructure failure charged per D-5. A tick that
  cannot top up a batch, or finds a batch's rows incomplete or not summing to its spend, fails, so its alarm fires.
- **D-10 (2026-10-02, Ruling 22):** The Slack service's batch watcher reads its own index, `EVAL_BATCHES#WATCH`, not
  the active list. The index is written with the batch and removed once the summary is posted (or the entry is
  dropped, D-12). The active list cannot serve: the tick removes a batch from it when it writes the results, before
  the summary can be posted. The Slack form's defaults:
  - a model the project approves with no thinking level runs at the runtime's own default: `medium` for a reasoning
    model, else `off`; a model the catalog does not know is refused;
  - an OpenRouter model gets the deployment's OpenRouter providers;
  - with no `cap $X`, the cap is every run's reservation (runs × the channel's ceiling × 1.1), rounded up to cents and
    at most $1,000.
- **D-11 (2026-10-02, Ruling 23):** The Slack form's batch ID is derived from the form as received, plus the team,
  channel and thread. The form is the benchmark, the instances, the model names as typed (ignoring case and spacing),
  the repeats, and the cap if one was given. No default resolved at request time is part of it. So a redelivered
  event finds the batch it created, even if the project's thinking levels, the providers or the channel's ceiling
  changed in between. The same form in another thread is another batch.
- **D-12 (2026-10-02, Rulings 22, 24, 26):** A batch that has not ended is never dropped. The watcher stops watching
  an ended batch, logged as an error naming the batch, when:
  - its channel is unbound, or now serves another project;
  - Slack answers a permanent error for its channel: `channel_not_found`, `is_archived`, `channel_is_archived` or
    `team_access_not_granted`;
  - it ended more than 7 days ago without its summary posted.

  A running batch is handled differently:
  - while its channel is unbound or rebound, it is left out of the list and logged as an error once; it is watched
    again once the channel serves its project again;
  - on a permanent Slack error, it is only backed off.

  `not_in_channel` and `restricted_action`, which an admin can fix, are never treated as permanent. After any failure
  that does not drop the batch, the watcher leaves it alone for 10 minutes.

  Each post is claimed on the batch record before it is made. A CLI batch's opener stores its timestamp before the
  thread is recorded, so a failed record retries the record, not the post. A posted summary is recorded with its
  timestamp. Within one process, both timestamps are kept until recorded. The risks that remain, accepted as
  reviewed:
  - a claimed progress post whose Slack call fails is lost, with any "model is done" line it carried;
  - a crash between a post and its record (or a Slack call that timed out after Slack delivered it) can repeat that
    opener or summary, once its claim is 10 minutes old;
  - a Slack form whose start message failed posts it on the redelivery, unless the record of the post was written.

## Success Criteria

- **SC-001:** Tests cover:
  - batch file validation, and the refusals;
  - the Slack form;
  - atomic slot taking under contention;
  - run-ended → next run;
  - the timer top-up;
  - the cost-cap stop, and the overshoot bound;
  - the single infra retry, and no retry of graded results;
  - `stop`;
  - the CSV, `summary.json` and the Wilson interval;
  - a single run starting while a batch holds slots.
- **SC-002:** No paid run is made during development (pre-launch decision). The first real batch is spec 046's
  shakedown slice, which checks the whole path: concurrency, the cap, results and the thread.
- **SC-003:** Typecheck, lint and the full suite pass, and spec 043/044/045 single runs are unchanged.
