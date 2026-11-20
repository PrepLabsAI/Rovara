// Lead 4 PCF on the task page the broker serves: the plan's feature line for a reader, "Change" and "No feature" for the owner who decides, what the page's API takes, and the page script's two presses.
// The deciding rule is the page's own (`pageAccess().canDecide`): a reader who may only read or comment sees the line and no control, and a press from them is refused by the same words as a decision.
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DynamoDocumentStore } from "@rovara/aws-adapters";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { DocumentAuditSink } from "@agentx/local-adapters";
import { getTaskDocumentView, pageFeatureChoices, setPageFeature } from "../../packages/broker/src/aws/developer-tasks.js";
import { createFeatureStore } from "../../packages/broker/src/core/report/feature-store.js";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { TASK_PAGE_API, createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import { TASK_PAGE_DECIDING_SCRIPT } from "../../packages/broker/src/aws/task-page-assets.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { OMAR, PRIYA, SAM, pagePlan, pageTask } from "../support/page-tasks.js";
import { fakeStorage, makeEvent, parseHtml, type FakeDocument, type FakeElement } from "../support/fake-dom.js";
import { planDocument } from "../support/plan-documents.js";

// The fixture's fake table cannot serve the document store's own queries, so the task page's feature store is an in-memory document store of the same shape (one per task, like one company's table).
const holder = vi.hoisted((): { store?: object } => ({}));
vi.mock("@rovara/aws-adapters", async () => ({ ...(await vi.importActual<Record<string, unknown>>("@rovara/aws-adapters")), DynamoDocumentStore: function () { return holder.store; } }));

const SYSTEM = { type: "system", id: "test" } as const;
const FT_ONE = `ft_${"1".repeat(20)}`, FT_TWO = `ft_${"2".repeat(20)}`;
const taskId = "11111111-1111-4111-8111-111111111111";
const DIGEST = "f".repeat(64);
const SESSION = "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111";
const caller = { developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" } as const;
const owner = { role: "owner" as const, canComment: true, canSuggest: false, canDecide: true, canAsk: true };
const reader = { role: "commenter" as const, canComment: true, canSuggest: true, canDecide: false, canAsk: true };
const LINE = "Feature: Checkout v2 (from the Linear parent)";

// ---- the real broker functions over the page-task fixture

describe("the task page's feature, from the broker (an owner, a channel reader and a stranger)", () => {
  function waiting() {
    holder.store = new MemoryDocumentStore();
    const t = pageTask();
    t.addVersion("plan", pagePlan());
    return { t };
  }
  const featuresOf = (t: ReturnType<typeof pageTask>) => {
    const store = new DynamoDocumentStore({ client: t.deps.documentClient, tableName: t.deps.tableName });
    return createFeatureStore({ store, companyId: IMPLICIT_COMPANY_ID, audit: new DocumentAuditSink({ store: () => store }), now: () => t.deps.now() });
  };

  it("shows the owner the line with a way to change it, and a channel reader the line alone", async () => {
    const { t } = waiting();
    const features = featuresOf(t);
    const parent = await features.create({ name: "Checkout v2", trackerLink: { tracker: "linear", id: "PRJ-1", url: "https://linear.app/x/project/1" } }, SYSTEM);
    await features.setTaskFeature({ taskId: t.taskId, project: "payments", featureId: parent.id, source: "tracker" }, SYSTEM);
    const mine = await getTaskDocumentView(t.deps, PRIYA, t.taskId);
    expect(mine.planFeature).toMatchObject({ line: LINE, feature: { id: parent.id, source: "tracker" }, canChange: true, canCreate: false });
    const theirs = await getTaskDocumentView(t.deps, SAM, t.taskId);
    expect(theirs.access!.canDecide).toBe(false);
    expect(theirs.planFeature).toMatchObject({ line: LINE, canChange: false, canCreate: false });
    await expect(getTaskDocumentView(t.deps, OMAR, t.taskId)).rejects.toThrow(/TASK_ACCESS_DENIED|FORBIDDEN|TASK_NOT_FOUND|NOT_FOUND/u);
  });

  it("lists the open features to the owner only; a reader is refused as a decision is, a stranger as a missing task", async () => {
    const { t } = waiting();
    const features = featuresOf(t);
    await features.create({ name: "Zulu" }, SYSTEM);
    await features.create({ name: "Alpha" }, SYSTEM);
    const done = await features.create({ name: "Done" }, SYSTEM);
    await features.setState(done.id, "done", SYSTEM);
    expect((await pageFeatureChoices(t.deps, PRIYA, t.taskId)).features.map((item) => item.name)).toEqual(["Alpha", "Zulu"]);
    await expect(pageFeatureChoices(t.deps, SAM, t.taskId)).rejects.toMatchObject({ pageReason: "owners_only" });
    await expect(pageFeatureChoices(t.deps, OMAR, t.taskId)).rejects.toBeDefined();
  });

  it("Change files `chosen` for the owner and answers the new line; a second change by the starter is refused in plain words; a reader changes nothing", async () => {
    const { t } = waiting();
    const features = featuresOf(t);
    const one = await features.create({ name: "One" }, SYSTEM);
    const two = await features.create({ name: "Two" }, SYSTEM);
    await expect(setPageFeature(t.deps, SAM, t.taskId, { feature: one.id })).rejects.toMatchObject({ pageReason: "owners_only" });
    expect(await features.taskFeature(t.taskId)).toBeUndefined();
    expect(await setPageFeature(t.deps, PRIYA, t.taskId, { feature: one.id })).toEqual({ line: "Feature: One (chosen)", featureId: one.id });
    expect(await features.taskFeature(t.taskId)).toMatchObject({ featureId: one.id, source: "chosen" });
    await expect(setPageFeature(t.deps, PRIYA, t.taskId, { feature: two.id })).rejects.toMatchObject({ pageReason: "not_allowed" });
    expect(await features.taskFeature(t.taskId)).toMatchObject({ featureId: one.id });
    // the page then shows the line with no way to change it again
    expect((await getTaskDocumentView(t.deps, PRIYA, t.taskId)).planFeature).toMatchObject({ line: "Feature: One (chosen)", canChange: false });
  });

  it("No feature replaces a tracker suggestion with an explicit none; an unknown or done feature is refused and writes nothing", async () => {
    const { t } = waiting();
    const features = featuresOf(t);
    const one = await features.create({ name: "One" }, SYSTEM);
    await features.setTaskFeature({ taskId: t.taskId, project: "payments", featureId: one.id, source: "tracker" }, SYSTEM);
    expect(await setPageFeature(t.deps, PRIYA, t.taskId, { feature: null })).toEqual({ line: "Feature: No feature" });
    expect(await features.taskFeature(t.taskId)).toMatchObject({ featureId: null, source: "chosen" });
    const t2 = waiting();
    const f2 = featuresOf(t2.t);
    const gone = await f2.create({ name: "Gone" }, SYSTEM);
    await f2.setState(gone.id, "done", SYSTEM);
    await expect(setPageFeature(t2.t.deps, PRIYA, t2.t.taskId, { feature: gone.id })).rejects.toBeDefined();
    await expect(setPageFeature(t2.t.deps, PRIYA, t2.t.taskId, { feature: FT_TWO })).rejects.toBeDefined();
    expect(await f2.taskFeature(t2.t.taskId)).toBeUndefined();
  });

  it("reads the page's feature in the deployment's own company: another company's filing for this task id never shows", async () => {
    const { t } = waiting();
    const COMPANY = `org_${"p".repeat(19)}a`, OTHER = `org_${"p".repeat(19)}b`;
    const store = new DynamoDocumentStore({ client: t.deps.documentClient, tableName: t.deps.tableName });
    const inCompany = (companyId: string) => createFeatureStore({ store, companyId, audit: new DocumentAuditSink({ store: () => store }), now: () => t.deps.now() });
    const mine = await inCompany(COMPANY).create({ name: "Mine" }, SYSTEM);
    const theirs = await inCompany(OTHER).create({ name: "Other company canary" }, SYSTEM);
    await inCompany(OTHER).setTaskFeature({ taskId: t.taskId, project: "payments", featureId: theirs.id, source: "chosen" }, SYSTEM);
    const deps = { ...t.deps, companyId: COMPANY };
    const view = await getTaskDocumentView(deps, PRIYA, t.taskId);
    expect(view.planFeature).toMatchObject({ line: "Feature: No feature", feature: null });
    expect(JSON.stringify(view.planFeature)).not.toContain("canary");
    expect((await pageFeatureChoices(deps, PRIYA, t.taskId)).features.map((item) => item.name)).toEqual(["Mine"]);
    await expect(setPageFeature(deps, PRIYA, t.taskId, { feature: theirs.id })).rejects.toBeDefined();
    expect(await inCompany(COMPANY).taskFeature(t.taskId)).toBeUndefined();
    expect(await setPageFeature(deps, PRIYA, t.taskId, { feature: mine.id })).toEqual({ line: "Feature: Mine (chosen)", featureId: mine.id });
  });

});

// ---- the page the server draws

const doc = (version: number): TaskDocumentView["documents"][number] => ({ kind: "coding plan", version, approved: false, current: true, format: "structured", plan: planDocument({ title: "Retry payments" }) });
async function pageHtml(options: { access?: typeof owner | typeof reader; planFeature?: TaskDocumentView["planFeature"]; waitingKind?: "coding plan" | "design"; waiting?: boolean } = {}): Promise<string> {
  const view: TaskDocumentView = {
    taskId, title: "Retry payments", status: "Waiting for your approval", nextStep: "Approve or request changes.", path: "QUICK", stage: "Coding plan", role: "owner",
    documents: [doc(1)], checks: [], findings: [], pullRequests: [], history: [], revision: 7, commentSeq: 3, access: options.access ?? owner, pageComments: [], pageSuggestions: [],
    ...(options.waiting === false ? {} : { waiting: { kind: options.waitingKind ?? "coding plan", version: 1, artifactDigest: DIGEST } }),
    optionalChecks: [],
    ...(options.planFeature === undefined ? {} : { planFeature: options.planFeature }),
  };
  const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => view });
  const answer = await web({ method: "GET", path: `/review/${taskId}/task`, headers: { cookie: SESSION }, requestId: "r" }, new URL(`https://agentx.example.test/review/${taskId}/task`));
  expect(answer.statusCode).toBe(200);
  return answer.body;
}
const withFeature = (over: Partial<NonNullable<TaskDocumentView["planFeature"]>> = {}): NonNullable<TaskDocumentView["planFeature"]> => ({ line: LINE, feature: { id: FT_ONE, name: "Checkout v2", source: "tracker" }, canChange: true, canCreate: false, ...over });

describe("the task page's feature line", () => {

  it("a reader sees the line and no control and the script is not told a press is allowed; an owner whose card says canChange false sees none either", async () => {
    for (const html of [await pageHtml({ access: reader, planFeature: withFeature() }), await pageHtml({ planFeature: withFeature({ canChange: false }) })]) {
      expect(html).toContain(LINE);
      expect(html).not.toContain('id="decide-feature-change"');
      expect(html).not.toContain('id="decide-feature-select"');
      expect(html).not.toContain('"canFeature"');
    }
  });

  it("is on a waiting coding plan only, and says nothing when the broker gave no line", async () => {
    expect(await pageHtml({ planFeature: withFeature(), waiting: false })).not.toContain('id="plan-feature"');
    expect(await pageHtml({ planFeature: withFeature(), waitingKind: "design" })).not.toContain('id="plan-feature"');
    expect(await pageHtml()).not.toContain('id="plan-feature"');
  });

});

// ---- the page's API

const ORIGIN = "https://agentx.example.test";
const CSRF = "c".repeat(43);
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const who: DeveloperCaller = { developerId: "d".repeat(64), sessionId: SESSION_ID, amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
const cookies = `__Host-agentx_review_session=${SESSION_ID}; __Host-agentx_review_csrf=${CSRF}`;
const api = (suffix: string) => `/review/${taskId}/task/api/${suffix}`;
const req = (method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}): AdaptedHttpRequest => ({
  method, path, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  headers: { cookie: cookies, ...(method === "POST" ? { origin: ORIGIN, "x-agentx-csrf": CSRF, "content-type": "application/json" } : {}), ...headers },
});
function deps(overrides: Partial<TaskWebApiDependencies> = {}, bare = false) {
  const calls: Array<{ name: string; input?: unknown }> = [];
  const base: TaskWebApiDependencies = {
    origin: ORIGIN, authenticateSession: async (id) => (id === SESSION_ID ? who : undefined),
    taskState: async () => ({ revision: 4, waiting: true, stage: "Coding plan", documents: [], commentSeq: 0, canRead: true, canComment: true, canSuggest: true, canDecide: true, canAsk: true, canManagePeople: false, canTakeOwnership: false }),
    listComments: async () => ({ comments: [] }), createComment: async () => ({ ok: true }) as never, editComment: async () => ({ ok: true }) as never, deleteComment: async () => ({ ok: true }) as never,
    setSuggestion: async () => ({}), decide: async () => ({ revision: 5 }),
    featureChoices: async () => { calls.push({ name: "choices" }); return { features: [{ id: FT_ONE, name: "One" }] }; },
    setFeature: async (_who, _id, input) => { calls.push({ name: "set", input }); return { line: "Feature: One (chosen)", featureId: FT_ONE }; },
    ...overrides,
  };
  if (bare) { delete base.featureChoices; delete base.setFeature; }
  return { value: base, calls };
}
const run = async (d: TaskWebApiDependencies, request: AdaptedHttpRequest) => {
  const response = await createTaskWebApi(d)(request, new URL(`${ORIGIN}${request.path}`));
  return { ...response, json: JSON.parse(response.body) as Record<string, unknown> };
};

describe("the task page's feature API", () => {
  it("are paths of the page's API, GET to read the choices and POST to change", async () => {
    expect(TASK_PAGE_API.test(api("feature"))).toBe(true);
    expect(TASK_PAGE_API.test(api("feature-choices"))).toBe(true);
    const d = deps();
    expect((await run(d.value, req("GET", api("feature-choices")))).statusCode).toBe(200);
    expect((await run(d.value, req("POST", api("feature-choices"), {}))).statusCode).toBe(405);
    expect((await run(d.value, req("GET", api("feature")))).statusCode).toBe(405);
  });

  it("changes with the strict body only, through the page's origin and CSRF checks, with the session's caller", async () => {
    const d = deps();
    const good = await run(d.value, req("POST", api("feature"), { feature: FT_ONE }));
    expect(good.statusCode).toBe(200);
    expect(good.json).toEqual({ line: "Feature: One (chosen)", featureId: FT_ONE });
    expect((await run(d.value, req("POST", api("feature"), { feature: null }))).statusCode).toBe(200);
    expect(d.calls.filter((call) => call.name === "set").map((call) => call.input)).toEqual([{ feature: FT_ONE }, { feature: null }]);
    const before = d.calls.length;
    for (const bad of [{}, { feature: "x" }, { feature: FT_ONE, extra: 1 }, { feature: FT_ONE.toUpperCase() }, { feature: 5 }, "{not json"]) expect((await run(d.value, req("POST", api("feature"), bad))).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await run(d.value, req("POST", api("feature"), { feature: FT_ONE }, { origin: "https://evil.example" }))).statusCode).toBe(403);
    expect((await run(d.value, req("POST", api("feature"), { feature: FT_ONE }, { "x-agentx-csrf": undefined }))).statusCode).toBe(403);
    expect(d.calls.length).toBe(before);
  });

  it("a person who may not decide is told so as a decision says it; without the dependencies the paths are not found; a signed-out caller is 401", async () => {
    const owners = deps({ setFeature: async () => { throw Object.assign(new Error("FORBIDDEN: Only owners decide."), { code: "FORBIDDEN", pageReason: "owners_only" }); }, featureChoices: async () => { throw Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN", pageReason: "owners_only" }); } });
    expect((await run(owners.value, req("POST", api("feature"), { feature: FT_ONE }))).json).toMatchObject({ error: "owners_only" });
    expect((await run(owners.value, req("GET", api("feature-choices")))).statusCode).toBe(403);
    const bare = deps({}, true);
    expect((await run(bare.value, req("GET", api("feature-choices")))).statusCode).toBe(404);
    expect((await run(bare.value, req("POST", api("feature"), { feature: FT_ONE }))).statusCode).toBe(404);
    expect((await run(deps().value, req("GET", api("feature-choices"), undefined, { cookie: "" }))).statusCode).toBe(401);
    const plain = deps({ setFeature: async () => { throw Object.assign(new Error("FORBIDDEN: Only a maintainer."), { code: "FORBIDDEN", pageReason: "not_allowed" }); } });
    const refused = await run(plain.value, req("POST", api("feature"), { feature: FT_ONE }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json).toMatchObject({ error: "not_allowed", message: "Only a maintainer." });
  });
});

// ---- the script

interface Sent { url: string; method: string; body?: Record<string, unknown> }
/** Boots the page's scripts over the parsed page; `respond` answers each request. */
function boot(html: string, respond: (sent: Sent) => { status: number; body: unknown }) {
  const document: FakeDocument = parseHtml(html);
  const sent: Sent[] = [];
  const sandbox: Record<string, unknown> = {
    document, console, setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined, URL, Date, JSON, Promise, Number, String, Array, Object, Math, Error, RegExp, Boolean,
    sessionStorage: fakeStorage(), localStorage: fakeStorage(), crypto: { randomUUID: () => randomUUID() },
    location: { reload: () => undefined, assign: () => undefined, href: `https://agentx.example.test/review/${taskId}/task` },
    navigator: { sendBeacon: () => true }, addEventListener: () => undefined, removeEventListener: () => undefined, AbortController,
    fetch: async (url: string, init: { method: string; body?: string }) => {
      const entry: Sent = { url, method: init.method, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as Record<string, unknown> }) };
      sent.push(entry);
      const reply = respond(entry);
      return { status: reply.status, json: async () => reply.body };
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(TASK_PAGE_DECIDING_SCRIPT, sandbox);
  const byId = (id: string): FakeElement => document.getElementById(id) as FakeElement;
  const settle = async () => { for (let n = 0; n < 8; n += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { document, sent, byId, settle };
}
const click = (element: FakeElement) => element.dispatchEvent(makeEvent("click", element));

describe("the task page script's feature presses", () => {

  it("a task with no feature has no No feature button; a refusal is said in the page's words and leaves the page alive", async () => {
    const none = boot(await pageHtml({ planFeature: withFeature({ feature: null, line: "Feature: No feature" }) }), () => ({ status: 200, body: {} }));
    expect(none.byId("decide-feature-none").hidden).toBe(true);
    const page = boot(await pageHtml({ planFeature: withFeature() }), (sent) => (sent.method === "POST" ? { status: 403, body: { error: "not_allowed", message: "Only a maintainer can move it." } } : { status: 200, body: { revision: 7 } }));
    click(page.byId("decide-feature-none"));
    await page.settle();
    expect(page.byId("plan-feature-error").hidden).toBe(false);
    expect(page.byId("plan-feature-error").textContent).toBe("Only a maintainer can move it.");
    expect(page.byId("plan-feature-line").textContent).toBe(LINE);
  });

});
