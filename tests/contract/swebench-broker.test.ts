import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SwebenchLaunchSchema, type SwebenchLaunch } from "@agentx/contracts";
import type { SwebenchDeployment } from "../../packages/broker/src/aws/swebench.js";
import { swebenchDeploymentFromParameters } from "../../packages/broker/src/aws/swebench-settings.js";
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
  },
  runnerImage,
  defaultModel: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-deployment" },
  environment: { PI_CACHE_RETENTION: "long" },
};

beforeAll(async () => {
  await loadSlackBroker();
});

/** A broker with SWE-bench runs installed, a bound channel, and the launch files it writes. */
async function evalBroker(options: { installed?: boolean; models?: unknown; startExecution?: () => Promise<void> } = {}) {
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
        deployment: async () => (options.installed === false ? undefined : deployment),
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
  it("records the run, takes the deployment's lock, writes the launch file and starts the state machine", async () => {
    const { handler, db, launches, startExecution } = await evalBroker();
    await enable(handler, { maxCostUsd: 12 });
    const started = await start(handler);
    expect(started).toMatchObject({ status: 200, body: { outcome: "STARTED", run: {
      dataset: "verified", instanceId: "django__django-11099", status: "STARTING", maxCostUsd: 12,
      model: deployment.defaultModel, thread: slackThread, requestedBy: { teamId: SLACK_TEAM, userId: member },
    } } });
    const runId = (started.body.run as { runId: string }).runId;
    expect(db.get(`SWEBENCH_RUN#${runId}`, "META")).toMatchObject({ entityType: "SWEBENCH_RUN", projectName: "payments", status: "STARTING" });
    expect(db.get("SWEBENCH#ACTIVE", "LOCK")).toMatchObject({ runId, threadSubject: thread });
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
    const { handler, startExecution } = await evalBroker();
    await enable(handler);
    const requestId = randomUUID();
    const first = await start(handler, { requestId });
    const again = await start(handler, { requestId });
    expect(again.body.run).toEqual(first.body.run);
    expect(startExecution).toHaveBeenCalledTimes(1);
    expect((await start(handler, {}, otherThread)).body).toMatchObject({ outcome: "REFUSED", reason: "RUN_ACTIVE" });
  });

  it("refuses a run where eval is not installed or the channel is not enabled", async () => {
    const notInstalled = await evalBroker({ installed: false });
    await enable(notInstalled.handler);
    expect((await start(notInstalled.handler)).body).toMatchObject({ outcome: "REFUSED", reason: "NOT_INSTALLED" });
    const notEnabled = await evalBroker();
    expect((await start(notEnabled.handler)).body).toMatchObject({ outcome: "REFUSED", reason: "NOT_ENABLED", message: expect.stringContaining("agentx admin eval enable") as unknown });
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

  it("fails the run and releases the lock when the state machine cannot start", async () => {
    const { handler, db } = await evalBroker({ startExecution: async () => { throw new Error("ExecutionLimitExceeded"); } });
    await enable(handler);
    const requestId = randomUUID();
    expect((await start(handler, { requestId })).status).toBeGreaterThanOrEqual(400);
    expect(db.get(`SWEBENCH_RUN#${requestId}`, "META")).toMatchObject({ status: "FAILED", error: expect.stringContaining("ExecutionLimitExceeded") as unknown });
    expect(db.get("SWEBENCH#ACTIVE", "LOCK")).toBeUndefined();
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

  it("moves the run to RUNNING, then applies the graded result and releases the lock", async () => {
    const { db, runId, callback, handler } = await runningRun();
    expect(await callback("started")).toMatchObject({ status: 200, body: { run: { status: "RUNNING" } } });
    const finished = await callback("result", { ...graded, artifactsPrefix: `evals/${runId}/` });
    expect(finished).toMatchObject({ status: 200, body: { run: { status: "SUCCEEDED", result: { resolved: true, failToPass: { passed: 3, total: 3 } } } } });
    expect(db.get("SWEBENCH#ACTIVE", "LOCK")).toBeUndefined();
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

describe("reading the eval settings from SSM (spec 043 FR-016)", () => {
  const prefix = "/agentx/production/";
  const values = (entries: Record<string, string>) => async () => new Map(Object.entries(entries).map(([key, value]) => [`${prefix}${key}`, value]));
  const complete = {
    "eval/settings": JSON.stringify(deployment.settings),
    "eval/runner-image": runnerImage,
    "worker-model-provider": "amazon-bedrock",
    "worker-model-id": "us.anthropic.claude-sonnet-deployment",
    "worker-prompt-cache-retention": "long",
    "worker-openrouter-secret-arn": "none",
    "worker-openrouter-providers": "none",
  };

  it("builds the deployment from the eval stack's settings, the runner image and the worker model", async () => {
    await expect(swebenchDeploymentFromParameters(prefix, values(complete))).resolves.toEqual(deployment);
  });

  it("is not installed until both the settings and a runner image exist", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { "eval/runner-image": _image, ...withoutImage } = complete;
    await expect(swebenchDeploymentFromParameters(prefix, values(withoutImage))).resolves.toBeUndefined();
    await expect(swebenchDeploymentFromParameters(prefix, values({ ...complete, "eval/runner-image": "none" }))).resolves.toBeUndefined();
    await expect(swebenchDeploymentFromParameters(prefix, values({ ...complete, "eval/runner-image": "agentx-worker:latest" }))).rejects.toThrow("pinned by digest");
  });
});
