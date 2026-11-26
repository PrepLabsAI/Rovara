/* eslint-disable @typescript-eslint/unbound-method -- the fakes are vi.fn mocks read back for their calls */
// D1-2 review M3: the People confirmation page is the one page of Code's old task page that stays (a human-in-the-loop security step for a change an AI tool or script proposed).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PEOPLE_CONFIRM_API, PEOPLE_CONFIRM_PAGE, createPeopleConfirmWeb, type PeopleConfirmDependencies } from "../../packages/broker/src/aws/people-confirm-web.js";
import { taskPersonStoredName, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const taskId = randomUUID();
const requestId = randomUUID();
const ORIGIN = "https://api.example.test";
const CSRF = "c".repeat(43);
const SESSION = randomUUID();
const caller = { developerId: "d".repeat(64), sessionId: SESSION, name: "Maya" } as DeveloperCaller;
const session = `__Host-agentx_review_session=${SESSION}`;
const pending = { status: "PENDING" as const, requestId, confirmationUrl: "x", expiresAt: "2026-11-25T12:00:00.000Z" };
const view = { kind: "role" as const, requestId, taskId, expectedPeopleRevision: 3, personId: randomUUID(), role: "owner" as const, expiresAt: "2026-11-25T12:00:00.000Z" };

function world(over: Partial<PeopleConfirmDependencies> = {}) {
  const deps = {
    origin: ORIGIN,
    authenticateSession: vi.fn(async (id: string) => (id === SESSION ? caller : undefined)),
    getRequest: vi.fn(async () => pending),
    getMetadata: vi.fn(async () => view),
    getPersonName: vi.fn(async () => "Priya <b>Rao</b>"),
    confirm: vi.fn(async () => ({ status: "COMMITTED" as const, view: {} })),
    ...over,
  } as unknown as PeopleConfirmDependencies & { confirm: ReturnType<typeof vi.fn> };
  return { deps, handle: createPeopleConfirmWeb(deps) };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", path, headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${session}; __Host-agentx_review_csrf=${CSRF}`, "x-agentx-csrf": CSRF, ...headers }, body: JSON.stringify(body), requestId: "r" } as never);
const pagePath = `/review/${taskId}/task/people/confirm/${requestId}`;
const apiPath = `/review/${taskId}/task/api/people/requests/${requestId}/confirm`;

describe("the People confirmation page", () => {
  it("names exactly its two paths", () => {
    expect(PEOPLE_CONFIRM_PAGE.test(pagePath)).toBe(true);
    expect(PEOPLE_CONFIRM_API.test(apiPath)).toBe(true);
    for (const other of [`/review/${taskId}/task`, `/review/${taskId}/task/api/state`, `/review/${taskId}/task/people/requests/${requestId}`, `/review/${taskId}/task/people/confirm/not-a-uuid`]) {
      expect(PEOPLE_CONFIRM_PAGE.test(other) || PEOPLE_CONFIRM_API.test(other), other).toBe(false);
    }
  });

  it("sends a person with no session to sign in and comes back to this page, without reading anything", async () => {
    const w = world();
    const answer = await w.handle({ method: "GET", path: pagePath, headers: {}, requestId: "r" }, new URL(pagePath, ORIGIN));
    expect(answer.statusCode).toBe(302);
    expect(answer.headers.location).toContain(encodeURIComponent(pagePath));
    expect(w.deps.getRequest).not.toHaveBeenCalled();
  });

  it("shows the change in words (the name escaped), under a nonce-only policy, with a CSRF cookie, and confirms nothing by being opened", async () => {
    const w = world();
    const answer = await w.handle({ method: "GET", path: pagePath, headers: { cookie: session }, requestId: "r" }, new URL(pagePath, ORIGIN));
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain("Review People change");
    expect(answer.body).toContain("Change Priya &lt;b&gt;Rao&lt;/b&gt; to Owner.");
    expect(answer.body).not.toContain("<b>Rao</b>");
    expect(answer.headers["content-security-policy"]).toMatch(/script-src 'nonce-[^']+'/);
    expect(answer.headers["set-cookie"]).toContain("__Host-agentx_review_csrf=");
    expect(w.deps.confirm).not.toHaveBeenCalled();
  });

  it("is the same 404 for a request that is not yours and for one that does not exist", async () => {
    const w = world({ getRequest: vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "TASK_NOT_FOUND" }); }) });
    const answer = await w.handle({ method: "GET", path: pagePath, headers: { cookie: session }, requestId: "r" }, new URL(pagePath, ORIGIN));
    expect(answer.statusCode).toBe(404);
    expect(answer.body).not.toContain(requestId);
  });

  it("an already committed request says so and offers nothing to confirm", async () => {
    const w = world({ getRequest: vi.fn(async () => ({ status: "COMMITTED" as const, view: {} })) as never });
    const answer = await w.handle({ method: "GET", path: pagePath, headers: { cookie: session }, requestId: "r" }, new URL(pagePath, ORIGIN));
    expect(answer.body).toContain("already complete");
    expect(answer.body).not.toContain("data-people-confirm");
  });
});

describe("the confirmation call", () => {
  it("confirms once for the signed-in person with this origin and the CSRF header, and says 200", async () => {
    const w = world();
    const answer = await w.handle(post(apiPath, { requestId }), new URL(apiPath, ORIGIN));
    expect(answer.statusCode).toBe(200);
    expect(w.deps.confirm).toHaveBeenCalledTimes(1);
    expect(w.deps.confirm).toHaveBeenCalledWith(caller, taskId, requestId);
  });

  it.each([
    ["no session", { cookie: `__Host-agentx_review_csrf=${CSRF}` }, 401],
    ["another origin", { origin: "https://evil.example" }, 403],
    ["no CSRF header", { "x-agentx-csrf": "" }, 403],
    ["a CSRF header that is not the cookie's", { "x-agentx-csrf": "d".repeat(43) }, 403],
    ["a body that is not JSON by its type", { "content-type": "text/plain" }, 400],
  ])("refuses %s and confirms nothing", async (_name, headers, status) => {
    const w = world();
    const answer = await w.handle(post(apiPath, { requestId }, headers), new URL(apiPath, ORIGIN));
    expect(answer.statusCode).toBe(status);
    expect(w.deps.confirm).not.toHaveBeenCalled();
  });

  it("refuses a body naming another request or with extra fields, and a replay of a committed request confirms nothing again", async () => {
    const w = world();
    expect((await w.handle(post(apiPath, { requestId: randomUUID() }), new URL(apiPath, ORIGIN))).statusCode).toBe(400);
    expect((await w.handle(post(apiPath, { requestId, extra: 1 }), new URL(apiPath, ORIGIN))).statusCode).toBe(400);
    expect(w.deps.confirm).not.toHaveBeenCalled();
    const committed = world({ getRequest: vi.fn(async () => ({ status: "COMMITTED" as const, view: {} })) as never });
    expect((await committed.handle(post(apiPath, { requestId }), new URL(apiPath, ORIGIN))).statusCode).toBe(200);
    expect(committed.deps.confirm).not.toHaveBeenCalled();
  });

  it("answers a refusal of someone else's request as the same 404, and a changed one as 409", async () => {
    const hidden = world({ confirm: vi.fn(async () => { throw Object.assign(new Error("x"), { code: "TASK_NOT_FOUND" }); }) });
    expect((await hidden.handle(post(apiPath, { requestId }), new URL(apiPath, ORIGIN))).statusCode).toBe(404);
    const changed = world({ confirm: vi.fn(async () => { throw Object.assign(new Error("x"), { code: "IDEMPOTENCY_CONFLICT" }); }) });
    expect((await changed.handle(post(apiPath, { requestId }), new URL(apiPath, ORIGIN))).statusCode).toBe(409);
  });
});

describe("the confirmation call's body cap", () => {
  it("refuses a body over 1 KB before reading it as JSON, and confirms nothing", async () => {
    const w = world();
    const big = post(apiPath, { requestId, pad: "x".repeat(2000) });
    expect((await w.handle(big, new URL(apiPath, ORIGIN))).statusCode).toBe(400);
    expect(w.deps.confirm).not.toHaveBeenCalled();
    // just under the cap with the one strict field is fine
    expect((await w.handle(post(apiPath, { requestId }), new URL(apiPath, ORIGIN))).statusCode).toBe(200);
  });
});

describe("the person's name on the page (taskPersonStoredName)", () => {
  const personId = randomUUID();
  const developerId = "e".repeat(64);
  const seed = (db: FakeDynamoDb, subjectPersonId = personId) => {
    db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, personId, developerId, name: "Priya Rao" });
    db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${developerId}`, personId: subjectPersonId, developerId });
  };
  const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" }) as never;

  it("reads the name from the immutable PERSON row and its matching PERSON_SUBJECT row, with no People view and no display reads (a Slack-shared task works)", async () => {
    const db = new FakeDynamoDb(); seed(db);
    expect(await taskPersonStoredName(deps(db), taskId, personId)).toBe("Priya Rao");
  });

  it("gives no name for a person with no row, or whose subject row names another person", async () => {
    const db = new FakeDynamoDb(); seed(db, randomUUID());
    expect(await taskPersonStoredName(deps(db), taskId, personId)).toBeUndefined();
    expect(await taskPersonStoredName(deps(new FakeDynamoDb()), taskId, personId)).toBeUndefined();
  });
});
