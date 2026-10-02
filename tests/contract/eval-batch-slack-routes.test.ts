// Spec 052 Task 6: the Slack service's batch routes. The Slack form starts a batch in its thread
// (FR-002, FR-003); the batch watcher lists the batches it posts for, opens the thread of a batch
// started from the CLI (Ruling 19) and records what it posted (restart idempotence). All behind the
// Slack orchestrator role, never the admin claim.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { slackThreadSubject } from "../../packages/contracts/src/index.js";
import { finalizeBatch, withEvalBatches } from "../../packages/broker/src/aws/eval-batch.js";
import { watchEvalBatchesOnce } from "../../packages/slack-service/src/eval-batch-watcher.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createEvalBatchWatchApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import { swebenchDeploymentForTests } from "../support/eval-batch-admin.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, orchestratorPrincipal, registerSlackProject, serviceCall } from "../support/slack-broker.js";

const administrator = { subject: "admin-subject", admin: true };
const member = "U0123456789";
const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };
const subject = slackThreadSubject(thread);
const runnerImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;
const bedrock = { provider: "amazon-bedrock", modelId: "us.vendor.batch-v1" };
// A model the catalog knows as a reasoning model, approved with no thinking level.
const glm = { provider: "openrouter", modelId: "z-ai/glm-4.6" };
const unknown = { provider: "amazon-bedrock", modelId: "us.vendor.unknown-v1" };
const form = { dataset: "verified", instanceIds: ["django__django-11099", "django__django-11100"], models: [bedrock, glm], selectors: ["Batch", "GLM"], repeats: 1 };
const batches = "/v1/service/evals/batches";

beforeAll(async () => {
  await loadSlackBroker();
});

async function slackBatchBroker(options: { enable?: boolean } = {}) {
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
  const base = swebenchDeploymentForTests(runnerImage);
  const deployment = { ...base, environment: { ...base.environment, AGENTX_OPENROUTER_PROVIDERS: "fireworks,deepinfra" } };
  const startExecution = vi.fn(async (input: { name: string }) => ({ executionArn: `arn:aws:states:us-east-1:111122223333:execution:x:${input.name}` }));
  const broker = createBroker({ s3, extra: { swebench: { deployment: async () => deployment, startExecution, estimateRunCostUsd: () => 2 } } });
  await registerSlackProject(broker.handler, {
    models: {
      default: bedrock,
      approved: [{ ...bedrock, thinkingLevel: "low", label: "Batch" }, { ...glm, label: "GLM" }, { ...unknown, label: "Unknown" }],
    },
  });
  if (options.enable !== false) {
    await call(broker.handler, { method: "PUT", path: `/v1/admin/evals/channels/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: administrator, body: { maxCostUsd: 5 } });
  }
  const dependencies = withEvalBatches({
    documentClient: broker.db as never, s3: s3 as never, tableName: "state", artifactBucketName: "artifacts", callbackSigningKey: "c".repeat(64),
    deployment: async () => deployment, startExecution, estimateRunCostUsd: () => 2,
  });
  return { ...broker, dependencies, objects, deployment };
}

type H = Awaited<ReturnType<typeof slackBatchBroker>>["handler"];
const startForm = (handler: H, body: unknown = form, threadSubject = subject) => serviceCall(handler, threadSubject, member, "POST", batches, body);
const list = (handler: H, principal = orchestratorPrincipal) => call(handler, { method: "GET", path: `${batches}/active`, service: { principal } });
const metaItems = (db: FakeDynamoDb) => db.find((item) => item.entityType === "EVAL_BATCH");

async function cliBatch(handler: H): Promise<{ batchId: string; placeholder: string }> {
  const started = await call(handler, {
    method: "POST", path: "/v1/admin/evals/batches", user: administrator,
    body: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, file: { benchmark: "verified", tasks: ["django__django-11099"], models: [{ ...bedrock, thinkingLevel: "low" }], costCapUsd: 50 } },
  });
  expect(started.status).toBe(200);
  const batchId = (started.body.batch as { batchId: string }).batchId;
  return { batchId, placeholder: (started.body.batch as { thread: { threadTs: string } }).thread.threadTs };
}

describe("the Slack batch form (spec 052 FR-002)", () => {
  it("starts the batch in the thread with the project's thinking levels, the deployment's OpenRouter providers and a default cap", async () => {
    const { handler, db } = await slackBatchBroker();
    const started = await startForm(handler);
    expect(started).toMatchObject({
      status: 200,
      body: {
        outcome: "STARTED",
        created: true,
        batch: {
          thread, status: "RUNNING", benchmark: "verified", tasks: 2, repeats: 1, runs: 4, finished: 0, resolved: 0, spentUsd: 0,
          // Four runs at a $5 ceiling, each reserving $5.50.
          costCapUsd: 22,
          perRunCeilingUsd: 5,
          watch: { revision: 0 },
          resultsWritten: false,
        },
      },
    });
    const view = started.body.batch as { models: Array<{ model: unknown }> };
    expect(view.models.map((entry) => entry.model)).toEqual([
      { ...bedrock, thinkingLevel: "low" },
      // No level in the project: the runtime's own default for a reasoning model.
      { ...glm, thinkingLevel: "medium", routing: { only: ["fireworks", "deepinfra"] } },
    ]);
    expect(metaItems(db)).toHaveLength(1);
    expect(metaItems(db)[0]).toMatchObject({ thread, projectName: "payments", file: { order: "cheapest-first" } });
    expect(metaItems(db)[0]!.file).not.toHaveProperty("concurrency");
  });

  it("answers a redelivered event with the same batch, creating no second one; another thread gets its own", async () => {
    const { handler, db } = await slackBatchBroker();
    const first = await startForm(handler);
    const again = await startForm(handler);
    expect(again).toMatchObject({ status: 200, body: { outcome: "STARTED", created: false } });
    expect((again.body.batch as { batchId: string }).batchId).toBe((first.body.batch as { batchId: string }).batchId);
    expect(metaItems(db)).toHaveLength(1);
    const elsewhere = await startForm(handler, form, slackThreadSubject({ ...thread, threadTs: "1695500000.000002" }));
    expect(elsewhere).toMatchObject({ body: { outcome: "STARTED", created: true } });
    expect(metaItems(db)).toHaveLength(2);
  });

  it("keeps an explicit cap and refuses, with the reason, what FR-003 refuses", async () => {
    const { handler } = await slackBatchBroker();
    expect(await startForm(handler, { ...form, costCapUsd: 30 })).toMatchObject({ body: { outcome: "STARTED", batch: { costCapUsd: 30 } } });
    const refused = async (body: unknown, reason: string) => {
      const answer = await startForm(handler, body, slackThreadSubject({ ...thread, threadTs: "1695500000.000009" }));
      expect(answer).toMatchObject({ status: 200, body: { outcome: "REFUSED", message: expect.stringContaining(reason) as unknown } });
    };
    await refused({ ...form, models: [{ provider: "amazon-bedrock", modelId: "us.vendor.other" }] }, "not approved");
    await refused({ ...form, models: [unknown] }, "thinking level");
    await refused({ ...form, costCapUsd: 2 }, "cost cap");
    await refused({ ...form, costCapUsd: 1_001 }, "1000");
    await refused({ ...form, instanceIds: ["njs.cve-2022-32414"] }, "does not fit");
    await refused({ ...form, instanceIds: Array.from({ length: 11 }, (_, index) => `django__django-${11_000 + index}`) }, "more than the 20");
  });

  it("refuses a batch in a channel where eval runs are not enabled", async () => {
    const { handler } = await slackBatchBroker({ enable: false });
    expect(await startForm(handler)).toMatchObject({ status: 200, body: { outcome: "REFUSED", message: expect.stringContaining("not enabled") as unknown } });
  });
});

describe("the batch watcher's list (spec 052 Task 6, Ruling 11)", () => {
  it("lists the batches to post for, to the Slack orchestrator role only, until the summary is posted", async () => {
    const { handler, dependencies, db } = await slackBatchBroker();
    const started = await startForm(handler);
    const batchId = (started.body.batch as { batchId: string }).batchId;
    expect((await list(handler, "arn:aws:sts::111122223333:assumed-role/Other/x")).status).toBe(403);
    expect(await list(handler)).toMatchObject({ status: 200, body: { batches: [{ batchId, status: "RUNNING", resultsWritten: false, watch: { revision: 0 } }] } });
    // Ended by its status, but the results are not written: not ready for its summary.
    await handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: member });
    expect(await list(handler)).toMatchObject({ body: { batches: [{ batchId, status: "STOPPED", resultsWritten: false }] } });
    expect(((await list(handler)).body.batches as Array<Record<string, unknown>>)[0]).not.toHaveProperty("summary");
    await finalizeBatch(dependencies, batchId);
    expect(await list(handler)).toMatchObject({ body: { batches: [{ batchId, status: "STOPPED", resultsWritten: true, summary: { batchId, models: expect.any(Array) as unknown } }] } });
    const posted = await serviceCall(handler, subject, member, "POST", `${batches}/${batchId}/watch`, { revision: 0, change: { summaryPostedAt: "2026-10-02T12:00:00.000Z" } });
    expect(posted).toMatchObject({ status: 200, body: { updated: true, watch: { revision: 1, summaryPostedAt: "2026-10-02T12:00:00.000Z" } } });
    expect(await list(handler)).toMatchObject({ body: { batches: [] } });
    expect(db.find((item) => item.entityType === "EVAL_BATCH_WATCH")).toHaveLength(0);
  });

  it("leaves out a batch whose channel now serves another project", async () => {
    const { handler, db } = await slackBatchBroker();
    await startForm(handler);
    db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)!.projectName = "elsewhere";
    expect(await list(handler)).toMatchObject({ status: 200, body: { batches: [] } });
  });
});

describe("the thread of a batch started from the CLI (spec 052 Ruling 19)", () => {
  it("records the watcher's thread once, for the batch's own placeholder, and a stop in that thread then stops the batch", async () => {
    const { handler, db } = await slackBatchBroker();
    const { batchId, placeholder } = await cliBatch(handler);
    expect(placeholder.startsWith("00")).toBe(true);
    const placeholderSubject = slackThreadSubject({ ...thread, threadTs: placeholder });
    const listed = (await list(handler)).body.batches as Array<{ thread: { threadTs: string }; createdBy: { userId: string } }>;
    expect(listed[0]!.thread.threadTs).toBe(placeholder);
    const opened = { ...thread, threadTs: "1695600000.000100" };
    const recorded = await serviceCall(handler, placeholderSubject, listed[0]!.createdBy.userId, "POST", `${batches}/${batchId}/thread`, { threadTs: opened.threadTs });
    expect(recorded).toMatchObject({ status: 200, body: { recorded: true, thread: opened } });
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ thread: opened, version: 1 });
    expect(db.get("EVAL_BATCHES#ACTIVE", `BATCH#${batchId}`)).toMatchObject({ threadSubject: slackThreadSubject(opened) });
    // A second watcher that raced the first loses: the first thread stays.
    const late = await serviceCall(handler, placeholderSubject, listed[0]!.createdBy.userId, "POST", `${batches}/${batchId}/thread`, { threadTs: "1695600000.000200" });
    expect(late).toMatchObject({ status: 200, body: { recorded: false, thread: opened } });
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ thread: opened });
    // A stop posted in the opened thread reaches the batch.
    const stopped = JSON.parse((await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: opened, userId: member })).body) as Record<string, unknown>;
    expect(stopped).toMatchObject({ outcome: "CANCEL_REQUESTED", workspaceId: batchId });
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ status: "STOPPED" });
  });

  it("refuses a placeholder as the thread, and a caller outside the batch's channel", async () => {
    const { handler } = await slackBatchBroker();
    const { batchId, placeholder } = await cliBatch(handler);
    const placeholderSubject = slackThreadSubject({ ...thread, threadTs: placeholder });
    expect((await serviceCall(handler, placeholderSubject, member, "POST", `${batches}/${batchId}/thread`, { threadTs: placeholder })).status).toBe(400);
    expect((await serviceCall(handler, subject, member, "POST", `${batches}/${batchId}/thread`, { threadTs: "1695600000.000100" })).status).toBe(404);
  });
});

describe("what the watcher posted (spec 052 Task 6, restart idempotence)", () => {
  it("records a change only against the revision it read, from the batch's own thread", async () => {
    const { handler, db } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    const watch = (body: unknown, threadSubject = subject) => serviceCall(handler, threadSubject, member, "POST", `${batches}/${batchId}/watch`, body);
    const change = { progressPostedAt: "2026-10-02T12:00:00.000Z", progressFinished: 1, progressResolved: 1 };
    expect(await watch({ revision: 0, change })).toMatchObject({ status: 200, body: { updated: true, watch: { revision: 1, ...change } } });
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ watch: { revision: 1, ...change }, version: 1 });
    // A second watcher that read revision 0 claims nothing.
    expect(await watch({ revision: 0, change: { progressFinished: 2 } })).toMatchObject({ status: 200, body: { updated: false, watch: { revision: 1, progressFinished: 1 } } });
    expect(await list(handler)).toMatchObject({ body: { batches: [{ batchId, watch: { revision: 1, progressFinished: 1 } }] } });
    expect((await watch({ revision: 1, change }, slackThreadSubject({ ...thread, threadTs: "1695500000.000002" }))).status).toBe(404);
  });

  it("refuses a batch whose project is not the channel's", async () => {
    const { handler, db } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)!.projectName = "elsewhere";
    expect((await serviceCall(handler, subject, member, "POST", `${batches}/${batchId}/watch`, { revision: 0, change: { progressFinished: 1 } })).status).toBe(404);
  });
});

/** The real watcher client, signing fetch and broker, posting to a Slack stub that records the in-thread texts. */
function watcherFor(handler: H, posts: string[]) {
  const toBroker = brokerFetch(handler);
  const api = createEvalBatchWatchApi({
    controlPlaneUrl: "https://agentx.example.test",
    signedFetchFor: (scope) => createSignedServiceFetch({
      region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" }, baseFetch: toBroker,
      ...(scope === undefined ? {} : { thread: scope.thread, userId: scope.userId }),
    }),
  });
  const slack = {
    post: vi.fn(async (_channel: string, _threadTs: string | undefined, text: string) => { posts.push(text); return "1695800000.000009"; }),
    delete: vi.fn(async () => undefined),
  };
  return { api, slack, logError: vi.fn(), now: () => Date.parse("2026-10-02T12:00:00.000Z") };
}

describe("the batch watcher against the broker (spec 052 Task 6, Ruling 19)", () => {
  it("opens a CLI batch's thread, a stop there stops the batch, and its summary is posted there once", async () => {
    const { handler, dependencies, db } = await slackBatchBroker();
    const { batchId } = await cliBatch(handler);
    const sent: Array<{ thread?: string | null; path: string }> = [];
    const toBroker = brokerFetch(handler);
    const baseFetch: typeof fetch = async (input, init) => {
      sent.push({ thread: new Headers(init?.headers).get("x-agentx-slack-thread"), path: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname });
      return toBroker(input, init);
    };
    const api = createEvalBatchWatchApi({
      controlPlaneUrl: "https://agentx.example.test",
      signedFetchFor: (scope) => createSignedServiceFetch({
        region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" }, baseFetch,
        ...(scope === undefined ? {} : { thread: scope.thread, userId: scope.userId }),
      }),
    });
    const posts: Array<{ threadTs: string | undefined; text: string }> = [];
    const slack = {
      post: vi.fn(async (_channel: string, threadTs: string | undefined, text: string) => {
        posts.push({ threadTs, text });
        return "1695800000.000001";
      }),
      delete: vi.fn(async () => undefined),
    };
    const logError = vi.fn();
    const watcher = { api, slack, logError, now: () => Date.parse("2026-10-02T12:00:00.000Z") };
    await watchEvalBatchesOnce(watcher);
    expect(logError).not.toHaveBeenCalled();
    expect(posts).toEqual([{ threadTs: undefined, text: expect.stringContaining(`Eval batch \`${batchId}\` started from the CLI: 1 run of SWE-bench Verified: 1 task × 1 model × 1 repeat, with a cost cap of $50.00`) as unknown }]);
    // The list carries no thread; the record acts for the batch's placeholder thread.
    expect(sent[0]).toEqual({ thread: null, path: "/v1/service/evals/batches/active" });
    // The opener is claimed, posted, its timestamp stored, and then its thread recorded (Ruling 24).
    expect(sent.slice(1).map((request) => request.path)).toEqual([
      `/v1/service/evals/batches/${batchId}/watch`,
      `/v1/service/evals/batches/${batchId}/watch`,
      `/v1/service/evals/batches/${batchId}/thread`,
    ]);
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ watch: { openerTs: "1695800000.000001" } });
    const opened = { ...thread, threadTs: "1695800000.000001" };
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ thread: opened });
    await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: opened, userId: member });
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ status: "STOPPED" });
    await finalizeBatch(dependencies, batchId);
    await watchEvalBatchesOnce(watcher);
    await watchEvalBatchesOnce(watcher);
    expect(logError).not.toHaveBeenCalled();
    expect(posts).toHaveLength(2);
    // Its one run was cancelled before it started, so it has no result row.
    expect(posts[1]!.threadTs).toBe(opened.threadTs);
    expect(posts[1]!.text.split("\n").slice(0, 2)).toEqual([
      `Eval batch \`${batchId}\` was stopped: 0/1 runs finished, 0 resolved, $0.00 spent of the $50.00 cap.`,
      "No run has a result row, so there is no table.",
    ]);
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ watch: { summaryPostedAt: "2026-10-02T12:00:00.000Z" } });
  });
});

describe("the Slack form's batch ID (spec 052 Ruling 23)", () => {
  it("is the form as received: a redelivery after the project's thinking level, the providers and the channel ceiling changed reaches the same batch", async () => {
    const { handler, db, deployment } = await slackBatchBroker();
    const first = await startForm(handler);
    expect(first.body).toMatchObject({ outcome: "STARTED", created: true });
    await registerSlackProject(handler, {
      revision: 2,
      bind: false,
      models: { default: bedrock, approved: [{ ...bedrock, thinkingLevel: "high", label: "Batch" }, { ...glm, thinkingLevel: "low", label: "GLM" }] },
    });
    deployment.environment.AGENTX_OPENROUTER_PROVIDERS = "together";
    await call(handler, { method: "PUT", path: `/v1/admin/evals/channels/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: administrator, body: { maxCostUsd: 7 } });
    const redelivered = await startForm(handler);
    expect(redelivered).toMatchObject({ status: 200, body: { outcome: "STARTED", created: false, batch: { costCapUsd: 22 } } });
    expect((redelivered.body.batch as { batchId: string }).batchId).toBe((first.body.batch as { batchId: string }).batchId);
    expect(metaItems(db)).toHaveLength(1);
  });

  it("names the form's model names as typed, ignoring case and spacing, so a resolved identifier does not change it", async () => {
    const { handler, db } = await slackBatchBroker();
    const first = await startForm(handler);
    const respaced = await startForm(handler, { ...form, selectors: [" batch ", "glm"] });
    expect((respaced.body.batch as { batchId: string }).batchId).toBe((first.body.batch as { batchId: string }).batchId);
    expect(metaItems(db)).toHaveLength(1);
  });
});

describe("the Slack form's default cap (spec 052 Ruling 22)", () => {
  it("rounds every run's reservation up to cents and is at most $1,000", async () => {
    const { handler } = await slackBatchBroker();
    const channel = `/v1/admin/evals/channels/${SLACK_TEAM}/${SLACK_CHANNEL}`;
    await call(handler, { method: "PUT", path: channel, user: administrator, body: { maxCostUsd: 4.33 } });
    const three = { ...form, instanceIds: ["django__django-11099", "django__django-11100", "django__django-11101"], models: [bedrock], selectors: ["Batch"] };
    // 3 × $4.33 × 1.1 = $14.289.
    expect(await startForm(handler, three)).toMatchObject({ body: { outcome: "STARTED", batch: { costCapUsd: 14.29 } } });
    await call(handler, { method: "PUT", path: channel, user: administrator, body: { maxCostUsd: 100 } });
    const twenty = { ...form, instanceIds: Array.from({ length: 10 }, (_, index) => `django__django-${11_200 + index}`) };
    // 20 × $110 is $2,200.
    expect(await startForm(handler, twenty)).toMatchObject({ body: { outcome: "STARTED", batch: { costCapUsd: 1_000, runs: 20 } } });
  });
});

describe("dropping a watch entry (spec 052 Ruling 24)", () => {
  // Changed by Ruling 26: a running batch whose channel moved is left out and logged, never dropped.
  it("leaves out a running batch whose channel was unbound, logs it once as an error, and watches it again once rebound", async () => {
    const { handler, db, dependencies } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    const binding = structuredClone(db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)!);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      db.delete(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`);
      expect(await list(handler)).toMatchObject({ status: 200, body: { batches: [], dropped: [] } });
      expect(await list(handler)).toMatchObject({ body: { batches: [], dropped: [] } });
      const unavailable = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("eval_batch_watch.channel_unavailable"));
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]).toContain(batchId);
      expect(db.find((item) => item.entityType === "EVAL_BATCH_WATCH")).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
    db.set({ ...binding });
    expect(await list(handler)).toMatchObject({ body: { batches: [{ batchId, status: "RUNNING" }] } });
    // Rebound, the batch's summary still posts once it ends.
    const posts: string[] = [];
    const watcher = watcherFor(handler, posts);
    await handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: member });
    await finalizeBatch(dependencies, batchId);
    await watchEvalBatchesOnce(watcher);
    expect(posts).toEqual([expect.stringMatching(new RegExp(`^Eval batch \`${batchId}\` was stopped`)) as unknown]);
  });

  // Changed by Ruling 26: a rebound channel's running batch is left out, not dropped.
  it("leaves out a running batch whose channel serves another project, and drops it only once it has ended", async () => {
    const { handler, db } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)!.projectName = "elsewhere";
    expect(await list(handler)).toMatchObject({ body: { batches: [], dropped: [] } });
    db.get(`EVAL_BATCH#${batchId}`, "META")!.status = "STOPPED";
    expect(await list(handler)).toMatchObject({ body: { batches: [], dropped: [{ batchId, reason: "channel_moved" }] } });
    expect(db.find((item) => item.entityType === "EVAL_BATCH_WATCH")).toHaveLength(0);
  });

  it("drops an ended batch whose channel was unbound", async () => {
    const { handler, db } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    await handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: member });
    db.delete(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`);
    expect(await list(handler)).toMatchObject({ body: { batches: [], dropped: [{ batchId, reason: "channel_unbound" }] } });
    expect(db.find((item) => item.entityType === "EVAL_BATCH_WATCH")).toHaveLength(0);
  });

  it("drops a batch that ended more than 7 days ago without its summary posted", async () => {
    const { handler, db, dependencies } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    await handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: member });
    await finalizeBatch(dependencies, batchId);
    const item = db.get(`EVAL_BATCH#${batchId}`, "META")!;
    item.finishedAt = new Date(Date.now() - 6 * 86_400_000).toISOString();
    expect(await list(handler)).toMatchObject({ body: { batches: [{ batchId }], dropped: [] } });
    item.finishedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    expect(await list(handler)).toMatchObject({ body: { batches: [], dropped: [{ batchId, reason: "ended_over_7_days" }] } });
  });

  it("drops a batch the watcher gave up on, from the batch's own thread", async () => {
    const { handler, db } = await slackBatchBroker();
    const batchId = ((await startForm(handler)).body.batch as { batchId: string }).batchId;
    const drop = (threadSubject: string) => serviceCall(handler, threadSubject, member, "POST", `${batches}/${batchId}/drop`, { reason: "slack:channel_not_found" });
    expect((await drop(slackThreadSubject({ ...thread, threadTs: "1695500000.000002" }))).status).toBe(404);
    expect(await drop(subject)).toMatchObject({ status: 200, body: { dropped: true } });
    expect(db.get(`EVAL_BATCH#${batchId}`, "META")).toMatchObject({ watch: { dropReason: "slack:channel_not_found", droppedAt: expect.any(String) as unknown } });
    expect(await list(handler)).toMatchObject({ body: { batches: [] } });
  });
});

describe("a stopped batch's counts (spec 052 Task 6 M-6)", () => {
  it("does not count a run cancelled before it started as finished", async () => {
    const { handler } = await slackBatchBroker();
    await startForm(handler);
    await handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: member });
    expect(await list(handler)).toMatchObject({ body: { batches: [{ status: "STOPPED", finished: 0, models: [{ finished: 0, ended: true }, { finished: 0, ended: true }] }] } });
  });
});
