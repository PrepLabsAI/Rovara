# Batches of Eval Runs Implementation Plan (spec 052)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a batch of (task, model, repeat) eval runs from a file or Slack. Runs execute several at once under a shared limit and a cost cap, and the batch produces a CSV and a per-model summary.

**Architecture:**
- The single-run lock becomes a **slot counter** plus one **slot item per run**, released exactly once by both release sites: the broker's `finishRun` and the state machine's `EndRun`.
- A **batch record** holds a queue. `topUpBatches()` claims queued entries and starts them through the existing `startSwebenchRun`. It runs inline after every result callback, and on a 2-minute schedule, which also reconciles slots.
- The broker cannot post to Slack (D11), so the **Slack service** watches active batches by polling the broker and posts progress, as it waits on single runs today.

**Tech Stack:** TypeScript, zod, AWS SDK v3 (DynamoDB, S3, Step Functions, EventBridge Scheduler), CDK, vitest.

**Spec:** `specs/052-eval-batches/spec.md`

## Global Constraints

- **Single-run behaviour stays unchanged** (spec 043/044/045), except:
  - the "run active" refusal is reworded to `N eval runs are in progress; try again shortly` (reason code stays `RUN_ACTIVE`);
  - `stop` finds runs by thread.
- **Slot release is exactly-once.** A transaction deletes the run's slot item (`attribute_exists(pk)`) and decrements the counter (`#count > :zero`). Both release sites use the same conditions.
- **`maxConcurrentEvals`** lives in `SwebenchSettingsSchema` (`packages/contracts/src/swebench.ts:263`): `z.number().int().min(1).max(6).default(4)`, so existing stored JSON stays valid.
- **Run IDs in a batch** are deterministic: a UUID derived from `batchId:index:attempt`, so `startSwebenchRun` stays idempotent (`swebench.ts:114-118`).
- **No paid runs during development.** All tests are offline: `FakeDynamoDb` (`tests/support/fake-dynamodb.ts`), `vi.fn` for S3, Step Functions and Scheduler, stubbed fetch for the CLI. `FakeDynamoDb` rejects reserved words, so use `#names` for `status`, `count`, `result`. Verify it supports `#count < :limit` and `ADD` before relying on them; extend the fake if needed, with its own test.
- Node 22 (scratchpad PATH). `npm run build` before tests.
- Pratik owns this code. Every change keeps the existing tests passing unchanged, except tests that assert the refusal wording or the lock item, which change with a one-line reason in the commit.

## Review Focus

1. **Two release sites.** `finishRun` (`packages/broker/src/aws/swebench.ts:264-304`) and `EndRun` (`infra/lib/swebench-eval-definition.ts`, about :128-160) must both move from deleting `SWEBENCH#ACTIVE/LOCK` to releasing the slot item and counter. If either one is missed, slots leak.
2. **The state machine's catch.** `EndRun`'s catch to `Terminate` swallows every error, so a failed decrement would leak silently. Narrow it to the "run already terminal" conditional failure.
3. **Migration.** A `SWEBENCH#ACTIVE/LOCK` item left by a run that was in flight during deploy is invisible to the counter. Release must tolerate a run with no slot item (no decrement), and the reconcile pass fixes drift.
4. **Stop.** `stopSwebenchRun` (`swebench.ts:203`) reads the single lock's `threadSubject`. It must look up runs by thread, and for a batch thread, stop the batch.
5. **Cost cap.** The cap must hold under concurrency: two top-ups at once must not both start the last run that fits.

## File Structure

| File | Change |
|---|---|
| `packages/contracts/src/swebench.ts` | `maxConcurrentEvals`; batch schemas (file, record, run measures, summary); Slack `eval batch` parser; the reworded refusal text |
| `packages/contracts/src/eval-stats.ts` | create: Wilson interval and per-model rollup (pure functions) |
| `packages/broker/src/aws/swebench.ts` | slot counter in start, finish and stop; batch `runId` link |
| `packages/broker/src/aws/eval-batches.ts` | create: batch create, show, stop, `topUpBatches`, results append, CSV and summary writer, reconcile |
| `packages/broker/src/aws/eval-batch-tick.ts` | create: the scheduled Lambda entry, calling `topUpBatches` and reconcile |
| `packages/broker/src/aws/broker.ts` | routes: admin `POST/GET /v1/admin/evals/batches[/<id>[/stop\|/results]]`, service `POST /v1/evals/batches`, `GET /v1/evals/batches/active`; wiring |
| `infra/lib/swebench-eval-definition.ts` | `EndRun` releases the slot item and counter; narrowed catch |
| `infra/lib/control-plane.ts` or `session-lifecycle.ts` | the tick Lambda and a 2-minute schedule (pattern at `session-lifecycle.ts:189-193`) |
| `packages/cli/src/admin/eval.ts`, `packages/cli/src/main.ts:541` | `admin eval batch start\|show\|stop\|results` |
| `packages/slack-service/src/eval-batch-command.ts`, `processor.ts` | create: the Slack batch form and the batch-thread watcher |
| tests | next to the existing `swebench-broker`, `swebench-eval-infrastructure`, `cli-admin-eval` and `slack-swebench` tests |

---

### Task 1: Contracts and statistics

- [ ] **`SwebenchSettingsSchema` gains `maxConcurrentEvals`.** Test that stored JSON without the field parses, with a default of 4, and that 7 is refused.
- [ ] **`EvalBatchFileSchema`**, per spec FR-001:
  - `benchmark` (dataset name from `SWEBENCH_DATASETS`);
  - `tasks`: a list of IDs that fit the dataset (reuse `swebenchInstanceIdFits`), or `sample: {count, seed, strata?}`;
  - `models`: each `{provider, modelId, thinkingLevel, provider routing?}`. If spec 053 has merged, reuse its `ModelSelectionSchema` and `ThinkingLevelSchema`; otherwise define it locally with a TODO-free comment pointing to 053;
  - `repeats` (1-5), `order` (`cheapest-first` | `as-listed`), `concurrency` (1-6), `costCapUsd` (1-1000);
  - `runnerImage?`: an ECR image pinned by digest, the regex at `swebench.ts`'s `SwebenchLaunchSchema`;
  - at most 500 runs in total.
- [ ] **`EvalBatchRecordSchema`:**
  - id, file, `createdBy`, thread;
  - status `QUEUED|RUNNING|STOPPING|DONE|STOPPED|CAPPED`;
  - the queue: entries with index, task, model, repeat, attempt, `state`, and `runId?`;
  - spent, counts, timestamps.
- [ ] **`EvalRunMeasureSchema`**, one CSV row: the fields of spec FR-010.
- [ ] **`EvalBatchSummarySchema`:** per model: runs, resolved, rate, Wilson low and high, total cost, and cost per solved task (`null` when none was solved).
- [ ] **Slack parser:** `parseEvalBatchCommand` for `eval batch <benchmark> <dataset> <ids…> models <a, b…> [repeats N] [cap $X]`. It allows at most 20 runs, and its errors use the same style as `parseSwebenchCommand`. It must not collide with `eval swebench` or `eval secbench`.
- [ ] **`eval-stats.ts`:** `wilsonInterval(successes, n, z = 1.96)` and `summarize(measures)`, tested against known values (e.g. 6/8 gives about 0.409-0.929).
- [ ] Commit: `feat(contracts): eval batch file, record, measures and summary (spec 052)`.

### Task 2: The slot counter replaces the lock

- [ ] **`startSwebenchRun`** (`swebench.ts:111`): drop the `get(ACTIVE_KEY)` pre-check (:128). In the transaction (:144-149), replace the lock Put with two items:
  - an Update on `{pk:"SWEBENCH#SLOTS", sk:"COUNTER"}`: `SET #count = if_not_exists(#count, :zero) + :one`, conditioned on `attribute_not_exists(#count) OR #count < :limit`, where `:limit` is the deployment's `maxConcurrentEvals`;
  - a Put on `{pk:"SWEBENCH#SLOT", sk:"RUN#<runId>"}` with `threadSubject` and `batchId?`.

  A condition failure on the counter means the reworded `RUN_ACTIVE` refusal, with N.
- [ ] **`finishRun`** (:264-304): replace the lock Delete with a Delete of the slot item (`attribute_exists(pk)`) and an Update decrementing the counter (`#count > :zero`), in the same transaction as the run update. A run with no slot item (the migration case) updates the run only, through a retry without the slot parts on that specific cancellation reason.
- [ ] **`EndRun`** (`infra/lib/swebench-eval-definition.ts`): the same three-item transaction in DynamoDB wire format. Narrow the catch to the conditional-check failure for an already-terminal run. Any other error goes to a state that still terminates the instance, then fails the execution, so CloudWatch alarms see it. Update `tests/contract/swebench-eval-infrastructure.test.ts` to assert the new items and the narrowed catch.
- [ ] **`stopSwebenchRun`** (:203): find the thread's active runs by querying slot items by `threadSubject` (a filter on `pk = SWEBENCH#SLOT` is acceptable at 6 items), and cancel each. If the thread is a batch thread, also stop the batch (Task 3's `stopBatch`).
- [ ] **Tests:**
  - two runs start, and a third is refused when the limit is 2;
  - finishing frees a slot;
  - a double finish, or broker plus state machine both releasing, decrements once;
  - the migration case;
  - stop by thread with 2 runs;
  - every existing `swebench-broker.test.ts` case passes, with only the refusal wording changed.
- [ ] Commit: `feat(eval): a shared limit on concurrent eval runs replaces the one-run lock (spec 052)`.

### Task 3: Batch records, top-up, cap, retry, stop

- [ ] **`createBatch(file, requester, thread)`:**
  - validate the file;
  - check that every model is approved for the channel's project;
  - expand tasks: a `sample` is drawn once with the seed and written down;
  - expand the queue as task × model × repeat;
  - order the queue (`cheapest-first` uses a per-model cost estimate: the model's list prices × a fixed reference token mix, and record the estimate);
  - pin the runner image (the file's, or the current one, resolved once);
  - write `EVAL_BATCH#<id>`.
- [ ] **`topUpBatches()`:** for each `RUNNING` batch, while slots are free and the next start fits the cap (`spent + inFlight × perRunCeiling + perRunCeiling ≤ costCapUsd`):
  1. claim the next queued entry with a conditional update on the batch record (`state = QUEUED` → `STARTING` plus a version check);
  2. call `startSwebenchRun` with the deterministic `runId` and the batch's pinned image and model selection;
  3. on `RUN_ACTIVE`, release the claim and stop topping up.

  When the cap stops new starts, set status `CAPPED` once the in-flight runs finish.
- [ ] **On run end:** `handleSwebenchCallback` calls `recordBatchRunEnd(run)` after `finishRun`, then `topUpBatches()`. So does the tick, for runs the state machine ended. `recordBatchRunEnd`:
  - adds the cost to `spent`;
  - appends the run's measure row;
  - on an infrastructure `FAILED` (instance lost, image pull, model access, recognised from the run's error text and pinned by tests), requeues it once with `attempt + 1`.

  Graded runs are never requeued.
- [ ] **Run IDs:** pass the batch's runner image and model selection into the run launch. Add optional `runnerImage` and `batchId` to the run record and to `SwebenchLaunchSchema`'s source, defaulting to today's behaviour.
- [ ] **`stopBatch(id)`:** mark `STOPPING`, cancel queued entries, and cancel in-flight runs via the stop path. The status becomes `STOPPED` when they end.
- [ ] **Tests,** with a fake clock:
  - claim races (two top-ups, one free slot, exactly one start);
  - the cap boundary (no start that could exceed the cap);
  - an infrastructure retry once, then failed;
  - no retry of a graded result;
  - stop;
  - the deterministic run ID making a repeated top-up idempotent.
- [ ] Commit: `feat(eval): batches queue runs under a cost cap and fill free slots (spec 052)`.

### Task 4: Results, tick and reconcile

- [ ] **When a batch reaches `DONE`, `STOPPED` or `CAPPED`,** write `evals/batches/<id>/results.csv` (a header and one row per measure, values escaped) and `summary.json` (`summarize`) to the artifact bucket.
- [ ] **`eval-batch-tick.ts`:** a scheduled Lambda, every 2 minutes, that is a no-op when no batch is active. It runs `topUpBatches()`, records the ends of runs the state machine finished, and **reconciles**: it counts slot items against active run records, and fixes the counter and deletes slot items of terminal runs, logging each correction. It is added with `packagedFunction` and `scheduler.Schedule`, following `session-lifecycle.ts:189-193`, with least-privilege IAM (table read/write, artifact bucket write under `evals/batches/*`, `states:StartExecution` through the broker's existing path), and with an infrastructure test.
- [ ] **Tests:** the CSV format (escaping, column order), `summary.json`, reconcile fixing a leaked slot and a negative counter, and the tick no-op.
- [ ] Commit: `feat(eval): batch results, a scheduled top-up and slot reconcile (spec 052)`.

### Task 5: CLI

- [ ] `agentx admin eval batch start --file <path> --team <T> --channel <C>`: posts to the admin route, prints the batch ID and thread.
- [ ] `show <id>`: progress.
- [ ] `stop <id>`.
- [ ] `results <id> [--csv <path>]`: downloads through the broker; the broker reads S3, so the CLI needs no AWS credentials.
- [ ] Routes use `requireAdministrator`. Tests follow `tests/contract/cli-admin-eval.test.ts`'s fetch stub.
- [ ] Commit: `feat(cli): agentx admin eval batch start, show, stop, results (spec 052)`.

### Task 6: Slack batch form and thread watcher

- [ ] **`eval batch …` in an enabled channel:** parsed (Task 1), the models resolved against the project's approved list (as `runSwebenchCommand` does), the batch created via the service route, then a start message in the thread.
- [ ] **A batch watcher in the Slack service:** a loop that polls `GET /v1/evals/batches/active` every 30 s. For each batch it:
  - posts a progress update in the batch's thread when the counts change, rate-limited to one post per 5 minutes plus one per finished model;
  - posts the final summary table when the batch ends;
  - survives restarts: the last-posted counts are stored on the batch record via a service route, so a restarted watcher doesn't repost.

  Batches started from the CLI get their thread created by the watcher's first post, in the channel the file names. It does not use the per-message wait (`waitForRun`), whose 2-hour limit doesn't fit batches.
- [ ] **`stop` in a batch thread** reaches `stopBatch` through Task 2's thread lookup.
- [ ] **Tests:** in the style of `tests/integration/slack-swebench.test.ts`, with stubbed APIs and a fake clock: the start message; the progress rate limit; the final table format (exact text); restart idempotence; stop.
- [ ] Commit: `feat(slack): eval batches from Slack, with progress and a summary in the thread (spec 052)`.

### Task 7: Verify

- [ ] `npm run build && npm run typecheck:all && npm run lint && npm test`, all green.
- [ ] Set the spec status to "Implemented; awaiting release". Push to the existing PR #242 branch, and retitle the PR.
