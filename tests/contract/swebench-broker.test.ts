import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { AgentXError, SwebenchLaunchSchema, type SwebenchLaunch } from "@agentx/contracts";
import { swebenchEvalDefinition } from "../../infra/lib/swebench-eval-definition.js";
import { stopSwebenchRun, type SwebenchDependencies, type SwebenchDeployment } from "../../packages/broker/src/aws/swebench.js";
import { swebenchDeploymentFromParameters } from "../../packages/broker/src/aws/swebench-settings.js";
import { createBatch, evalBatchRunId, getBatch, topUpBatches, withEvalBatches } from "../../packages/broker/src/aws/eval-batch.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, registerSlackProject, serviceCall } from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const otherThread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const slackThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };
const member = "U0123456789";
const administrator = { subject: "admin-subject", admin: true };
const channelPath = `/v1/admin/evals/channels/${SLACK_TEAM}/${SLACK_CHANNEL}`;
const runnerImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;

const deployment: SwebenchDeployment = {
  settings: {
    stateMachineArn: "arn:aws:states:us-east-1:111122223333:stateMachine:agentx-production-swebench-eval",
    subnetIds: ["subnet-0123456789abcdef0"],
    controlPlaneUrl: "https://api.example.com",
    logGroupName: "/agentx/production/swebench",
    maxConcurrentEvals: 4, // spec 052: the schema default fills stored settings that lack it
  },
  runnerImage,
  defaultModel: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-deployment" },
  environment: { PI_CACHE_RETENTION: "long" },
  runnerFeatures: ["model.thinkingLevel"],
};

beforeAll(async () => {
  await loadSlackBroker();
});

/** A broker with SWE-bench runs installed, a bound channel, and the launch files it writes. */
async function evalBroker(options: { installed?: boolean; models?: unknown; startExecution?: () => Promise<void>; runnerFeatures?: string[]; maxConcurrentEvals?: number } = {}) {
  const launches = new Map<string, SwebenchLaunch>();
  const s3 = {
    send: vi.fn(async (command: { input: { Key?: string; Body?: string } }) => {
      if (command.input.Key?.endsWith("/launch.json")) launches.set(command.input.Key, SwebenchLaunchSchema.parse(JSON.parse(command.input.Body!)));
      return {};
    }),
  };
  const startExecution = vi.fn(options.startExecution ?? (async () => undefined));
  const broker = createBroker({
    s3,
    extra: {
      swebench: {
        deployment: async () => (options.installed === false ? undefined : {
          ...deployment,
          settings: { ...deployment.settings, maxConcurrentEvals: options.maxConcurrentEvals ?? deployment.settings.maxConcurrentEvals },
          runnerFeatures: options.runnerFeatures ?? deployment.runnerFeatures,
        }),
        startExecution,
      },
    },
  });
  await registerSlackProject(broker.handler, options.models === undefined ? {} : { models: options.models });
  return { ...broker, launches, startExecution };
}

const enable = (handler: Parameters<typeof call>[0], body: unknown = {}, user = administrator) =>
  call(handler, { method: "PUT", path: channelPath, user, body });

const start = (handler: Parameters<typeof call>[0], body: Record<string, unknown> = {}, threadValue = thread) =>
  serviceCall(handler, threadValue, member, "POST", "/v1/service/evals/swebench", {
    requestId: randomUUID(), dataset: "verified", instanceId: "django__django-11099", ...body,
  });

describe("enabling SWE-bench runs in a channel (spec 043 FR-002)", () => {
  it("lets a project administrator enable, read and disable a bound channel", async () => {
    const { handler } = await evalBroker();
    expect(await enable(handler, { maxCostUsd: 25 })).toMatchObject({ status: 200, body: { channel: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, maxCostUsd: 25 }, projectName: "payments" } });
    expect(await call(handler, { method: "GET", path: channelPath, user: administrator })).toMatchObject({ status: 200, body: { channel: { maxCostUsd: 25 } } });
    expect(await call(handler, { method: "DELETE", path: channelPath, user: administrator })).toMatchObject({ status: 200, body: { deleted: true } });
    expect(await call(handler, { method: "DELETE", path: channelPath, user: administrator })).toMatchObject({ status: 200, body: { deleted: false } });
    expect((await call(handler, { method: "GET", path: channelPath, user: administrator })).status).toBe(404);
  });

  it("defaults the cost ceiling to 10 USD and refuses one outside 1 to 100", async () => {
    const { handler } = await evalBroker();
    expect((await enable(handler)).body).toMatchObject({ channel: { maxCostUsd: 10 } });
    expect((await enable(handler, { maxCostUsd: 0.5 })).status).toBe(400);
    expect((await enable(handler, { maxCostUsd: 500 })).status).toBe(400);
  });

  it("refuses a non-administrator and an unbound channel", async () => {
    const { handler } = await evalBroker();
    expect((await enable(handler, {}, { subject: "someone" })).status).toBe(403);
    const unbound = await call(handler, { method: "PUT", path: `/v1/admin/evals/channels/${SLACK_TEAM}/C0999999999`, user: administrator, body: {} });
    expect(unbound).toMatchObject({ status: 404, body: { error: { message: expect.stringContaining("bind the channel") as unknown } } });
  });
});

describe("starting a run (spec 043 FR-001 to FR-006)", () => {
  it("records the run, takes a slot, writes the launch file and starts the state machine", async () => {
    const { handler, db, launches, startExecution } = await evalBroker();
    await enable(handler, { maxCostUsd: 12 });
    const started = await start(handler);
    expect(started).toMatchObject({ status: 200, body: { outcome: "STARTED", run: {
      dataset: "verified", instanceId: "django__django-11099", status: "STARTING", maxCostUsd: 12,
      model: deployment.defaultModel, thread: slackThread, requestedBy: { teamId: SLACK_TEAM, userId: member },
    } } });
    const runId = (started.body.run as { runId: string }).runId;
    expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ entityType: "SWEBENCH_RUN", projectName: "payments", status: "STARTING" });
    expect(db.get("SWEBENCH#SLOT", `RUN#${runId}`)).toMatchObject({ runId, threadSubject: thread });
    expect(db.get("SWEBENCH#SLOTS", "COUNTER")).toMatchObject({ count: 1 });
    const launch = launches.get(`evals/${runId}/launch.json`);
    expect(launch).toMatchObject({
      runnerImage, logGroupName: "/agentx/production/swebench", environment: { PI_CACHE_RETENTION: "long" },
      run: { runId, controlPlaneUrl: "https://api.example.com", artifactBucket: "artifacts", artifactsPrefix: `evals/${runId}/`, maxCostUsd: 12 },
    });
    expect(startExecution).toHaveBeenCalledWith({
      stateMachineArn: deployment.settings.stateMachineArn,
      name: runId,
      input: JSON.stringify({ runId, subnetId: "subnet-0123456789abcdef0" }),
    });
  });

  it("answers a repeated request with the run it started, and refuses a second run while one is active", async () => {
    const { handler, startExecution } = await evalBroker({ maxConcurrentEvals: 1 });
    await enable(handler);
    const requestId = randomUUID();
    const first = await start(handler, { requestId });
    const again = await start(handler, { requestId });
    expect(again.body.run).toEqual(first.body.run);
    expect(startExecution).toHaveBeenCalledTimes(1);
    expect((await start(handler, {}, otherThread)).body).toMatchObject({ outcome: "REFUSED", reason: "RUN_ACTIVE", message: "1 eval run is in progress; try again shortly." });
  });

  it("refuses a run where eval is not installed or the channel is not enabled", async () => {
    const notInstalled = await evalBroker({ installed: false });
    await enable(notInstalled.handler);
    expect((await start(notInstalled.handler)).body).toMatchObject({ outcome: "REFUSED", reason: "NOT_INSTALLED", message: expect.stringMatching(/^Eval runs are not installed in this deployment\./) as unknown });
    const notEnabled = await evalBroker();
    expect((await start(notEnabled.handler)).body).toMatchObject({ outcome: "REFUSED", reason: "NOT_ENABLED", message: expect.stringMatching(/^Eval runs are not enabled in this channel\. .*agentx admin eval enable/) as unknown });
    expect(notEnabled.startExecution).not.toHaveBeenCalled();
  });

  it("uses the project's current model, an approved requested one, and refuses an unapproved one (FR-003)", async () => {
    const models = {
      default: { provider: "amazon-bedrock", modelId: "balanced", label: "Balanced" },
      approved: [
        { provider: "amazon-bedrock", modelId: "balanced", label: "Balanced" },
        { provider: "amazon-bedrock", modelId: "fast", label: "Fast" },
      ],
    };
    const withModel = async (body: Record<string, unknown>) => {
      const { handler } = await evalBroker({ models });
      await enable(handler);
      return start(handler, body);
    };
    expect((await withModel({})).body).toMatchObject({ run: { model: { provider: "amazon-bedrock", modelId: "balanced" } } });
    expect((await withModel({ model: { provider: "amazon-bedrock", modelId: "fast" } })).body).toMatchObject({ run: { model: { modelId: "fast" } } });
    expect(await withModel({ model: { provider: "amazon-bedrock", modelId: "unapproved" } }))
      .toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("not approved") as unknown } } });
  });

  it("carries the approved entry's thinking level into the run record and launch file, and none for an entry or default without one (spec 053)", async () => {
    const models = {
      default: { provider: "amazon-bedrock", modelId: "balanced", label: "Balanced" },
      approved: [
        { provider: "amazon-bedrock", modelId: "balanced", label: "Balanced" },
        { provider: "amazon-bedrock", modelId: "fast", label: "Fast", thinkingLevel: "low" },
      ],
    };
    const startWith = async (options: { models?: unknown; runnerFeatures?: string[] }, body: Record<string, unknown>) => {
      const broker = await evalBroker(options);
      await enable(broker.handler);
      const started = await start(broker.handler, body);
      expect(started.body).toMatchObject({ outcome: "STARTED" });
      const runId = (started.body.run as { runId: string }).runId;
      const stored = broker.db.get(`SWEBENCH_RUN#${runId}`, "META")!.model as Record<string, unknown>;
      return { reply: (started.body.run as { model: Record<string, unknown> }).model, stored, launched: broker.launches.get(`evals/${runId}/launch.json`)!.run.model as Record<string, unknown> };
    };
    const fast = { model: { provider: "amazon-bedrock", modelId: "fast" } };

    const leveled = await startWith({ models }, fast);
    const expected = { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low" };
    expect(leveled).toEqual({ reply: expected, stored: expected, launched: expected });

    for (const { reply, stored, launched } of [await startWith({ models }, {}), await startWith({}, {})]) {
      for (const model of [reply, stored, launched]) expect(Object.keys(model)).not.toContain("thinkingLevel");
    }
    expect((await startWith({}, {})).launched).toEqual(deployment.defaultModel);
  });

  it("omits the thinking level for a runner image that does not record the feature, in the record as in the launch file (spec 053)", async () => {
    const models = {
      default: { provider: "amazon-bedrock", modelId: "fast", label: "Fast", thinkingLevel: "low" },
      approved: [{ provider: "amazon-bedrock", modelId: "fast", label: "Fast", thinkingLevel: "low" }],
    };
    const broker = await evalBroker({ models, runnerFeatures: [] });
    await enable(broker.handler);
    const started = await start(broker.handler);
    const runId = (started.body.run as { runId: string }).runId;
    const model = { provider: "amazon-bedrock", modelId: "fast" };
    expect(started.body).toMatchObject({ outcome: "STARTED", run: { model } });
    expect(Object.keys((started.body.run as { model: object }).model)).not.toContain("thinkingLevel");
    expect(broker.db.get(`SWEBENCH_RUN#${runId}`, "META")!.model).toEqual(model);
    expect(broker.launches.get(`evals/${runId}/launch.json`)!.run.model).toEqual(model);
  });

  it("fails the run and releases its slot when the state machine cannot start", async () => {
    const { handler, db } = await evalBroker({ startExecution: async () => { throw new Error("ExecutionLimitExceeded"); } });
    await enable(handler);
    const requestId = randomUUID();
    expect((await start(handler, { requestId })).status).toBeGreaterThanOrEqual(400);
    expect(db.get(`SWEBENCH_RUN#${requestId}`, "META")).toMatchObject({ status: "FAILED", error: expect.stringContaining("ExecutionLimitExceeded") as unknown });
    expect(db.get("SWEBENCH#SLOT", `RUN#${requestId}`)).toBeUndefined();
    expect(db.get("SWEBENCH#SLOTS", "COUNTER")).toMatchObject({ count: 0 });
  });

  it("shows a run only to the thread that started it", async () => {
    const { handler } = await evalBroker();
    await enable(handler);
    const runId = ((await start(handler)).body.run as { runId: string }).runId;
    expect(await serviceCall(handler, thread, member, "GET", `/v1/service/evals/swebench/${runId}`)).toMatchObject({ status: 200, body: { run: { runId, status: "STARTING" } } });
    expect((await serviceCall(handler, otherThread, member, "GET", `/v1/service/evals/swebench/${runId}`)).status).toBe(404);
  });
});

describe("the runner's callbacks and the stop command (spec 043 FR-005, FR-007)", () => {
  const usage = {
    schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "m", cacheRetention: "long",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cacheReadRatio: 0, costUsd: 1.25,
  };
  const graded = {
    outcome: "GRADED", resolved: true, stopReason: "finished", patchBytes: 899,
    failToPass: { passed: 3, total: 3 }, passToPass: { passed: 19, total: 19 },
    agentSeconds: 420, imageDigest: "swebench/x@sha256:abc", usage,
  };

  async function runningRun() {
    const broker = await evalBroker();
    await enable(broker.handler);
    const runId = ((await start(broker.handler)).body.run as { runId: string }).runId;
    const capability = broker.launches.get(`evals/${runId}/launch.json`)!.run.capability;
    const callback = (action: string, body: unknown = {}, token = capability, id = runId) => call(broker.handler, {
      method: "POST", path: `/v1/internal/evals/${id}/${action}`, headers: { "x-agentx-callback-capability": token }, body,
    });
    return { ...broker, runId, capability, callback };
  }

  it("moves the run to RUNNING, then applies the graded result and releases the slot", async () => {
    const { db, runId, callback, handler } = await runningRun();
    expect(await callback("started")).toMatchObject({ status: 200, body: { run: { status: "RUNNING" } } });
    const finished = await callback("result", { ...graded, artifactsPrefix: `evals/${runId}/` });
    expect(finished).toMatchObject({ status: 200, body: { run: { status: "SUCCEEDED", result: { resolved: true, failToPass: { passed: 3, total: 3 } } } } });
    expect(db.get("SWEBENCH#SLOT", `RUN#${runId}`)).toBeUndefined();
    expect(db.get("SWEBENCH#SLOTS", "COUNTER")).toMatchObject({ count: 0 });
    // A repeated result changes nothing, and the next run may start.
    expect(await callback("result", { outcome: "FAILED", error: "late" })).toMatchObject({ status: 200, body: { run: { status: "SUCCEEDED" } } });
    expect((await start(handler, {}, otherThread)).body).toMatchObject({ outcome: "STARTED" });
  });

  it("records a failed run's error", async () => {
    const { callback } = await runningRun();
    expect(await callback("result", { outcome: "FAILED", error: "could not pull the image" })).toMatchObject({
      body: { run: { status: "FAILED", error: "could not pull the image" } },
    });
  });

  it("refuses a missing, forged, other run's or workspace-style capability", async () => {
    const { callback, capability } = await runningRun();
    const refused = async (response: Promise<{ status: number; body: Record<string, unknown> }>) =>
      expect(await response).toMatchObject({ body: { error: { code: "CALLBACK_FORBIDDEN" } } });
    await refused(callback("started", {}, ""));
    const [body] = capability.split(".");
    await refused(callback("started", {}, `${body}.${"A".repeat(43)}`));
    // A workspace callback capability is signed with the undivided key: it never passes here.
    const { createHmac } = await import("node:crypto");
    await refused(callback("started", {}, `${body}.${createHmac("sha256", "c".repeat(64)).update(body!).digest("base64url")}`));
    await refused(callback("started", {}, capability, randomUUID()));
  });

  it("stops the thread's run from the stop command, and leaves other threads alone", async () => {
    const { handler, db, runId } = await runningRun();
    const other = await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: { ...slackThread, threadTs: "1695500000.000002" }, userId: member });
    expect(JSON.parse(other.body)).toMatchObject({ outcome: "NOTHING_RUNNING" });
    const stopped = await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: slackThread, userId: member });
    expect(JSON.parse(stopped.body)).toMatchObject({ outcome: "CANCEL_REQUESTED", targetOperationId: runId });
    expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED", cancelRequestedBy: { teamId: SLACK_TEAM, userId: member } });
  });
});

describe("the shared limit on concurrent runs (spec 052 FR-005)", () => {
  const counter = (db: { get: (pk: string, sk: string) => Record<string, unknown> | undefined }) => db.get("SWEBENCH#SLOTS", "COUNTER")?.count;
  const runIdOf = (response: { body: Record<string, unknown> }) => (response.body.run as { runId: string }).runId;
  const definition = swebenchEvalDefinition({ launchTemplateId: "lt-1", stateTableName: "state", environmentTag: "production", resourcePrefix: "agentx-production" }) as {
    States: Record<string, { Resource?: string; Arguments?: Record<string, unknown> }>;
  };

  /**
   * A write step of the eval state machine, sent to the fake table as Step Functions would send it
   * for this run: its JSONata values filled in and its wire-format values unmarshalled.
   */
  async function stateMachineWrite(db: { send: (command: never) => Promise<unknown> }, state: string, runId: string) {
    const expressions: Record<string, string> = {
      "{% 'SWEBENCH_RUN#' & $runId %}": `SWEBENCH_RUN#${runId}`,
      "{% 'RUN#' & $runId %}": `RUN#${runId}`,
      "{% $runId %}": runId,
      "{% $endStatus %}": "CANCELLED",
      "{% $failure %}": "cancelled from Slack",
      "{% $now() %}": new Date().toISOString(),
    };
    const fill = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("{%")) {
        if (!(value in expressions)) throw new Error(`no value for ${value}`);
        return expressions[value];
      }
      if (Array.isArray(value)) return value.map(fill);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]));
      return value;
    };
    const plain = (action: Record<string, unknown>) => ({
      ...action,
      Key: unmarshall(action.Key as never),
      ...(action.ExpressionAttributeValues === undefined ? {} : { ExpressionAttributeValues: unmarshall(action.ExpressionAttributeValues as never) }),
    });
    const step = definition.States[state]!;
    const args = fill(step.Arguments) as Record<string, unknown>;
    if (step.Resource!.endsWith(":transactWriteItems")) {
      const items = (args.TransactItems as Array<Record<string, Record<string, unknown>>>).map((entry) =>
        Object.fromEntries(Object.entries(entry).map(([kind, action]) => [kind, plain(action)])));
      return db.send(new TransactWriteCommand({ TransactItems: items }) as never);
    }
    if (step.Resource!.endsWith(":updateItem")) return db.send(new UpdateCommand(plain(args) as never) as never);
    throw new Error(`${state} is not a write step`);
  }

  async function brokerWithResult(options: { maxConcurrentEvals?: number } = {}) {
    const broker = await evalBroker(options);
    await enable(broker.handler);
    const result = (runId: string, body: unknown = { outcome: "FAILED", error: "could not pull the image" }) => call(broker.handler, {
      method: "POST", path: `/v1/internal/evals/${runId}/result`,
      headers: { "x-agentx-callback-capability": broker.launches.get(`evals/${runId}/launch.json`)!.run.capability }, body,
    });
    return { ...broker, result };
  }

  it("starts two runs and refuses a third when the limit is 2", async () => {
    const { handler, db, startExecution } = await brokerWithResult({ maxConcurrentEvals: 2 });
    const first = runIdOf(await start(handler));
    const second = runIdOf(await start(handler, {}, otherThread));
    expect(counter(db)).toBe(2);
    expect(db.get("SWEBENCH#SLOT", `RUN#${first}`)).toMatchObject({ threadSubject: thread });
    expect(db.get("SWEBENCH#SLOT", `RUN#${second}`)).toMatchObject({ threadSubject: otherThread });
    const third = await start(handler, {}, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000003`);
    expect(third.body).toMatchObject({ outcome: "REFUSED", reason: "RUN_ACTIVE", message: "2 eval runs are in progress; try again shortly." });
    expect(counter(db)).toBe(2);
    expect(startExecution).toHaveBeenCalledTimes(2);
  });

  it("frees a slot when a run finishes", async () => {
    const { handler, db, result } = await brokerWithResult({ maxConcurrentEvals: 1 });
    const runId = runIdOf(await start(handler));
    expect((await start(handler, {}, otherThread)).body).toMatchObject({ outcome: "REFUSED", reason: "RUN_ACTIVE" });
    expect(await result(runId)).toMatchObject({ status: 200, body: { run: { status: "FAILED" } } });
    expect(counter(db)).toBe(0);
    expect(db.get("SWEBENCH#SLOT", `RUN#${runId}`)).toBeUndefined();
    expect((await start(handler, {}, otherThread)).body).toMatchObject({ outcome: "STARTED" });
  });

  it("releases a slot once when the broker and the state machine both end the run, in either order", async () => {
    const { handler, db, result } = await brokerWithResult({ maxConcurrentEvals: 3 });
    const [brokerFirst, machineFirst, other] = [runIdOf(await start(handler)), runIdOf(await start(handler)), runIdOf(await start(handler))];
    expect(counter(db)).toBe(3);

    // The runner's result arrives twice, then the state machine ends the same run.
    await result(brokerFirst);
    expect(await result(brokerFirst)).toMatchObject({ status: 200, body: { run: { status: "FAILED" } } });
    await expect(stateMachineWrite(db, "EndRun", brokerFirst)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(counter(db)).toBe(2);

    // The state machine ends the run, then a late result changes nothing.
    await stateMachineWrite(db, "EndRun", machineFirst);
    expect(db.get(`SWEBENCH_RUN#${machineFirst}`, "META")).toMatchObject({ status: "CANCELLED" });
    expect(db.get("SWEBENCH#SLOT", `RUN#${machineFirst}`)).toBeUndefined();
    await expect(stateMachineWrite(db, "EndRun", machineFirst)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(await result(machineFirst)).toMatchObject({ status: 200, body: { run: { status: "CANCELLED" } } });
    expect(counter(db)).toBe(1);
    expect(db.get("SWEBENCH#SLOT", `RUN#${other}`)).toBeDefined();
  });

  it("ends a run started under the one-run lock without taking a slot it never held (migration)", async () => {
    const { handler, db, result } = await brokerWithResult({ maxConcurrentEvals: 2 });
    // Two runs from before the deploy: their records exist, but no slot item, and the counter does not count them.
    const [reported, ended] = [runIdOf(await start(handler)), runIdOf(await start(handler, {}, otherThread))];
    for (const runId of [reported, ended]) db.delete("SWEBENCH#SLOT", `RUN#${runId}`);
    db.set({ pk: "SWEBENCH#ACTIVE", sk: "LOCK", entityType: "SWEBENCH_ACTIVE", runId: reported, threadSubject: thread });
    db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 1 });
    const running = runIdOf(await start(handler, {}, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000003`));
    expect(counter(db)).toBe(2);

    expect(await result(reported)).toMatchObject({ status: 200, body: { run: { status: "FAILED" } } });
    expect(counter(db)).toBe(2);
    expect(db.get("SWEBENCH#ACTIVE", "LOCK")).toBeUndefined();

    // The state machine's release is refused for want of a slot, and its fallback ends the run only.
    await expect(stateMachineWrite(db, "EndRun", ended)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await stateMachineWrite(db, "EndRunWithoutSlot", ended);
    expect(db.get(`SWEBENCH_RUN#${ended}`, "META")).toMatchObject({ status: "CANCELLED" });
    await expect(stateMachineWrite(db, "EndRunWithoutSlot", ended)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(counter(db)).toBe(2);
    expect(db.get("SWEBENCH#SLOT", `RUN#${running}`)).toBeDefined();
  });

  it("stops every active run in the thread, and only that thread's (FR-009)", async () => {
    const { handler, db } = await brokerWithResult({ maxConcurrentEvals: 3 });
    const [one, two, elsewhere] = [runIdOf(await start(handler)), runIdOf(await start(handler)), runIdOf(await start(handler, {}, otherThread))];
    const stopped = await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: slackThread, userId: member });
    expect(JSON.parse(stopped.body)).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    for (const runId of [one, two]) expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED", cancelRequestedBy: { teamId: SLACK_TEAM, userId: member } });
    expect(db.get(`SWEBENCH_RUN#${elsewhere}`, "META")).toMatchObject({ status: "STARTING" });
    // Stopping asks for cancellation; the slots stay held until the state machine ends the runs.
    expect(counter(db)).toBe(3);
  });

  /** A run from before the deploy, holding the one-run lock rather than a slot. */
  function underTheLock(db: { delete: (pk: string, sk: string) => void; set: (item: Record<string, unknown>) => void; get: (pk: string, sk: string) => Record<string, unknown> | undefined }, runId: string, threadSubject: string) {
    db.delete("SWEBENCH#SLOT", `RUN#${runId}`);
    db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: (counter(db) as number) - 1 });
    db.set({ pk: "SWEBENCH#ACTIVE", sk: "LOCK", entityType: "SWEBENCH_ACTIVE", runId, threadSubject });
  }
  const stopThread = async (handler: (event: unknown) => Promise<{ body: string }>, threadValue = slackThread) =>
    JSON.parse((await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: threadValue, userId: member })).body) as Record<string, unknown>;

  it("retires the one-run lock with its run, at either release site, so a later stop in the thread stops nothing", async () => {
    const { handler, db, result } = await brokerWithResult();
    const reported = runIdOf(await start(handler));
    underTheLock(db, reported, thread);
    await result(reported);
    expect(db.get("SWEBENCH#ACTIVE", "LOCK")).toBeUndefined();
    expect(await stopThread(handler)).toMatchObject({ outcome: "NOTHING_RUNNING" });

    const ended = runIdOf(await start(handler));
    underTheLock(db, ended, thread);
    await expect(stateMachineWrite(db, "EndRun", ended)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await stateMachineWrite(db, "EndRunWithoutSlot", ended);
    expect(db.get("SWEBENCH#ACTIVE", "LOCK")).toBeUndefined();
    expect(await stopThread(handler)).toMatchObject({ outcome: "NOTHING_RUNNING" });
    expect(counter(db)).toBe(0);
  });

  it("ignores a one-run lock left by a run that is no longer active", async () => {
    const { handler, db, result } = await brokerWithResult();
    const runId = runIdOf(await start(handler));
    await result(runId);
    db.set({ pk: "SWEBENCH#ACTIVE", sk: "LOCK", entityType: "SWEBENCH_ACTIVE", runId, threadSubject: thread });
    expect(await stopThread(handler)).toMatchObject({ outcome: "NOTHING_RUNNING" });
    expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "FAILED" });
  });

  it("cancels the thread's runs before the batch hook, survives a failing hook, and cancels a run the batch started meanwhile", async () => {
    const { handler, db } = await brokerWithResult();
    const first = runIdOf(await start(handler));
    let toppedUp: string | undefined;
    const stopBatchForThread = vi.fn(async () => {
      expect(db.get(`SWEBENCH_RUN#${first}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED" });
      // A top-up that took a slot between the stop's read and the hook.
      toppedUp = runIdOf(await start(handler));
      return undefined;
    });
    const dependencies: SwebenchDependencies = {
      documentClient: db as never, s3: { send: vi.fn() } as never, tableName: "state", artifactBucketName: "artifacts", callbackSigningKey: "c".repeat(64),
      deployment: async () => deployment, startExecution: vi.fn(), stopBatchForThread,
    };
    const requester = { teamId: SLACK_TEAM, userId: member };
    expect(await stopSwebenchRun(dependencies, slackThread, requester)).toBe(first);
    expect(db.get(`SWEBENCH_RUN#${toppedUp!}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED" });

    const second = runIdOf(await start(handler, {}, otherThread));
    stopBatchForThread.mockRejectedValueOnce(new Error("batch record unreadable"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const otherSlackThread = { ...slackThread, threadTs: "1695500000.000002" };
    expect(await stopSwebenchRun(dependencies, otherSlackThread, requester)).toBe(second);
    expect(db.get(`SWEBENCH_RUN#${second}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("swebench.stop_batch_failed"));
    log.mockRestore();
  });

  it("gives up a release after three refused attempts while the run holds its slot, leaving the run active", async () => {
    const { handler, db, result } = await brokerWithResult();
    const runId = runIdOf(await start(handler));
    // Drift: the counter says no slot is held, so its decrement is refused on every attempt.
    db.set({ pk: "SWEBENCH#SLOTS", sk: "COUNTER", count: 0 });
    const before = db.commandNames().filter((name) => name === "TransactWriteCommand").length;
    // Spec 052 Ruling 3: a retryable 503, since the runner drops a result on any other 4xx but 429.
    expect(await result(runId)).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    expect(db.commandNames().filter((name) => name === "TransactWriteCommand").length - before).toBe(3);
    expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "STARTING" });
    expect(db.get("SWEBENCH#SLOT", `RUN#${runId}`)).toBeDefined();
  });

  it("says the limit is reached, without a count, when it cannot say how many runs hold slots", async () => {
    const { handler, db } = await brokerWithResult({ maxConcurrentEvals: 2 });
    const requestId = randomUUID();
    // A slot item with no run record: the start is refused though the counter is below the limit.
    db.set({ pk: "SWEBENCH#SLOT", sk: `RUN#${requestId}`, runId: requestId, threadSubject: thread });
    expect((await start(handler, { requestId })).body).toMatchObject({ outcome: "REFUSED", reason: "RUN_ACTIVE", message: "The eval run limit is reached; try again shortly." });
  });

  it("asks the batch hook to stop the thread's batch, and still stops a run started under the one-run lock", async () => {
    const { handler, db } = await brokerWithResult();
    const runId = runIdOf(await start(handler));
    db.delete("SWEBENCH#SLOT", `RUN#${runId}`);
    db.set({ pk: "SWEBENCH#ACTIVE", sk: "LOCK", entityType: "SWEBENCH_ACTIVE", runId, threadSubject: thread });
    const stopBatchForThread = vi.fn(async () => undefined);
    const dependencies: SwebenchDependencies = {
      documentClient: db as never, s3: { send: vi.fn() } as never, tableName: "state", artifactBucketName: "artifacts", callbackSigningKey: "c".repeat(64),
      deployment: async () => deployment, startExecution: vi.fn(), stopBatchForThread,
    };
    const requester = { teamId: SLACK_TEAM, userId: member };
    expect(await stopSwebenchRun(dependencies, slackThread, requester)).toBe(runId);
    expect(stopBatchForThread).toHaveBeenCalledWith(slackThread, requester);
    expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ status: "CANCEL_REQUESTED" });
    // A thread with nothing running stops nothing, unless the hook stopped its batch.
    const otherSlackThread = { ...slackThread, threadTs: "1695500000.000002" };
    expect(await stopSwebenchRun(dependencies, otherSlackThread, requester)).toBeUndefined();
    const batchId = randomUUID();
    stopBatchForThread.mockResolvedValueOnce(batchId as never);
    expect(await stopSwebenchRun(dependencies, otherSlackThread, requester)).toBe(batchId);
  });
});

describe("eval batches on the broker's run path (spec 052)", () => {
  it("records a batch run's result from the runner's callback and starts the batch's next run", async () => {
    // Two slots: one for the batch, one kept for single runs (Ruling 30).
    const broker = await evalBroker({ maxConcurrentEvals: 2, models: {
      default: { provider: "amazon-bedrock", modelId: "us.vendor.batch-v1" },
      approved: [{ provider: "amazon-bedrock", modelId: "us.vendor.batch-v1" }],
    } });
    await enable(broker.handler);
    const dependencies = withEvalBatches({
      documentClient: broker.db as never, s3: broker.brokerInput.s3 as never, tableName: "state", artifactBucketName: "artifacts", callbackSigningKey: "c".repeat(64),
      deployment: async () => ({ ...deployment, settings: { ...deployment.settings, maxConcurrentEvals: 2 } }), startExecution: broker.startExecution,
      estimateRunCostUsd: () => 2,
    });
    const model = { provider: "amazon-bedrock", modelId: "us.vendor.batch-v1" };
    const batch = await createBatch(dependencies, {
      thread: slackThread, requester: { teamId: SLACK_TEAM, userId: member }, projectName: "payments", projectModel: async () => model,
    }, { benchmark: "verified", tasks: ["django__django-11099", "django__django-11100"], models: [{ ...model, thinkingLevel: "low" }], costCapUsd: 100 });
    await topUpBatches(dependencies);
    const first = evalBatchRunId(batch.batchId, 0, 1);
    expect(broker.startExecution).toHaveBeenCalledTimes(1);
    const capability = broker.launches.get(`evals/${first}/launch.json`)!.run.capability;
    const answered = await call(broker.handler, {
      method: "POST", path: `/v1/internal/evals/${first}/result`, headers: { "x-agentx-callback-capability": capability },
      body: { outcome: "FAILED", error: "the SWE-bench harness wrote no report (exit 1): boom" },
    });
    expect(answered).toMatchObject({ status: 200, body: { run: { status: "FAILED", batchId: batch.batchId } } });
    expect((await getBatch(dependencies, batch.batchId))!.queue.map((entry) => entry.state)).toEqual(["FAILED", "RUNNING"]);
    expect(broker.startExecution).toHaveBeenCalledTimes(2);
    // The thread's stop command stops the batch through the broker's hook.
    const stopped = await broker.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: slackThread, userId: member });
    expect(JSON.parse(stopped.body)).toMatchObject({ outcome: "CANCEL_REQUESTED", targetOperationId: evalBatchRunId(batch.batchId, 1, 1) });
    expect(await getBatch(dependencies, batch.batchId)).toMatchObject({ status: "STOPPING" });
  });
});

describe("reading the eval settings from SSM (spec 043 FR-016)", () => {
  const prefix = "/agentx/production/";
  const values = (entries: Record<string, string>) => async () => new Map(Object.entries(entries).map(([key, value]) => [`${prefix}${key}`, value]));
  const complete = {
    "eval/settings": JSON.stringify(deployment.settings),
    "eval/runner-image": runnerImage,
    "eval/runner-features": JSON.stringify({ runnerImage, features: ["model.thinkingLevel"] }),
    "worker-model-provider": "amazon-bedrock",
    "worker-model-id": "us.anthropic.claude-sonnet-deployment",
    "worker-prompt-cache-retention": "long",
    "worker-openrouter-secret-arn": "none",
    "worker-openrouter-providers": "none",
  };

  it("builds the deployment from the eval stack's settings, the runner image and the worker model", async () => {
    await expect(swebenchDeploymentFromParameters(prefix, values(complete))).resolves.toEqual(deployment);
  });

  it("passes the keyed providers' secret references to the runner, and none when a release has not set them", async () => {
    const anthropic = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/production/anthropic-AbCdEf";
    const openai = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/production/openai-AbCdEf";
    const configured = await swebenchDeploymentFromParameters(prefix, values({ ...complete,
      "worker-anthropic-secret-arn": anthropic, "worker-openai-secret-arn": openai }));
    expect(configured?.environment).toEqual({ ...deployment.environment, AGENTX_ANTHROPIC_SECRET_ARN: anthropic, AGENTX_OPENAI_SECRET_ARN: openai });
    const unset = await swebenchDeploymentFromParameters(prefix, values({ ...complete, "worker-anthropic-secret-arn": "none" }));
    expect(unset?.environment).toEqual(deployment.environment);
  });

  it("is not installed until both the settings and a runner image exist", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { "eval/runner-image": _image, ...withoutImage } = complete;
    await expect(swebenchDeploymentFromParameters(prefix, values(withoutImage))).resolves.toBeUndefined();
    await expect(swebenchDeploymentFromParameters(prefix, values({ ...complete, "eval/runner-image": "none" }))).resolves.toBeUndefined();
    await expect(swebenchDeploymentFromParameters(prefix, values({ ...complete, "eval/runner-image": "agentx-worker:latest" }))).rejects.toThrow("pinned by digest");
  });

  it("takes the runner's features only when they were recorded for the current runner image (spec 053)", async () => {
    const features = async (entries: Record<string, string>) => (await swebenchDeploymentFromParameters(prefix, values(entries)))!.runnerFeatures;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { "eval/runner-features": _features, ...withoutFeatures } = complete;
    // A runner image released before spec 053 has no features parameter.
    await expect(features(withoutFeatures)).resolves.toEqual([]);
    // A features value left by an earlier image does not describe this one.
    const otherImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"b".repeat(64)}`;
    await expect(features({ ...complete, "eval/runner-features": JSON.stringify({ runnerImage: otherImage, features: ["model.thinkingLevel"] }) })).resolves.toEqual([]);
    await expect(features({ ...complete, "eval/runner-features": "{not json" })).resolves.toEqual([]);
    await expect(features({ ...complete, "eval/runner-features": JSON.stringify({ runnerImage, features: "model.thinkingLevel" }) })).resolves.toEqual([]);
  });

  it("answers a malformed setting as RUNTIME_UNAVAILABLE naming the parameter, so the broker's catch-all keeps the words (#48 review)", async () => {
    const refusal = (entries: Record<string, string>) => swebenchDeploymentFromParameters(prefix, values(entries)).then(() => undefined, (error: unknown) => error);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { "worker-model-id": _model, ...withoutModel } = complete;
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...complete, "eval/runner-image": "agentx-worker:latest" }, `${prefix}eval/runner-image must be an ECR image pinned by digest`],
      [withoutModel, `${prefix}worker-model-provider and ${prefix}worker-model-id are required for SWE-bench runs`],
      [{ ...complete, "eval/settings": "{not json" }, `${prefix}eval/settings is not valid SWE-bench settings JSON`],
      [{ ...complete, "eval/settings": JSON.stringify({ unexpected: true }) }, `${prefix}eval/settings is not valid SWE-bench settings JSON`],
    ];
    for (const [entries, message] of cases) {
      const error = await refusal(entries);
      expect(error).toBeInstanceOf(AgentXError);
      expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain("not json");
    }
  });
});
