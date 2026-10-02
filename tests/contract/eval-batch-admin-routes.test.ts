// Spec 052 Task 5: the admin routes of eval batches (FR-001, FR-003, FR-009, FR-010). Each is behind
// the administrator claim and the administrator membership of the channel's project.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { swebenchDeploymentForTests } from "../support/eval-batch-admin.js";
import { finalizeBatch, withEvalBatches } from "../../packages/broker/src/aws/eval-batch.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const administrator = { subject: "admin-subject", admin: true };
const outsider = { subject: "someone", admin: false };
const model = { provider: "amazon-bedrock", modelId: "us.vendor.batch-v1", thinkingLevel: "low" };
const batchFile = { benchmark: "verified", tasks: ["django__django-11099", "django__django-11100"], models: [model], costCapUsd: 100 };
const base = "/v1/admin/evals/batches";
const runnerImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;

beforeAll(async () => {
  await loadSlackBroker();
});

async function batchBroker(options: { installed?: boolean } = {}) {
  const objects = new Map<string, string>();
  const s3 = {
    send: vi.fn(async (command: { constructor: { name: string }; input: { Key?: string; Body?: string } }) => {
      if (command.constructor.name === "PutObjectCommand") {
        objects.set(command.input.Key!, String(command.input.Body));
        return {};
      }
      const body = objects.get(command.input.Key!);
      if (body === undefined) throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => body } };
    }),
  };
  const deployment = swebenchDeploymentForTests(runnerImage);
  const startExecution = vi.fn(async (input: { name: string }) => ({ executionArn: `arn:aws:states:us-east-1:111122223333:execution:x:${input.name}` }));
  const broker = createBroker({
    s3,
    extra: {
      swebench: { deployment: async () => (options.installed === false ? undefined : deployment), startExecution, estimateRunCostUsd: () => 2 },
    },
  });
  await registerSlackProject(broker.handler, { models: { default: { provider: model.provider, modelId: model.modelId }, approved: [{ provider: model.provider, modelId: model.modelId }] } });
  await call(broker.handler, { method: "PUT", path: `/v1/admin/evals/channels/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: administrator, body: {} });
  const dependencies = withEvalBatches({
    documentClient: broker.db as never, s3: s3 as never, tableName: "state", artifactBucketName: "artifacts", callbackSigningKey: "c".repeat(64),
    deployment: async () => deployment, startExecution, estimateRunCostUsd: () => 2,
  });
  return { ...broker, objects, dependencies, startExecution };
}

const start = (handler: Parameters<typeof call>[0], file: unknown = batchFile, extra: Record<string, unknown> = {}, user = administrator) =>
  call(handler, { method: "POST", path: base, user, body: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, file, ...extra } });

describe("starting a batch from a file (spec 052 FR-001)", () => {
  it("creates the batch and answers the same batch to a repeated request", async () => {
    const { handler } = await batchBroker();
    const first = await start(handler);
    expect(first).toMatchObject({ status: 200, body: { created: true, batch: { status: "RUNNING", counts: { queued: 2 } } } });
    const batchId = (first.body.batch as { batchId: string }).batchId;
    const again = await start(handler);
    expect(again).toMatchObject({ status: 200, body: { created: false, batch: { batchId } } });
    // The same content in another key order is the same batch; another file is another batch.
    const reordered = await start(handler, { costCapUsd: 100, models: [model], tasks: batchFile.tasks, benchmark: "verified" });
    expect((reordered.body.batch as { batchId: string }).batchId).toBe(batchId);
    const other = await start(handler, { ...batchFile, costCapUsd: 101 });
    expect((other.body.batch as { batchId: string }).batchId).not.toBe(batchId);
    // A label starts a deliberate second run of the same file.
    const labelled = await start(handler, batchFile, { label: "second pass" });
    expect((labelled.body.batch as { batchId: string }).batchId).not.toBe(batchId);
  });

  it("refuses an invalid file, an unapproved model, a low cap and an unbound channel with the reason", async () => {
    const { handler } = await batchBroker();
    expect(await start(handler, { ...batchFile, tasks: [] })).toMatchObject({ status: 400 });
    const unapproved = await start(handler, { ...batchFile, models: [{ ...model, modelId: "us.vendor.other" }] });
    expect(unapproved).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("not approved") as unknown } } });
    expect(await start(handler, { ...batchFile, costCapUsd: 1 })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("cost cap") as unknown } } });
    const unbound = await call(handler, { method: "POST", path: base, user: administrator, body: { teamId: SLACK_TEAM, channelId: "C0999999999", file: batchFile } });
    expect(unbound.status).toBe(404);
  });
});

describe("showing and stopping a batch (spec 052 FR-009, Ruling 11)", () => {
  it("shows progress without the queue, stops, and reports an ended batch by its status", async () => {
    const { handler } = await batchBroker();
    const batchId = ((await start(handler)).body.batch as { batchId: string }).batchId;
    const shown = await call(handler, { method: "GET", path: `${base}/${batchId}`, user: administrator });
    expect(shown).toMatchObject({ status: 200, body: { ended: false, batch: { batchId, status: "RUNNING", spentUsd: 0 } } });
    expect(shown.body.batch).not.toHaveProperty("queue");
    const stopped = await call(handler, { method: "POST", path: `${base}/${batchId}/stop`, user: administrator });
    expect(stopped).toMatchObject({ status: 200, body: { alreadyEnded: false, ended: true, batch: { status: "STOPPED", counts: { cancelled: 2 } } } });
    const again = await call(handler, { method: "POST", path: `${base}/${batchId}/stop`, user: administrator });
    expect(again).toMatchObject({ status: 200, body: { alreadyEnded: true, ended: true, batch: { status: "STOPPED" } } });
    expect(await call(handler, { method: "GET", path: `${base}/${batchId}`, user: administrator })).toMatchObject({ body: { ended: true, batch: { status: "STOPPED" } } });
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call(handler, { method: "GET", path: `${base}/${missing}`, user: administrator })).status).toBe(404);
    expect((await call(handler, { method: "POST", path: `${base}/${missing}/stop`, user: administrator })).status).toBe(404);
  });
});

describe("a batch's results (spec 052 FR-010)", () => {
  it("answers not ready until the results are written, then the CSV and the per-model summary", async () => {
    const { handler, dependencies } = await batchBroker();
    const batchId = ((await start(handler)).body.batch as { batchId: string }).batchId;
    const path = `${base}/${batchId}/results`;
    expect(await call(handler, { method: "GET", path, user: administrator })).toMatchObject({ status: 200, body: { ready: false, status: "RUNNING", message: expect.stringContaining("still running") as unknown } });
    await call(handler, { method: "POST", path: `${base}/${batchId}/stop`, user: administrator });
    // Ended by its status, but the tick has not written the files yet.
    expect(await call(handler, { method: "GET", path, user: administrator })).toMatchObject({ body: { ready: false, status: "STOPPED", message: expect.stringContaining("not written yet") as unknown } });
    await finalizeBatch(dependencies, batchId);
    const results = await call(handler, { method: "GET", path, user: administrator });
    expect(results).toMatchObject({ status: 200, body: { ready: true, status: "STOPPED", summary: { batchId, models: expect.any(Array) as unknown } } });
    expect(results.body.csv).toMatch(/^batchId,runId,instanceId/);
  });
});

describe("the administrator claim (spec 052 Task 5)", () => {
  it("refuses a non-administrator on each of the four routes", async () => {
    const { handler } = await batchBroker();
    const batchId = ((await start(handler)).body.batch as { batchId: string }).batchId;
    expect((await start(handler, batchFile, {}, outsider)).status).toBe(403);
    expect((await call(handler, { method: "GET", path: `${base}/${batchId}`, user: outsider })).status).toBe(403);
    expect((await call(handler, { method: "POST", path: `${base}/${batchId}/stop`, user: outsider })).status).toBe(403);
    expect((await call(handler, { method: "GET", path: `${base}/${batchId}/results`, user: outsider })).status).toBe(403);
    // Nothing happened to the batch.
    expect(await call(handler, { method: "GET", path: `${base}/${batchId}`, user: administrator })).toMatchObject({ body: { batch: { status: "RUNNING" } } });
  });
});
