// The task page's JSON API: same origin, the CSRF header matching its cookie, the session, JSON only and strict bodies.
// The actor always comes from the session, and a reader who may not see the task cannot tell it exists.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskComment } from "@agentx/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { TASK_PAGE_API, createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { pagePlan } from "../support/page-tasks.js";
import { planAnswer } from "../support/plan-documents.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";

const ORIGIN = new URL(DEV_ISSUER).origin;
const taskId = "11111111-1111-4111-8111-111111111111";
const CSRF = "c".repeat(43);
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const caller: DeveloperCaller = { developerId: "d".repeat(64), sessionId: SESSION_ID, amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
const cookies = (csrf: string | null = CSRF) => `__Host-agentx_review_session=${SESSION_ID}${csrf === null ? "" : `; __Host-agentx_review_csrf=${csrf}`}`;

function fakeDeps(overrides: Partial<TaskWebApiDependencies> = {}): TaskWebApiDependencies & { calls: Array<{ name: string; caller: DeveloperCaller; input?: unknown }> } {
  const calls: Array<{ name: string; caller: DeveloperCaller; input?: unknown }> = [];
  const record = (name: string) => async (who: DeveloperCaller, _taskId: string, input?: unknown) => { calls.push({ name, caller: who, input }); return { ok: true } as never; };
  return {
    calls,
    origin: DEV_ISSUER,
    authenticateSession: async (sessionId) => (sessionId === SESSION_ID ? caller : undefined),
    taskState: async (who) => { calls.push({ name: "state", caller: who }); return { revision: 4, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 1 }], commentSeq: 2 }; },
    listComments: async (who) => { calls.push({ name: "comments", caller: who }); return []; },
    createComment: record("createComment"),
    editComment: record("editComment"),
    deleteComment: record("deleteComment"),
    setSuggestion: record("setSuggestion"),
    decide: async (who, _taskId, input) => { calls.push({ name: "decide", caller: who, input }); return { revision: 5 }; },
    ...overrides,
  };
}

const commentBody = { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, text: "Above reads better.", ask: false };

function post(path: string, body: unknown, headers: Record<string, string | undefined> = {}): AdaptedHttpRequest {
  return {
    method: "POST", path, requestId: "r", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { origin: ORIGIN, cookie: cookies(), "x-agentx-csrf": CSRF, "content-type": "application/json", ...headers },
  };
}
const get = (path: string, cookie: string = cookies()): AdaptedHttpRequest => ({ method: "GET", path, requestId: "r", headers: { cookie } });
const api = (suffix: string) => `/review/${taskId}/task/api/${suffix}`;
const call = async (deps: TaskWebApiDependencies, request: AdaptedHttpRequest) => {
  const response = await createTaskWebApi(deps)(request, new URL(`${ORIGIN}${request.path}`));
  return { ...response, json: JSON.parse(response.body) as Record<string, unknown> };
};

describe("task page API", () => {
  it("matches only its own paths", () => {
    expect(TASK_PAGE_API.test(api("state"))).toBe(true);
    expect(TASK_PAGE_API.test(api(`comments/${randomUUID()}/edit`))).toBe(true);
    expect(TASK_PAGE_API.test(api("decision"))).toBe(true);
    expect(TASK_PAGE_API.test(api("other"))).toBe(false);
    expect(TASK_PAGE_API.test(`/review/${taskId}/api/decision`)).toBe(false);
  });

  it("every POST needs same origin, the CSRF header and its cookie", async () => {
    const deps = fakeDeps();
    const refused = [
      post(api("comments"), commentBody, { "x-agentx-csrf": undefined }),
      post(api("comments"), commentBody, { "x-agentx-csrf": "d".repeat(43) }),
      post(api("comments"), commentBody, { cookie: cookies(null) }),
      post(api("comments"), commentBody, { cookie: cookies("short"), "x-agentx-csrf": "short" }),
      post(api("comments"), commentBody, { origin: undefined }),
      post(api("comments"), commentBody, { origin: "null" }),
      post(api("comments"), commentBody, { origin: "https://evil.example" }),
      post(api("decision"), {}, { origin: "https://evil.example" }),
    ];
    for (const request of refused) {
      const answer = await call(deps, request);
      expect(answer.statusCode).toBe(403);
      expect(answer.json).toEqual({ error: "request_refused" });
    }
    expect(deps.calls).toEqual([]);
    const accepted = await call(deps, post(api("comments"), commentBody));
    expect(accepted.statusCode).toBe(201);
    // A signed-out request is told to sign in, before anything else.
    const signedOut = await call(deps, post(api("comments"), commentBody, { cookie: undefined }));
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.json).toEqual({ error: "sign_in_required" });
    // Reads are GET only and writes POST only.
    expect((await call(deps, { ...get(api("state")), method: "POST", headers: post(api("state"), {}).headers })).statusCode).toBe(405);
    expect((await call(deps, get(api("comments/" + randomUUID() + "/edit")))).statusCode).toBe(405);
    expect((await call(deps, { ...get(api("decision")), method: "PUT" })).statusCode).toBe(405);
  });

  it("JSON only, at most 16 KB, strict fields", async () => {
    const deps = fakeDeps();
    const plain = await call(deps, post(api("comments"), commentBody, { "content-type": "text/plain" }));
    expect(plain.statusCode).toBe(400);
    expect(plain.json.error).toBe("invalid_request");
    const form = await call(deps, post(api("comments"), commentBody, { "content-type": "application/x-www-form-urlencoded" }));
    expect(form.statusCode).toBe(400);
    expect((await call(deps, post(api("comments"), commentBody, { "content-type": "application/json; charset=utf-8" }))).statusCode).toBe(201);
    const big = await call(deps, post(api("comments"), { ...commentBody, text: "x".repeat(16_400) }));
    expect(big.statusCode).toBe(400);
    expect((await call(deps, post(api("comments"), "{not json"))).statusCode).toBe(400);
    for (const extra of [{ author: "someone" }, { actorId: "x" }, { role: "owner" }]) {
      const answer = await call(deps, post(api("comments"), { ...commentBody, ...extra }));
      expect(answer.statusCode).toBe(400);
      expect(answer.json.error).toBe("invalid_request");
    }
    const decision = { requestId: randomUUID(), expectedRevision: 4, artifactDigest: "a".repeat(64), decision: "APPROVE", answers: [], includedCommentIds: [] };
    expect((await call(deps, post(api("decision"), { ...decision, actorId: "x" }))).statusCode).toBe(400);
    expect((await call(deps, post(api("decision"), { ...decision, decision: "SKIP" }))).statusCode).toBe(400);
    expect((await call(deps, post(api("decision"), { ...decision, includedCommentIds: Array.from({ length: 26 }, () => randomUUID()) }))).statusCode).toBe(400);
    expect((await call(deps, post(api("decision"), { ...decision, note: "n".repeat(501) }))).statusCode).toBe(400);
    expect((await call(deps, post(api("decision"), decision))).statusCode).toBe(200);
    expect(deps.calls.filter((entry) => entry.name === "decide")).toHaveLength(1);
  });

  it("maps each refusal to its status and sentence", async () => {
    const thrower = (error: Record<string, unknown>) => fakeDeps({ createComment: async () => { throw Object.assign(new Error("refused"), error); } });
    const cases: Array<[Record<string, unknown>, number, string, string | undefined]> = [
      [{ code: "CONFIG_INVALID", pageReason: "too_long", message: "Keep comments under 2,000 characters." }, 400, "invalid_request", "Keep comments under 2,000 characters."],
      [{ code: "TASK_BUSY", pageReason: "slow_down", message: "You've posted a lot in the last 10 minutes. Try again in a few minutes." }, 429, "slow_down", "You've posted a lot in the last 10 minutes. Try again in a few minutes."],
      [{ code: "IDEMPOTENCY_CONFLICT", pageReason: "locked", message: "Sent with a decision, so it can't be changed." }, 409, "changed", "Sent with a decision, so it can't be changed."],
      [{ code: "CONFIG_INVALID", pageReason: "thread_full", message: "This thread has 20 replies, the most it can hold." }, 409, "full", "This thread has 20 replies, the most it can hold."],
      [{ code: "FORBIDDEN", pageReason: "not_yours", message: "Only the person who wrote a comment can change it." }, 403, "not_allowed", "Only the person who wrote a comment can change it."],
      [{ code: "IDEMPOTENCY_CONFLICT", pageReason: "comment_changed", message: "A comment you included was edited or deleted. Check the list and send again." }, 409, "changed", "A comment you included was edited or deleted. Check the list and send again."],
      [{ code: "TASK_NOT_FOUND" }, 404, "not_found", "You don't have access to this task."],
      [{ code: "TASK_ACCESS_DENIED", owners: ["Maya"] }, 404, "not_found", "You don't have access to this task."],
      [{ code: "SOMETHING_ELSE", message: "workflow revision digest" }, 503, "unavailable", undefined],
    ];
    for (const [error, status, code, message] of cases) {
      const answer = await call(thrower(error), post(api("comments"), commentBody));
      expect(answer.statusCode, code).toBe(status);
      expect(answer.json.error).toBe(code);
      if (message !== undefined) expect(answer.json.message).toBe(message);
      expect(answer.body).not.toMatch(/workflow|revision|digest|Maya/);
    }
  });

  it("state refreshes the CSRF cookie and carries no comment text", async () => {
    const deps = fakeDeps();
    const kept = await call(deps, get(api("state")));
    expect(kept.statusCode).toBe(200);
    expect(kept.json).toEqual({ revision: 4, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 1 }], commentSeq: 2, csrf: CSRF });
    expect(kept.headers["set-cookie"]).toBe(`__Host-agentx_review_csrf=${CSRF}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`);
    expect(kept.headers["cache-control"]).toContain("no-store");
    const fresh = await call(deps, get(api("state"), cookies(null)));
    expect(typeof fresh.json.csrf).toBe("string");
    expect(fresh.json.csrf).not.toBe(CSRF);
    expect(fresh.json.csrf).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(fresh.headers["set-cookie"]).toContain(`__Host-agentx_review_csrf=${String(fresh.json.csrf)};`);
  });
});

describe("task page API through the broker", () => {
  const LEE: Developer = { developerId: "f".repeat(64), name: "Lee Park", provider: "slack", sessionId: "s-lee", slackUserId: "U0LEE0001" };
  const NIA: Developer = { developerId: "a".repeat(64), name: "Nia Fox", provider: "slack", sessionId: "s-nia", slackUserId: "U0NIA0001" };

  /** A shared task whose structured coding plan v1 waits for Maya; Lee is in the channel, Nia and Omar are not. */
  async function sharedTask() {
    const harness = await createDeveloperTaskBroker({ channelMembers: async (request) => ({
      ok: true, memberOf: request.slackUserId === MAYA.slackUserId || request.slackUserId === LEE.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
    }) });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test", shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    const id = (started.body.task as { taskId: string }).taskId;
    const workspaceId = (harness.db.get(`DEVTASK#${id}`, "META") as { workspaceId: string }).workspaceId;
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const planning = operations().find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    const plan = pagePlan();
    delete plan.checks;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(plan));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflow = (harness.db.get(`DEVTASK#${id}`, "META") as { workflow: { revision: number; stage: string; artifacts: Array<{ sha256: string }> } }).workflow;
    expect(workflow.stage).toBe("PLAN_REVIEW");
    const sha256 = workflow.artifacts.at(-1)!.sha256;
    const revision = workflow.revision;
    for (const who of [MAYA, OMAR, LEE, NIA]) {
      harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name,
        ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    const send = async (who: Developer, method: string, path: string, body?: unknown) => {
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: who.developerId, amr: who.provider,
        startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
      const response = await harness.handler({
        version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: path, rawQueryString: "",
        headers: {
          host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=${CSRF}`,
          ...(method === "POST" ? { origin: ORIGIN, "x-agentx-csrf": CSRF, "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        requestContext: { requestId: randomUUID(), http: { method } },
      }) as { statusCode: number; headers: Record<string, string>; body: string };
      return { ...response, json: (() => { try { return JSON.parse(response.body) as Record<string, unknown>; } catch { return {}; } })() };
    };
    const decision = (extra: Record<string, unknown> = {}) => ({
      requestId: randomUUID(), expectedRevision: revision, artifactDigest: sha256, decision: "APPROVE",
      answers: [{ decisionId: "d1", optionId: "below", opened: false }], includedCommentIds: [], ...extra,
    });
    return { harness, id, sha256, revision, send, decision };
  }

  it("the actor comes from the session, never the body", async () => {
    const t = await sharedTask();
    const answer = await t.send(LEE, "POST", `/review/${t.id}/task/api/comments`, { ...commentBody, requestId: randomUUID() });
    expect(answer.statusCode, answer.body).toBe(201);
    expect((answer.json.comment as { author: unknown }).author).toEqual({ kind: "person", name: "Lee Park", owner: false, you: true });
    const stored = t.harness.db.find((item) => item.entityType === "TASK_COMMENT") as unknown as TaskComment[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.author).toMatchObject({ kind: "person", developerId: LEE.developerId, name: "Lee Park", owner: false });
    // A field naming someone else is refused outright.
    const forged = await t.send(LEE, "POST", `/review/${t.id}/task/api/comments`, { ...commentBody, requestId: randomUUID(), author: { kind: "agentx" } });
    expect(forged.statusCode).toBe(400);
    // The listing names no IDs, only who wrote it and whether it is the reader.
    const listed = await t.send(MAYA, "GET", `/review/${t.id}/task/api/comments`);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(LEE.developerId);
    expect((listed.json.comments as Array<{ author: unknown; text: string }>)[0]).toMatchObject({ author: { kind: "person", name: "Lee Park", owner: false, you: false }, text: "Above reads better." });
  });

  it("a commenter cannot decide", async () => {
    const t = await sharedTask();
    const answer = await t.send(LEE, "POST", `/review/${t.id}/task/api/decision`, t.decision());
    expect(answer.statusCode).toBe(403);
    expect(answer.json).toEqual({ error: "owners_only", message: "Only owners decide." });
    expect((t.harness.db.get(`DEVTASK#${t.id}`, "META") as { workflow: { revision: number } }).workflow.revision).toBe(t.revision);
  });

  it("a reader without access cannot tell a task exists", async () => {
    const t = await sharedTask();
    const missing = randomUUID();
    for (const who of [NIA, OMAR]) {
      for (const [method, suffix, body] of [["GET", "state", undefined], ["GET", "comments", undefined], ["POST", "comments", { ...commentBody, requestId: randomUUID() }], ["POST", "decision", t.decision()]] as const) {
        const real = await t.send(who, method, `/review/${t.id}/task/api/${suffix}`, body);
        const none = await t.send(who, method, `/review/${missing}/task/api/${suffix}`, body);
        expect(real.statusCode, `${who.name} ${suffix}`).toBe(404);
        expect(real.body).toBe(none.body);
        expect(real.json).toEqual({ error: "not_found", message: "You don't have access to this task." });
        expect(real.body).not.toContain("Maya");
      }
    }
  });

  it("a stale decision answers 409 with the refusal sentence", async () => {
    const t = await sharedTask();
    const first = await t.send(MAYA, "POST", `/review/${t.id}/task/api/decision`, t.decision({ decision: "REQUEST_CHANGES", note: "Shorter, please." }));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json.revision).toBeGreaterThan(t.revision);
    const second = await t.send(MAYA, "POST", `/review/${t.id}/task/api/decision`, t.decision({ decision: "REQUEST_CHANGES", note: "Again." }));
    expect(second.statusCode).toBe(409);
    expect(second.json).toEqual({ error: "changed", message: "Changes were already requested by Maya Chen a moment ago." });
    // Request changes with nothing to say is refused with the page's own sentence.
    const t2 = await sharedTask();
    const empty = await t2.send(MAYA, "POST", `/review/${t2.id}/task/api/decision`, t2.decision({ decision: "REQUEST_CHANGES" }));
    expect(empty.statusCode).toBe(400);
    expect(empty.json).toEqual({ error: "invalid_request", message: "Include at least one comment or write a note." });
  });

  it("state answers the owner and a teammate with the CSRF token", async () => {
    const t = await sharedTask();
    for (const who of [MAYA, LEE]) {
      const answer = await t.send(who, "GET", `/review/${t.id}/task/api/state`);
      expect(answer.statusCode).toBe(200);
      expect(answer.json).toEqual({ revision: t.revision, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 1 }], commentSeq: 0, csrf: CSRF });
    }
  });

  it("the page itself shows the owner's answer controls and a teammate's comment, with the data the script reads", async () => {
    const t = await sharedTask();
    const posted = await t.send(LEE, "POST", `/review/${t.id}/task/api/comments`, { ...commentBody, requestId: randomUUID(), text: "Above <b>reads</b> better." });
    expect(posted.statusCode).toBe(201);
    const owner = await t.send(MAYA, "GET", `/review/${t.id}/task`);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain('type="radio" name="answer-d1"');
    expect(owner.body).toContain('class="decide-bar"');
    expect(owner.body).toContain("Above &lt;b&gt;reads&lt;/b&gt; better.");
    const island = JSON.parse(/<script type="application\/json" id="agentx-page-data">([\s\S]*?)<\/script>/.exec(owner.body)![1]!) as { current: { version: number; artifactDigest: string; openCommentIds: string[] }; commentSeq: number; revision: number };
    expect(island).toMatchObject({ revision: t.revision, commentSeq: 1, current: { version: 1, artifactDigest: t.sha256, openCommentIds: [(posted.json.comment as { id: string }).id] } });
    const teammate = await t.send(LEE, "GET", `/review/${t.id}/task`);
    expect(teammate.body).toContain("Only owners decide.");
    expect(teammate.body).not.toContain('type="radio"');
    expect(teammate.body).toContain("You can read and comment on this task.");
  });

  it("through the AI tool API a teammate cannot decide either, and hears the answer a missing task gets", async () => {
    const t = await sharedTask();
    for (const who of [LEE, NIA]) {
      t.harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    }
    const body = { requestId: randomUUID(), expectedRevision: t.revision, decision: "APPROVE", reason: "Looks right.", artifactDigest: t.sha256 };
    const teammate = await t.harness.dev(LEE, "POST", `/v1/dev/tasks/${t.id}/workflow/decision`, body);
    expect(teammate.status).toBe(404);
    expect((teammate.body.error as { code: string }).code).toBe("TASK_NOT_FOUND");
    const outsider = await t.harness.dev(NIA, "POST", `/v1/dev/tasks/${t.id}/workflow/decision`, body);
    expect(outsider.body.error).toEqual(teammate.body.error);
    expect((t.harness.db.get(`DEVTASK#${t.id}`, "META") as { workflow: { revision: number } }).workflow.revision).toBe(t.revision);
    const owner = await t.harness.dev(MAYA, "POST", `/v1/dev/tasks/${t.id}/workflow/decision`, body);
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
  });

  it("the feedback review routes are unchanged", async () => {
    const t = await sharedTask();
    // The PR feedback page and its API still answer their own paths: this task has no review, so both say not found in their own words.
    const feedback = await t.send(MAYA, "GET", `/review/${t.id}/api`);
    expect(feedback.statusCode).toBe(404);
    expect(feedback.json).toEqual({ error: "not_found" });
    const decision = await t.send(MAYA, "POST", `/review/${t.id}/api/decision`, {});
    expect(decision.statusCode).toBe(400);
    expect(decision.json).toEqual({ error: "invalid_request" });
    // An unknown path under the task page is the task page's own not found, never the feedback page.
    const unknown = await t.send(MAYA, "GET", `/review/${t.id}/task/api/other`);
    expect(unknown.statusCode).toBe(404);
  });
});
