import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { SlackThreadPrepareResultSchema, SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, fakeGitHubMcp, finishOperation, lazyEnsureWorkspace,
  account, call, loadSlackBroker, markReady, orchestratorPrincipal, prepareThread, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadOne = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const threadTwo = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const pratik = "U0123456789";
const bob = "U0456789012";
const carol = "U0789012345";

beforeAll(async () => {
  await loadSlackBroker();
});

describe("lazy thread workspace records", () => {
  it("creates a thread record with no compute and no limit charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const created = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(created.status).toBe(200);
    delete created.body.requestId;
    const workspaceId = created.body.workspaceId as string;
    expect(SlackThreadWorkspaceResultSchema.parse(created.body)).toEqual({
      outcome: "WORKSPACE", workspaceId, status: "UNPREPARED", operationId: null, created: true,
      orchestratorInstructions: "Delegate work (revision 1).", connectors: [], repositories: ["demo"],
      recoverableOperations: [], settingsRevision: 1,
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED", fence: 0, projectRevision: 1, activeOperationId: null });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    const threadRecord = db.find((item) => item.entityType === "SLACK_THREAD")[0];
    expect(threadRecord).toMatchObject({ thread: threadOne, workspaceId });
    expect(threadRecord).not.toHaveProperty("starterUserId");

    const followUp = await lazyEnsureWorkspace(handler, threadOne, bob);
    expect(followUp.body).toMatchObject({ workspaceId, status: "UNPREPARED", operationId: null, created: false });
  });

  it("gives a member any number of connector-only threads, past both limits", async () => {
    const { db, handler } = createBroker({ memberLimit: 1, organizationLimit: 2 });
    await registerSlackProject(handler);
    for (const ts of ["000001", "000002", "000003", "000004"]) {
      const created = await lazyEnsureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.${ts}`, pratik);
      expect(created.body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", created: true });
    }
    expect((await lazyEnsureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000005`, carol)).body).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(5);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });

  it("answers connector discovery and calls, and keeps the ledger, for a thread with no compute", async () => {
    const { githubMcp, invoke } = fakeGitHubMcp();
    const { db, handler } = createBroker({ githubMcp });
    await registerSlackProject(handler, { connectors: GITHUB_LIST_ISSUES });
    const created = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(created.body.connectors).toEqual([{ name: "github", type: "github", label: expect.any(String) as string, scopes: ["demo"], connected: true }]);
    const workspaceId = created.body.workspaceId as string;
    expect((await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`)).status).toBe(201);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await serviceCall(handler, threadOne, pratik, "GET", `${path}/tools`)).body.catalog);
    const requestId = randomUUID();
    const called = await serviceCall(handler, threadOne, pratik, "POST", `${path}/call`, {
      requestId, scope: "demo", tool: "list_issues", schemaHash: catalog.tools[0]!.scopes[0]!.schemaHash, arguments: {},
    });
    expect(called.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && String(item.sk).includes(requestId))).toHaveLength(1);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
  });

  it("refuses coding operations on a thread with no compute", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const conversation = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    const task = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "list the files",
    });
    expect(task.status).toBe(409);
    expect(task.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is UNPREPARED" });
    const pullRequest = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, {
      requestId: randomUUID(), repository: "demo", title: "Fix",
    });
    expect(pullRequest.status).toBe(409);
    expect(pullRequest.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is UNPREPARED" });
  });

  it("tells a connector-only thread there is nothing to close, and leaves it usable", async () => {
    const { db, handler, deleteEc2Session } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const close = await serviceCall(handler, threadOne, bob, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.body).toMatchObject({ outcome: "NOT_FOUND" });
    expect(deleteEc2Session).not.toHaveBeenCalled();
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    expect((await lazyEnsureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ workspaceId, status: "UNPREPARED", created: false });
  });

  it("creates one record when two first messages race", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const results = await Promise.all([lazyEnsureWorkspace(handler, threadOne, pratik), lazyEnsureWorkspace(handler, threadOne, bob)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(new Set(results.map((result) => result.body.workspaceId)).size).toBe(1);
    expect(results.map((result) => result.body.created).sort()).toEqual([false, true]);
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });
});

const PRE_LAZY_STATUSES = ["PREPARING", "READY", "PREPARATION_FAILED", "BUSY", "UNHEALTHY", "STOPPED", "RESUMING", "CLOSING", "CLOSED"];

function members(db: ReturnType<typeof createBroker>["db"]) {
  return db.find((item) => item.entityType === "SLACK_LIMIT" && String(item.sk).startsWith("MEMBER#"));
}

describe("preparing a thread's compute on first use", () => {
  it("prepares once, charges the member who asked, and pins the revision the thread started with", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    await registerSlackProject(handler, { revision: 2, bind: false });

    const prepared = await prepareThread(handler, threadOne, bob);
    expect(prepared.status).toBe(200);
    delete prepared.body.requestId;
    const result = SlackThreadPrepareResultSchema.parse(prepared.body);
    expect(result).toEqual({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId: expect.any(String) as string, created: true });
    const operationId = (result as { operationId: string }).operationId;
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", activeOperationId: operationId, fence: 1, projectRevision: 1 });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({
      kind: "prepare", status: "ACCEPTED", fence: 1, requestedBy: { teamId: SLACK_TEAM, userId: bob },
    });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
    expect((outbox?.invocation as { payload: { project: { revision: number } } }).payload.project.revision).toBe(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toBeUndefined();
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "SLACK_THREAD")[0]).toMatchObject({ starterUserId: bob });

    // The model's settings follow the latest revision, as they do for every thread.
    expect((await lazyEnsureWorkspace(handler, threadOne, pratik)).body).toMatchObject({
      workspaceId, status: "PREPARING", operationId, created: false, settingsRevision: 2, orchestratorInstructions: "Delegate work (revision 2).",
    });
  });

  it("releases the preparing member's charge when the thread is closed", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const prepared = await prepareThread(handler, threadOne, bob);
    await finishOperation(handler, db, workspaceId, prepared.body.operationId as string, "SUCCEEDED");
    const started = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(started.body).toMatchObject({ outcome: "PREFLIGHT", workspaceId });
    await finishOperation(handler, db, workspaceId, started.body.operationId as string, "SUCCEEDED", { safeToClose: true, repositories: [] });
    const completed = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId: started.body.operationId,
    });
    expect(completed.body).toMatchObject({ outcome: "CLOSED", workspaceId });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toMatchObject({ count: 0, threads: [] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it("refuses at the member limit, lists the member's prepared threads, and leaves the thread usable and uncharged", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    await prepareThread(handler, threadOne, pratik);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadTwo, pratik)).body.workspaceId as string;

    const refused = await prepareThread(handler, threadTwo, pratik);
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({
      outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1,
      starterThreads: [{ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }],
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED", fence: 0 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId)).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_THREAD" && item.thread === threadTwo)[0]).not.toHaveProperty("starterUserId");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    expect((await lazyEnsureWorkspace(handler, threadTwo, pratik)).body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED" });
  });

  it("refuses at the organization limit", async () => {
    const { handler } = createBroker({ organizationLimit: 1 });
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    await prepareThread(handler, threadOne, pratik);
    await lazyEnsureWorkspace(handler, threadTwo, bob);
    expect((await prepareThread(handler, threadTwo, bob)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: 1, starterThreads: [] });
  });

  it("prepares once when two requests race, and tells the second it is already being set up", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    const results = await Promise.all([prepareThread(handler, threadOne, pratik), prepareThread(handler, threadOne, bob)]);
    expect(results.map((result) => result.body.created).sort()).toEqual([false, true]);
    expect(results.every((result) => result.body.status === "PREPARING")).toBe(true);
    expect(new Set(results.map((result) => result.body.operationId)).size).toBe(1);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(1);
    expect(members(db).map((item) => item.count)).toEqual([1]);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
  });

  it("never exceeds the member limit when two threads race for the last slot", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    await lazyEnsureWorkspace(handler, threadTwo, pratik);
    const results = await Promise.all([prepareThread(handler, threadOne, pratik), prepareThread(handler, threadTwo, pratik)]);
    expect(results.map((result) => result.body.outcome).sort()).toEqual(["LIMIT_REACHED", "WORKSPACE"]);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
  });

  it("keeps today's retry for a preparation that failed, without a second charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const prepared = await prepareThread(handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, prepared.body.operationId as string, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });

    const next = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(next.body).toMatchObject({ workspaceId, status: "PREPARING", created: false });
    expect(next.body.operationId).not.toBe(prepared.body.operationId);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(2);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("answers the current state, without preparing again, for a thread that already has compute", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const answered = await prepareThread(handler, threadOne, bob);
    delete answered.body.requestId;
    expect(answered.body).toEqual({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toBeUndefined();
  });

  it("answers CLOSED for a closed thread", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const record = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    record.status = "CLOSED";
    record.closedAt = "2026-09-25T10:00:00.000Z";
    delete record.activeOperationId;
    expect((await prepareThread(handler, threadOne, pratik)).body).toMatchObject({ outcome: "CLOSED", workspaceId, closedAt: "2026-09-25T10:00:00.000Z" });
  });

  it("refuses a thread that has no workspace record", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const refused = await prepareThread(handler, threadOne, pratik);
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("an older Slack service and a thread with no compute", () => {
  it("prepares at once, and charges the limit, when an older service reaches the thread", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    // ensureWorkspace sends the request body of a Slack service from before lazy preparation.
    const older = await ensureWorkspace(handler, threadOne, bob);
    expect(older.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", created: true });
    expect(PRE_LAZY_STATUSES).toContain(older.body.status);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect((await ensureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ status: "PREPARING", created: false });
  });

  it("gives an older service the limit refusal it already understands", async () => {
    const { handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    await ensureWorkspace(handler, threadOne, pratik);
    await lazyEnsureWorkspace(handler, threadTwo, pratik);
    expect((await ensureWorkspace(handler, threadTwo, pratik)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
  });
});

describe("a closed thread and the lazy opt-in", () => {
  it("answers CLOSED to a lazy request for a thread closed through the eager flow, and creates no new record", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const started = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(started.body).toMatchObject({ outcome: "PREFLIGHT", workspaceId });
    await finishOperation(handler, db, workspaceId, started.body.operationId as string, "SUCCEEDED", { safeToClose: true, repositories: [] });
    const completed = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId: started.body.operationId,
    });
    expect(completed.body).toMatchObject({ outcome: "CLOSED", workspaceId });
    const closedAt = completed.body.closedAt as string;
    const workspacesBefore = db.find((item) => item.entityType === "WORKSPACE").length;
    const defaultsBefore = db.find((item) => item.entityType === "DEFAULT_WORKSPACE").length;

    const lazy = await lazyEnsureWorkspace(handler, threadOne, bob);
    expect(lazy.status).toBe(200);
    delete lazy.body.requestId;
    expect(lazy.body).toEqual({ outcome: "CLOSED", workspaceId, closedAt });
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(workspacesBefore);
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(defaultsBefore);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
  });
});

describe("preparing a thread: authorization and the thread record", () => {
  it("writes a complete thread record, with the charged member among its requesters, even if the record is missing", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    for (const [key, item] of db.items) if (item.entityType === "SLACK_THREAD") db.items.delete(key);

    const prepared = await prepareThread(handler, threadOne, bob);
    expect(prepared.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", created: true });
    const threadRecord = db.find((item) => String(item.pk).startsWith("SLACK_THREAD#"));
    expect(threadRecord).toHaveLength(1);
    expect(threadRecord[0]).toMatchObject({ entityType: "SLACK_THREAD", thread: threadOne, workspaceId, starterUserId: bob });
    expect([...(threadRecord[0]!.requesters as Set<string>)]).toEqual([bob]);
  });

  it("refuses a caller that is not the Slack orchestrator", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    const refused = await call(handler, {
      method: "POST",
      path: "/v1/service/threads/workspace/prepare",
      service: { principal: `arn:aws:sts::${account}:assumed-role/OtherRole/session`, thread: threadOne, slackUser: pratik },
      body: { requestId: randomUUID() },
    });
    expect(refused.status).toBe(403);
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });

  it("charges the member named by the Slack user header, never a member named in the body", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    const prepared = await call(handler, {
      method: "POST",
      path: "/v1/service/threads/workspace/prepare",
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik },
      body: { requestId: randomUUID(), userId: "UOTHER" },
    });
    expect(prepared.body).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#UOTHER")).toBeUndefined();
    expect(members(db)).toHaveLength(1);
    expect(db.find((item) => item.entityType === "SLACK_THREAD")[0]).toMatchObject({ starterUserId: pratik });
  });

  it("answers WORKSPACE_BUSY, and charges nothing, when the transaction fails for a reason other than the limit", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    db.find((item) => item.entityType === "SLACK_THREAD")[0]!.starterUserId = carol;

    const refused = await prepareThread(handler, threadOne, pratik);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "WORKSPACE_BUSY", message: "thread workspace preparation conflicted with another request; retry" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED", fence: 0 });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });
});
