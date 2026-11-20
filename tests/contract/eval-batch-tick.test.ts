// Spec 052 Task 4: the batch tick. It records run ends the broker missed, fills free slots with no
// start cap, reconciles the slot counter, and at a batch's end rebuilds lost rows (Ruling 8) and
// writes results.csv and summary.json. Offline: FakeDynamoDb, a vi.fn state machine and S3.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CALLBACK_SIGNING_KEY_UNAVAILABLE, forgetCallbackSigningKey } from "../../packages/broker/src/aws/callback-signing-key.js";
import { EvalBatchSummarySchema, SWEBENCH_RUN_TIME_LIMIT_SECONDS } from "@agentx/contracts";
import { EVAL_BATCH_RESULTS_COLUMNS, createBatch, evalBatchResultsCsv, evalBatchRunId, getBatch, listBatchMeasures, reconcileBatchRows, stopBatchForThread, topUpBatches } from "../../packages/broker/src/aws/eval-batch.js";
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

});

describe("slot reconcile (spec 052 FR-005)", () => {


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

});

describe("the tick with no batch active", () => {
  // Ruling 10: the idle tick reads the active list, the slot counter and at most one slot item.
  const IDLE_READS = ["QueryCommand", "GetCommand", "QueryCommand"];

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

  it("is what the scheduled handler runs, with the Lambda's environment", async () => {
    const { handler } = await import("../../packages/broker/src/aws/eval-batch-tick.js");
    forgetCallbackSigningKey();
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return {};
    }) as never);
    // No secret named: the tick fails before it reads or signs anything (the Lambda's error metric and alarm see it), and a plain CALLBACK_SIGNING_KEY is not taken for the key.
    vi.stubEnv("CALLBACK_SIGNING_KEY", "k".repeat(64));
    await expect(handler()).rejects.toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect(sent).toEqual([]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("STATE_TABLE_NAME", "agentx-state");
    vi.stubEnv("ARTIFACT_BUCKET_NAME", "agentx-artifacts");
    vi.stubEnv("CALLBACK_SIGNING_KEY_SECRET_ID", "agentx/production/callback-key");
    vi.stubEnv("SWEBENCH_SETTINGS_PREFIX", "/agentx/production/");
    const secretReads: unknown[] = [];
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async (command: { input: unknown }) => {
      secretReads.push(command.input);
      return { SecretString: "k".repeat(64) };
    }) as never);
    sent.length = 0;
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GetCommand" ? {} : { Items: [] };
    }) as never);
    expect(await handler()).toEqual({ active: 0, endsRecorded: 0, slotCorrections: [], rowsRebuilt: 0, finalized: [] });
    expect(sent.map((command) => command.name)).toEqual(IDLE_READS);
    expect(sent.every((command) => command.input.TableName === "agentx-state")).toBe(true);
    expect(sent[0]!.input.ExpressionAttributeValues).toMatchObject({ ":pk": "EVAL_BATCHES#ACTIVE" });
    // The key was read from its one secret, by name; the second tick of the same container reads nothing more.
    expect(secretReads).toEqual([{ SecretId: "agentx/production/callback-key" }]);
    await handler();
    expect(secretReads).toHaveLength(1);
    forgetCallbackSigningKey();
  });
});

describe("runs whose execution died before it ended them (spec 052 Ruling 13)", () => {
  const GRACE_MS = 10 * 60_000;
  const run = (h: Harness, runId: string) => h.db.get(`SWEBENCH_RUN#${runId}`, "META")!;

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

