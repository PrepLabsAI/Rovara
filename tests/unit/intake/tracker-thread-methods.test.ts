// The Tracker port's thread methods (design B9, owner decision 254z d): `comment` answers the comment's id and takes a parent, and `updateComment` rewrites a comment Rovara wrote, in place. Linear and Jira
// carry them over a fake of each tracker's API. What is held: an id that is not a comment on THIS issue is refused and nothing is written; the key goes only to the tracker's own address; no error carries the key
// or the text; a refusal is a `TrackerWriteRefusedError`, a rate limit or fault that may pass is thrown.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HostScope } from "@agentx/contracts";
import { createLinearApiAccess, linearCommentIdFor } from "../../../packages/broker/src/plugins/tracker/linear/api.js";
import { linearTracker } from "../../../packages/broker/src/plugins/tracker/linear/index.js";
import { JIRA_MARKER_PROPERTY, jiraTracker } from "../../../packages/broker/src/plugins/tracker/jira/index.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const SCOPE: HostScope = { orgId: ORG };
const KEY = ["lin", "api", "unit", "test", "only"].join("_");
const TOKEN = ["jira", "token", "unit", "test", "only"].join("-");

interface Call { url: string; method: string; body: { query?: string; variables?: Record<string, unknown> } & Record<string, unknown> | undefined }
function fakeFetch(answer: (call: Call) => { status?: number; body?: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: Call = { url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) as Call["body"] : undefined };
    calls.push(call);
    const reply = answer(call);
    const status = reply.status ?? 200;
    return new Response(status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body), { status });
  };
  return { fetch: impl, calls };
}

describe("Linear: a reply in a thread, an edit in place", () => {
  const ISSUE = { id: "iss-1", identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/refunds", state: { name: "Todo" }, team: { states: { nodes: [] } } };
  const REF = { tracker: "linear", id: "ENG-1", url: ISSUE.url };
  const ROOT = linearCommentIdFor(ORG, "root");
  const tracker = (impl: typeof fetch) => linearTracker(createLinearApiAccess({ apiKey: async () => KEY, companyId: ORG, fetch: impl, sleep: async () => undefined }));
  const queryOf = (call: Call): string => call.body?.query ?? "";
  // Linear answers the comment that was asked for: the fake echoes the id it was given.
  const commentRead = (issue: string, parent?: string) => (call: Call) => ({ body: { data: { comment: { id: String(call.body?.variables?.["id"]), issue: { identifier: issue }, ...(parent === undefined ? {} : { parent: { id: parent } }) } } } });

  it("offers both methods only when the install can edit, and answers the new comment's id", async () => {
    const { fetch: impl } = fakeFetch(() => ({ body: { data: { issue: ISSUE, commentCreate: { success: true } } } }));
    const linear = tracker(impl);
    expect(typeof linear.updateComment).toBe("function");
    expect(linear.capabilities.internalComments).toBeUndefined();
    await expect(linear.comment!(REF, "root", SCOPE, { key: "root" })).resolves.toEqual({ commentId: ROOT });
    // An access with no `edit` (the hosted product's older reply port) has no `updateComment`: the tickets stay on one-shot comments.
    expect(linearTracker({ reply: { reply: async () => ({ commentId: ROOT }) } })).not.toHaveProperty("updateComment");
    expect(linearTracker({ reply: { reply: async () => undefined } })).not.toHaveProperty("updateComment");
  });

  it("writes a reply under a comment that is on this very issue and is itself the root, with the id made from its key", async () => {
    const { fetch: impl, calls } = fakeFetch((call) => (queryOf(call).includes("comment(id") ? commentRead("ENG-1")(call) : { body: { data: { issue: ISSUE, commentCreate: { success: true } } } }));
    const answer = await tracker(impl).comment!(REF, "a reply", SCOPE, { key: "reply-1", parentId: ROOT });
    expect(answer).toEqual({ commentId: linearCommentIdFor(ORG, "reply-1") });
    const create = calls.find((call) => queryOf(call).includes("commentCreate"))!;
    expect(create.body?.variables).toMatchObject({ input: { id: linearCommentIdFor(ORG, "reply-1"), issueId: "iss-1", body: "a reply", parentId: ROOT } });
  });

  it("refuses a parent that is on another issue, that is itself a reply, or that is not a comment id, and writes nothing", async () => {
    for (const [read, parent] of [[commentRead("ENG-2"), ROOT], [commentRead("ENG-1", "some-root"), ROOT], [{ body: { data: { comment: null } } }, ROOT], [commentRead("ENG-1"), "not a uuid"]] as const) {
      const { fetch: impl, calls } = fakeFetch((call) => (queryOf(call).includes("comment(id") ? (typeof read === "function" ? read(call) : read) : { body: { data: { issue: ISSUE, commentCreate: { success: true } } } }));
      await expect(tracker(impl).comment!(REF, "a reply", SCOPE, { key: "reply-1", parentId: parent })).rejects.toBeDefined();
      expect(calls.some((call) => queryOf(call).includes("commentCreate"))).toBe(false);
    }
  });

  it("rewrites a comment on this issue in place, and only that", async () => {
    const { fetch: impl, calls } = fakeFetch((call) => (queryOf(call).includes("comment(id") ? commentRead("ENG-1")(call) : queryOf(call).includes("commentUpdate") ? { body: { data: { commentUpdate: { success: true } } } } : { body: { data: { issue: ISSUE } } }));
    await tracker(impl).updateComment!(REF, ROOT, "new words", SCOPE);
    const update = calls.find((call) => queryOf(call).includes("commentUpdate"))!;
    expect(update.body?.variables).toEqual({ id: ROOT, input: { body: "new words" } });
    expect(calls.every((call) => call.url === "https://api.linear.app/graphql")).toBe(true);
  });

  it("refuses to rewrite a comment on another issue, in another workspace, or that does not exist, and writes nothing", async () => {
    for (const [read, issue] of [[commentRead("ENG-2"), ISSUE], [{ body: { data: { comment: null } } }, ISSUE], [commentRead("ENG-1"), { ...ISSUE, url: "https://linear.app/other/issue/ENG-1/x" }]] as const) {
      const { fetch: impl, calls } = fakeFetch((call) => (queryOf(call).includes("comment(id") ? (typeof read === "function" ? read(call) : read) : { body: { data: { issue } } }));
      await expect(tracker(impl).updateComment!(REF, ROOT, "new words", SCOPE)).rejects.toMatchObject({ name: "TrackerWriteRefusedError", reason: "not_found" });
      expect(calls.some((call) => queryOf(call).includes("commentUpdate"))).toBe(false);
    }
    await expect(tracker(fakeFetch(() => ({ body: {} })).fetch).updateComment!(REF, "../etc", "x", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(tracker(fakeFetch(() => ({ body: {} })).fetch).updateComment!(REF, ROOT, "", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("says a refused edit in fixed words, and a rate limit as a fault that may pass, never with the key or the text", async () => {
    const forbidden = fakeFetch((call) => (queryOf(call).includes("comment(id") ? commentRead("ENG-1")(call) : queryOf(call).includes("commentUpdate") ? { body: { errors: [{ message: "x", extensions: { code: "FORBIDDEN" } }] } } : { body: { data: { issue: ISSUE } } }));
    await expect(tracker(forbidden.fetch).updateComment!(REF, ROOT, "secret words", SCOPE)).rejects.toMatchObject({ name: "TrackerWriteRefusedError", reason: "needs_write_access" });
    const limited = await tracker(fakeFetch(() => ({ status: 429 })).fetch).updateComment!(REF, ROOT, "secret words", SCOPE).then(() => undefined, (error: Error) => error);
    expect(limited).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(String(limited?.message)).not.toContain(KEY);
    expect(String(limited?.message)).not.toContain("secret words");
  });
});

describe("Jira: the comment's id, and an edit in place", () => {
  const SITE = "https://acme.atlassian.net";
  const make = (impl: typeof fetch) => jiraTracker({ site: SITE, email: "owner@example.test", apiToken: async () => TOKEN, fetch: impl });
  const REF = { tracker: "jira", id: "PAY-12", url: `${SITE}/browse/PAY-12` };
  const mine = (id: string, extra: Record<string, unknown> = {}) => ({ id, author: { accountId: "acct-me" }, properties: [{ key: JIRA_MARKER_PROPERTY, value: { id: "m" } }], ...extra });

  it("answers the new comment's id (and the earlier one's, when the same key was already posted)", async () => {
    const posted = fakeFetch((call) => (call.method === "POST" ? { status: 201, body: { id: "10501" } } : call.url.includes("/myself") ? { body: { accountId: "acct-me" } } : { body: { comments: [] } }));
    const jira = make(posted.fetch);
    // A plain Jira Software project ignores the internal property, so Jira does not claim internal comments: a task only its owner can see stays at status only there.
    expect(jira.capabilities.internalComments).toBeUndefined();
    await expect(jira.comment!(REF, "root", SCOPE, { key: "root", requirePrivate: true })).resolves.toEqual({ commentId: "10501" });
    const again = fakeFetch((call) => (call.url.includes("/myself") ? { body: { accountId: "acct-me" } } : { body: { comments: [mine("10501", { properties: [{ key: JIRA_MARKER_PROPERTY, value: { id: createHash("sha256").update("root").digest("hex").slice(0, 32) } }] })] } }));
    await expect(make(again.fetch).comment!(REF, "root", SCOPE, { key: "root" })).resolves.toEqual({ commentId: "10501" });
    expect(again.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("writes a reply as an ordinary comment (Jira has no threads) and never sends the parent id to Jira", async () => {
    const { fetch: impl, calls } = fakeFetch((call) => (call.method === "POST" ? { status: 201, body: { id: "10502" } } : call.url.includes("/myself") ? { body: { accountId: "acct-me" } } : { body: { comments: [] } }));
    await expect(make(impl).comment!(REF, "a reply", SCOPE, { key: "reply-1", parentId: "10501" })).resolves.toEqual({ commentId: "10502" });
    expect(JSON.stringify(calls.find((call) => call.method === "POST")!.body)).not.toContain("10501");
  });

  it("rewrites a comment this account wrote as a Rovara update, on this issue, and nothing else", async () => {
    const ok = fakeFetch((call) => (call.method === "PUT" ? { status: 204 } : call.url.includes("/myself") ? { body: { accountId: "acct-me" } } : { body: mine("10501") }));
    await make(ok.fetch).updateComment!(REF, "10501", "new\nwords", SCOPE);
    const put = ok.calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe(`${SITE}/rest/api/3/issue/PAY-12/comment/10501`);
    expect(JSON.stringify(put.body)).toContain("new");
    // Someone else's comment, one without Rovara's marker, one that is another comment than the id asked, and a missing one: each is refused and nothing is written.
    for (const found of [{ status: 200, body: mine("10501", { author: { accountId: "acct-other" } }) }, { status: 200, body: mine("10501", { properties: [] }) }, { status: 200, body: mine("99999") }, { status: 404 }]) {
      const refused = fakeFetch((call) => (call.url.includes("/myself") ? { body: { accountId: "acct-me" } } : call.method === "PUT" ? { status: 204 } : found));
      await expect(make(refused.fetch).updateComment!(REF, "10501", "x", SCOPE)).rejects.toMatchObject({ name: "TrackerWriteRefusedError", reason: "not_found" });
      expect(refused.calls.some((call) => call.method === "PUT")).toBe(false);
    }
    await expect(make(ok.fetch).updateComment!(REF, "../x", "x", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
