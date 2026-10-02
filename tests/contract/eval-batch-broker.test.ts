// Spec 052 Task 3: batch records, top-up under a cost cap, the single infrastructure retry, and stop.
// Offline: FakeDynamoDb, a vi.fn state machine and S3, and a fake clock.
import { describe, expect, it, vi, type Mock } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SwebenchLaunchSchema, agentXError, type ModelIdentifier, type SwebenchLaunch } from "@agentx/contracts";
import {
  EVAL_BATCH_REFERENCE_TOKENS,
  createBatch,
  defaultRunCostEstimate,
  drawSample,
  evalBatchRunId,
  getBatch,
  isInfrastructureFailure,
  listBatchMeasures,
  recordBatchRunEnd,
  stopBatch,
  topUpBatches,
  withEvalBatches,
  type EvalBatchDependencies,
} from "../../packages/broker/src/aws/eval-batch.js";
import {
  handleSwebenchCallback,
  issueSwebenchCapability,
  putSwebenchChannel,
  stopSwebenchRun,
  type SwebenchDependencies,
  type SwebenchDeployment,
  type SwebenchSlackContext,
} from "../../packages/broker/src/aws/swebench.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TEAM = "T0BSHLLUGBD";
const CHANNEL = "C0123456789";
const thread = { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000001" };
const requester = { teamId: TEAM, userId: "U0123456789" };
const runnerImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;
const pinnedImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"b".repeat(64)}`;

const cheap = { provider: "openrouter", modelId: "vendor/cheap-v1", thinkingLevel: "high", routing: { only: ["fireworks"] } } as const;
const dear = { provider: "amazon-bedrock", modelId: "us.vendor.dear-v1", thinkingLevel: "medium" } as const;
const unapproved = { provider: "amazon-bedrock", modelId: "us.vendor.other-v1", thinkingLevel: "off" } as const;
const prices: Record<string, number> = { [cheap.modelId]: 1.5, [dear.modelId]: 7.2, [unapproved.modelId]: 3 };

const tasks = ["django__django-11099", "sympy__sympy-13878"];

const usage = (costUsd: number | null) => ({
  schemaVersion: 1, outcome: "SUCCEEDED", provider: "openrouter", modelId: cheap.modelId, cacheRetention: "long",
  tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, total: 115 }, cacheReadRatio: 0.9, costUsd,
});
const graded = (costUsd: number, resolved = true) => ({
  outcome: "GRADED", resolved, stopReason: "finished", patchBytes: 899,
  failToPass: { passed: 3, total: 3 }, passToPass: { passed: 19, total: 19 },
  agentSeconds: 420, imageDigest: "swebench/x@sha256:abc", usage: usage(costUsd), artifactsPrefix: "evals/run/",
});

interface Harness {
  db: FakeDynamoDb;
  dependencies: EvalBatchDependencies;
  context: SwebenchSlackContext;
  launches: Map<string, SwebenchLaunch>;
  startExecution: Mock<SwebenchDependencies["startExecution"]>;
  advance: (ms: number) => void;
  limit: { value: number };
}

async function harness(options: { maxConcurrentEvals?: number; maxCostUsd?: number; datasetInstanceIds?: EvalBatchDependencies["datasetInstanceIds"] } = {}): Promise<Harness> {
  const db = new FakeDynamoDb();
  const launches = new Map<string, SwebenchLaunch>();
  const s3 = {
    send: vi.fn(async (command: { input: { Key?: string; Body?: string } }) => {
      if (command.input.Key?.endsWith("/launch.json")) launches.set(command.input.Key, SwebenchLaunchSchema.parse(JSON.parse(command.input.Body!)));
      return {};
    }),
  };
  const startExecution = vi.fn<SwebenchDependencies["startExecution"]>(async () => undefined);
  let clock = new Date("2026-10-02T10:00:00.000Z").getTime();
  const limit = { value: options.maxConcurrentEvals ?? 4 };
  const deployment = (): SwebenchDeployment => ({
    settings: {
      stateMachineArn: "arn:aws:states:us-east-1:111122223333:stateMachine:agentx-production-swebench-eval",
      subnetIds: ["subnet-0123456789abcdef0"],
      controlPlaneUrl: "https://api.example.com",
      logGroupName: "/agentx/production/swebench",
      maxConcurrentEvals: limit.value,
    },
    runnerImage,
    defaultModel: { provider: "amazon-bedrock", modelId: "us.vendor.default-v1" },
    environment: { PI_CACHE_RETENTION: "long", AGENTX_OPENROUTER_PROVIDERS: "deployment-default" },
    runnerFeatures: ["model.thinkingLevel"],
  });
  const dependencies: EvalBatchDependencies = withEvalBatches({
    documentClient: db as never,
    s3: s3 as never,
    tableName: "state",
    artifactBucketName: "artifacts",
    callbackSigningKey: "c".repeat(64),
    deployment: async () => deployment(),
    startExecution,
    now: () => new Date(clock),
    estimateRunCostUsd: (model) => prices[model.modelId],
    sleep: async () => undefined,
    ...(options.datasetInstanceIds === undefined ? {} : { datasetInstanceIds: options.datasetInstanceIds }),
  });
  await putSwebenchChannel(dependencies, TEAM, CHANNEL, { maxCostUsd: options.maxCostUsd ?? 10 });
  const approved: ModelIdentifier[] = [cheap, dear];
  const context: SwebenchSlackContext = {
    thread, requester, projectName: "payments",
    projectModel: async (requested) => {
      const found = approved.find((model) => model.provider === requested?.provider && model.modelId === requested.modelId);
      if (found === undefined) throw agentXError("CONFIG_INVALID", `model ${requested?.provider}/${requested?.modelId} is not approved for this project`);
      return { provider: found.provider, modelId: found.modelId };
    },
  };
  return { db, dependencies, context, launches, startExecution, advance: (ms) => { clock += ms; }, limit };
}

const file = (overrides: Record<string, unknown> = {}) => ({
  benchmark: "verified", tasks, models: [dear, cheap], repeats: 1, costCapUsd: 200, ...overrides,
});

/** The runner's result callback for one run, as the runner sends it. */
async function finish(h: Harness, runId: string, body: unknown) {
  return handleSwebenchCallback(h.dependencies, issueSwebenchCapability(h.dependencies, runId), runId, "result", body);
}

/** The state machine ends a run (instance lost, cancel): the run goes terminal and its slot is released; the tick records it. */
async function endByStateMachine(h: Harness, runId: string, status: "FAILED" | "CANCELLED", error: string) {
  await h.db.send(new TransactWriteCommand({
    TransactItems: [
      { Update: { TableName: "state", Key: { pk: `SWEBENCH_RUN#${runId}`, sk: "META" }, UpdateExpression: "SET #status = :status, #error = :error, finishedAt = :now", ExpressionAttributeNames: { "#status": "status", "#error": "error" }, ExpressionAttributeValues: { ":status": status, ":error": error, ":now": "2026-10-02T11:00:00.000Z" } } },
      { Delete: { TableName: "state", Key: { pk: "SWEBENCH#SLOT", sk: `RUN#${runId}` } } },
      { Update: { TableName: "state", Key: { pk: "SWEBENCH#SLOTS", sk: "COUNTER" }, UpdateExpression: "SET #count = #count - :one", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":one": 1 } } },
    ],
  }));
  const run = without(h.db.get(`SWEBENCH_RUN#${runId}`, "META")!, "pk", "sk", "entityType", "projectName");
  await recordBatchRunEnd(h.dependencies, run as never);
  await topUpBatches(h.dependencies);
}

const without = (item: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));

const states = async (h: Harness, batchId: string) => (await getBatch(h.dependencies, batchId))!.queue.map((entry) => entry.state);
const runIds = async (h: Harness, batchId: string, state = "RUNNING") =>
  (await getBatch(h.dependencies, batchId))!.queue.filter((entry) => entry.state === state).map((entry) => entry.runId!);

describe("creating a batch (spec 052 FR-001, FR-003, FR-004)", () => {
  it("expands task × model × repeat cheapest first, records each estimate, pins the current runner image and writes the record", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ repeats: 2 }));
    expect(batch).toMatchObject({ status: "RUNNING", version: 0, perRunCeilingUsd: 10, spentUsd: 0, thread, createdBy: requester });
    expect(batch.file.runnerImage).toBe(runnerImage);
    expect(batch.queue).toHaveLength(8);
    expect(batch.queue.map((entry) => [entry.index, entry.model.modelId, entry.task, entry.repeat, entry.estimatedCostUsd])).toEqual([
      [0, cheap.modelId, tasks[0], 1, 1.5], [1, cheap.modelId, tasks[0], 2, 1.5], [2, cheap.modelId, tasks[1], 1, 1.5], [3, cheap.modelId, tasks[1], 2, 1.5],
      [4, dear.modelId, tasks[0], 1, 7.2], [5, dear.modelId, tasks[0], 2, 7.2], [6, dear.modelId, tasks[1], 1, 7.2], [7, dear.modelId, tasks[1], 2, 7.2],
    ]);
    expect(batch.queue.every((entry) => entry.state === "QUEUED" && entry.attempt === 1)).toBe(true);
    expect(batch.counts).toMatchObject({ queued: 8, starting: 0, running: 0, done: 0 });
    expect(h.db.get(`EVAL_BATCH#${batch.batchId}`, "META")).toMatchObject({ entityType: "EVAL_BATCH", projectName: "payments", status: "RUNNING" });
    expect(await getBatch(h.dependencies, batch.batchId)).toEqual(batch);
    // Nothing starts until a top-up.
    expect(h.startExecution).not.toHaveBeenCalled();
  });

  it("keeps the listed order when asked, and pins the file's own runner image", async () => {
    const h = await harness();
    const batch = await createBatch(h.dependencies, h.context, file({ order: "as-listed", runnerImage: pinnedImage }));
    expect(batch.queue.map((entry) => [entry.task, entry.model.modelId])).toEqual([
      [tasks[0], dear.modelId], [tasks[0], cheap.modelId], [tasks[1], dear.modelId], [tasks[1], cheap.modelId],
    ]);
    expect(batch.file.runnerImage).toBe(pinnedImage);
  });

  it("refuses an unapproved model, a model it cannot price, a cap below one run's ceiling, a disabled channel and an invalid file", async () => {
    const h = await harness();
    await expect(createBatch(h.dependencies, h.context, file({ models: [cheap, unapproved] }))).rejects.toThrow(/not approved/);
    const unpriced = await harness();
    unpriced.dependencies.estimateRunCostUsd = () => undefined;
    await expect(createBatch(unpriced.dependencies, unpriced.context, file())).rejects.toThrow(/cost of .* cannot be estimated/);
    await expect(createBatch(h.dependencies, h.context, file({ costCapUsd: 5 }))).rejects.toThrow(/below one run's ceiling/);
    await expect(createBatch(h.dependencies, { ...h.context, thread: { ...thread, channelId: "C0999999999" } }, file())).rejects.toThrow(/not enabled/);
    await expect(createBatch(h.dependencies, h.context, file({ costCapUsd: 5_000 }))).rejects.toThrow();
    await expect(createBatch(h.dependencies, h.context, file({ tasks: ["njs.cve-2022-32414"] }))).rejects.toThrow(/does not fit/);
    await expect(createBatch(h.dependencies, h.context, file({ models: [{ ...cheap, routing: { only: ["Not A Slug"] } }] }))).rejects.toThrow(/provider slugs/);
    expect(h.db.find((item) => String(item.pk).startsWith("EVAL_BATCH#"))).toEqual([]);
  });

  it("draws a sample once with its seed and writes the drawn tasks into the queue", async () => {
    const population = Array.from({ length: 30 }, (_, index) => `${index % 2 === 0 ? "django__django" : "sympy__sympy"}-${1000 + index}`);
    const h = await harness({ datasetInstanceIds: vi.fn(async () => population) });
    const sample = { count: 6, seed: 46 };
    const batch = await createBatch(h.dependencies, h.context, { benchmark: "verified", sample, models: [cheap], costCapUsd: 50 });
    const drawn = batch.queue.map((entry) => entry.task);
    expect(drawn).toHaveLength(6);
    expect(new Set(drawn).size).toBe(6);
    expect(drawn).toEqual(drawSample(population, sample));
    expect(drawSample(population, sample)).toEqual(drawSample([...population].reverse(), sample));
    expect(drawSample(population, { count: 6, seed: 47 })).not.toEqual(drawn);
    // Strata split the draw across projects as evenly as the count allows.
    const stratified = drawSample(population, { count: 4, seed: 1, strata: ["django", "sympy"] });
    expect(stratified.filter((id) => id.startsWith("django")).length).toBe(2);
    expect(stratified.filter((id) => id.startsWith("sympy")).length).toBe(2);
    // No population source: a sample is refused with the reason.
    const none = await harness();
    await expect(createBatch(none.dependencies, none.context, { benchmark: "verified", sample, models: [cheap], costCapUsd: 50 })).rejects.toThrow(/list the tasks/);
  });

  it("estimates a run's cost as list prices times the measured SEC-bench token mix", () => {
    expect(EVAL_BATCH_REFERENCE_TOKENS).toEqual({ input: 0, output: 101_000, cacheRead: 16_900_000, cacheWrite: 167_000 });
    // Sonnet 4.6: 16.9M × $0.30 + 0.101M × $15 + 0.167M × $3.75 per million.
    expect(defaultRunCostEstimate({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" })).toBeCloseTo(5.07 + 1.515 + 0.62625, 6);
    // A Bedrock inference profile prices as its catalog model.
    expect(defaultRunCostEstimate({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-6-v1" })).toBeCloseTo(8.45 + 2.525 + 1.04375, 6);
    // No cache price: cached reads are billed as input.
    expect(defaultRunCostEstimate({ provider: "openrouter", modelId: "minimax/minimax-m2" })).toBeCloseTo(16.9 * 0.255 + 0.101 * 1.02 + 0.167 * 0.255, 6);
    expect(defaultRunCostEstimate({ provider: "openrouter", modelId: "vendor/unknown-v1" })).toBeUndefined();
    expect(defaultRunCostEstimate({ provider: "openrouter", modelId: "minimax/minimax-m2.7:free" })).toBeUndefined();
  });
});

describe("topping up a batch's slots (spec 052 FR-004 to FR-006)", () => {
  it("starts runs up to the free slots with deterministic run IDs, the pinned image, the model's level and its provider pin", async () => {
    const h = await harness({ maxConcurrentEvals: 2 });
    const batch = await createBatch(h.dependencies, h.context, file({ runnerImage: pinnedImage }));
    await topUpBatches(h.dependencies);
    expect(h.startExecution).toHaveBeenCalledTimes(2);
    expect(await states(h, batch.batchId)).toEqual(["RUNNING", "RUNNING", "QUEUED", "QUEUED"]);
    const first = evalBatchRunId(batch.batchId, 0, 1);
    expect(await runIds(h, batch.batchId)).toEqual([first, evalBatchRunId(batch.batchId, 1, 1)]);
    expect(evalBatchRunId(batch.batchId, 0, 1)).toBe(first);
    expect(evalBatchRunId(batch.batchId, 0, 2)).not.toBe(first);
    expect(h.launches.get(`evals/${first}/launch.json`)).toMatchObject({
      runnerImage: pinnedImage,
      environment: { PI_CACHE_RETENTION: "long", AGENTX_OPENROUTER_PROVIDERS: "fireworks" },
      run: { runId: first, instanceId: tasks[0], model: { provider: cheap.provider, modelId: cheap.modelId, thinkingLevel: "high" }, maxCostUsd: 10 },
    });
    expect(h.db.get(`SWEBENCH_RUN#${first}`, "META")).toMatchObject({ batchId: batch.batchId, runnerImage: pinnedImage, thread });
    expect(h.db.get("SWEBENCH#SLOT", `RUN#${first}`)).toMatchObject({ batchId: batch.batchId });
    // A later top-up with no free slot starts nothing.
    await topUpBatches(h.dependencies);
    expect(h.startExecution).toHaveBeenCalledTimes(2);
  });

  it("holds to the batch's own concurrency", async () => {
    const h = await harness({ maxConcurrentEvals: 4 });
    const batch = await createBatch(h.dependencies, h.context, file({ concurrency: 1 }));
    await topUpBatches(h.dependencies);
    expect(await states(h, batch.batchId)).toEqual(["RUNNING", "QUEUED", "QUEUED", "QUEUED"]);
  });

  it("starts exactly one run when two top-ups race for one free slot", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await Promise.all([topUpBatches(h.dependencies), topUpBatches(h.dependencies)]);
    expect(h.startExecution).toHaveBeenCalledTimes(1);
    expect(await states(h, batch.batchId)).toEqual(["RUNNING", "QUEUED", "QUEUED", "QUEUED"]);
    expect(h.db.get("SWEBENCH#SLOTS", "COUNTER")).toMatchObject({ count: 1 });
  });

  it("re-reads the record when a claim loses its write to a stop, so the stop is never undone", async () => {
    const h = await harness({ maxConcurrentEvals: 4 });
    const batch = await createBatch(h.dependencies, h.context, file());
    const send = h.db.send;
    let raced = false;
    h.db.send = async (command) => {
      const input = command.input as { Item?: { queue?: Array<{ state: string }> } };
      if (!raced && command.constructor.name === "PutCommand" && input.Item?.queue?.some((entry) => entry.state === "STARTING")) {
        // The stop lands between the claim's read and its write.
        raced = true;
        await stopBatch(h.dependencies, batch.batchId, requester);
      }
      return send(command);
    };
    await topUpBatches(h.dependencies);
    expect(raced).toBe(true);
    expect(h.startExecution).not.toHaveBeenCalled();
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "STOPPED", counts: { cancelled: 4, starting: 0 } });
  });

  it("is idempotent through the deterministic run ID: a claim whose record write was lost starts no second run", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    // The record forgets the start, as if the write after startSwebenchRun had been lost.
    const item = h.db.get(`EVAL_BATCH#${batch.batchId}`, "META")!;
    const queue = (item.queue as Array<Record<string, unknown>>).map((entry, index) => {
      if (index !== 0) return entry;
      return { ...without(entry, "runId", "claimedAt"), state: "QUEUED" };
    });
    h.db.set({ ...item, queue });
    h.limit.value = 2;
    await topUpBatches(h.dependencies);
    // Entry 0 found its run again; entry 1 took the second slot.
    expect(h.startExecution.mock.calls.map(([input]) => (input as { name: string }).name)).toEqual([runId, evalBatchRunId(batch.batchId, 1, 1)]);
    expect((await getBatch(h.dependencies, batch.batchId))!.queue[0]).toMatchObject({ state: "RUNNING", runId });
  });

  it("releases a stale claim that started nothing, adopts one that did, and leaves a fresh one alone", async () => {
    const h = await harness({ maxConcurrentEvals: 4 });
    // One run at a time: a claim in flight keeps the next entry queued.
    const batch = await createBatch(h.dependencies, h.context, file({ concurrency: 1 }));
    const item = h.db.get(`EVAL_BATCH#${batch.batchId}`, "META")!;
    const claimed = (indexes: number[], at: string) => (item.queue as Array<Record<string, unknown>>).map((entry, index) =>
      (indexes.includes(index) ? { ...entry, state: "STARTING", claimedAt: at } : entry));
    // A claim made 4 minutes ago by a top-up that may still be starting it.
    h.db.set({ ...item, queue: claimed([0], "2026-10-02T09:56:00.000Z") });
    await topUpBatches(h.dependencies);
    expect(await states(h, batch.batchId)).toEqual(["STARTING", "QUEUED", "QUEUED", "QUEUED"]);
    expect(h.startExecution).not.toHaveBeenCalled();
    // Past 5 minutes with no run behind it, the claim is released and the entry starts.
    h.advance(2 * 60_000);
    await topUpBatches(h.dependencies);
    expect(await states(h, batch.batchId)).toEqual(["RUNNING", "QUEUED", "QUEUED", "QUEUED"]);
    expect(h.startExecution).toHaveBeenCalledTimes(1);
    // A stale claim whose run did start is adopted, not started again.
    const again = h.db.get(`EVAL_BATCH#${batch.batchId}`, "META")!;
    h.db.set({ ...again, queue: (again.queue as Array<Record<string, unknown>>).map((entry, index) => {
      if (index !== 0) return entry;
      return { ...without(entry, "runId"), state: "STARTING", claimedAt: "2026-10-02T09:50:00.000Z" };
    }) });
    await topUpBatches(h.dependencies);
    expect((await getBatch(h.dependencies, batch.batchId))!.queue[0]).toMatchObject({ state: "RUNNING", runId: evalBatchRunId(batch.batchId, 0, 1) });
    expect(h.startExecution).toHaveBeenCalledTimes(1);
  });

  it("retries a start refused by a transaction conflict on the slot counter, and gives the claim back after three", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    const send = h.db.send;
    let conflicts = 1;
    h.db.send = async (command) => {
      const input = command.input as { TransactItems?: Array<Record<string, unknown>> };
      if (command.constructor.name === "TransactWriteCommand" && input.TransactItems?.[0]?.Put !== undefined && conflicts > 0) {
        conflicts -= 1;
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "None" }],
        });
      }
      return send(command);
    };
    await topUpBatches(h.dependencies);
    expect(h.startExecution).toHaveBeenCalledTimes(1);
    expect(await states(h, batch.batchId)).toEqual(["RUNNING", "QUEUED", "QUEUED", "QUEUED"]);

    const stuck = await harness({ maxConcurrentEvals: 1 });
    const other = await createBatch(stuck.dependencies, stuck.context, file());
    const stuckSend = stuck.db.send;
    let attempts = 0;
    stuck.db.send = async (command) => {
      const input = command.input as { TransactItems?: Array<Record<string, unknown>> };
      if (command.constructor.name === "TransactWriteCommand" && input.TransactItems?.[0]?.Put !== undefined) {
        attempts += 1;
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "None" }],
        });
      }
      return stuckSend(command);
    };
    await topUpBatches(stuck.dependencies);
    expect(attempts).toBe(3);
    expect(stuck.startExecution).not.toHaveBeenCalled();
    expect(await states(stuck, other.batchId)).toEqual(["QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
  });

  it("gives a claim back when no slot is free, and starts it when a single run's slot is released", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    // A single run holds the only slot.
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    expect(h.startExecution).not.toHaveBeenCalled();
    expect(await states(h, batch.batchId)).toEqual(["QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
    // The counter read raced a release: the start itself is refused, and the claim is given back.
    h.limit.value = 2;
    h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 1 });
    const send = h.db.send;
    h.db.send = async (command) => {
      const input = command.input as { TransactItems?: Array<Record<string, unknown>> };
      if (input.TransactItems?.[0]?.Put !== undefined) h.db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 2 });
      return send(command);
    };
    await topUpBatches(h.dependencies);
    expect(h.startExecution).not.toHaveBeenCalled();
    expect(await states(h, batch.batchId)).toEqual(["QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
  });
});

describe("the cost cap (spec 052 FR-007)", () => {
  it("never starts a run that could take spend past the cap, and ends CAPPED once the in-flight runs finish", async () => {
    // Ceiling 10, cap 25: two runs in flight reserve 20, and a third would reserve 30.
    const h = await harness({ maxConcurrentEvals: 4, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ costCapUsd: 25, repeats: 2 }));
    await topUpBatches(h.dependencies);
    expect(h.startExecution).toHaveBeenCalledTimes(2);
    const [first, second] = await runIds(h, batch.batchId);
    // 3 spent + 1 × 10 in flight + 10 = 23 ≤ 25: the next run starts.
    await finish(h, first!, graded(3));
    expect(h.startExecution).toHaveBeenCalledTimes(3);
    expect((await getBatch(h.dependencies, batch.batchId))!.spentUsd).toBe(3);
    // 9 spent + 1 × 10 + 10 = 29 > 25: no start, and the batch waits for its in-flight run.
    await finish(h, second!, graded(6));
    expect(h.startExecution).toHaveBeenCalledTimes(3);
    expect((await getBatch(h.dependencies, batch.batchId))!.status).toBe("RUNNING");
    const [third] = await runIds(h, batch.batchId);
    // 18 spent + 10 = 28 > 25 with nothing in flight: the rest never start.
    await finish(h, third!, graded(9, false));
    const capped = (await getBatch(h.dependencies, batch.batchId))!;
    expect(capped).toMatchObject({ status: "CAPPED", spentUsd: 18, counts: { done: 3, notStarted: 5, queued: 0, running: 0 } });
    expect(capped.finishedAt).toBeDefined();
    expect(h.startExecution).toHaveBeenCalledTimes(3);
    // A capped batch is no longer topped up.
    await topUpBatches(h.dependencies);
    expect(h.startExecution).toHaveBeenCalledTimes(3);
  });

  it("holds the cap when two top-ups race for the last run that fits", async () => {
    const h = await harness({ maxConcurrentEvals: 4, maxCostUsd: 10 });
    const batch = await createBatch(h.dependencies, h.context, file({ costCapUsd: 10 }));
    await Promise.all([topUpBatches(h.dependencies), topUpBatches(h.dependencies)]);
    expect(h.startExecution).toHaveBeenCalledTimes(1);
    expect(await states(h, batch.batchId)).toEqual(["RUNNING", "QUEUED", "QUEUED", "QUEUED"]);
  });
});

describe("run ends and the single infrastructure retry (spec 052 FR-008, FR-010)", () => {
  it("recognises infrastructure failures by their error text", () => {
    for (const error of [
      "the eval instance could not be launched: InsufficientInstanceCapacity",
      "the eval instance could not be recorded: ThrottlingException",
      "the eval instance stopped (terminated) without reporting a result; see its log stream",
      "the run could not start: AccessDenied writing launch.json",
      "could not pull swebench/sweb.eval.x86_64.django_1776_django-11099:latest (timed out): EOF",
      "AccessDeniedException: You don't have access to the model with the specified model ID.",
      "OpenRouter credential could not be loaded; check the secret value and read permissions",
    ]) expect(isInfrastructureFailure(error), error).toBe(true);
    for (const error of [
      "the run did not finish within its 2-hour limit",
      "cancelled from Slack",
      "django__django-99999 is not in SWE-bench/SWE-bench_Verified",
      "SEC-bench's evaluator could not grade the patch: build failed",
      "the SWE-bench harness wrote no report (exit 1): boom",
      undefined,
    ]) expect(isInfrastructureFailure(error), String(error)).toBe(false);
  });

  it("retries an infrastructure failure once under a new run ID, then records it failed", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], models: [cheap] }));
    await topUpBatches(h.dependencies);
    const first = evalBatchRunId(batch.batchId, 0, 1);
    await finish(h, first, { outcome: "FAILED", error: "could not pull swebench/x: EOF", usage: usage(0.4) });
    const retried = (await getBatch(h.dependencies, batch.batchId))!;
    const second = evalBatchRunId(batch.batchId, 0, 2);
    expect(retried.queue[0]).toMatchObject({ state: "RUNNING", attempt: 2, runId: second });
    expect(retried.spentUsd).toBeCloseTo(0.4, 9);
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual([]);
    // The second infrastructure failure, seen by the state machine, is final.
    await endByStateMachine(h, second, "FAILED", "the eval instance stopped (terminated) without reporting a result; see its log stream");
    const failed = (await getBatch(h.dependencies, batch.batchId))!;
    expect(failed).toMatchObject({ status: "DONE", counts: { failed: 1, queued: 0, running: 0 } });
    expect(failed.queue[0]).toMatchObject({ state: "FAILED", attempt: 2, runId: second });
    expect(h.startExecution).toHaveBeenCalledTimes(2);
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toEqual([expect.objectContaining({
      batchId: batch.batchId, runId: second, instanceId: tasks[0], provider: "openrouter", modelId: cheap.modelId, thinkingLevel: "high",
      routing: { only: ["fireworks"] }, repeat: 1, outcome: "FAILED", resolved: false, costUsd: null,
    })]);
  });

  it("never retries a graded result, nor a failure that is not the infrastructure's", async () => {
    const h = await harness({ maxConcurrentEvals: 2 });
    const batch = await createBatch(h.dependencies, h.context, file({ tasks: [tasks[0]], repeats: 1 }));
    await topUpBatches(h.dependencies);
    const [cheapRun, dearRun] = await runIds(h, batch.batchId);
    await finish(h, cheapRun!, graded(2.5, false));
    await finish(h, dearRun!, { outcome: "FAILED", error: "the SWE-bench harness wrote no report (exit 1): boom" });
    const done = (await getBatch(h.dependencies, batch.batchId))!;
    expect(done).toMatchObject({ status: "DONE", spentUsd: 2.5, counts: { done: 1, failed: 1 } });
    expect(done.queue.map((entry) => entry.attempt)).toEqual([1, 1]);
    expect(h.startExecution).toHaveBeenCalledTimes(2);
    const measures = await listBatchMeasures(h.dependencies, batch.batchId);
    expect(measures).toHaveLength(2);
    expect(measures.find((measure) => measure.runId === cheapRun)).toMatchObject({
      outcome: "GRADED", resolved: false, stopReason: "finished", agentSeconds: 420, costUsd: 2.5, imageDigest: "swebench/x@sha256:abc",
      failToPass: { passed: 3, total: 3 }, tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, total: 115 },
    });
    // A repeated result records nothing twice.
    await finish(h, cheapRun!, graded(2.5, false));
    await recordBatchRunEnd(h.dependencies, (await finish(h, cheapRun!, graded(2.5))).run);
    expect((await getBatch(h.dependencies, batch.batchId))!.spentUsd).toBe(2.5);
    expect(await listBatchMeasures(h.dependencies, batch.batchId)).toHaveLength(2);
  });

  it("starts the next queued run when a run ends", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    await finish(h, evalBatchRunId(batch.batchId, 0, 1), graded(1));
    expect(await states(h, batch.batchId)).toEqual(["DONE", "RUNNING", "QUEUED", "QUEUED"]);
  });
});

describe("stopping a batch (spec 052 FR-009)", () => {
  it("cancels queued runs and in-flight runs, starts nothing more, and ends STOPPED when the runs end", async () => {
    const h = await harness({ maxConcurrentEvals: 2 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    const [first, second] = await runIds(h, batch.batchId);
    const stopping = await stopBatch(h.dependencies, batch.batchId, requester);
    expect(stopping).toMatchObject({ status: "STOPPING", counts: { cancelled: 2, running: 2, queued: 0 } });
    expect(h.db.get(`SWEBENCH_RUN#${first}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED", cancelRequestedBy: requester });
    expect(h.db.get(`SWEBENCH_RUN#${second}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED" });
    await endByStateMachine(h, first!, "CANCELLED", "cancelled from Slack");
    expect(h.startExecution).toHaveBeenCalledTimes(2);
    expect((await getBatch(h.dependencies, batch.batchId))!.status).toBe("STOPPING");
    // The runner's result can still arrive for a run being cancelled: it is recorded, not retried.
    await finish(h, second!, { outcome: "FAILED", error: "could not pull swebench/x: EOF" });
    const stopped = (await getBatch(h.dependencies, batch.batchId))!;
    expect(stopped).toMatchObject({ status: "STOPPED", counts: { cancelled: 3, failed: 1, running: 0 } });
    expect(stopped.finishedAt).toBeDefined();
    expect(h.startExecution).toHaveBeenCalledTimes(2);
    // Stopping again changes nothing.
    expect(await stopBatch(h.dependencies, batch.batchId, requester)).toMatchObject({ status: "STOPPED" });
  });

  it("stops the batch from its thread's stop command, through the stop path's batch hook", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    expect(await stopSwebenchRun(h.dependencies, thread, requester)).toBe(runId);
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "STOPPING", counts: { cancelled: 3, running: 1 } });
    // A stop in a thread whose batch runs nothing returns the batch.
    const idle = await createBatch(h.dependencies, { ...h.context, thread: { ...thread, threadTs: "1695500000.000009" } }, file());
    expect(await stopSwebenchRun(h.dependencies, { ...thread, threadTs: "1695500000.000009" }, requester)).toBe(idle.batchId);
    expect(await getBatch(h.dependencies, idle.batchId)).toMatchObject({ status: "STOPPED", counts: { cancelled: 4 } });
  });

  it("cancels a run that a top-up started while the batch was being stopped", async () => {
    const h = await harness({ maxConcurrentEvals: 1 });
    const batch = await createBatch(h.dependencies, h.context, file());
    const startExecution = h.startExecution;
    startExecution.mockImplementationOnce(async () => {
      await stopBatch(h.dependencies, batch.batchId, requester);
    });
    await topUpBatches(h.dependencies);
    const runId = evalBatchRunId(batch.batchId, 0, 1);
    expect(h.db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(await getBatch(h.dependencies, batch.batchId)).toMatchObject({ status: "STOPPING", counts: { running: 1, cancelled: 3 } });
  });
});
