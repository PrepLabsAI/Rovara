import { describe, expect, it } from "vitest";
import type { Citation } from "@rovara-code/contracts";
import { RESULT_RETENTION_SECONDS, citationViews, decideQuote, documentResultStore, registerContextSourceCleanup, type QuoteDependencies } from "../../../packages/core/src/context-sources/quotes.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../../packages/core/src/core/task-flow/flow.js";
import { NOW, ORG, source } from "./fixtures.js";

const handlers: Array<(event: { orgId: typeof ORG; taskId: string }) => Promise<void>> = [];
const onTaskEnd = (handler: (event: { orgId: typeof ORG; taskId: string }) => Promise<void>) => { handlers.push(handler); return () => undefined; };

const viewer = { orgId: ORG, developerId: "dev1" };
const keepInput = (over: Partial<Parameters<ReturnType<typeof documentResultStore>["keep"]>[0]> = {}) => ({
  orgId: ORG, taskId: "task1", operationId: "op1", sourceId: "sim", itemRef: "P1", digest: "a".repeat(64), text: "the ticket body", retention: "team_record" as const, quotes: "project_members" as const, fetchedAt: "2026-11-01T10:00:00Z", ...over,
});
const citation = (over: Partial<Citation> = {}): Citation => ({ sourceId: "sim", itemRef: "P1", title: "Login fails", fetchedAt: "2026-11-01T10:00:00Z", digest: "a".repeat(64), standing: "outsider", ...over });
const members = (...ids: string[]): QuoteDependencies => ({ isProjectMember: async (who) => ids.includes(who.developerId) });

describe("what is kept", () => {
  it("keeps the text of a source that shows quotes, with an expiry, and lists it back", async () => {
    const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const store = documentResultStore({ store: table, now: () => NOW });
    await store.keep(keepInput());
    expect(await store.list(ORG, "task1")).toEqual([expect.objectContaining({ sourceId: "sim", itemRef: "P1", text: "the ticket body", retention: "team_record" })]);
    const raw = (await table.query({ pk: `ORG#${ORG}#CTXRES#task1` })).items;
    expect(raw[0]!.indexExpiresAt).toBe(Math.floor(NOW / 1_000) + RESULT_RETENTION_SECONDS);
  });
  it("keeps nothing for a citations-only source or for Slack, whatever else is set", async () => {
    const store = documentResultStore({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW });
    await store.keep(keepInput({ quotes: "citations_only" }));
    await store.keep(keepInput({ system: "slack", quotes: "project_members", retention: "live_only" }));
    expect(await store.list(ORG, "task1")).toEqual([]);
  });
  it("keeps one task's text apart from another's and another org's", async () => {
    const store = documentResultStore({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW });
    await store.keep(keepInput());
    expect(await store.list(ORG, "task2")).toEqual([]);
    expect(await store.list("org_bbbbbbbbbbbbbbbbbbbb", "task1")).toEqual([]);
  });
  it("deletes only the live-only items when the task ends, and all of them on request", async () => {
    const store = documentResultStore({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW });
    await store.keep(keepInput({ itemRef: "P1", retention: "live_only" }));
    await store.keep(keepInput({ itemRef: "P2", retention: "team_record" }));
    expect(await store.deleteForTask(ORG, "task1", { onlyLiveOnly: true })).toBe(1);
    expect((await store.list(ORG, "task1")).map((item) => item.itemRef)).toEqual(["P2"]);
    expect(await store.deleteForTask(ORG, "task1", { onlyLiveOnly: false })).toBe(1);
    expect(await store.list(ORG, "task1")).toEqual([]);
  });
  it("the task-end handler deletes live-only text, and a failing delete never stops the task ending", async () => {
    const store = documentResultStore({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW });
    await store.keep(keepInput({ retention: "live_only" }));
    registerContextSourceCleanup({ store, onTaskEnd });
    await handlers.at(-1)!({ orgId: ORG, taskId: "task1" });
    expect(await store.list(ORG, "task1")).toEqual([]);
    const logs: string[] = [];
    registerContextSourceCleanup({ store: { deleteForTask: async () => { throw new Error("down"); } }, onTaskEnd, log: (event) => logs.push(event) });
    await expect(handlers.at(-1)!({ orgId: ORG, taskId: "task1" })).resolves.toBeUndefined();
    expect(logs).toEqual(["context_source.live_only_delete_failed"]);
  });
});

describe("who sees a quote", () => {
  it("citations only: nobody, not even a member", async () => {
    expect(await decideQuote(members("dev1"), { viewer, project: "proj", source: source({ quotes: "citations_only" }), itemRef: "P1" })).toEqual({ show: false, reason: "citations_only" });
  });
  it("project members: a member yes, a stranger no, and a membership check that fails is a no", async () => {
    const input = { viewer, project: "proj", source: source({ quotes: "project_members" }), itemRef: "P1" };
    expect(await decideQuote(members("dev1"), input)).toEqual({ show: true });
    expect(await decideQuote(members("someone-else"), input)).toEqual({ show: false, reason: "not_a_member" });
    expect(await decideQuote({ isProjectMember: async () => { throw new Error("down"); } }, input)).toEqual({ show: false, reason: "not_a_member" });
  });
  it("people allowed at the source: only with a live check that says yes; no check, a no, or an error is a no", async () => {
    const input = { viewer, project: "proj", source: source({ quotes: "source_acl" }), itemRef: "P1" };
    expect(await decideQuote({ ...members("dev1"), liveAclCheck: async () => true }, input)).toEqual({ show: true });
    expect(await decideQuote({ ...members("dev1"), liveAclCheck: async () => false }, input)).toEqual({ show: false, reason: "no_access_at_source" });
    expect(await decideQuote({ ...members("dev1"), liveAclCheck: async () => { throw new Error("timeout"); } }, input)).toEqual({ show: false, reason: "no_access_at_source" });
    expect(await decideQuote(members("dev1"), input)).toEqual({ show: false, reason: "no_live_check" });
    // A member who fails the check at the source is not helped by being a member.
    expect(await decideQuote({ ...members("dev1"), liveAclCheck: async () => true }, { ...input, viewer: { orgId: ORG, developerId: "stranger" } })).toEqual({ show: false, reason: "not_a_member" });
  });
  it("Slack: never, even when a stale setting says members", async () => {
    expect(await decideQuote(members("dev1"), { viewer, project: "proj", source: source({ system: "slack", quotes: "project_members" }), itemRef: "P1" })).toEqual({ show: false, reason: "citations_only" });
  });
});

describe("the citations of a task, as a viewer sees them", () => {
  async function world() {
    const store = documentResultStore({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW });
    await store.keep(keepInput({ itemRef: "P1", text: "SECRET BODY 1" }));
    await store.keep(keepInput({ sourceId: "wiki", itemRef: "W1", text: "SECRET BODY 2" }));
    return store;
  }
  it("gives a viewer without access the title and the link, and never the text", async () => {
    const results = await world();
    const views = await citationViews({ ...members("dev1"), results }, {
      viewer: { orgId: ORG, developerId: "outsider" }, orgId: ORG, taskId: "task1", project: "proj",
      citations: [citation({ url: "https://sim.example.com/P1" })], sources: [source({ quotes: "project_members" })],
    });
    expect(views).toEqual([{ citation: citation({ url: "https://sim.example.com/P1" }), label: "SIM", withheld: "not_a_member" }]);
    expect(JSON.stringify(views)).not.toContain("SECRET");
  });
  it("gives a member the text of the item cited, and not another item's", async () => {
    const results = await world();
    const views = await citationViews({ ...members("dev1"), results }, {
      viewer, orgId: ORG, taskId: "task1", project: "proj", citations: [citation(), citation({ sourceId: "wiki", itemRef: "W1" })],
      sources: [source({ quotes: "project_members" }), source({ sourceId: "wiki", label: "Wiki", quotes: "project_members" })],
    });
    expect(views.map((view) => view.quote)).toEqual(["SECRET BODY 1", "SECRET BODY 2"]);
  });
  it("withholds as expired when the text is gone, and keeps the citation of a source that was removed", async () => {
    const results = await world();
    const views = await citationViews({ ...members("dev1"), results }, {
      viewer, orgId: ORG, taskId: "task1", project: "proj", citations: [citation({ itemRef: "P-missing" }), citation({ sourceId: "gone" })], sources: [source({ quotes: "project_members" })],
    });
    expect(views.map((view) => view.withheld)).toEqual(["expired", "citations_only"]);
  });
  it("shows nothing but citations when the store cannot be read", async () => {
    const views = await citationViews({ ...members("dev1"), results: { list: async () => { throw new Error("down"); } } }, {
      viewer, orgId: ORG, taskId: "task1", project: "proj", citations: [citation()], sources: [source({ quotes: "project_members" })],
    });
    expect(views[0]).toMatchObject({ withheld: "expired" });
    expect(views[0]).not.toHaveProperty("quote");
  });
});

describe("the result store", () => {
  it("does not serve an item past its expiry, even while the table has not deleted it yet", async () => {
    const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    let clock = NOW;
    const store = documentResultStore({ store: table, now: () => clock });
    await store.keep(keepInput());
    expect(await store.list(ORG, "task1")).toHaveLength(1);
    clock = NOW + (RESULT_RETENTION_SECONDS + 1) * 1_000;
    expect(await store.list(ORG, "task1")).toEqual([]);
  });
  it("strips hidden characters from what it keeps, so a quote shown to a person holds none", async () => {
    const store = documentResultStore({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW });
    await store.keep(keepInput({ text: "visible\u202E\u200B text\u{E0041}" }));
    expect((await store.list(ORG, "task1"))[0]!.text).toBe("visible text");
  });
});
