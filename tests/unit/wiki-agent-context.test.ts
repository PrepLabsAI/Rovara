// Lead 4 A1, the broker side: what a task step is given of the project wiki (`buildWikiContext`), the switch, and the worker's report filed per company, project and task.
// The golden hop here is page -> agent: what the store's agent view drops (pending notes, flagged and not-found claims, flagged pages) never reaches the payload; and a task in project A never gets
// project B's pages (two-project) nor another company's (two-company).
import { describe, expect, it } from "vitest";
import { WIKI_AGENT_LIMITS, wikiUsePartition, type OrgId, type WikiPageWrite, type WikiReadReport } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { WIKI_INVOCATION_MARGIN_BYTES, invocationTooBigForWiki } from "../../packages/broker/src/core/task-flow/wiki-step.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { agentPageOf, buildWikiContext, createWikiForStep, createWikiOnEvents, deleteWikiUse, readWikiTaskUse, recordWikiReports, setWikiAgentSwitch, wikiAgentSwitchIsOn, wikiReportsOfEvents } from "../../packages/broker/src/core/wiki/agent-context.js";
import { COMPANY_PURGE_COOLING_OFF_MS } from "../../packages/broker/src/core/company/purge.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SHA = "a".repeat(40);
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const TASK = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const OP = "aaaaaaaa-1111-4111-8111-111111111111";
void COMPANY_PURGE_COOLING_OFF_MS;

function world() {
  const store = new MemoryDocumentStore();
  let n = 0;
  const opts = (companyId: OrgId) => ({ store, companyId, now: () => T0 });
  const wiki = (companyId: OrgId) => createWikiStore({ store, companyId, now: () => T0, newId: () => `id-${String(++n).padStart(4, "0")}` });
  return { store, opts, wiki };
}

const claim = (id: string, tag: string, over: Record<string, unknown> = {}) => ({ claimId: id, text: `Claim ${id} ${tag}`, citations: [{ repo: "web", path: `src/${id}.ts`, commit: SHA, line: 3, quote: `export const ${id} = "${tag}-quote-text";` }], source: "found" as const, checkedAt: "2026-11-17T09:00:00.000Z", ...over });
function page(tag: string, over: Partial<WikiPageWrite> = {}): WikiPageWrite {
  return {
    pageId: "overview", kind: "overview", title: `Overview ${tag}`, summary: `Summary ${tag}`, order: 0, repos: [{ repo: "web", commit: SHA }],
    blocks: [
      { kind: "heading", blockId: "h0001", level: 2, text: `Heading ${tag}` },
      { kind: "paragraph", blockId: "p0001", text: `First ${tag}`, claimIds: ["c0001"] },
      { kind: "paragraph", blockId: "p0002", text: `Second ${tag}`, claimIds: ["c0002"] },
    ],
    claims: [claim("c0001", tag), claim("c0002", tag)], buildId: "build-0001", ...over,
  };
}
const REPOS = ["web", "api"];

describe("wiki for agents: the switch", () => {

  it("a store that fails to read the switch means off", async () => {
    const w = world();
    await w.wiki(A).writePage("alpha", page("A-alpha"));
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    const broken = { ...w.opts(A), store: { ...w.store, get: async () => { throw new Error("boom"); } } as never };
    expect(await wikiAgentSwitchIsOn(broken, "alpha")).toBe(false);
  });
});

describe("wiki for agents: page -> agent (golden)", () => {

  it("leaves out a page naming a repository the project no longer has, and a page mostly out of date", async () => {
    const w = world();
    const wiki = w.wiki(A);
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    await wiki.writePage("alpha", page("OK", { pageId: "ok-page" }));
    await wiki.writePage("alpha", page("GONE", { pageId: "gone-page", repos: [{ repo: "removed", commit: SHA }], claims: [claim("c0001", "g", { citations: [{ repo: "removed", path: "a.ts", commit: SHA, line: 1, quote: "export const removed = 1;" }] }), claim("c0002", "g", { citations: [{ repo: "removed", path: "b.ts", commit: SHA, line: 1, quote: "export const removed = 2;" }] })] }));
    await wiki.writePage("alpha", page("OLD", { pageId: "old-page" }));
    await wiki.markClaims("alpha", "old-page", [{ claimId: "c0001", source: "changed" }, { claimId: "c0002", source: "changed" }]);
    await wiki.writePage("alpha", page("HALF", { pageId: "half-page" }));
    await wiki.markClaims("alpha", "half-page", [{ claimId: "c0001", source: "changed" }]);
    const context = await buildWikiContext(w.opts(A), { project: "alpha", repositories: REPOS });
    expect(context?.pages.map((p) => p.pageId).sort()).toEqual(["half-page", "ok-page"]);
    expect(context?.leftOut).toBe(2);
  });

  it("nothing to give (no page, or every page withheld) is no context at all", async () => {
    const w = world();
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    expect(await buildWikiContext(w.opts(A), { project: "alpha", repositories: REPOS })).toBeUndefined();
    await w.wiki(A).writePage("alpha", page("X"));
    await w.wiki(A).addFlag("alpha", { pageId: "overview", by: { kind: "task", taskId: TASK } });
    expect(await buildWikiContext(w.opts(A), { project: "alpha", repositories: REPOS })).toBeUndefined();
  });

  it("places the map first and stops at the size budget, naming how many pages did not fit", async () => {
    const w = world();
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    const big = (n: number) => "x".repeat(3_000) + n;
    for (let i = 0; i < 30; i += 1) {
      const id = `mod-${String(i).padStart(2, "0")}`;
      await w.wiki(A).writePage("alpha", page(id, { pageId: id, kind: "module", order: i, blocks: [{ kind: "heading", blockId: "h0001", level: 2, text: "H" }, ...[0, 1].map((k) => ({ kind: "paragraph" as const, blockId: `p000${k}`, text: big(k), claimIds: [`c000${k + 1}`] }))] }));
    }
    await w.wiki(A).writePage("alpha", page("map", { pageId: "overview", kind: "overview", order: 99 }));
    const context = await buildWikiContext(w.opts(A), { project: "alpha", repositories: REPOS });
    expect(context?.pages[0]?.pageId).toBe("overview");
    expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThanOrEqual(WIKI_AGENT_LIMITS.contextBytes);
    expect(context!.pages.length).toBeLessThan(31);
    expect(context!.leftOut).toBe(31 - context!.pages.length);
  });

  it("an unreadable page row means no context, never a partial one", async () => {
    const w = world();
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    await w.wiki(A).writePage("alpha", page("X"));
    const rows = await w.store.query({ pk: "ORG#" + A + "#WIKI#alpha" });
    void rows;
    const broken = { ...w.opts(A), store: { ...w.store, get: async (key: { pk: string; sk: string }) => { if (key.sk.startsWith("SWITCH")) return w.store.get(key); throw new Error("boom"); }, getMany: async () => { throw new Error("boom"); }, query: w.store.query.bind(w.store), put: w.store.put.bind(w.store), update: w.store.update.bind(w.store), delete: w.store.delete.bind(w.store), transact: w.store.transact.bind(w.store) } as never };
    expect(await buildWikiContext(broken, { project: "alpha", repositories: REPOS })).toBeUndefined();
  });
});

describe("wiki for agents: the agent copy is a second wall behind the store's agent view", () => {
  it("leaves out a pending note, a not-found claim, a claim with an open flag and every paragraph resting on one, even if a read handed them over", () => {
    const written = page("X", {
      blocks: [
        { kind: "heading", blockId: "h0001", level: 2, text: "Heading" },
        { kind: "paragraph", blockId: "p0001", text: "KEPT", claimIds: ["c0001"] },
        { kind: "paragraph", blockId: "p0002", text: "NOTFOUND-PARA", claimIds: ["c0002"] },
        { kind: "paragraph", blockId: "p0003", text: "FLAGGED-PARA", claimIds: ["c0003"] },
      ],
      claims: [claim("c0001", "x"), claim("c0002", "x"), claim("c0003", "x")],
    });
    const read = {
      page: { ...written, writtenAt: "2026-11-17T10:00:00.000Z", claims: [written.claims[0]!, { ...written.claims[1]!, source: "not_found" as const }, written.claims[2]!] },
      notes: [
        { noteId: "note-pending", pageId: "overview", text: "PENDING", authorId: "p1", createdAt: "2026-11-17T10:00:00.000Z", approval: { state: "pending" as const } },
        { noteId: "note-approved", pageId: "overview", text: "APPROVED", authorId: "p1", createdAt: "2026-11-17T10:00:00.000Z", approval: { state: "approved" as const, by: "m1", at: "2026-11-17T10:00:00.000Z" } },
      ],
      flags: [{ flagId: "flag-0001", pageId: "overview", claimId: "c0003", by: { kind: "task" as const, taskId: TASK }, createdAt: "2026-11-17T10:00:00.000Z", state: "open" as const }],
      staleBlockIds: ["p0002", "p0003", "p0001"],
    };
    const copy = agentPageOf(read);
    expect(copy?.notes).toEqual([{ noteId: "note-approved", text: "APPROVED" }]);
    expect(copy?.claims.map((c) => c.claimId)).toEqual(["c0001"]);
    expect(copy?.blocks.map((b) => b.blockId)).toEqual(["h0001", "p0001"]);
    expect(copy?.staleBlockIds).toEqual(["p0001"]);
    const json = JSON.stringify(copy);
    for (const gone of ["NOTFOUND-PARA", "FLAGGED-PARA", "PENDING", "p1"]) expect(json).not.toContain(gone);
  });
});

describe("wiki for agents: the wiki never makes a step too big to send", () => {
  it("measures the whole invocation against a margin under the 1 MiB body the workers accept", () => {
    expect(invocationTooBigForWiki({ payload: { prompt: "x".repeat(WIKI_INVOCATION_MARGIN_BYTES - 1_000) } })).toBe(false);
    expect(invocationTooBigForWiki({ payload: { prompt: "x".repeat(WIKI_INVOCATION_MARGIN_BYTES + 1) } })).toBe(true);
  });
});

describe("wiki for agents: the delivery seam and the report", () => {
  const step = { companyId: A, project: "alpha", taskId: TASK, operationId: OP, workflowMode: "PLAN" as string | undefined, repositories: REPOS };
  async function ready() {
    const w = world();
    await w.wiki(A).writePage("alpha", page("A-alpha"));
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    return w;
  }
  const report = (over: Partial<WikiReadReport> = {}): WikiReadReport => ({ v: 1, project: "alpha", phase: "read", pages: [{ pageId: "overview", stale: 0 }], dropped: [], ...over });

  it("gives a task step the wiki, notes the delivery under the operation, and files the worker's reports on that task only", async () => {
    const w = await ready();
    const forStep = createWikiForStep(w.opts(A));
    expect((await forStep(step)).wikiContext?.pages.map((p) => p.pageId)).toEqual(["overview"]);
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [report({ phase: "given", pages: [{ pageId: "overview", stale: 1 }] }), report()] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toEqual({ given: ["overview"], read: ["overview"] });
    // Not another task, not another project, not another company.
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK_B })).toBeUndefined();
    expect(await readWikiTaskUse(w.opts(A), { project: "beta", taskId: TASK })).toBeUndefined();
    expect(await readWikiTaskUse(w.opts(B), { project: "alpha", taskId: TASK })).toBeUndefined();
  });

  it("a report for an operation no delivery noted, or naming another project, is dropped; a report is a set (no duplicates)", async () => {
    const w = await ready();
    await createWikiForStep(w.opts(A))(step);
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: "bbbbbbbb-2222-4222-8222-222222222222", reports: [report()] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [report({ project: "beta" })] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [report(), report()] });
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [report()] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toEqual({ given: [], read: ["overview"] });
    // Company B cannot file a report on company A's operation.
    await recordWikiReports(w.opts(B), { project: "alpha", operationId: OP, reports: [report({ pages: [{ pageId: "evil", stale: 0 }] })] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toEqual({ given: [], read: ["overview"] });
  });

  it("refuses a workspace of another company, and a mode that is not a reading or deciding stage; nothing is noted for them", async () => {
    const w = await ready();
    const forStep = createWikiForStep(w.opts(A));
    expect(await forStep({ ...step, companyId: B })).toEqual({});
    for (const mode of ["SETUP_DRAFT", "SETUP_AGENT", "SPEC_WRITE", "CHECKS", "FEEDBACK_REVIEW"]) expect(await forStep({ ...step, workflowMode: mode })).toEqual({});
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [report()] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
    for (const mode of [undefined, "UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW"]) expect((await forStep({ ...step, workflowMode: mode })).wikiContext).toBeDefined();
  });

  it("with the switch off the step gets nothing and no delivery is noted", async () => {
    const w = await ready();
    await setWikiAgentSwitch(w.opts(A), "alpha", false);
    expect(await createWikiForStep(w.opts(A))(step)).toEqual({});
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [report()] });
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
  });

  it("reads reports out of worker progress events (a malformed one is dropped whole) and deleteWikiUse removes the project's switch, refs and reports only", async () => {
    const w = await ready();
    await w.wiki(A).writePage("beta", page("B"));
    await setWikiAgentSwitch(w.opts(A), "beta", true);
    const good = report();
    expect(wikiReportsOfEvents([{ type: "progress", payload: { wikiReadReport: good } }, { type: "progress", payload: { wikiReadReport: { v: 1, nonsense: true } } }, { type: "tool", payload: { wikiReadReport: good } }, { type: "progress", payload: { message: "x" } }])).toEqual([good]);
    await createWikiForStep(w.opts(A))(step);
    await recordWikiReports(w.opts(A), { project: "alpha", operationId: OP, reports: [good] });
    expect(await deleteWikiUse(w.opts(A), "alpha")).toBe(3);
    expect(await wikiAgentSwitchIsOn(w.opts(A), "alpha")).toBe(false);
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
    expect(await wikiAgentSwitchIsOn(w.opts(A), "beta")).toBe(true);
    expect((await w.store.query({ pk: wikiUsePartition(A, "alpha") })).items).toHaveLength(0);
  });
});

describe("wiki for agents: the callback hook files a step's report on its own task", () => {
  const WORKSPACE = "33333333-3333-4333-8333-333333333333";
  const progress = (project: string) => ({ type: "progress", payload: { wikiReadReport: { v: 1, project, phase: "read", pages: [{ pageId: "overview", stale: 0 }], dropped: [] } } });
  async function ready() {
    const w = world();
    await w.wiki(A).writePage("alpha", page("A-alpha"));
    await setWikiAgentSwitch(w.opts(A), "alpha", true);
    await createWikiForStep(w.opts(A))({ companyId: A, project: "alpha", taskId: TASK, operationId: OP, workflowMode: "PLAN", repositories: REPOS });
    await w.store.put({ item: { ...workspaceKey(A, WORKSPACE), entityType: "WORKSPACE", id: WORKSPACE, companyId: A, projectName: "alpha" } });
    return w;
  }

  it("takes the project from the operation's own workspace record, never from the event", async () => {
    const w = await ready();
    // The event names project beta; the workspace says alpha: the report is for alpha's delivery or nothing.
    await createWikiOnEvents(w.opts(A))({ workspaceId: WORKSPACE, id: OP }, [progress("beta")]);
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
    await createWikiOnEvents(w.opts(A))({ workspaceId: WORKSPACE, id: OP }, [progress("alpha")]);
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toEqual({ given: [], read: ["overview"] });
  });

  it("a workspace of another company, a missing workspace and a broken store file nothing and never throw", async () => {
    const w = await ready();
    await createWikiOnEvents(w.opts(B))({ workspaceId: WORKSPACE, id: OP }, [progress("alpha")]);
    await createWikiOnEvents(w.opts(A))({ workspaceId: "44444444-4444-4444-8444-444444444444", id: OP }, [progress("alpha")]);
    await createWikiOnEvents({ ...w.opts(A), store: { get: async () => { throw new Error("boom"); } } as never })({ workspaceId: WORKSPACE, id: OP }, [progress("alpha")]);
    expect(await readWikiTaskUse(w.opts(A), { project: "alpha", taskId: TASK })).toBeUndefined();
  });
});
