import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { TASK_PAGE_API, createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import { DEV_ISSUER, MAYA, OMAR } from "../support/developer-task-broker.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";
import { FAIL, caseIdsOf, operatorEvidenceWith, runRound } from "../support/e2e-application-round-run.js";
import { OTHER_SHOT, OTHER_SHOT_SHA, SHOT, SHOT_SHA } from "../support/e2e-scenario-results.js";

// M1.3 Task 3.7: the screenshot behind a row is read through a route that needs a task session, answers only for a digest in the task's current display, and streams the
// private object with its recorded type. Nobody without access to the task can read it.

afterEach(disposeRealCandidates);

const ORIGIN = new URL(DEV_ISSUER).origin;
const taskId = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const caller: DeveloperCaller = { developerId: "d".repeat(64), sessionId: SESSION_ID, amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
const path = (sha256: string) => `/review/${taskId}/task/api/e2e/artifacts/${sha256}`;
const get = (url: string, cookie: string | null = `__Host-agentx_review_session=${SESSION_ID}`): AdaptedHttpRequest => ({ method: "GET", path: url, requestId: "r", headers: cookie === null ? {} : { cookie } });

function deps(overrides: Partial<TaskWebApiDependencies> = {}): TaskWebApiDependencies {
  return { origin: DEV_ISSUER, authenticateSession: async (sessionId) => (sessionId === SESSION_ID ? caller : undefined),
    taskState: async () => { throw new Error("not used"); }, listComments: async () => ({ comments: [] }), createComment: async () => ({} as never), editComment: async () => ({} as never),
    deleteComment: async () => ({} as never), setSuggestion: async () => ({}), decide: async () => ({ revision: 1 }),
    readE2EArtifact: async (_who, _task, sha256) => (sha256 === SHOT_SHA ? { contentType: "image/jpeg" as const, bytes: new Uint8Array(SHOT) } : undefined), ...overrides };
}
const call = (dependencies: TaskWebApiDependencies, request: AdaptedHttpRequest) => createTaskWebApi(dependencies)(request, new URL(`${ORIGIN}${request.path}`));

describe("GET the screenshot of a row, through the task page's API", () => {
  it("is a path of the page API, for a SHA-256 only, and a digest that is not lowercase is not read", async () => {
    expect(TASK_PAGE_API.test(path(SHOT_SHA))).toBe(true);
    expect(TASK_PAGE_API.test(path("abc"))).toBe(false);
    expect(TASK_PAGE_API.test(`${path(SHOT_SHA)}/extra`)).toBe(false);
    let reads = 0;
    const counting = deps({ readE2EArtifact: async () => { reads += 1; return undefined; } });
    expect((await call(counting, get(path(SHOT_SHA.toUpperCase())))).statusCode).toBe(404);
    expect(reads).toBe(0);
  });

  it("streams the object with its recorded type, privately, as base64 for the gateway", async () => {
    const answer = await call(deps(), get(path(SHOT_SHA)));
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/jpeg");
    expect(answer.headers["cache-control"]).toBe("private, max-age=300");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(answer.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(answer.headers["content-disposition"]).toBe("inline");
    expect(answer.headers["x-frame-options"]).toBe("DENY");
    expect(answer.isBase64Encoded).toBe(true);
    expect(Buffer.from(answer.body, "base64").equals(SHOT)).toBe(true);
  });

  it("needs a session: none is 401 and an unknown one is 401, and the object is not read for either", async () => {
    let reads = 0;
    const counting = deps({ readE2EArtifact: async () => { reads += 1; return { contentType: "image/jpeg" as const, bytes: new Uint8Array(SHOT) }; } });
    expect((await call(counting, get(path(SHOT_SHA), null))).statusCode).toBe(401);
    expect((await call(counting, get(path(SHOT_SHA), "__Host-agentx_review_session=33333333-3333-4333-8333-333333333333"))).statusCode).toBe(401);
    expect(reads).toBe(0);
  });

  it("answers 403 to someone who may not see the task, whatever the task and the digest, without reading the object", async () => {
    for (const code of ["TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "FORBIDDEN", "NOT_FOUND"]) {
      const denying = deps({ readE2EArtifact: async () => { throw Object.assign(new Error(`${code}: no task here that you can see`), { code }); } });
      const answer = await call(denying, get(path(SHOT_SHA)));
      expect(answer.statusCode, code).toBe(403);
      expect(JSON.parse(answer.body)).toEqual({ error: "forbidden", message: "You don't have access to this task." });
      expect(answer.isBase64Encoded).toBeUndefined();
    }
  });

  it("answers 404 to a digest that is not in the task's display, and 503 when the store cannot be read", async () => {
    expect((await call(deps(), get(path(OTHER_SHOT_SHA)))).statusCode).toBe(404);
    const broken = deps({ readE2EArtifact: async () => { throw new Error("S3 is down"); } });
    expect((await call(broken, get(path(SHOT_SHA)))).statusCode).toBe(503);
  });

  it("is a read: anything but GET is refused, and without the dependency the path is not found", async () => {
    const post = { ...get(path(SHOT_SHA)), method: "POST" };
    const refused = await call(deps(), post);
    expect(refused.statusCode).toBe(405);
    expect(refused.headers.allow).toBe("GET");
    const without = deps();
    delete without.readE2EArtifact;
    expect((await call(without, get(path(SHOT_SHA)))).statusCode).toBe(404);
  });
});

describe("the screenshot of a row on the real broker", () => {
  const sessionFor = (round: ApplicationRound, developerId: string) => {
    const sessionId = randomUUID();
    round.harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId, amr: "slack", startedAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    return sessionId;
  };
  const route = async (round: ApplicationRound, sha256: string, sessionId: string | undefined, method = "GET") => {
    const harness = round.harness as unknown as { handler: (event: unknown) => Promise<{ statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean }> };
    const rawPath = `/review/${round.taskId}/task/api/e2e/artifacts/${sha256}`;
    return harness.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath, rawQueryString: "",
      headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", ...(sessionId === undefined ? {} : { cookie: `__Host-agentx_review_session=${sessionId}` }) },
      requestContext: { requestId: randomUUID(), http: { method } } });
  };
  async function failedRound() {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } });
    return round;
  }

  it("is served to the task's owner as image/jpeg, byte for byte", async () => {
    const round = await failedRound();
    const answer = await route(round, SHOT_SHA, sessionFor(round, MAYA.developerId));
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/jpeg");
    expect(answer.headers["cache-control"]).toBe("private, max-age=300");
    expect(answer.isBase64Encoded).toBe(true);
    expect(Buffer.from(answer.body, "base64").equals(SHOT)).toBe(true);
  });

  it("is refused with 403 to a signed-in person who is not on the task, and with 401 to nobody", async () => {
    const round = await failedRound();
    expect((await route(round, SHOT_SHA, sessionFor(round, OMAR.developerId))).statusCode).toBe(403);
    expect((await route(round, SHOT_SHA, undefined)).statusCode).toBe(401);
  });

  it("answers 404 for a digest that is not in the task's current display, even when the object exists in the task's private storage", async () => {
    const round = await failedRound();
    const task = round.taskNow() as { ownerKey: string; workspaceId: string };
    // An object of the task's own storage that no row of the display names is still not served.
    (round.harness.s3 as unknown as { binary: Map<string, Buffer> }).binary.set(`private/${task.ownerKey}/${task.workspaceId}/workflow-e2e-artifacts/${OTHER_SHOT_SHA}`, OTHER_SHOT);
    const owner = sessionFor(round, MAYA.developerId);
    expect((await route(round, OTHER_SHOT_SHA, owner)).statusCode).toBe(404);
    expect((await route(round, "f".repeat(64), owner)).statusCode).toBe(404);
  });

  it("answers 404 when the stored object is not the bytes its digest names", async () => {
    const round = await failedRound();
    const task = round.taskNow() as { ownerKey: string; workspaceId: string };
    (round.harness.s3 as unknown as { binary: Map<string, Buffer> }).binary.set(`private/${task.ownerKey}/${task.workspaceId}/workflow-e2e-artifacts/${SHOT_SHA}`, OTHER_SHOT);
    expect((await route(round, SHOT_SHA, sessionFor(round, MAYA.developerId))).statusCode).toBe(404);
  });

  it("is refused for any method but GET", async () => {
    const round = await failedRound();
    expect((await route(round, SHOT_SHA, sessionFor(round, MAYA.developerId), "DELETE")).statusCode).toBe(405);
  });
});
