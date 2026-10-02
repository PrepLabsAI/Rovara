// Spec 052 Task 4: the batch tick. It records run ends the broker missed, fills free slots with no
// start cap, reconciles the slot counter, and at a batch's end rebuilds lost rows (Ruling 8) and
// writes results.csv and summary.json. Offline: FakeDynamoDb, a vi.fn state machine and S3.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EvalBatchSummarySchema, SWEBENCH_RUN_TIME_LIMIT_SECONDS, summarize } from "@agentx/contracts";
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
  executionArn,
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
  vi.unstubAllEnvs();
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
      "costUsd", "chargedUsd", "costEstimated", "imageDigest", "claimCheck", "checkStatus", "agentClaim", "disagrees",
    ]);
    expect(csv.split("\r\n")).toEqual([
      EVAL_BATCH_RESULTS_COLUMNS.join(","),
      `${batch.batchId},${first},${tasks[0]},openrouter,vendor/cheap-v1,high,fireworks,1,1,GRADED,true,,,,,,3,3,19,19,finished,420,,10,5,100,0,115,0.25,0.25,false,swebench/x@sha256:abc,,,,`,
      // RFC 4180: a field with a comma, quote or line break is quoted, and its quotes doubled.
      `${batch.batchId},${second},${tasks[0]},amazon-bedrock,us.vendor.dear-v1,medium,,1,1,FAILED,,"the agent said ""no"", then\nquit, again\r\n",,,,,,,,,,0,,0,0,0,0,0,,10,true,,,,,`,
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
    expect(lines[1]).toBe(`${batch.batchId},${measure.runId},${tasks[0]},openrouter,vendor/cheap-v1,high,fireworks|together,1,1,GRADED,false,,true,true,false,poc,,,,,finished,7,3,1,2,3,4,10,0.5,0.5,false,x,"{""claim"":""fixed, I think"",""score"":2}",,,`);
    expect(lines[2]).toBe(`${batch.batchId},${failed.runId},${tasks[0]},openrouter,vendor/cheap-v1,high,,1,2,FAILED,,"he said ""stop""\nbye",,,,,,,,,finished,7,3,1,2,3,4,10,0.5,0.5,false,y,,,,`);
  });

  it("carries AgentX's check status, the agent's claim and their disagreement into the row, the CSV and the per-model rate (spec 051 FR-010)", async () => {
    const h = await harness({ maxConcurrentEvals: 5 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const report = (status: string) => ({
      status, source: "agent_commands", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "success",
    });
    const withChecks = (checkStatus: string, agentClaim: string, disagrees: boolean) => ({
      ...graded(0.25),
      checks: report(checkStatus),
      agentClaim,
      disagreement: { claimedSuccess: agentClaim === "success", checkRegression: checkStatus === "regression", graderBrokenPassToPass: false, disagrees },
      preambleSha256: "a".repeat(64),
    });
    const [first] = (await getBatch(h.dependencies, batch.batchId))!.queue;
    await finish(h, first!.runId!, withChecks("regression", "success", true));
    await runEvalBatchTick(h.dependencies);
    const [row] = await listBatchMeasures(h.dependencies, batch.batchId);
    expect(row).toMatchObject({ checkStatus: "regression", agentClaim: "success", disagrees: true });
    const csv = h.objects.get(`evals/batches/${batch.batchId}/results.csv`)!.split("\r\n");
    const header = csv[0]!.split(",");
    const fields = csv[1]!.split(",");
    expect(["checkStatus", "agentClaim", "disagrees"].map((column) => fields[header.indexOf(column)])).toEqual(["regression", "success", "true"]);
    const summary = EvalBatchSummarySchema.parse(JSON.parse(h.objects.get(`evals/batches/${batch.batchId}/summary.json`)!));
    expect(summary.models[0]).toMatchObject({ runs: 1, disagreementRate: 1 });
  });

  it("leaves the columns empty and the rate null for a result from a runner older than the checks", async () => {
    const h = await harness({ maxConcurrentEvals: 5 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const [first] = (await getBatch(h.dependencies, batch.batchId))!.queue;
    await finish(h, first!.runId!, graded(0.25));
    await runEvalBatchTick(h.dependencies);
    const [row] = await listBatchMeasures(h.dependencies, batch.batchId);
    expect(row).not.toHaveProperty("checkStatus");
    expect(row).not.toHaveProperty("agentClaim");
    expect(row).not.toHaveProperty("disagrees");
    const csv = h.objects.get(`evals/batches/${batch.batchId}/results.csv`)!.split("\r\n");
    expect(csv[1]!.endsWith(",swebench/x@sha256:abc,,,,")).toBe(true);
    const summary = EvalBatchSummarySchema.parse(JSON.parse(h.objects.get(`evals/batches/${batch.batchId}/summary.json`)!));
    expect(summary.models[0]!.disagreementRate).toBeNull();
  });

  it("writes summary.json from the rows, removes the batch from the active list, and writes nothing again on the next tick", async () => {
    const h = await harness({ maxConcurrentEvals: 5 });
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
    // No batch, and no slot held: the idle tick's reads only.
    expect(h.db.commandNames().slice(before)).toEqual(["QueryCommand", "GetCommand", "QueryCommand"]);
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
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
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
    const h = await harness({ maxConcurrentEvals: 2 });
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
    const h = await harness({ maxConcurrentEvals: 3, maxCostUsd: 10 });
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

  // Review M-2: a run that starts and fails within the counting, then another start before the write,
  // leaves the counter one low. The write cannot see it; the next reconcile corrects it.
  it("heals the one sequence that leaves the counter one low at the next reconcile", async () => {
    const h = await harness({ maxConcurrentEvals: 6 });
    await singleRun(h, RUN_A);
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 3 });
    const send = h.db.send;
    let step = 0;
    h.db.send = async (command) => {
      const name = command.constructor.name;
      const isCounter = name === "GetCommand" && (command.input.Key as { pk?: string }).pk === "SWEBENCH#SLOTS";
      if (step === 0 && isCounter) {
        step = 1;
        h.db.send = send;
        await singleRun(h, RUN_B);
        const result = await send(command);
        await endByStateMachine(h, RUN_B, "FAILED", "the run could not start: boom");
        h.db.send = intercept;
        return result;
      }
      if (step === 1 && name === "QueryCommand") {
        step = 2;
        const result = await send(command);
        h.db.send = send;
        await singleRun(h, RUN_C);
        h.db.send = intercept;
        return result;
      }
      return send(command);
    };
    const intercept = h.db.send;
    await reconcileSwebenchSlots(h.dependencies);
    h.db.send = send;
    expect(step).toBe(2);
    expect(slotRunIds(h)).toEqual([RUN_A, RUN_C]);
    await reconcileSwebenchSlots(h.dependencies);
    expect(counter(h)).toBe(2);
  });

  it("logs a warning when there are too many slot items to count", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = await harness();
    for (let index = 0; index < 99; index += 1) h.db.set({ pk: "SWEBENCH#SLOT", sk: `RUN#${String(index).padStart(36, "0")}` });
    await reconcileSwebenchSlots(h.dependencies);
    const events = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(events.some((line) => line.includes("eval_slots.too_many_to_count") && line.includes("\"slots\":99"))).toBe(true);
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
    const h = await harness({ maxConcurrentEvals: 2 });
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
  // Ruling 10: the idle tick reads the active list, the slot counter and at most one slot item.
  const IDLE_READS = ["QueryCommand", "GetCommand", "QueryCommand"];

  it("makes three small reads and nothing else while no run holds a slot", async () => {
    const h = await harness();
    h.startExecution.mockClear();
    h.deployment.mockClear();
    h.s3Send.mockClear();
    const before = h.db.commandNames().length;
    expect(await runEvalBatchTick(h.dependencies)).toEqual({ active: 0, endsRecorded: 0, slotCorrections: [], rowsRebuilt: 0, finalized: [] });
    expect(h.db.commandNames().slice(before)).toEqual(IDLE_READS);
    expect(h.deployment).not.toHaveBeenCalled();
    expect(h.s3Send).not.toHaveBeenCalled();
    expect(h.startExecution).not.toHaveBeenCalled();
  });

  it("releases a leaked slot of an ended run, so it cannot block single runs", async () => {
    const h = await harness({ maxConcurrentEvals: 2 });
    await singleRun(h, RUN_A);
    endWithoutRelease(h, RUN_A);
    const report = await runEvalBatchTick(h.dependencies);
    expect(report.slotCorrections).toEqual([expect.objectContaining({ correction: "released_slot", runId: RUN_A })]);
    expect(slotRunIds(h)).toEqual([]);
    expect(counter(h)).toBe(0);
    // The next single run gets the slot.
    await singleRun(h, RUN_B);
  });

  it("sets a counter left above 0 with no slot held, and deletes a slot item the counter missed", async () => {
    const h = await harness();
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 2 });
    await runEvalBatchTick(h.dependencies);
    expect(counter(h)).toBe(0);
    await singleRun(h, RUN_A);
    endWithoutRelease(h, RUN_A);
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 0 });
    await runEvalBatchTick(h.dependencies);
    expect(slotRunIds(h)).toEqual([]);
    expect(counter(h)).toBe(0);
  });

  it("sets a negative counter to the slots held", async () => {
    const h = await harness();
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: -1 });
    await runEvalBatchTick(h.dependencies);
    expect(counter(h)).toBe(0);
  });

  it("leaves the slot of a run that has not ended alone", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    h.db.set({ ...h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")!, status: "RUNNING" });
    const report = await runEvalBatchTick(h.dependencies);
    expect(report.slotCorrections).toEqual([]);
    expect(slotRunIds(h)).toEqual([RUN_A]);
    expect(counter(h)).toBe(1);
  });

  it("is what the scheduled handler runs, with the Lambda's environment", async () => {
    const { handler } = await import("../../packages/broker/src/aws/eval-batch-tick.js");
    await expect(handler()).rejects.toThrow(/is required/);
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("STATE_TABLE_NAME", "agentx-state");
    vi.stubEnv("ARTIFACT_BUCKET_NAME", "agentx-artifacts");
    vi.stubEnv("CALLBACK_SIGNING_KEY", "k".repeat(64));
    vi.stubEnv("SWEBENCH_SETTINGS_PREFIX", "/agentx/production/");
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GetCommand" ? {} : { Items: [] };
    }) as never);
    expect(await handler()).toEqual({ active: 0, endsRecorded: 0, slotCorrections: [], rowsRebuilt: 0, finalized: [] });
    expect(sent.map((command) => command.name)).toEqual(IDLE_READS);
    expect(sent.every((command) => command.input.TableName === "agentx-state")).toBe(true);
    expect(sent[0]!.input.ExpressionAttributeValues).toMatchObject({ ":pk": "EVAL_BATCHES#ACTIVE" });
  });
});

describe("runs whose execution died before it ended them (spec 052 Ruling 13)", () => {
  const GRACE_MS = 10 * 60_000;
  const run = (h: Harness, runId: string) => h.db.get(`SWEBENCH_RUN#${runId}`, "META")!;

  it("records the execution's ARN on the run as it starts", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    expect(run(h, RUN_A).executionArn).toBe(executionArn(RUN_A));
  });

  it("ends a run whose execution stopped, charges its ceiling, releases its slot once, and lets the batch finalize", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap], costCapUsd: 20 }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    await runnerStarted(h, runId);
    h.executions.set(executionArn(runId), "FAILED");
    h.advance(GRACE_MS + 1);
    const report = await runEvalBatchTick(h.dependencies);
    expect(report.slotCorrections).toEqual([expect.objectContaining({ correction: "ended_dead_run", runId, executionStatus: "FAILED" })]);
    expect(run(h, runId)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^the eval instance stopped \(its execution ended FAILED\) without reporting a result; the batch tick ended the run$/) as unknown });
    expect(slotRunIds(h)).toEqual([]);
    expect(counter(h)).toBe(0);
    // An infrastructure failure: retried, but the retry does not fit the cap, so the batch is CAPPED and finalized.
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "CAPPED", spentUsd: 10 });
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId, outcome: "RETRIED", chargedUsd: 10, costEstimated: true }),
    ]));
    expect(report.finalized).toEqual([batch.batchId]);
    expect(h.objects.has(`evals/batches/${batch.batchId}/results.csv`)).toBe(true);
    await expectChargesMatchSpend(h, batch.batchId);
  });

  it("charges nothing for a run whose runner never started, and retries it", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    h.executions.set(executionArn(runId), "ABORTED");
    h.advance(GRACE_MS + 1);
    await runEvalBatchTick(h.dependencies);
    expect(run(h, runId)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^the run could not start: its execution ended ABORTED before the runner started/) as unknown });
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ spentUsd: 0 });
    expect((await getBatch(h.dependencies, batch.batchId))!.queue[0]).toMatchObject({ attempt: 2, state: "RUNNING" });
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual([expect.objectContaining({ runId, outcome: "RETRIED", chargedUsd: 0 })]);
  });

  it("leaves a run alone while its execution runs, and does not look before the grace period", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    h.executions.set(executionArn(RUN_A), "FAILED");
    await reconcileSwebenchSlots(h.dependencies);
    expect(h.describeExecution).not.toHaveBeenCalled();
    expect(run(h, RUN_A).status).toBe("STARTING");
    h.executions.set(executionArn(RUN_A), "RUNNING");
    h.advance(GRACE_MS + 1);
    expect(await reconcileSwebenchSlots(h.dependencies)).toEqual([]);
    expect(h.describeExecution).toHaveBeenCalledWith(executionArn(RUN_A));
    expect(run(h, RUN_A).status).toBe("STARTING");
    expect(slotRunIds(h)).toEqual([RUN_A]);
    expect(counter(h)).toBe(1);
  });

  it("ends a run with no recorded execution only once it is past the run time limit plus 15 minutes", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    await runnerStarted(h, RUN_A);
    // A run started before its execution's ARN was recorded.
    const older = { ...run(h, RUN_A) };
    delete older.executionArn;
    h.db.set(older);
    h.advance(SWEBENCH_RUN_TIME_LIMIT_SECONDS * 1_000 + 15 * 60_000 - 1_000);
    await reconcileSwebenchSlots(h.dependencies);
    expect(run(h, RUN_A).status).toBe("RUNNING");
    h.advance(2_000);
    expect(await reconcileSwebenchSlots(h.dependencies)).toEqual([expect.objectContaining({ correction: "ended_dead_run", runId: RUN_A, executionStatus: null })]);
    expect(h.describeExecution).not.toHaveBeenCalled();
    expect(run(h, RUN_A)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^the eval instance stopped \(its execution is unknown and the run is past its time limit\) without reporting a result; AgentX ended the run$/) as unknown });
    expect(slotRunIds(h)).toEqual([]);
    expect(counter(h)).toBe(0);
  });

  it("ends a stuck run whose release had failed on a counter at 0", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    await runnerStarted(h, RUN_A);
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 0 });
    h.executions.set(executionArn(RUN_A), "FAILED");
    h.advance(GRACE_MS + 1);
    await reconcileSwebenchSlots(h.dependencies);
    expect(run(h, RUN_A).status).toBe("FAILED");
    expect(slotRunIds(h)).toEqual([]);
    expect(counter(h)).toBe(0);
  });

  it("releases once and writes one row when EndRun ends the run while the tick looks", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    await runnerStarted(h, runId);
    h.advance(GRACE_MS + 1);
    h.describeExecution.mockImplementationOnce(async () => {
      await endByStateMachine(h, runId, "FAILED", "the run did not finish within its 2-hour limit");
      return { status: "SUCCEEDED" };
    });
    const report = await runEvalBatchTick(h.dependencies);
    expect(report.slotCorrections).toEqual([]);
    expect(run(h, runId)).toMatchObject({ status: "FAILED", error: "the run did not finish within its 2-hour limit" });
    expect(counter(h)).toBe(0);
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "DONE", spentUsd: 10 });
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual([expect.objectContaining({ runId, outcome: "FAILED", chargedUsd: 10 })]);
  });
});

describe("a dead run's runner that is still alive (spec 052 Ruling 16)", () => {
  const GRACE_MS = 10 * 60_000;

  it("refuses the runner's late start with a final 409, so a run charged $0 cannot spend, and its retry is counted once", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    h.executions.set(executionArn(runId), "ABORTED");
    h.advance(GRACE_MS + 1);
    await runEvalBatchTick(h.dependencies);
    expect(h.db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "FAILED" });
    // The runner was still pulling its image: its start is refused, and it stops before the agent.
    await expect(runnerStarted(h, runId)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.db.get(`SWEBENCH_RUN#${runId}`, "META")!.runnerStartedAt).toBeUndefined();
    await runEvalBatchTick(h.dependencies);
    const after = (await getBatch(h.dependencies, batch.batchId))!;
    expect(after).toMatchObject({ spentUsd: 0 });
    expect(after.queue[0]).toMatchObject({ attempt: 2, state: "RUNNING" });
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual([expect.objectContaining({ runId, outcome: "RETRIED", chargedUsd: 0 })]);
    expect(h.startExecution).toHaveBeenCalledTimes(2);
  });

  it("still answers a repeated start of a run that is running", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    await runnerStarted(h, RUN_A);
    await expect(runnerStarted(h, RUN_A)).resolves.toBeUndefined();
  });

  it("terminates a dead run's instance, when it is known, before ending the run", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    h.db.set({ ...h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")!, ec2InstanceId: "i-0123456789abcdef0" });
    await singleRun(h, RUN_B);
    h.executions.set(executionArn(RUN_A), "ABORTED");
    h.executions.set(executionArn(RUN_B), "FAILED");
    const order: string[] = [];
    h.terminateInstance.mockImplementation(async (instanceId) => {
      order.push(`terminate ${instanceId} while ${String(h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")!.status)}`);
    });
    h.advance(GRACE_MS + 1);
    await reconcileSwebenchSlots(h.dependencies);
    expect(order).toEqual(["terminate i-0123456789abcdef0 while STARTING"]);
    expect(h.terminateInstance).toHaveBeenCalledTimes(1);
    expect(h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")).toMatchObject({ status: "FAILED" });
    expect(h.db.get(`SWEBENCH_RUN#${RUN_B}`, "META")).toMatchObject({ status: "FAILED" });
  });

  it("ends a run whose recorded instance ID is malformed, with a warning naming it, and still refuses its late start", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = await harness();
    await singleRun(h, RUN_A);
    h.db.set({ ...h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")!, ec2InstanceId: "not-an-instance" });
    h.executions.set(executionArn(RUN_A), "ABORTED");
    h.terminateInstance.mockRejectedValue(Object.assign(new Error("Invalid id"), { name: "InvalidInstanceID.Malformed" }));
    h.advance(GRACE_MS + 1);
    await reconcileSwebenchSlots(h.dependencies);
    expect(h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")).toMatchObject({ status: "FAILED" });
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes("eval_slots.instance_not_terminated") && line.includes(RUN_A) && line.includes("not-an-instance"))).toBe(true);
    await expect(runnerStarted(h, RUN_A)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a start when the run ends between the callback's read and its write", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "UpdateCommand" && (command.input.Key as { pk?: string }).pk === `SWEBENCH_RUN#${RUN_A}`) {
        h.db.send = send;
        await endByStateMachine(h, RUN_A, "CANCELLED", "cancelled from Slack");
      }
      return send(command);
    };
    await expect(runnerStarted(h, RUN_A)).rejects.toMatchObject({ statusCode: 409 });
    h.db.send = send;
    expect(h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")!.runnerStartedAt).toBeUndefined();
  });

  it("leaves the run to the next tick when its instance cannot be terminated", async () => {
    const h = await harness();
    await singleRun(h, RUN_A);
    h.db.set({ ...h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")!, ec2InstanceId: "i-0123456789abcdef0" });
    h.executions.set(executionArn(RUN_A), "ABORTED");
    h.terminateInstance.mockRejectedValueOnce(Object.assign(new Error("not authorized"), { name: "UnauthorizedOperation" }));
    h.advance(GRACE_MS + 1);
    await expect(reconcileSwebenchSlots(h.dependencies)).rejects.toThrow(/could not be ended/);
    expect(h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")).toMatchObject({ status: "STARTING" });
    await reconcileSwebenchSlots(h.dependencies);
    expect(h.db.get(`SWEBENCH_RUN#${RUN_A}`, "META")).toMatchObject({ status: "FAILED" });
  });
});

describe("charges that sum exactly to the spend (spec 052 Ruling 17)", () => {
  it("rounds an estimated ceiling charge as spend is rounded", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10.123_456_7 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    await runnerStarted(h, runId);
    await endByStateMachine(h, runId, "FAILED", "the run did not finish within its 2-hour limit");
    expect(await runEvalBatchTick(h.dependencies)).toMatchObject({ finalized: [batch.batchId] });
    expect(row(h, batch.batchId, runId)).toMatchObject({ chargedUsd: 10.123457, costEstimated: true });
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ spentUsd: 10.123457 });
  });

  it("rounds each reported cost once, so 200 runs at unrounded costs still finalize", async () => {
    const h = await harness({ maxConcurrentEvals: 6, maxCostUsd: 10 });
    const ids = Array.from({ length: 100 }, (_, index) => `django__django-${10000 + index}`);
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: ids, models: [dear, cheap], costCapUsd: 1000 }));
    // A seeded stream of costs with nine and more decimals, as session statistics report them.
    let seed = 20261002;
    const cost = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (seed / 2_147_483_648) * 4.9 + 0.000_000_123;
    };
    await topUpBatches(h.dependencies);
    for (let round = 0; round < 100; round += 1) {
      const running = (await getBatch(h.dependencies, batch.batchId))!.queue.filter((entry) => entry.state === "RUNNING");
      if (running.length === 0) break;
      for (const entry of running) await finish(h, entry.runId!, graded(cost()));
      await topUpBatches(h.dependencies);
    }
    const ended = (await getBatch(h.dependencies, batch.batchId))!;
    expect(ended).toMatchObject({ status: "DONE", counts: { done: 200 } });
    expect(await runEvalBatchTick(h.dependencies)).toMatchObject({ finalized: [batch.batchId] });
    const rows = await listBatchMeasures(h.dependencies, batch.batchId);
    expect(rows).toHaveLength(200);
    const charged = rows.reduce((sum, measure) => sum + measure.chargedUsd, 0);
    expect(Math.round(charged * 1_000_000) / 1_000_000).toBe(ended.spentUsd);
  }, 60_000);
});

describe("a tick that cannot do its work fails (spec 052 Ruling 14)", () => {
  it("fails when a batch cannot be topped up, after topping up the others", async () => {
    const h = await harness();
    const first = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    const second = await createBatch(h.dependencies, { ...h.context, thread: { ...h.context.thread, threadTs: "1695500000.000002" } }, file({ tasks: [tasks[1]], models: [cheap] }));
    h.deployment.mockRejectedValueOnce(new Error("ssm:GetParameters is not authorized"));
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/top_up/);
    const started = [first, second].map((batch) => h.startExecution.mock.calls.some(([input]) => input.name === evalBatchRunId(batch.batchId, 0, 1)));
    expect(started.sort()).toEqual([false, true]);
  });

  it("fails when the eval stack is not installed while a batch waits", async () => {
    const h = await harness();
    await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    h.deployment.mockResolvedValue(undefined);
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/top_up/);
  });

  it("fails when a run cannot be started", async () => {
    const h = await harness();
    await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    h.startExecution.mockRejectedValueOnce(new Error("AccessDeniedException: states:StartExecution"));
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/top_up/);
  });

  it("fails when a step other than finalize fails, and still runs the others", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"] === "SWEBENCH#SLOT") throw new Error("throttled");
      return send(command);
    };
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/reconcile_slots/);
    h.db.send = send;
    expect(h.startExecution).toHaveBeenCalledWith(expect.objectContaining({ name: evalBatchRunId(batch.batchId, 0, 1) }));
  });

  it("fails, keeps the batch listed and still writes its files when the rows' charges do not sum to the spend", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    await finish(h, runId, graded(0.25));
    h.db.set({ ...row(h, batch.batchId, runId)!, chargedUsd: 0.5 });
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/finalize/);
    expect(h.objects.has(`evals/batches/${batch.batchId}/results.csv`)).toBe(true);
    expect(activeItem(h, batch.batchId)).toBeDefined();
  });

  it("fails and keeps the batch listed when a lost row cannot be rebuilt", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    await finish(h, runId, graded(0.25));
    h.db.delete(`EVAL_BATCH#${batch.batchId}`, `MEASURE#${runId}`);
    h.db.delete(`SWEBENCH_RUN#${runId}`, "META");
    await expect(runEvalBatchTick(h.dependencies)).rejects.toThrow(/finalize/);
    expect(activeItem(h, batch.batchId)).toBeDefined();
  });
});

describe("ticks and callbacks that overlap", () => {
  it("leaves the charge and the row alone when the runner's result arrives after the tick recorded the end", async () => {
    const h = await harness({ maxConcurrentEvals: 2, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    await runnerStarted(h, runId);
    await endByStateMachine(h, runId, "FAILED", "the run did not finish within its 2-hour limit");
    await runEvalBatchTick(h.dependencies);
    const recorded = row(h, batch.batchId, runId);
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "DONE", spentUsd: 10 });
    await finish(h, runId, graded(0.25));
    expect(row(h, batch.batchId, runId)).toEqual(recorded);
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "DONE", spentUsd: 10 });
    expect(counter(h)).toBe(0);
  });

  it("writes the same files once over when two ticks finalize a batch at once", async () => {
    const h = await harness({ maxConcurrentEvals: 5 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    for (const entry of (await getBatch(h.dependencies, batch.batchId))!.queue) await finish(h, entry.runId!, graded(0.25));
    const puts: string[] = [];
    h.s3Send.mockImplementation(async (command: { input: { Key?: string; Body?: string } }) => {
      if (command.input.Key !== undefined) {
        if (h.objects.has(command.input.Key)) expect(String(command.input.Body)).toBe(h.objects.get(command.input.Key));
        h.objects.set(command.input.Key, String(command.input.Body));
        puts.push(command.input.Key);
      }
      return {};
    });
    const reports = await Promise.all([runEvalBatchTick(h.dependencies), runEvalBatchTick(h.dependencies)]);
    expect(reports.flatMap((report) => report.finalized)).toContain(batch.batchId);
    expect(new Set(puts)).toEqual(new Set([`evals/batches/${batch.batchId}/results.csv`, `evals/batches/${batch.batchId}/summary.json`]));
    expect(activeItem(h, batch.batchId)).toBeUndefined();
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toHaveLength(4);
    await expectChargesMatchSpend(h, batch.batchId);
  });
});
