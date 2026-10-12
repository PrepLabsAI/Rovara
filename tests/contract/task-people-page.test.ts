import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskPeopleChangeResult, TaskPeopleDisplayReadRequest, TaskPeopleProposal } from "@agentx/contracts";
import type { TaskPeopleView } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { createTaskWebApi } from "../../packages/broker/src/aws/task-web-api.js";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { DEV_ISSUER, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const csrf = "c".repeat(43);
const origin = "https://agentx.example.test";
const caller: DeveloperCaller = { developerId: "d".repeat(64), sessionId, amr: "slack", name: "Maya" };
const people: TaskPeopleView = {
  revision: 7, orphaned: false,
  people: [{ personId, name: "Lee <script>", role: "commenter", you: false, effectiveRole: "commenter" }],
  canManage: true, canTakeOwnership: false,
  addPeopleUrl: "https://slack.com/archives/C0123456789/p1234567890123456",
};

const documentView: TaskDocumentView = {
  taskId, title: "Private People", status: "Waiting", nextStep: "Review", path: "QUICK", revision: 4,
  stage: "Coding plan", role: "owner", documents: [], checks: [], findings: [], pullRequests: [], history: [],
  access: { role: "owner", canComment: true, canSuggest: true, canDecide: true, canAsk: true },
  peopleRevision: 7, canManagePeople: true, canTakeOwnership: false,
};

function request(method: string, path: string, body?: unknown): AdaptedHttpRequest {
  return { method, path, requestId: "r", headers: {
    cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=${csrf}`,
    ...(method === "POST" ? { origin, "x-agentx-csrf": csrf, "content-type": "application/json" } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

describe("private task People page adapters", () => {
  it("runs the authenticated proposal, effect-free confirmation GET, commit, and receipt replay through the real broker route", async () => {
    const creatorSlackUserId = "U0PAGEPPL1";
    const targetSlackUserId = "U0PAGEPPL2";
    const creator: Developer = { developerId: developerIdForSlackUser(creatorSlackUserId), name: "Maya Chen", provider: "slack",
      sessionId: randomUUID(), slackUserId: creatorSlackUserId };
    const harness = await createDeveloperTaskBroker({
      channelMembers: async (input) => ({ ok: true, memberOf: input.channelIds }),
      developerExtra: {
        taskPeopleConfiguration: { peopleChangesEnabled: true },
        taskPersonProof: async (input) => ({ ok: true, user: { id: input.slackUserId, teamId: SLACK_TEAM,
          name: input.slackUserId === creatorSlackUserId ? creator.name : "Lee Park" }, memberOf: input.channelIds }),
        taskPeopleDisplayRead: async (input: TaskPeopleDisplayReadRequest) => input.operation === "proof"
          ? { operation: "proof" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
            user: { id: input.request.slackUserId, teamId: SLACK_TEAM, name: input.request.slackUserId === creatorSlackUserId ? creator.name : "Lee Park" },
            memberOf: input.request.channelIds } }
          : { operation: "directory" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
            users: [creatorSlackUserId, targetSlackUserId].map((id) => ({ id, teamId: SLACK_TEAM,
              name: id === creatorSlackUserId ? creator.name : "Lee Park", memberOf: input.request.channelIds })) } },
      },
    });
    harness.db.set({ pk: `DEVELOPER#${creator.developerId}`, sk: "META", developerId: creator.developerId, provider: creator.provider,
      displayName: creator.name, slackUserId: creatorSlackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow",
      thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000081" }, userId: creatorSlackUserId,
      instructions: "Exercise the private People page", workflowPath: "QUICK", requestId: randomUUID() });
    expect(started.statusCode).toBe(200);
    const realTaskId = (JSON.parse(started.body) as { taskId: string }).taskId;
    const browserSessionId = randomUUID();
    harness.db.set({ pk: `SESSION#${browserSessionId}`, sk: "META", sessionId: browserSessionId, developerId: creator.developerId,
      amr: creator.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600,
      reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    const routed = async (method: string, suffix: string, body?: unknown, sessionId = browserSessionId) => {
      const path = `/review/${realTaskId}/task${suffix}`;
      const response = await harness.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: path, rawQueryString: "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=${csrf}`,
          ...(method === "POST" ? { origin: new URL(DEV_ISSUER).origin, "x-agentx-csrf": csrf, "content-type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } } });
      return { ...response, json: (() => { try { return JSON.parse(response.body) as Record<string, unknown>; } catch { return {}; } })() };
    };
    const listed = await routed("GET", "/api/people");
    expect(listed.statusCode, listed.body).toBe(200);
    const view = listed.json as unknown as TaskPeopleView;
    const target = view.people.find((entry) => entry.name === "Lee Park")!;
    const roleRequestId = randomUUID();
    const proposed = await routed("POST", "/api/people/role", { requestId: roleRequestId, expectedPeopleRevision: view.revision,
      personId: target.personId, role: "owner" });
    expect(proposed.statusCode, proposed.body).toBe(202);
    const before = harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT").length;
    const review = await routed("GET", `/people/confirm/${roleRequestId}`);
    expect(review.statusCode, review.body).toBe(200);
    expect(review.body).toContain("Lee Park");
    expect(harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(before);
    const confirmed = await routed("POST", `/api/people/requests/${roleRequestId}/confirm`, { requestId: roleRequestId });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json).toMatchObject({ status: "COMMITTED", view: { revision: view.revision + 1 } });
    expect(harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(before + 1);
    expect(harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")[0]).toMatchObject({ actorDeveloperId: creator.developerId });
    const targetDeveloperId = developerIdForSlackUser(targetSlackUserId);
    const targetSessionId = randomUUID();
    harness.db.set({ pk: `DEVELOPER#${targetDeveloperId}`, sk: "META", developerId: targetDeveloperId, provider: "slack", displayName: "Lee Park",
      slackUserId: targetSlackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    harness.db.set({ pk: `SESSION#${targetSessionId}`, sk: "META", sessionId: targetSessionId, developerId: targetDeveloperId, amr: "slack",
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600,
      reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    const coOwnerView = (await routed("GET", "/api/people", undefined, targetSessionId)).json as unknown as TaskPeopleView;
    const creatorPerson = coOwnerView.people.find((entry) => entry.you === false && entry.name === creator.name)!;
    const coOwnerRequestId = randomUUID();
    expect((await routed("POST", "/api/people/role", { requestId: coOwnerRequestId, expectedPeopleRevision: coOwnerView.revision,
      personId: creatorPerson.personId, role: "viewer" }, targetSessionId)).statusCode).toBe(202);
    expect((await routed("POST", `/api/people/requests/${coOwnerRequestId}/confirm`, { requestId: coOwnerRequestId }, targetSessionId)).statusCode).toBe(200);
    expect((harness.db.get(`DEVTASK#${realTaskId}`, "META") as { developerId: string }).developerId).toBe(creator.developerId);
    const page = await routed("GET", "", undefined, targetSessionId);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain("Lee Park made The task owner viewer");
    const afterCoOwnerEvents = harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT").length;
    const replay = await routed("GET", `/api/people/requests/${roleRequestId}`);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json).toEqual(confirmed.json);
    expect(harness.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(afterCoOwnerEvents);
  });

  it("projects People through the session caller and accepts only strict route-bound confirmations", async () => {
    const calls: Array<{ name: string; who: string; value?: unknown }> = [];
    const committed: TaskPeopleChangeResult = { status: "COMMITTED", view: people };
    const pending: TaskPeopleChangeResult = { status: "PENDING", requestId, confirmationUrl: `${origin}/review/${taskId}/task/people/confirm/${requestId}`, expiresAt: "2026-10-12T12:10:00.000Z" };
    const api = createTaskWebApi({
      origin, authenticateSession: async () => caller,
      taskState: async () => ({ revision: 4, waiting: true, stage: "Coding plan", documents: [], commentSeq: 0,
        peopleRevision: 7, canRead: true, canComment: true, canSuggest: true, canDecide: true, canAsk: true, canManagePeople: true, canTakeOwnership: false }),
      listComments: async () => ({ comments: [] }), createComment: async () => ({ comment: {} as never }),
      editComment: async () => ({ comment: {} as never }), deleteComment: async () => ({ comment: {} as never }),
      setSuggestion: async () => undefined, decide: async () => ({ revision: 5 }),
      getPeople: async (who) => (calls.push({ name: "get", who: who.developerId }), people),
      proposePeopleRole: async (who, _task, value) => (calls.push({ name: "role", who: who.developerId, value }), pending),
      proposeOwnership: async () => committed,
      getPeopleRequest: async () => committed,
      confirmPeopleRequest: async (who, _task, value) => (calls.push({ name: "confirm", who: who.developerId, value }), committed),
    });
    const call = async (method: string, suffix: string, body?: unknown) => api(request(method, `/review/${taskId}/task/api/${suffix}`, body), new URL(`${origin}/review/${taskId}/task/api/${suffix}`));
    expect(JSON.parse((await call("GET", "people")).body)).toEqual(people);
    expect((await call("POST", "people/role", { requestId, expectedPeopleRevision: 7, personId, role: "viewer" })).statusCode).toBe(202);
    expect((await call("POST", `people/requests/${requestId}/confirm`, { requestId: randomUUID() })).statusCode).toBe(400);
    expect((await call("POST", `people/requests/${requestId}/confirm`, { requestId })).statusCode).toBe(200);
    expect(calls).toEqual([
      { name: "get", who: caller.developerId },
      { name: "role", who: caller.developerId, value: { requestId, expectedPeopleRevision: 7, personId, role: "viewer" } },
      { name: "confirm", who: caller.developerId, value: requestId },
    ]);
  });

  it("renders the private People panel and a GET-only pending confirmation with escaped immutable identity", async () => {
    const pending: TaskPeopleProposal = { requestId, taskId, expectedPeopleRevision: 7, personId, role: "owner", kind: "role", expiresAt: "2026-10-12T12:10:00.000Z" };
    const web = createTaskWeb({
      authenticateSession: async () => caller,
      getTaskDocumentView: async () => documentView,
      getTaskPeople: async () => people,
      getTaskPeopleRequest: async () => ({ status: "PENDING", requestId, confirmationUrl: `${origin}/review/${taskId}/task/people/confirm/${requestId}`, expiresAt: pending.expiresAt }),
      getTaskPeopleProposalMetadata: async () => pending,
      getTaskPersonName: async () => "Lee <script>",
      getTaskPeopleCapabilities: async () => ({ peopleRevision: 7, canManagePeople: true, canTakeOwnership: false }),
    });
    const page = await web(request("GET", `/review/${taskId}/task`), new URL(`${origin}/review/${taskId}/task`));
    expect(page.body).toContain('id="task-people"');
    expect(page.body).toContain("Lee &lt;script&gt;");
    expect(page.body).toContain("Add people in Slack");
    const confirmation = await web(request("GET", `/review/${taskId}/task/people/confirm/${requestId}`), new URL(`${origin}/review/${taskId}/task/people/confirm/${requestId}`));
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.body).toContain("Review People change");
    expect(confirmation.body).toContain("Lee &lt;script&gt;");
  });
});
