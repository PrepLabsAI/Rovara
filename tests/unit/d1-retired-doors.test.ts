// D1-2 (old workflow engine removed): the doors that closed, each with the answer it gives now.
//  - ruling (a): a press of an old workflow card gets one fixed answer with a stable code, privately, and nothing about the task is read or written;
//  - the three retired schedule events are answered and do nothing (the deploy window);
//  - every /review/ path except the channel link page is a path nobody serves (owner DEC 254zzz511), signed in or not: nothing of a task page or of the PR-feedback page remains;
//  - the admin routes of the old engine (webhook delivery retry, audit replay) are not routes;
//  - a worker callback of the old engine (candidate export, baseline source, E2E admission and evidence, feedback, pull request, CodeBuild) is not a route; the surviving callbacks are.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RETIRED_SCHEDULE_ANSWER, RETIRED_SCHEDULE_SOURCES, isRetiredScheduleEvent } from "../../packages/broker/src/aws/retired-schedules.js";
import { SLACK_RETIRED_BUTTON_CODE, SLACK_RETIRED_BUTTON_WORDS, recordRetiredSlackButtonNote } from "../../packages/broker/src/aws/slack-retired-buttons.js";
import { WORKFLOW_BUTTON_OUT_OF_DATE } from "../../packages/broker/src/developer/workflow-actions.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000100" };
const digest = "a".repeat(64);
const base = (action: string, extra: Record<string, unknown> = {}) => ({ source: "agentx.slack-ingress", action, taskId, userId: MAYA.slackUserId, thread, requestId: randomUUID(), expectedRevision: 3, ...extra });
/** One event of each kind of press an old workflow card carried (the shapes the broker's own guards accept). */
const PRESSES: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
  ["Approve or Request changes", () => base("workflow-decision", { artifactDigest: digest, decision: "APPROVE", reason: "", selectedOptionalCheckIds: [] })],
  ["Retry checks", () => base("workflow-retry", { selectedOptionalCheckIds: [] })],
  ["Retry reviews", () => base("workflow-review-retry", { candidateDigest: digest })],
  ["Retry publish", () => base("workflow-publish-retry")],
  ["Keep pull requests", () => base("workflow-keep-pull-requests")],
  ["Send back", () => base("workflow-send-back")],
  ["Resolve findings", () => base("workflow-resolve-findings", { candidateDigest: digest, resolutions: [{ findingId: digest, action: "ACCEPT", note: "" }] })],
  ["Close", () => base("workflow-close")],
  ["PR feedback decision", () => base("workflow-feedback-findings-decision", { reviewDigest: digest, proposalDigest: digest, bundleSetDigest: digest, selection: "RECOMMENDED", decision: "APPROVE" })],
  ["Retry PR feedback review", () => base("workflow-feedback-review-retry", { reviewDigest: digest })],
];

describe("an old workflow card's button (ruling a)", () => {
  it("says one fixed sentence with one stable code, whatever the button was, and the words come from one module", async () => {
    const w = await createDeveloperTaskBroker();
    const answers: unknown[] = [];
    for (const [, build] of PRESSES) {
      const answer = await w.handler(build());
      expect(answer.statusCode).toBe(200);
      const body = JSON.parse(answer.body) as Record<string, unknown>;
      expect(body).toMatchObject({ refused: true, code: SLACK_RETIRED_BUTTON_CODE, message: SLACK_RETIRED_BUTTON_WORDS });
      answers.push({ ...body, requestId: undefined });
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(SLACK_RETIRED_BUTTON_CODE).toBe("SLACK_BUTTON_RETIRED");
    // The same sentence the Slack side says for a stale card, so no person-visible change.
    expect(SLACK_RETIRED_BUTTON_WORDS).toBe(WORKFLOW_BUTTON_OUT_OF_DATE);
  });

  it("is told privately to the person who pressed (one note row, for the notifier's ephemeral post) and reads and writes nothing else about the task", async () => {
    const w = await createDeveloperTaskBroker();
    // The note is written only for a task that has a record (the old handler read the task first).
    const record = { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId };
    w.db.set(record);
    const writes: Array<{ pk: string; sk: string }> = [];
    w.db.onWrite((change) => { if (change.after !== undefined) writes.push({ pk: String(change.after.pk), sk: String(change.after.sk) }); });
    const request = base("workflow-keep-pull-requests");
    await w.handler(request);
    const notes = w.db.find((item) => item.entityType === "WORKFLOW_ACTION_REFUSAL");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pk: `DEVTASK#${taskId}`, taskId, slackUserId: MAYA.slackUserId, channelId: SLACK_CHANNEL, threadTs: thread.threadTs, message: SLACK_RETIRED_BUTTON_WORDS });
    // The only row written is that note: no task, workspace, operation, outbox or index row.
    expect(writes.map((row) => row.sk.split("#")[0])).toEqual(["REFUSAL"]);
    expect(w.db.get(`DEVTASK#${taskId}`, "META")).toEqual(record);
  });

  it("writes no note for a task that has no record at all (the answer is the same)", async () => {
    const w = await createDeveloperTaskBroker();
    const answer = await w.handler(base("workflow-close"));
    expect(JSON.parse(answer.body)).toMatchObject({ refused: true, code: SLACK_RETIRED_BUTTON_CODE });
    expect(w.db.find((item) => item.entityType === "WORKFLOW_ACTION_REFUSAL")).toEqual([]);
  });

  it("writes no note for a press whose ids are not well formed, and never throws for a note that cannot be written", async () => {
    const db = new FakeDynamoDb();
    const dependencies = { documentClient: db, tableName: "state" };
    expect(await recordRetiredSlackButtonNote(dependencies, { taskId: "not-an-id", userId: MAYA.slackUserId!, thread, requestId: randomUUID() }, randomUUID())).toBe(false);
    expect(await recordRetiredSlackButtonNote(dependencies, { taskId, userId: "lower", thread, requestId: randomUUID() }, randomUUID())).toBe(false);
    expect(db.find(() => true)).toEqual([]);
    const failing = { documentClient: { send: async () => { throw new Error("table down"); } }, tableName: "state" };
    expect(await recordRetiredSlackButtonNote(failing, { taskId, userId: MAYA.slackUserId!, thread, requestId: randomUUID() }, randomUUID())).toBe(false);
  });

  it("a PR feedback note for the old engine's review page is refused as a 4xx (the ingress treats it as an expected refusal and never retries)", async () => {
    const w = await createDeveloperTaskBroker();
    const answer = await w.handler({ source: "agentx.slack-ingress", action: "feedback-note", taskId, userId: MAYA.slackUserId, thread, eventId: "e1", messageTs: "1695500000.000200", text: "a note" });
    expect(answer.statusCode).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: SLACK_RETIRED_BUTTON_CODE, message: SLACK_RETIRED_BUTTON_WORDS } });
  });

  it("a reply in an old workflow thread is refused (nothing saved), and Stop there finds nothing running", async () => {
    const w = await createDeveloperTaskBroker();
    const note = await w.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId, userId: MAYA.slackUserId, thread, eventId: "e2", messageTs: "1695500000.000300", text: "hello" });
    expect(JSON.parse(note.body)).toEqual({ outcome: "refused" });
    const stop = await w.handler({ source: "agentx.slack-ingress", action: "stop-task", userId: MAYA.slackUserId, thread });
    expect(stop.statusCode).toBeLessThan(500);
  });
});

describe("the three retired schedules (the deploy window, owner R6)", () => {
  it("names exactly the three sources and recognises only a direct invoke with one of them", () => {
    expect([...RETIRED_SCHEDULE_SOURCES]).toEqual(["agentx.github-webhook-recovery", "agentx.workflow-merge-recovery", "agentx.workflow-dispatch-recovery"]);
    for (const source of RETIRED_SCHEDULE_SOURCES) {
      expect(isRetiredScheduleEvent({ source })).toBe(true);
      expect(isRetiredScheduleEvent({ source, continuation: 2 })).toBe(true);
      // An HTTP event (API Gateway always sets requestContext) can never take this path.
      expect(isRetiredScheduleEvent({ source, requestContext: {} })).toBe(false);
    }
    for (const other of [null, "x", [], {}, { source: "agentx.core-job" }, { source: "agentx.github-binding-backfill" }]) expect(isRetiredScheduleEvent(other)).toBe(false);
  });

  it("each is answered 200 by the broker and nothing is read or written", async () => {
    const w = await createDeveloperTaskBroker();
    const before = w.db.commandNames().length;
    for (const source of RETIRED_SCHEDULE_SOURCES) {
      const answer = await w.handler({ source });
      expect(answer.statusCode).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({ ...RETIRED_SCHEDULE_ANSWER });
    }
    expect(w.db.commandNames().length).toBe(before);
  });
});

describe("Code's own task page and the PR-feedback page are gone (owner DEC 254zzz511)", () => {
  it("every /review/ path except the channel link page is a route nobody serves, signed in or not, and the answer names no task", async () => {
    const w = await createDeveloperTaskBroker();
    const paths = [`/review/${taskId}`, `/review/${taskId}/task`, `/review/${taskId}/task/api/state`, `/review/${taskId}/task/status`, `/review/${taskId}/task/people/requests/${randomUUID()}`, "/review/anything"];
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        // API Gateway's exact public review route; the cookies are a browser's review session and CSRF token.
        const answer = await w.handler({ version: "2.0", rawPath: path, routeKey: "ANY /review/{proxy+}", rawQueryString: "", headers: { cookie: "__Host-agentx_review_session=22222222-2222-4222-8222-222222222222; __Host-agentx_review_csrf=x", origin: "https://code.example.test" },
          requestContext: { requestId: "d1", http: { method, path }, accountId: "x", apiId: "x", domainName: "x", domainPrefix: "x", stage: "$default", time: "x", timeEpoch: 0 } });
        expect(answer.statusCode, `${method} ${path}`).toBe(404);
        expect(answer.body, `${method} ${path}`).not.toMatch(/task page|You don't have access|no task|not_found/u);
      }
    }
  });
});

describe("the People confirmation page is NOT retired (owner DEC 254zzz511, review M3): a person is still sent there", () => {
  it("the confirmation page and its API are served through the broker (sign in first), while the task page beside them stays gone", async () => {
    const w = await createDeveloperTaskBroker();
    const event = (path: string, method = "GET") => ({ version: "2.0", rawPath: path, routeKey: "ANY /review/{proxy+}", rawQueryString: "", headers: {},
      requestContext: { requestId: "d1", http: { method, path }, accountId: "x", apiId: "x", domainName: "x", domainPrefix: "x", stage: "$default", time: "x", timeEpoch: 0 } });
    const requestId = randomUUID();
    const page = await w.handler(event(`/review/${taskId}/task/people/confirm/${requestId}`));
    expect(page.statusCode).toBe(302);
    expect((page as unknown as { headers: Record<string, string> }).headers.location).toContain(encodeURIComponent(`/review/${taskId}/task/people/confirm/${requestId}`));
    const api = await w.handler(event(`/review/${taskId}/task/api/people/requests/${requestId}`));
    expect(api.statusCode).toBe(401);
    const gone = await w.handler(event(`/review/${taskId}/task`));
    expect(gone.statusCode).toBe(404);
  });
});

describe("the admin routes of the old engine are not routes", () => {
  it("the GitHub delivery retry and the audit replay answer what an unknown admin route answers", async () => {
    const w = await createDeveloperTaskBroker();
    const unknown = await call(w.handler, { method: "POST", path: "/v1/admin/no-such-route", user: { subject: "admin", admin: true }, body: {} });
    for (const path of [`/v1/admin/github/webhook-deliveries/${randomUUID()}/retry`, `/v1/admin/tasks/${taskId}/e2e-replay`]) {
      for (const method of ["POST", "GET"]) {
        const answer = await call(w.handler, { method, path, user: { subject: "admin", admin: true }, ...(method === "POST" ? { body: {} } : {}) });
        expect(answer.status, `${method} ${path}`).toBe(unknown.status);
        expect((answer.body as { error?: { code?: string } }).error?.code, `${method} ${path}`).toBe((unknown.body as { error?: { code?: string } }).error?.code);
      }
    }
  });
});

describe("the oldest engine's workspace routes do not reach a core task's workspace (the outbox gap)", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  const user = "U0123456789";
  beforeAll(async () => { await loadSlackBroker(); });

  it("a task posted to a workspace the core holds is refused as a missing workspace and writes nothing at all (no operation, no outbox row)", async () => {
    const broker = createBroker();
    await registerSlackProject(broker.handler);
    const workspaceId = (await ensureWorkspace(broker.handler, thread, user)).body.workspaceId as string;
    markReady(broker.db, workspaceId);
    const conversation = await serviceCall(broker.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    const body = { requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run the tests" };
    // The workspace is the oldest engine's: the same post is taken (the control).
    const control = await serviceCall(broker.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, body);
    expect(control.status).toBe(202);
    // Make it a core task's workspace: its task pointer and the task's mark exist.
    const coreTaskId = randomUUID();
    broker.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: coreTaskId });
    broker.db.set({ ...coreTaskMarkKey(coreTaskId), entityType: "TASK_ENGINE", coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on", stampedAt: "2026-11-25T00:00:00.000Z" } });
    const before = broker.db.find(() => true).length;
    const refused = await serviceCall(broker.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { ...body, requestId: randomUUID() });
    expect(refused).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(JSON.stringify(refused.body)).toContain("workspace not found");
    expect(broker.db.find(() => true).length).toBe(before);
  });
});

describe("a press of a button on a CORE task's card, arriving as the legacy invoke event (the channel path off)", () => {
  const route = vi.fn(async (request: { method: string; path: string; body?: string }) => ({ statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId, kept: request.path } }) }));
  const world = async () => {
    route.mockClear();
    const w = await createDeveloperTaskBroker({ developerExtra: { coreTasks: { route } } });
    w.db.set({ ...coreTaskMarkKey(taskId), entityType: "TASK_ENGINE", coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on", stampedAt: "2026-11-25T00:00:00.000Z" } });
    return w;
  };

  it("Keep the pull request is served by the core's own route as the pressing person, never answered as out of date", async () => {
    const w = await world();
    const answer = await w.handler(base("workflow-keep-pull-requests"));
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ task: { taskId } });
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0]).toMatchObject({ method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/keep-pull-requests` });
  });

  it("every other of the ten buttons is refused for a core task as it always was (owner-only words), calls no core route and is not the retired answer", async () => {
    const w = await world();
    for (const [name, build] of PRESSES) {
      if (name === "Keep pull requests") continue;
      const answer = await w.handler(build());
      const body = JSON.parse(answer.body) as Record<string, unknown>;
      expect(body, name).toMatchObject({ refused: true, message: "Only the task owner can do that." });
      expect(body, name).not.toHaveProperty("code");
    }
    expect(route).not.toHaveBeenCalled();
  });

  it("the same press with no core mark on its task is an old card's: the retired answer (the control)", async () => {
    const w = await createDeveloperTaskBroker({ developerExtra: { coreTasks: { route } } });
    const answer = await w.handler(base("workflow-keep-pull-requests"));
    expect(JSON.parse(answer.body)).toMatchObject({ refused: true, code: SLACK_RETIRED_BUTTON_CODE });
    expect(route).not.toHaveBeenCalled();
  });
});
