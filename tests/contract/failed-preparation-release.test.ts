// Issue #213, part one: a workspace whose preparation failed stops counting toward the per-person
// and organization workspace limits at once, a new message in its Slack thread starts fresh, and a
// later close never gives the slot back a second time.
import { randomUUID } from "node:crypto";
import { SLACK_FORMAT } from "../../packages/slack-service/src/slack-format.js";
import { beforeAll, describe, expect, it } from "vitest";
import { releaseFailedPreparation } from "../../packages/broker/src/aws/failed-preparation.js";
import { failActiveOperation, failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { sweepStuckCancels } from "../../packages/broker/src/aws/stuck-cancels.js";
import type { DurableOutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { preparationFailedMessage } from "../../packages/slack-service/src/messages.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, finishOperation, lazyEnsureWorkspace, loadSlackBroker, prepareThread, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadOne = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const threadTwo = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const pratik = "U0123456789";
const bob = "U0456789012";

beforeAll(async () => {
  await loadSlackBroker();
});

const member = (db: FakeDynamoDb, userId: string) => db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${userId}`);
const organization = (db: FakeDynamoDb) => db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION");
const threadRecord = (db: FakeDynamoDb, subject: string) => db.find((item) => item.entityType === "SLACK_THREAD" && item.thread === subject)[0];
const outboxOf = (db: FakeDynamoDb, operationId: string) => db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as unknown as DurableOutboxRecord;

/** A thread whose compute preparation was accepted (charged), as the lazy worker asks for it. */
async function preparingThread(db: FakeDynamoDb, handler: Parameters<typeof lazyEnsureWorkspace>[0], subject: string, userId: string) {
  const workspaceId = (await lazyEnsureWorkspace(handler, subject, userId)).body.workspaceId as string;
  const prepared = await prepareThread(handler, subject, userId);
  const operationId = prepared.body.operationId as string;
  expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
  return { workspaceId, operationId };
}

/** As a failed workspace stored before #213 is: still charged to `userId`, its starter still recorded. */
function chargeAsBefore(db: FakeDynamoDb, subject: string, userId: string, organizationCount = 1) {
  Object.assign(member(db, userId)!, { count: 1, threads: [subject] });
  Object.assign(organization(db)!, { count: organizationCount });
  Object.assign(threadRecord(db, subject)!, { starterUserId: userId });
}

/** Runs `competitor` once, just before the next transaction `db` is sent, with the table as it is then. */
function beforeNextTransaction(db: FakeDynamoDb, competitor: () => Promise<unknown>) {
  const original = db.send;
  let armed = true;
  db.send = async (command) => {
    if (armed && command.constructor.name === "TransactWriteCommand") {
      armed = false;
      db.send = original;
      await competitor();
    }
    return original(command);
  };
}

describe("a Slack thread whose workspace failed preparation (#213)", () => {

  it("stops counting when the worker failed to boot and the dispatch failed (the live case)", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);

    await failOutboxOperation(db, "state", outboxOf(db, operationId), "RUNTIME_UNAVAILABLE: workspace compute failed to start: boot failed");

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("stops counting when the reconciler finds the preparing compute lost", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId } = await preparingThread(db, handler, threadOne, pratik);

    await failActiveOperation(db, "state", workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("stops counting when the stuck-cancel sweep ends a cancelled preparation whose compute is gone", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    Object.assign(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!, { status: "CANCEL_REQUESTED", updatedAt: new Date(Date.now() - 40 * 60_000).toISOString() });

    const swept = await sweepStuckCancels({ client: db, tableName: "state" }, [{ workspaceId, compute: "gone" }], new Date());

    expect(swept.ended).toEqual([operationId]);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("refuses an older service's fresh start at the limit, and leaves the failed workspace uncharged", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    await preparingThread(db, handler, threadTwo, pratik);

    const refused = await ensureWorkspace(handler, threadOne, pratik);
    expect(refused.body).toMatchObject({
      outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1,
      starterThreads: [{ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000002" }],
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadTwo] });
    expect(threadRecord(db, threadOne)).not.toHaveProperty("starterUserId");
  });

  it("gives the slot back exactly once when the thread is retried, set up and then closed", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await preparingThread(db, handler, threadTwo, bob);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    const retried = await lazyEnsureWorkspace(handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, retried.body.operationId as string, "SUCCEEDED");
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 2 });

    const started = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    await finishOperation(handler, db, workspaceId, started.body.operationId as string, "SUCCEEDED", { safeToClose: true, repositories: [] });
    const completed = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId: started.body.operationId,
    });
    expect(completed.body).toMatchObject({ outcome: "CLOSED", workspaceId });
    await releaseFailedPreparation(db, "state", workspaceId);

    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(member(db, bob)).toMatchObject({ count: 1, threads: [threadTwo] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("answers a lazy turn at the limit with no compute, instead of refusing it, and refuses only when a tool needs the worker", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    await preparingThread(db, handler, threadTwo, pratik);

    // A connector-only turn in the released thread is answered, as a new thread's would be.
    expect((await lazyEnsureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "UNPREPARED", operationId: null });
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadTwo] });
    // The tool that needs the worker is refused at the limit, and nothing is charged.
    expect((await prepareThread(handler, threadOne, pratik)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadTwo] });
  });

  it("prepares a released workspace through the prepare route, charged afresh, once a slot is free", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");

    const prepared = await prepareThread(handler, threadOne, bob);
    expect(prepared.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING" });
    expect(prepared.body.operationId).not.toBe(operationId);
    expect(member(db, bob)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("releases on a repeated failure result, when the first result's release did not land", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    chargeAsBefore(db, threadOne, pratik);

    await finishOperation(handler, db, workspaceId, operationId, "FAILED");

    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("releases nothing when a retry overtakes the release, so the preparing workspace keeps its charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    chargeAsBefore(db, threadOne, pratik);
    // The release read the workspace as failed; the thread's retry commits before the release's write.
    beforeNextTransaction(db, () => lazyEnsureWorkspace(handler, threadOne, pratik));

    expect(await releaseFailedPreparation(db, "state", workspaceId)).toBe("not_failed");

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("tells a close in a released thread there is no workspace to close, and charges nothing", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    const started = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(started.body).toMatchObject({ outcome: "NOT_FOUND" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

});


describe("the thread's notice for a failed setup (#213)", () => {
  it("says plainly that the workspace was released and that a new message starts fresh", () => {
    expect(preparationFailedMessage("FAILED", undefined, SLACK_FORMAT)).toBe(
      "AgentX could not set up this thread's workspace (FAILED). The workspace was released, so it no longer counts toward the workspace limit. Mention me again in this thread to start fresh.",
    );
    expect(preparationFailedMessage("FAILED", "setup step 1 (npm ci) exited 1", SLACK_FORMAT)).toBe(
      "AgentX could not set up this thread's workspace (FAILED). The workspace was released, so it no longer counts toward the workspace limit. Ask an administrator to fix the project's setup commands, then mention me again in this thread to start fresh.\nReason: setup step 1 (npm ci) exited 1",
    );
  });
});
