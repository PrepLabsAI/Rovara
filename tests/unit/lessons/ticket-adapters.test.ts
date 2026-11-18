// The adapters' comment reads (L4-SRC-TK), over a fake of each tracker's API. Each guard has its own test: the issue asked about is the issue answered (and in the workspace asked about), who is a bot or Rovara's own,
// the since filter, the cursor walk and the page arithmetic, a read that is not whole says so, and another company's scope is refused before anything is fetched.
import { describe, expect, it } from "vitest";
import type { HostScope } from "@agentx/contracts";
import { linearCompanyTracker } from "../../../packages/broker/src/aws/linear-app-intake.js";
import { JIRA_MARKER_PROPERTY, jiraTracker } from "../../../packages/broker/src/plugins/tracker/jira/index.js";
import { createLinearApiAccess } from "../../../packages/broker/src/plugins/tracker/linear/api.js";
import { linearTracker } from "../../../packages/broker/src/plugins/tracker/linear/index.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const SCOPE: HostScope = { orgId: ORG };
const KEY = ["lin", "api", "unit", "test", "only"].join("_");
const TOKEN = ["jira", "token", "unit", "test", "only"].join("-");

interface Call { url: string; body: { query?: string; variables?: Record<string, unknown> } | undefined }
function fakeFetch(answer: (call: Call) => { status?: number; body?: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: Call = { url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, body: typeof init?.body === "string" ? JSON.parse(init.body) as Call["body"] : undefined };
    calls.push(call);
    const reply = answer(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  };
  return { fetch: impl, calls };
}

describe("Linear: the comments of an issue", () => {
  const URL_ISSUE = "https://linear.app/acme/issue/ENG-1/refunds";
  const REF = { tracker: "linear", id: "ENG-1", url: URL_ISSUE };
  const node = (id: string, over: Record<string, unknown> = {}) => ({ id, body: "Use the shared helper please", createdAt: "2026-11-17T11:00:00.000Z", updatedAt: "2026-11-17T11:00:00.000Z", user: { id: "u1" }, botActor: null, ...over });
  const answerOf = (nodes: unknown[], over: { identifier?: string; url?: string; next?: boolean; cursor?: string; viewer?: string } = {}) => ({ body: { data: {
    viewer: { id: over.viewer ?? "viewer-1" }, issue: { identifier: over.identifier ?? "ENG-1", url: over.url ?? URL_ISSUE, comments: { pageInfo: { hasNextPage: over.next === true, endCursor: over.cursor ?? null }, nodes } },
  } } });
  const make = (impl: typeof fetch, own = false) => linearTracker(createLinearApiAccess({ apiKey: async () => KEY, companyId: ORG, fetch: impl, sleep: async () => undefined, ...(own ? { ownAccountIsRovara: true } : {}) }));

  it("answers the comments of the issue as neutral item comments, oldest first, each with its author's own account id", async () => {
    const { fetch: impl } = fakeFetch(() => answerOf([node("c2", { createdAt: "2026-11-17T11:30:00.000Z", updatedAt: "2026-11-17T11:30:00.000Z" }), node("c1")]));
    const page = await make(impl).comments!(REF, {}, SCOPE);
    expect(page.comments.map((c) => [c.id, c.author.hostUserId, c.author.isBot, c.subject])).toEqual([
      ["c1", "u1", false, { kind: "item", ref: { tracker: "linear", id: "ENG-1", url: URL_ISSUE } }], ["c2", "u1", false, { kind: "item", ref: { tracker: "linear", id: "ENG-1", url: URL_ISSUE } }],
    ]);
  });
  it("an answer for another issue than the one asked about is no answer", async () => {
    const { fetch: impl } = fakeFetch(() => answerOf([node("c1")], { identifier: "ENG-2" }));
    expect((await make(impl).comments!(REF, {}, SCOPE)).comments).toEqual([]);
  });
  it("an issue of another workspace (the key repeats across workspaces) is no answer when the ticket's own link names its workspace", async () => {
    const { fetch: impl } = fakeFetch(() => answerOf([node("c1")], { url: "https://linear.app/beta/issue/ENG-1/refunds" }));
    expect((await make(impl).comments!(REF, {}, SCOPE)).comments).toEqual([]);
    const same = fakeFetch(() => answerOf([node("c1")]));
    expect((await make(same.fetch).comments!(REF, {}, SCOPE)).comments).toHaveLength(1);
  });
  it("an app actor, a comment with no user (a customer) and, with Rovara's own account as the key, that account are bots; a person is not", async () => {
    const { fetch: impl } = fakeFetch(() => answerOf([node("app", { botActor: { id: "bot-1" } }), node("customer", { user: null }), node("rovara", { user: { id: "viewer-1" } }), node("person", { user: { id: "u9" } })]));
    const own = await make(impl, true).comments!(REF, {}, SCOPE);
    expect(Object.fromEntries(own.comments.map((c) => [c.id, c.author.isBot]))).toEqual({ app: true, customer: true, rovara: true, person: false });
    // On a laptop the key is the owner's own account: its comments are the owner's (Rovara's echo is told apart by its words in the lessons).
    const laptop = await make(impl).comments!(REF, {}, SCOPE);
    expect(Object.fromEntries(laptop.comments.map((c) => [c.id, c.author.isBot]))).toEqual({ app: true, customer: true, rovara: false, person: false });
  });
  it("asks only for comments created after `since`, and tells when there is another page; a page past the first walks the cursors", async () => {
    const first = fakeFetch(() => answerOf([node("c1")], { next: true, cursor: "cur-1" }));
    const page1 = await make(first.fetch).comments!(REF, { since: "2026-11-17T10:00:00.000Z" }, SCOPE);
    expect(first.calls[0]!.body?.variables).toMatchObject({ id: "ENG-1", after: null, filter: { createdAt: { gt: "2026-11-17T10:00:00.000Z" } } });
    expect(page1.nextPage).toBe(2);
    const second = fakeFetch((call) => (call.body?.variables?.["after"] === null ? answerOf([node("c1")], { next: true, cursor: "cur-1" }) : answerOf([node("c2")])));
    const page2 = await make(second.fetch).comments!(REF, { page: 2 }, SCOPE);
    expect(second.calls.map((c) => c.body?.variables?.["after"])).toEqual([null, "cur-1"]);
    expect(page2.comments.map((c) => c.id)).toEqual(["c2"]);
    expect(page2.nextPage).toBeUndefined();
  });
  it("reading page after page costs one request per page (the cursor that ends a page is remembered), and a page asked for cold still walks from the start", async () => {
    const pages = fakeFetch((call) => {
      const after = call.body?.variables?.["after"];
      return after === null ? answerOf([node("p1")], { next: true, cursor: "cur-1" }) : after === "cur-1" ? answerOf([node("p2")], { next: true, cursor: "cur-2" }) : answerOf([node("p3")]);
    });
    const tracker = make(pages.fetch);
    expect((await tracker.comments!(REF, { page: 1 }, SCOPE)).comments.map((c) => c.id)).toEqual(["p1"]);
    expect((await tracker.comments!(REF, { page: 2 }, SCOPE)).comments.map((c) => c.id)).toEqual(["p2"]);
    expect((await tracker.comments!(REF, { page: 3 }, SCOPE)).comments.map((c) => c.id)).toEqual(["p3"]);
    expect(pages.calls.map((c) => c.body?.variables?.["after"])).toEqual([null, "cur-1", "cur-2"]);
    const cold = fakeFetch((call) => (call.body?.variables?.["after"] === null ? answerOf([node("p1")], { next: true, cursor: "cur-1" }) : answerOf([node("p2")])));
    expect((await make(cold.fetch).comments!(REF, { page: 2 }, SCOPE)).comments.map((c) => c.id)).toEqual(["p2"]);
    expect(cold.calls.map((c) => c.body?.variables?.["after"])).toEqual([null, "cur-1"]);
    // Another read of the same ticket (another `since`) does not take this one's cursor.
    const other = fakeFetch(() => answerOf([node("q1")], { next: true, cursor: "cq" }));
    const second = make(other.fetch);
    await second.comments!(REF, { since: "2026-11-17T10:00:00.000Z", page: 1 }, SCOPE);
    await second.comments!(REF, { since: "2026-11-17T11:00:00.000Z", page: 2 }, SCOPE).catch(() => undefined);
    expect(other.calls[1]!.body?.variables?.["after"]).toBeNull();
  });
  it("a comment with no id or no time is left out; an issue that is not found has no comments; a refusal is a refusal", async () => {
    const odd = fakeFetch(() => answerOf([node("ok"), { body: "no id", createdAt: "2026-11-17T11:00:00.000Z" }, node("notime", { createdAt: null, updatedAt: null })]));
    expect((await make(odd.fetch).comments!(REF, {}, SCOPE)).comments.map((c) => c.id)).toEqual(["ok"]);
    const missing = fakeFetch(() => ({ body: { errors: [{ extensions: { code: "NOT_FOUND" }, message: "Entity not found" }] } }));
    expect((await make(missing.fetch).comments!(REF, {}, SCOPE)).comments).toEqual([]);
    const refused = fakeFetch(() => ({ status: 403 }));
    await expect(make(refused.fetch).comments!(REF, {}, SCOPE)).rejects.toMatchObject({ reason: "needs_write_access" });
  });
  it("the company's own tracker refuses another company's scope before anything is fetched", async () => {
    const { fetch: impl, calls } = fakeFetch(() => answerOf([node("c1")]));
    const tracker = linearCompanyTracker({ connections: { accessToken: async () => "tok" }, companyId: ORG, fetch: impl });
    expect((await tracker.comments!(REF, {}, SCOPE)).comments).toHaveLength(1);
    const before = calls.length;
    await expect(tracker.comments!(REF, {}, { orgId: OTHER })).rejects.toBeDefined();
    expect(calls.length).toBe(before);
  });
});

describe("Jira: the comments of an issue", () => {
  const SITE = "https://acme.atlassian.net";
  const REF = { tracker: "jira", id: "PAY-12", url: `${SITE}/browse/PAY-12` };
  const make = (impl: typeof fetch) => jiraTracker({ site: SITE, email: "owner@example.test", apiToken: async () => TOKEN, fetch: impl });
  const text = (value: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
  const cmt = (id: string, over: Record<string, unknown> = {}) => ({ id, author: { accountId: "acct-1", accountType: "atlassian", displayName: "Ann" }, body: text("Use the shared helper please"), created: "2026-11-17T11:00:00.000+0000", updated: "2026-11-17T11:00:00.000+0000", properties: [], ...over });
  const answer = (comments: unknown[], total = comments.length) => ({ body: { comments, total } });

  it("answers the comments as neutral item comments with the author's account id and the issue's own link", async () => {
    const { fetch: impl, calls } = fakeFetch(() => answer([cmt("10001")]));
    const page = await make(impl).comments!(REF, {}, SCOPE);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]).toMatchObject({ id: "10001", body: "Use the shared helper please\n", author: { hostUserId: "acct-1", isBot: false }, subject: { kind: "item", ref: { tracker: "jira", id: "PAY-12", url: `${SITE}/browse/PAY-12` } }, createdAt: "2026-11-17T11:00:00.000Z" });
    expect(calls[0]!.url).toContain("/rest/api/3/issue/PAY-12/comment?");
    expect(calls[0]!.url).toContain("startAt=0");
  });
  it("Rovara's own marker, an app or a service-desk customer, and no account at all are bots; an atlassian person is not", async () => {
    const { fetch: impl } = fakeFetch(() => answer([
      cmt("1", { properties: [{ key: JIRA_MARKER_PROPERTY, value: { id: "m" } }] }), cmt("2", { author: { accountId: "a2", accountType: "app" } }), cmt("3", { author: { accountId: "a3", accountType: "customer" } }),
      cmt("4", { author: { displayName: "Nobody" } }), cmt("5"),
    ]));
    const page = await make(impl).comments!(REF, {}, SCOPE);
    expect(Object.fromEntries(page.comments.map((c) => [c.id, c.author.isBot]))).toEqual({ "1": true, "2": true, "3": true, "4": true, "5": false });
  });
  it("a comment only some can read (a role or group visibility, a service desk's internal note) is left out; a public one and a null visibility stay", async () => {
    const { fetch: impl } = fakeFetch(() => answer([
      cmt("1", { visibility: { type: "role", value: "Administrators" } }), cmt("2", { visibility: { type: "group", value: "staff" } }), cmt("3", { jsdPublic: false }), cmt("4", { jsdPublic: true }), cmt("5", { visibility: null }), cmt("6"),
    ]));
    expect((await make(impl).comments!(REF, {}, SCOPE)).comments.map((c) => c.id)).toEqual(["4", "5", "6"]);
  });
  it("an atlassian account with no account id is a bot (nobody can be named)", async () => {
    const { fetch: impl } = fakeFetch(() => answer([cmt("1", { author: { accountType: "atlassian", displayName: "Ghost" } })]));
    expect((await make(impl).comments!(REF, {}, SCOPE)).comments.map((c) => c.author.isBot)).toEqual([true]);
  });
  it("leaves out comments created at or before `since`, and ones whose times or id cannot be read", async () => {
    const { fetch: impl } = fakeFetch(() => answer([cmt("1", { created: "2026-11-17T09:00:00.000+0000", updated: "2026-11-17T09:00:00.000+0000" }), cmt("2"), cmt("x-3"), cmt("4", { created: "soon" })]));
    const page = await make(impl).comments!(REF, { since: "2026-11-17T10:00:00.000Z" }, SCOPE);
    expect(page.comments.map((c) => c.id)).toEqual(["2"]);
  });
  it("page arithmetic: the second page starts at 100, and a next page is offered whenever there are more, even past the fifth (a read that is not whole says so)", async () => {
    const { fetch: impl, calls } = fakeFetch(() => answer([cmt("1")], 650));
    const second = await make(impl).comments!(REF, { page: 2 }, SCOPE);
    expect(calls[0]!.url).toContain("startAt=100");
    expect(second.nextPage).toBe(3);
    expect((await make(impl).comments!(REF, { page: 5 }, SCOPE)).nextPage).toBe(6);
    expect((await make(fakeFetch(() => answer([cmt("1")], 100)).fetch).comments!(REF, {}, SCOPE)).nextPage).toBeUndefined();
  });
  it("an issue that is not found has no comments; a refusal is a refusal; a fault that may pass is thrown", async () => {
    expect((await make(fakeFetch(() => ({ status: 404 })).fetch).comments!(REF, {}, SCOPE)).comments).toEqual([]);
    await expect(make(fakeFetch(() => ({ status: 403 })).fetch).comments!(REF, {}, SCOPE)).rejects.toMatchObject({ reason: "needs_write_access" });
    await expect(make(fakeFetch(() => ({ status: 500 })).fetch).comments!(REF, {}, SCOPE)).rejects.toBeDefined();
  });
});
