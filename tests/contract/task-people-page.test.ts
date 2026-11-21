import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskPeopleChangeResult } from "@agentx/contracts";
import type { TaskPeopleView } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { createTaskWebApi } from "../../packages/broker/src/aws/task-web-api.js";

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

function request(method: string, path: string, body?: unknown): AdaptedHttpRequest {
  return { method, path, requestId: "r", headers: {
    cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=${csrf}`,
    ...(method === "POST" ? { origin, "x-agentx-csrf": csrf, "content-type": "application/json" } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

describe("private task People page adapters", () => {

  it("projects People through the session caller and accepts only strict route-bound confirmations", async () => {
    const calls: Array<{ name: string; who: string; value?: unknown }> = [];
    const committed: TaskPeopleChangeResult = { status: "COMMITTED", view: people };
    const pending: TaskPeopleChangeResult = { status: "PENDING", requestId, confirmationUrl: `${origin}/review/${taskId}/task/people/confirm/${requestId}`, expiresAt: "2026-10-12T12:10:00.000Z" };
    const baseDependencies = {
      origin, authenticateSession: async () => caller,
      taskState: async () => ({ revision: 4, waiting: true, stage: "Coding plan", documents: [], commentSeq: 0,
        peopleRevision: 7, canRead: true, canComment: true, canSuggest: true, canDecide: true, canAsk: true, canManagePeople: true, canTakeOwnership: false }),
      listComments: async () => ({ comments: [] }), createComment: async () => ({ comment: {} as never }),
      editComment: async () => ({ comment: {} as never }), deleteComment: async () => ({ comment: {} as never }),
      setSuggestion: async () => undefined, decide: async () => ({ revision: 5 }),
    };
    const api = createTaskWebApi({
      ...baseDependencies,
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
    ]);

    const pendingCalls: string[] = [];
    const pendingApi = createTaskWebApi({ ...baseDependencies,
      getPeopleRequest: async () => (pendingCalls.push("receipt"), pending),
      confirmPeopleRequest: async () => (pendingCalls.push("confirm"), committed),
    });
    const pendingResult = await pendingApi(request("POST", `/review/${taskId}/task/api/people/requests/${requestId}/confirm`, { requestId }),
      new URL(`${origin}/review/${taskId}/task/api/people/requests/${requestId}/confirm`));
    expect(pendingResult.statusCode).toBe(200);
    expect(pendingCalls).toEqual(["receipt", "confirm"]);
  });

});
