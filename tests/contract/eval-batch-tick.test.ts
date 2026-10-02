// Spec 052 Task 4: the batch tick. It records run ends the broker missed, fills free slots with no
// start cap, reconciles the slot counter, and at a batch's end rebuilds lost rows (Ruling 8) and
// writes results.csv and summary.json. Offline: FakeDynamoDb, a vi.fn state machine and S3.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalBatchSummarySchema, summarize } from "@agentx/contracts";
import {
  EVAL_BATCH_RESULTS_COLUMNS,
  createBatch,
  evalBatchResultsCsv,
  evalBatchRunId,
  getBatch,
  listBatchMeasures,
  reconcileBatchRows,
  stopBatch,
  stopBatchForThread,
  topUpBatches,
} from "../../packages/broker/src/aws/eval-batch.js";
import { runEvalBatchTick } from "../../packages/broker/src/aws/eval-batch-tick.js";
import { reconcileSwebenchSlots, startSwebenchRun } from "../../packages/broker/src/aws/swebench.js";
import {
  cheap,
  dear,
  endByStateMachine,
  file,
  finish,
  graded,
  harness,
  runnerStarted,
  tasks,
  usage,
  type Harness,
} from "../support/eval-batch-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const counter = (h: Harness) => h.db.get("SWEBENCH#SLOTS", "COUNTER")?.count;
const slotRunIds = (h: Harness) => h.db.find((item) => item.pk === "SWEBENCH#SLOT").map((item) => item.runId).sort();
const activeItem = (h: Harness, batchId: string) => h.db.get("EVAL_BATCHES#ACTIVE", `BATCH#${batchId}`);
const row = (h: Harness, batchId: string, runId: string) => h.db.get(`EVAL_BATCH#${batchId}`, `MEASURE#${runId}`);

async function expectChargesMatchSpend(h: Harness, batchId: string) {
  const charged = (await listBatchMeasures(h.dependencies, batchId)).reduce((sum, measure) => sum + measure.chargedUsd, 0);
  expect(charged).toBeCloseTo((await getBatch(h.dependencies, batchId))!.spentUsd, 9);
}

/** A single run started from Slack, holding a slot. */
async function singleRun(h: Harness, requestId: string) {
  const started = await startSwebenchRun(h.dependencies, h.context, { requestId, dataset: "verified", instanceId: tasks[0], model: { provider: dear.provider, modelId: dear.modelId } });
  expect(started.outcome).toBe("STARTED");
  return requestId;
}

/** Ends a run as a broker from before spec 052 did: terminal, with its slot item and the counter left behind. */
function endWithoutRelease(h: Harness, runId: string, status = "FAILED") {
  const item = h.db.get(`SWEBENCH_RUN#${runId}`, "META")!;
  h.db.set({ ...item, status, error: "ended by an older broker", finishedAt: "2026-10-02T10:30:00.000Z" });
}

const RUN_A = "0b8f6a52-6c1e-4c35-9d55-6a1d4f2b9c01";
const RUN_B = "0b8f6a52-6c1e-4c35-9d55-6a1d4f2b9c02";
const RUN_C = "0b8f6a52-6c1e-4c35-9d55-6a1d4f2b9c03";

describe("the results files (spec 052 FR-010)", () => {
  it("writes results.csv with a header and one escaped row per measure, in queue order, when the batch ends", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]] }));
    await topUpBatches(h.dependencies);
    const [first, second] = [evalBatchRunId(batch.batchId, 0, 1), evalBatchRunId(batch.batchId, 1, 1)];
    // The dear run ends first, so the rows were written out of queue order.
    await runnerStarted(h, second);
    await finish(h, second, { outcome: "FAILED", error: "the agent said \"no\", then\nquit, again\r\n" });
    await finish(h, first, graded(0.25));
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "DONE" });
    // The results wait for the tick, so the batch is still listed as active.
    expect(activeItem(h, batch.batchId)).toBeDefined();

    await runEvalBatchTick(h.dependencies);
    const csv = h.objects.get(`evals/batches/${batch.batchId}/results.csv`)!;
    expect(EVAL_BATCH_RESULTS_COLUMNS).toEqual([
      "batchId", "runId", "instanceId", "provider", "modelId", "thinkingLevel", "routing", "repeat", "attempt", "outcome",
      "resolved", "error", "secbenchStrict", "secbenchMedium", "secbenchGenerous", "secbenchFailedStep",
      "failToPassPassed", "failToPassTotal", "passToPassPassed", "passToPassTotal", "stopReason", "agentSeconds", "toolCalls",
      "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens",
      "costUsd", "chargedUsd", "costEstimated", "imageDigest", "claimCheck",
    ]);
    expect(csv.split("\r\n")).toEqual([
      EVAL_BATCH_RESULTS_COLUMNS.join(","),
      `${batch.batchId},${first},${tasks[0]},openrouter,vendor/cheap-v1,high,fireworks,1,1,GRADED,true,,,,,,3,3,19,19,finished,420,,10,5,100,0,115,0.25,0.25,false,swebench/x@sha256:abc,`,
      // RFC 4180: a field with a comma, quote or line break is quoted, and its quotes doubled.
      `${batch.batchId},${second},${tasks[0]},amazon-bedrock,us.vendor.dear-v1,medium,,1,1,FAILED,,"the agent said ""no"", then\nquit, again\r\n",,,,,,,,,,0,,0,0,0,0,0,,10,true,,`,
      "",
    ].join("\r\n").split("\r\n"));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(h.s3Send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Bucket: "artifacts", Key: `evals/batches/${batch.batchId}/results.csv`, ContentType: "text/csv; charset=utf-8" }) as unknown,
    }));
  });

  it("quotes only the fields that need it, and writes a pin's providers and the claim-check fields", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    const measure = {
      batchId: batch.batchId, runId: evalBatchRunId(batch.batchId, 0, 1), instanceId: tasks[0]!, provider: "openrouter", modelId: "vendor/cheap-v1",
      thinkingLevel: "high" as const, routing: { only: ["fireworks", "together"] }, repeat: 1, attempt: 1, outcome: "GRADED" as const, resolved: false,
      secbench: { strict: true, medium: true, generous: false, failedStep: "poc" as const, sanitizerReport: true, timedOut: false },
      stopReason: "finished" as const, agentSeconds: 7, toolCalls: 3, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      costUsd: 0.5, chargedUsd: 0.5, imageDigest: "x", claimCheck: { claim: "fixed, I think", score: 2 },
    };
    // A quote or a line break alone is enough to quote a field.
    const failed = {
      ...measure, runId: evalBatchRunId(batch.batchId, 0, 2), attempt: 2, outcome: "FAILED" as const, resolved: undefined, secbench: undefined,
      routing: undefined, claimCheck: undefined, error: "he said \"stop\"\nbye", imageDigest: "y",
    };
    const lines = evalBatchResultsCsv((await getBatch(h.dependencies, batch.batchId))!, [failed, measure]).split("\r\n");
    expect(lines[1]).toBe(`${batch.batchId},${measure.runId},${tasks[0]},openrouter,vendor/cheap-v1,high,fireworks|together,1,1,GRADED,false,,true,true,false,poc,,,,,finished,7,3,1,2,3,4,10,0.5,0.5,false,x,"{""claim"":""fixed, I think"",""score"":2}"`);
    expect(lines[2]).toBe(`${batch.batchId},${failed.runId},${tasks[0]},openrouter,vendor/cheap-v1,high,,1,2,FAILED,,"he said ""stop""\nbye",,,,,,,,,finished,7,3,1,2,3,4,10,0.5,0.5,false,y,`);
  });

  it("writes summary.json from the rows, removes the batch from the active list, and writes nothing again on the next tick", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    for (const entry of (await getBatch(h.dependencies, batch.batchId))!.queue) {
      await finish(h, entry.runId!, graded(entry.model.modelId === cheap.modelId ? 0.25 : 1.5, entry.index % 2 === 0));
    }
    await runEvalBatchTick(h.dependencies);
    const measures = await listBatchMeasures(h.dependencies, batch.batchId);
    const summary = EvalBatchSummarySchema.parse(JSON.parse(h.objects.get(`evals/batches/${batch.batchId}/summary.json`)!));
    expect(summary.batchId).toBe(batch.batchId);
    expect(summary.models).toHaveLength(2);
    expect(summary.models).toEqual(expect.arrayContaining(summarize(measures)));
    expect(summary.models.map((model) => [model.modelId, model.runs, model.resolved])).toEqual(expect.arrayContaining([[cheap.modelId, 2, 1], [dear.modelId, 2, 1]]));
    expect(activeItem(h, batch.batchId)).toBeUndefined();

    h.s3Send.mockClear();
    const before = h.db.commandNames().length;
    await runEvalBatchTick(h.dependencies);
    expect(h.s3Send).not.toHaveBeenCalled();
    expect(h.db.commandNames().slice(before)).toEqual(["QueryCommand"]);
  });

  it("writes the same files again when a tick stopped before it took the batch off the active list", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    await finish(h, evalBatchRunId(batch.batchId, 0, 1), graded(0.25));
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "DeleteCommand" && String((command.input.Key as { pk: string }).pk) === "EVAL_BATCHES#ACTIVE") throw new Error("the tick timed out");
      return send(command);
    };
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/1 step of the eval batch tick failed/);
    const first = new Map(h.objects);
    h.db.send = send;
    await runEvalBatchTick(h.dependencies);
    expect(h.objects).toEqual(first);
    expect(activeItem(h, batch.batchId)).toBeUndefined();
  });
});

describe("a batch that has ended but whose results are not yet written", () => {
  it("is not stopped again by a stop in its thread", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    await finish(h, evalBatchRunId(batch.batchId, 0, 1), graded(0.25));
    expect(activeItem(h, batch.batchId)).toBeDefined();
    expect(await stopBatchForThread(h.dependencies, h.context.thread, h.context.requester)).toBeUndefined();
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "DONE" });
  });
});

describe("rebuilding lost rows before a batch's results are written (spec 052 Ruling 8)", () => {
  type Variant = { name: string; setUp: (h: Harness, batchId: string) => Promise<string> };
  const variants: Variant[] = [
    {
      name: "a graded row",
      setUp: async (h, batchId) => {
        const runId = evalBatchRunId(batchId, 0, 1);
        await finish(h, runId, graded(0.25));
        return runId;
      },
    },
    {
      name: "an estimated-cost row",
      setUp: async (h, batchId) => {
        const runId = evalBatchRunId(batchId, 0, 1);
        await runnerStarted(h, runId);
        await endByStateMachine(h, runId, "FAILED", "the run did not finish within its 2-hour limit");
        await runEvalBatchTick(h.dependencies);
        // The tick ended the batch and wrote its files; the lost row is the one this test deletes below.
        return runId;
      },
    },
    {
      name: "a retried row",
      setUp: async (h, batchId) => {
        const runId = evalBatchRunId(batchId, 0, 1);
        await finish(h, runId, { outcome: "FAILED", error: "could not pull swebench/x: EOF", usage: usage(0.3) });
        await finish(h, evalBatchRunId(batchId, 0, 2), graded(0.25));
        return runId;
      },
    },
    {
      name: "a D-8 row (a retry the cap kept from starting)",
      setUp: async (h, batchId) => {
        const runId = evalBatchRunId(batchId, 0, 1);
        await runnerStarted(h, runId);
        await finish(h, runId, { outcome: "FAILED", error: "the eval instance stopped (terminated) without reporting a result; see its log stream" });
        expect(await getBatch(h.dependencies, batchId)).toMatchObject({ status: "CAPPED" });
        return evalBatchRunId(batchId, 0, 2);
      },
    },
  ];

  it.each(variants)("rebuilds $name with the charge it had, so the charges still sum to the spend", async ({ name, setUp }) => {
    const h = await harness({ maxConcurrentEvals: 1, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap], costCapUsd: name.startsWith("a D-8") ? 20 : 200 }));
    await topUpBatches(h.dependencies);
    const runId = await setUp(h, batch.batchId);
    const original = row(h, batch.batchId, runId)!;
    expect(original).toBeDefined();
    await expectChargesMatchSpend(h, batch.batchId);
    // The crash between the record's write and the row's: the row is lost. A batch the tick has
    // already finished is listed as active again, as it was before its files were written.
    h.db.delete(`EVAL_BATCH#${batch.batchId}`, `MEASURE#${runId}`);
    if (activeItem(h, batch.batchId) === undefined) {
      h.db.set({ pk: "EVAL_BATCHES#ACTIVE", sk: `BATCH#${batch.batchId}`, entityType: "EVAL_BATCH_ACTIVE", batchId: batch.batchId });
    }
    const rows = (await listBatchMeasures(h.dependencies, batch.batchId)).length;

    await runEvalBatchTick(h.dependencies);
    expect(row(h, batch.batchId, runId)).toEqual(original);
    await expectChargesMatchSpend(h, batch.batchId);
    const csv = h.objects.get(`evals/batches/${batch.batchId}/results.csv`)!;
    expect(csv.split("\r\n").filter((line) => line.length > 0)).toHaveLength(rows + 2);
    expect(csv).toContain(runId);
    // Idempotent: nothing is missing, so nothing is rebuilt.
    expect(await reconcileBatchRows(h.dependencies, batch.batchId)).toBe(0);
    expect(row(h, batch.batchId, runId)).toEqual(original);
  });

  it("writes no row for an entry that never ran", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]] }));
    await topUpBatches(h.dependencies);
    await stopBatch(h.dependencies, batch.batchId, h.context.requester);
    await endByStateMachine(h, evalBatchRunId(batch.batchId, 0, 1), "CANCELLED", "cancelled from Slack");
    await runEvalBatchTick(h.dependencies);
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "STOPPED" });
    expect((await listBatchMeasures(h.dependencies, batch.batchId)).map((measure) => measure.outcome)).toEqual(["CANCELLED"]);
    expect(await reconcileBatchRows(h.dependencies, batch.batchId)).toBe(0);
  });
});

describe("run ends the broker missed (spec 052 FR-006)", () => {
  it("records runs the state machine ended, and fills every free slot, not just one", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    const running = (await getBatch(h.dependencies, batch.batchId))!.queue.filter((entry) => entry.state === "RUNNING");
    expect(running).toHaveLength(2);
    for (const entry of running) {
      await runnerStarted(h, entry.runId!);
      await endByStateMachine(h, entry.runId!, "FAILED", "the run did not finish within its 2-hour limit");
    }
    // Nobody told the batch.
    expect((await getBatch(h.dependencies, batch.batchId))!.counts).toMatchObject({ running: 2, failed: 0 });

    const report = await runEvalBatchTick(h.dependencies);
    expect(report.endsRecorded).toBe(2);
    const after = (await getBatch(h.dependencies, batch.batchId))!;
    expect(after).toMatchObject({ spentUsd: 20, counts: { failed: 2, running: 2, queued: 0 } });
    expect(h.startExecution).toHaveBeenCalledTimes(4);
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual(expect.arrayContaining(running.map((entry) => expect.objectContaining({
      runId: entry.runId, outcome: "FAILED", chargedUsd: 10, costEstimated: true, error: "the run did not finish within its 2-hour limit",
    }) as unknown)));
    await expectChargesMatchSpend(h, batch.batchId);
  });
});

describe("slot reconcile (spec 052 FR-005)", () => {
  const corrections = () => vi.mocked(console.log).mock.calls
    .flatMap(([line]) => { try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; } })
    .filter((entry) => entry.event === "eval_slots.corrected");

  it("releases the slot of a run that ended without releasing it, and logs it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = await harness();
    await singleRun(h, RUN_A);
    await singleRun(h, RUN_B);
    endWithoutRelease(h, RUN_A);
    expect(counter(h)).toBe(2);
    await reconcileSwebenchSlots(h.dependencies);
    expect(slotRunIds(h)).toEqual([RUN_B]);
    expect(counter(h)).toBe(1);
    expect(corrections()).toEqual([expect.objectContaining({ correction: "released_slot", runId: RUN_A, runStatus: "FAILED" })]);
  });

  it("never deletes the slot of a run that has not ended", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    await singleRun(h, RUN_B);
    await singleRun(h, RUN_C);
    h.db.set({ ...h.db.get(`SWEBENCH_RUN#${RUN_B}`, "META")!, status: "RUNNING" });
    h.db.set({ ...h.db.get(`SWEBENCH_RUN#${RUN_C}`, "META")!, status: "CANCEL_REQUESTED" });
    await reconcileSwebenchSlots(h.dependencies);
    expect(slotRunIds(h)).toEqual([RUN_A, RUN_B, RUN_C]);
    expect(counter(h)).toBe(3);
  });

  it.each([
    { name: "a negative counter", count: -1 },
    { name: "a counter of 0 with slots held", count: 0 },
    { name: "a counter above the slots held", count: 5 },
  ])("sets $name to the slots held, and logs it", async ({ count }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = await harness();
    await singleRun(h, RUN_A);
    await singleRun(h, RUN_B);
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count });
    await reconcileSwebenchSlots(h.dependencies);
    expect(counter(h)).toBe(2);
    expect(slotRunIds(h)).toEqual([RUN_A, RUN_B]);
    expect(corrections()).toEqual([expect.objectContaining({ correction: "counter_set", from: count, to: 2 })]);
  });

  it("deletes an ended run's slot when the counter cannot be decremented, then sets the counter", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    endWithoutRelease(h, RUN_A, "SUCCEEDED");
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 0 });
    await reconcileSwebenchSlots(h.dependencies);
    expect(slotRunIds(h)).toEqual([]);
    expect(counter(h)).toBe(0);
  });

  it("releases a leaked slot once when two reconciles race", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    await singleRun(h, RUN_B);
    endWithoutRelease(h, RUN_A);
    await Promise.all([reconcileSwebenchSlots(h.dependencies), reconcileSwebenchSlots(h.dependencies)]);
    expect(slotRunIds(h)).toEqual([RUN_B]);
    expect(counter(h)).toBe(1);
  });

  // A start takes its slot item and the counter together. A reconcile that counted the slots at one
  // moment and wrote the counter at another would undo a start made in between.
  it.each([
    { name: "between its two reads of the slots", when: (name: string, key: unknown) => name === "GetCommand" && (key as { pk?: string } | undefined)?.pk === "SWEBENCH#SLOTS" },
    { name: "just before it writes the counter", when: (name: string) => name === "TransactWriteCommand" },
  ])("never undoes a start made $name", async ({ when }) => {
    const h = await harness();
    await singleRun(h, RUN_A);
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 3 });
    const send = h.db.send;
    let raced = false;
    h.db.send = async (command) => {
      if (!raced && when(command.constructor.name, command.input.Key)) {
        raced = true;
        h.db.send = send;
        await singleRun(h, RUN_B);
      }
      return send(command);
    };
    await reconcileSwebenchSlots(h.dependencies);
    h.db.send = send;
    expect(raced).toBe(true);
    expect(slotRunIds(h)).toEqual([RUN_A, RUN_B]);
    // Left as it was, never below the slots held; the next reconcile corrects it.
    expect(counter(h)).toBeGreaterThanOrEqual(2);
    await reconcileSwebenchSlots(h.dependencies);
    expect(counter(h)).toBe(2);
  });

  // The batch's own pattern: a run ends and frees its slot, and the next run takes it.
  it("never undoes a start that follows a release made while it counted", async () => {
    const h = await harness({ maxConcurrentEvals: 6 });
    await singleRun(h, RUN_A);
    await singleRun(h, RUN_B);
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 5 });
    const send = h.db.send;
    let counted = false;
    let raced = false;
    h.db.send = async (command) => {
      const name = command.constructor.name;
      if (name === "GetCommand" && (command.input.Key as { pk?: string }).pk === "SWEBENCH#SLOTS") counted = true;
      if (!counted || raced || name !== "QueryCommand") return send(command);
      // Its second read of the slots: B ends just before it, and C starts just after.
      raced = true;
      h.db.send = send;
      await endByStateMachine(h, RUN_B, "FAILED", "the run did not finish within its 2-hour limit");
      const result = await send(command);
      await singleRun(h, RUN_C);
      return result;
    };
    await reconcileSwebenchSlots(h.dependencies);
    h.db.send = send;
    expect(slotRunIds(h)).toEqual([RUN_A, RUN_C]);
    expect(counter(h)).toBeGreaterThanOrEqual(2);
    await reconcileSwebenchSlots(h.dependencies);
    expect(counter(h)).toBe(2);
  });

  it("deletes the one-run lock of a run that has ended, and keeps that of one still running", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    h.db.set({ pk: "SWEBENCH#ACTIVE", sk: "LOCK", runId: RUN_A, threadSubject: "x" });
    await reconcileSwebenchSlots(h.dependencies);
    expect(h.db.get("SWEBENCH#ACTIVE", "LOCK")).toBeDefined();
    endWithoutRelease(h, RUN_A);
    await reconcileSwebenchSlots(h.dependencies);
    expect(h.db.get("SWEBENCH#ACTIVE", "LOCK")).toBeUndefined();
  });

  it("runs in the tick, before the top-up, so a leaked slot is filled in the same tick", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    await singleRun(h, RUN_A);
    endWithoutRelease(h, RUN_A);
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    const report = await runEvalBatchTick(h.dependencies);
    expect(report.slotCorrections).toEqual([expect.objectContaining({ correction: "released_slot", runId: RUN_A })]);
    expect((await getBatch(h.dependencies, batch.batchId))!.counts).toMatchObject({ running: 1 });
    expect(slotRunIds(h)).toEqual([evalBatchRunId(batch.batchId, 0, 1)]);
  });
});

describe("the tick with no batch active", () => {
  it("reads the active list once and does nothing else", async () => {
    const h = await harness();
    // A leaked slot is left for a tick with a batch active (FR-011: the timer works only for batches).
    await singleRun(h, RUN_A);
    endWithoutRelease(h, RUN_A);
    h.startExecution.mockClear();
    h.deployment.mockClear();
    h.s3Send.mockClear();
    const before = h.db.commandNames().length;
    expect(await runEvalBatchTick(h.dependencies)).toEqual({ active: 0, endsRecorded: 0, slotCorrections: [], rowsRebuilt: 0, finalized: [] });
    expect(h.db.commandNames().slice(before)).toEqual(["QueryCommand"]);
    expect(h.deployment).not.toHaveBeenCalled();
    expect(h.s3Send).not.toHaveBeenCalled();
    expect(h.startExecution).not.toHaveBeenCalled();
    expect(counter(h)).toBe(1);
  });

  it("is what the scheduled handler runs", async () => {
    const module = await import("../../packages/broker/src/aws/eval-batch-tick.js");
    expect(typeof module.handler).toBe("function");
  });
});
