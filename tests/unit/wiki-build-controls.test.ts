// Wiki W4: the wiki build controls (core/wiki-build/controls.ts) over a memory store and fakes. Every control checks the caller's standing on THAT project (manage, view, none); the state is read by
// any role; the agents switch, both deletes and Refresh now are keyed by company AND project (two-project and two-company tests below). Mutants are listed in the PR body with the test that kills each.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WIKI_BUILD_WORDS, WIKI_CONTROLS_WORDS, queryAll, wikiAgentSwitchKey, wikiPartition, wikiUsePartition, type OrgId, type WikiBuildRecord, type WikiPageWrite } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { setWikiAgentSwitch, wikiAgentSwitchIsOn } from "../../packages/broker/src/core/wiki/agent-context.js";
import { wikiBuildPartition } from "../../packages/broker/src/core/wiki-build/keys.js";
import { modulePageId } from "../../packages/broker/src/core/wiki-build/plan.js";
import { nextWikiPage, readWikiBuildPointer, submitWikiPage, type WikiBuildDeps, type WikiBuildStanding, type WikiPageLoopDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import {
  agentsSwitchControl, continueWikiControl, deleteProjectWiki, deleteWikiControl, refreshWikiControl, startWikiControl, stopWikiControl, wikiControlsView, type WikiControlAction, type WikiControlsDeps,
} from "../../packages/broker/src/core/wiki-build/controls.js";
import { change, when } from "@agentx/contracts";
import { wikiBuildRunKey } from "../../packages/broker/src/core/wiki-build/keys.js";
import { deleteWikiBuildRows } from "../../packages/broker/src/core/wiki-build/controls.js";
import { API_SHA, COMPANY_A, COMPANY_B, FakeSink, FakeStarter, WEB_SHA, area, fileMap, reader, repoEntry } from "../support/wiki-build-fixtures.js";

const ADMIN = "person-admin";
const VIEWER = "person-viewer";
const OUTSIDER = "person-outsider";
const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const clock = { now: T0 };
const API_FILE = "export function startServer(port: number) {\n  return listen(port, routes);\n}\n";

const PAGE_CLAIM = { claimId: "c0001", text: "A claim", citations: [{ repo: "api", path: "src/server.ts", commit: API_SHA, line: 1, quote: "export function startServer(port: number) {" }], source: "found" as const, checkedAt: "2026-11-17T09:00:00.000Z" };
function page(pageId: string, over: Partial<WikiPageWrite> = {}): WikiPageWrite {
  return {
    pageId, kind: pageId === "overview" ? "overview" : pageId.startsWith("repo-") ? "repo" : "module", title: `Page ${pageId}`, summary: "Summary", order: 0, repos: [{ repo: "api", commit: API_SHA }],
    blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }], claims: [PAGE_CLAIM], buildId: "build-0001", ...over,
  };
}

/** Standing by person AND project: the admin manages `beacon` only; the viewer views `beacon`; `other` is the admin's too in company A. */
function world(options: { company?: OrgId; manages?: string[]; views?: string[]; record?: WikiControlsDeps["record"]; deps?: Partial<WikiBuildDeps>; store?: MemoryDocumentStore } = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const starter = new FakeStarter(store);
  const records: WikiBuildRecord[] = [];
  const sink = new FakeSink(company, "beacon");
  const manages = options.manages ?? ["beacon", "other"];
  const views = options.views ?? ["beacon"];
  const standing = async (person: string, project: string): Promise<WikiBuildStanding> => (person === ADMIN && manages.includes(project) ? { access: "manage" } : person === VIEWER && views.includes(project) ? { access: "view" } : { access: "none" });
  const map = fileMap([repoEntry("api", [area("src", { rank: 1 })]), repoEntry("web", [area("app", { rank: 1 })])]);
  const build: WikiBuildDeps = {
    store, companyId: company, now: () => clock.now, starter, standing, modelAccessConfigured: true, aiKey: async () => "connected", fileMap: async () => map,
    defaultBranchHeads: async () => [{ repo: "api", commit: API_SHA }, { repo: "web", commit: WEB_SHA }], limitSetting: async () => ({ budgetCents: 1_000, pageReserveCents: 100 }),
    recordBuild: async (record) => { records.push(record); }, ...options.deps,
  };
  const wiki = createWikiStore({ store, companyId: company, now: () => T0 });
  const audited: Array<{ action: WikiControlAction; project: string; requestId: string; on?: boolean; token: string }> = [];
  const record = options.record ?? (async (action, project, details) => { audited.push({ action, project, ...details }); });
  const controls: WikiControlsDeps = { build, wiki, agents: { store, companyId: company, now: () => T0 }, record };
  const loop: WikiPageLoopDeps = { store, companyId: company, now: () => T0, standing, read: reader({ [`api:src/server.ts@${API_SHA}`]: API_FILE }).read, sink };
  return { store, company, starter, records, sink, controls, audited, wiki, loop, build };
}
type World = ReturnType<typeof world>;
const id = () => randomUUID();
const rows = async (w: World, pk: string) => (await queryAll(w.store, { pk })).length;

async function seedWiki(w: World, project: string, pageIds: string[] = ["overview"]): Promise<void> {
  const store = createWikiStore({ store: w.store, companyId: w.company, now: () => T0 });
  for (const pageId of pageIds) await store.writePage(project, page(pageId));
}

describe("the state: any role reads, nobody else", () => {
  it("shows a manager canManage, a viewer a read-only view, and a person with no role 'project not found'", async () => {
    const w = world();
    await seedWiki(w, "beacon", ["overview", "repo-api"]);
    const manager = await wikiControlsView(w.controls, ADMIN, "beacon");
    expect(manager).toMatchObject({ status: "none", canManage: true, aiKey: "connected", agents: { on: false }, wiki: { pages: 2, refreshPages: 0 }, payer: "project" });
    expect(manager).not.toHaveProperty("connectKey");
    expect(await wikiControlsView(w.controls, VIEWER, "beacon")).toMatchObject({ canManage: false, wiki: { pages: 2 } });
    await expect(wikiControlsView(w.controls, OUTSIDER, "beacon")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // A person with a role on one project reads nothing of another project of the same company.
    await expect(wikiControlsView(w.controls, VIEWER, "other")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("says 'Connect an AI key' when there is no key or no gateway, says unknown when the install cannot tell, and counts what Refresh now would rewrite", async () => {
    const missing = world({ deps: { aiKey: async () => "missing" } });
    expect(await wikiControlsView(missing.controls, ADMIN, "beacon")).toMatchObject({ aiKey: "missing", connectKey: WIKI_BUILD_WORDS.connectKey });
    expect(await wikiControlsView(world({ deps: { modelAccessConfigured: false } }).controls, ADMIN, "beacon")).toMatchObject({ aiKey: "missing", connectKey: WIKI_BUILD_WORDS.connectKey });
    expect(await wikiControlsView(world({ deps: { aiKey: async () => { throw new Error("gateway down"); } } }).controls, ADMIN, "beacon")).toMatchObject({ aiKey: "unknown" });
    const w = world();
    await seedWiki(w, "beacon", ["overview", "repo-api", "repo-web"]);
    await w.wiki.addFlag("beacon", { pageId: "repo-api", by: { kind: "person", personId: "p1" } });
    await w.wiki.markClaims("beacon", "repo-web", [{ claimId: "c0001", source: "changed" }]);
    expect((await wikiControlsView(w.controls, ADMIN, "beacon")).wiki).toEqual({ pages: 3, refreshPages: 2 });
  });

});

describe("Build, Stop and Continue: manage only, the run's own rules, audited first", () => {

  it("an audit record that cannot be written means nothing is done", async () => {
    const w = world({ record: async () => { throw new Error("audit down"); } });
    for (const control of [startWikiControl, continueWikiControl, stopWikiControl]) await expect(control(w.controls, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(agentsSwitchControl(w.controls, ADMIN, "beacon", { requestId: id(), on: true })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(refreshWikiControl(w.controls, ADMIN, "beacon", { requestId: id() })).rejects.toBeDefined();
    expect(w.starter.started).toHaveLength(0);
    expect(await wikiAgentSwitchIsOn(w.controls.agents, "beacon")).toBe(false);
  });

  it("no AI key: 'Connect an AI key' and no task; Stop then Continue keep the finished pages (the run's own rules reached through the controls)", async () => {
    const none = world({ deps: { aiKey: async () => "missing" } });
    await expect(startWikiControl(none.controls, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE", message: `MODEL_PROXY_UNAVAILABLE: ${WIKI_BUILD_WORDS.connectKey}` });
    expect(none.starter.started).toHaveLength(0);

    const w = world();
    await startWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    const pointer = (await readWikiBuildPointer(w.store, w.company, "beacon"))!;
    const scope = { orgId: w.company, project: "beacon", taskId: pointer.taskId };
    const job = await nextWikiPage(w.loop, scope, { spentCents: 0 });
    if (job.kind !== "page") throw new Error("expected a page");
    await submitWikiPage(w.loop, scope, { pageId: job.page.id, spentCents: 10, draft: { pageId: job.page.id, sections: [{ heading: "Start", claims: [{ sentence: "The server starts in `startServer` with a port.", citations: [{ repo: "api", path: "src/server.ts", commit: API_SHA, line: 1, quote: "export function startServer(port: number) {" }] }] }] } });
    const stopped = await stopWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    expect(stopped.view).toMatchObject({ status: "stopped", stop: "stopped_by_person", canContinue: true });
    expect(w.starter.cancelled).toEqual([pointer.taskId]);
    const continued = await continueWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    expect(continued.status).toBe(202);
    expect((await readWikiBuildPointer(w.store, w.company, "beacon"))?.keptFromEarlier).toContain(job.page.id);
    expect(w.audited.map((entry) => entry.action)).toEqual(["start_requested", "stop_requested", "continue_requested"]);
  });
});

describe("Refresh now: the same entry, a filtered plan", () => {
  const FULL = ["overview", "repo-api", "repo-web", modulePageId("api", "src"), modulePageId("web", "app"), "connections"];

  it("a claim mark older than the page (a refresh already rewrote it and kept the claim) does not pick it up again; a resolved mark never does", async () => {
    const w = world();
    await seedWiki(w, "beacon", FULL);
    await w.wiki.addFlag("beacon", { pageId: "repo-web", claimId: "c0001", by: { kind: "person", personId: "p1" } });
    await w.wiki.addFlag("beacon", { pageId: "repo-api", claimId: "c0001", by: { kind: "person", personId: "p1" } });
    // The pages are rewritten a moment later (a refresh ran): the marks stay open (disputed) but were looked at.
    const later = createWikiStore({ store: w.store, companyId: w.company, now: () => T0 + 60_000 });
    await later.writePage("beacon", page("repo-web"));
    await later.writePage("beacon", page("repo-api"));
    expect((await wikiControlsView(w.controls, ADMIN, "beacon")).wiki).toEqual({ pages: FULL.length, refreshPages: 0 });
    await expect(refreshWikiControl(w.controls, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ message: `CONFIG_INVALID: ${WIKI_CONTROLS_WORDS.nothingToRefresh}` });
    // A new mark after the rewrite counts again; a resolved one does not.
    const newer = createWikiStore({ store: w.store, companyId: w.company, now: () => T0 + 120_000 });
    await newer.addFlag("beacon", { pageId: "repo-web", claimId: "c0001", by: { kind: "person", personId: "p2" } });
    await newer.resolveFlags("beacon", "repo-api");
    expect((await wikiControlsView(w.controls, ADMIN, "beacon")).wiki.refreshPages).toBe(1);
    await refreshWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    expect((await readWikiBuildPointer(w.store, w.company, "beacon"))!.plan.map((p) => p.id)).toEqual(["repo-web"]);
  });

  it("when the marks cannot all be read, every page counts (never a partial answer); when they cannot be read at all, the view and Refresh say so in fixed words", async () => {
    const w = world();
    await seedWiki(w, "beacon", FULL);
    const unsure = { ...w.controls, wiki: { ...w.wiki, openClaimFlagPages: async () => ({ pages: [], complete: false }) } } as WikiControlsDeps;
    expect((await wikiControlsView(unsure, ADMIN, "beacon")).wiki).toEqual({ pages: FULL.length, refreshPages: FULL.length });
    await refreshWikiControl(unsure, ADMIN, "beacon", { requestId: id() });
    expect((await readWikiBuildPointer(w.store, w.company, "beacon"))!.plan).toHaveLength(FULL.length);
    const broken = { ...w.controls, wiki: { ...w.wiki, openClaimFlagPages: async () => { throw new Error("secret row detail"); } } } as WikiControlsDeps;
    await expect(wikiControlsView(broken, ADMIN, "beacon")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${WIKI_CONTROLS_WORDS.unreadable}` });
    await expect(refreshWikiControl(broken, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${WIKI_CONTROLS_WORDS.unreadable}` });
  });

  it("is manage only, project scoped, and company scoped: another company's flagged page does not make a refresh", async () => {
    const store = new MemoryDocumentStore();
    const a = world({ store, manages: ["beacon"] });
    const b = world({ store, company: COMPANY_B });
    await seedWiki(a, "beacon", FULL);
    await seedWiki(b, "beacon", FULL);
    await b.wiki.addFlag("beacon", { pageId: "repo-api", by: { kind: "person", personId: "p1" } });
    // A is fully up to date even though B's same-named project has a flagged page.
    await expect(refreshWikiControl(a.controls, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ message: `CONFIG_INVALID: ${WIKI_CONTROLS_WORDS.nothingToRefresh}` });
    await a.wiki.addFlag("beacon", { pageId: "repo-web", by: { kind: "person", personId: "p1" } });
    await expect(refreshWikiControl(a.controls, VIEWER, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refreshWikiControl(a.controls, OUTSIDER, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(refreshWikiControl(a.controls, ADMIN, "other", { requestId: id() })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(a.starter.started).toHaveLength(0);
    expect((await refreshWikiControl(a.controls, ADMIN, "beacon", { requestId: id() })).status).toBe(202);
    expect((await readWikiBuildPointer(store, COMPANY_A, "beacon"))!.plan.map((p) => p.id)).toEqual(["repo-web"]);
    expect(await readWikiBuildPointer(store, COMPANY_B, "beacon")).toBeUndefined();
  });

  it("a body with anything but a request id is refused", async () => {
    const w = world();
    await seedWiki(w, "beacon", ["overview"]);
    await expect(refreshWikiControl(w.controls, ADMIN, "beacon", { requestId: id(), pages: ["overview"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(refreshWikiControl(w.controls, ADMIN, "beacon", {})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.starter.started).toHaveLength(0);
  });
});

describe("Give the wiki to agents: A1's switch, written by a manager for ONE company and project", () => {
  it("a manager turns it on and off; the row is the project's own, so another project and another company stay off", async () => {
    const store = new MemoryDocumentStore();
    const a = world({ store });
    const b = world({ store, company: COMPANY_B });
    const on = await agentsSwitchControl(a.controls, ADMIN, "beacon", { requestId: id(), on: true });
    expect(on.view.agents).toEqual({ on: true });
    expect((await store.get(wikiAgentSwitchKey(COMPANY_A, "beacon")))?.["on"]).toBe(true);
    expect(await wikiAgentSwitchIsOn(a.controls.agents, "beacon")).toBe(true);
    expect(await wikiAgentSwitchIsOn(a.controls.agents, "other")).toBe(false);
    expect(await wikiAgentSwitchIsOn(b.controls.agents, "beacon")).toBe(false);
    expect(await store.get(wikiAgentSwitchKey(COMPANY_A, "other"))).toBeUndefined();
    expect(await store.get(wikiAgentSwitchKey(COMPANY_B, "beacon"))).toBeUndefined();
    expect((await agentsSwitchControl(a.controls, ADMIN, "beacon", { requestId: id(), on: false })).view.agents).toEqual({ on: false });
    expect(a.audited.map((entry) => [entry.action, entry.on])).toEqual([["agents_switched", true], ["agents_switched", false]]);
  });

});

describe("Delete wiki: W2's deleteWiki AND A1's deleteWikiUse AND the build's own rows, for this company and project only", () => {
  const partitions = (company: OrgId, project: string) => ({ wiki: wikiPartition(company, project), use: wikiUsePartition(company, project), build: wikiBuildPartition({ orgId: company, project }) });

  async function fill(w: World, project: string): Promise<void> {
    await seedWiki(w, project, ["overview", "repo-api"]);
    await w.wiki.addNote(project, { pageId: "overview", text: "a note", authorId: "p1" });
    await w.wiki.addFlag(project, { pageId: "overview", by: { kind: "person", personId: "p1" } });
    await w.wiki.writeBuild(project, { buildId: "build-0001", kind: "first", state: "done", startedBy: "p1", startedAt: "2026-11-17T10:00:00.000Z", repos: [{ repo: "api", commit: API_SHA }], counts: { pagesWritten: 1, claimsKept: 1, claimsDropped: 0, skipped: 0 }, dropped: [], skipped: [] } satisfies WikiBuildRecord);
    await setWikiAgentSwitch(w.controls.agents, project, true);
    await w.store.put({ item: { pk: wikiBuildPartition({ orgId: w.company, project }), sk: "NOTES#t1", entityType: "WIKI_BUILD_NOTES", orgId: w.company, project, taskId: "t1", by: "p1", notes: "steer" } });
    await w.store.put({ item: { pk: wikiBuildPartition({ orgId: w.company, project }), sk: "DONE#t1#overview", entityType: "WIKI_BUILD_PAGE_DONE", orgId: w.company, project } });
  }
  const sizes = async (w: World, company: OrgId, project: string) => {
    const p = partitions(company, project);
    return { wiki: await rows(w, p.wiki), use: await rows(w, p.use), build: await rows(w, p.build) };
  };

  it("removes all three families of the project, and leaves another project and another company with the same name untouched", async () => {
    const store = new MemoryDocumentStore();
    const a = world({ store });
    const b = world({ store, company: COMPANY_B });
    await fill(a, "beacon");
    await fill(a, "other");
    await fill(b, "beacon");
    const before = { other: await sizes(a, COMPANY_A, "other"), b: await sizes(a, COMPANY_B, "beacon") };
    const mine = await sizes(a, COMPANY_A, "beacon");
    expect(mine.wiki).toBeGreaterThan(0); expect(mine.use).toBe(1); expect(mine.build).toBe(2);
    const done = await deleteWikiControl(a.controls, ADMIN, "beacon", { requestId: id() }, { store, now: () => T0 });
    expect(done).toMatchObject({ status: 200, message: WIKI_CONTROLS_WORDS.deleted, deleted: { buildRows: 2, useRows: 1 } });
    expect(await sizes(a, COMPANY_A, "beacon")).toEqual({ wiki: 0, use: 0, build: 0 });
    expect(await sizes(a, COMPANY_A, "other")).toEqual(before.other);
    expect(await sizes(a, COMPANY_B, "beacon")).toEqual(before.b);
    expect(a.audited.map((entry) => entry.action)).toEqual(["delete_requested"]);
  });

  it("a viewer, a person with no role and a manager of another project delete nothing; a running build must be stopped first", async () => {
    const w = world({ manages: ["other"], views: ["beacon"] });
    await fill(w, "beacon");
    const before = await sizes(w, w.company, "beacon");
    for (const [person, code] of [[VIEWER, "FORBIDDEN"], [OUTSIDER, "PROJECT_NOT_FOUND"], [ADMIN, "PROJECT_NOT_FOUND"]] as const) {
      await expect(deleteWikiControl(w.controls, person, "beacon", { requestId: id() }, { store: w.store, now: () => T0 })).rejects.toMatchObject({ code });
    }
    expect(await sizes(w, w.company, "beacon")).toEqual(before);
    expect(w.audited).toHaveLength(0);

    const running = world();
    await seedWiki(running, "beacon");
    await startWikiControl(running.controls, ADMIN, "beacon", { requestId: id() });
    const kept = await sizes(running, running.company, "beacon");
    await expect(deleteWikiControl(running.controls, ADMIN, "beacon", { requestId: id() }, { store: running.store, now: () => T0 })).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: `WORKSPACE_BUSY: ${WIKI_CONTROLS_WORDS.deleteWhileRunning}` });
    expect(await sizes(running, running.company, "beacon")).toEqual(kept);
  });

  it("a worker that is still running when the wiki is deleted cannot write a page into it: its pointer is gone", async () => {
    const w = world();
    await startWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    const pointer = (await readWikiBuildPointer(w.store, w.company, "beacon"))!;
    const scope = { orgId: w.company, project: "beacon", taskId: pointer.taskId };
    const job = await nextWikiPage(w.loop, scope, { spentCents: 0 });
    if (job.kind !== "page") throw new Error("expected a page");
    await stopWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    await deleteWikiControl(w.controls, ADMIN, "beacon", { requestId: id() }, { store: w.store, now: () => T0 });
    await expect(submitWikiPage(w.loop, scope, { pageId: job.page.id, spentCents: 10, draft: { pageId: job.page.id, sections: [] } })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.sink.pages.size).toBe(0);
  });

  it("deleteProjectWiki (a project's removal) is the same three deletes, safe to repeat, and keyed by company and project", async () => {
    const store = new MemoryDocumentStore();
    const a = world({ store });
    const b = world({ store, company: COMPANY_B });
    await fill(a, "beacon");
    await fill(b, "beacon");
    const kept = await sizes(a, COMPANY_B, "beacon");
    const first = await deleteProjectWiki({ store, companyId: COMPANY_A, now: () => T0 }, "beacon");
    expect(first.wikiRows).toBeGreaterThan(0);
    expect(first).toMatchObject({ buildRows: 2, useRows: 1 });
    expect(await deleteProjectWiki({ store, companyId: COMPANY_A, now: () => T0 }, "beacon")).toEqual({ buildRows: 0, wikiRows: 0, useRows: 0 });
    expect(await sizes(a, COMPANY_A, "beacon")).toEqual({ wiki: 0, use: 0, build: 0 });
    expect(await sizes(a, COMPANY_B, "beacon")).toEqual(kept);
    await expect(deleteProjectWiki({ store, companyId: COMPANY_A, now: () => T0 }, "../x")).rejects.toBeDefined();
  });
});

describe("audit tokens and a pointer that moved (review M1, L3)", () => {

  it("deleting the build's rows leaves the pointer of a run that started after the pointer was read", async () => {
    const w = world();
    await startWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    const seen = (await readWikiBuildPointer(w.store, w.company, "beacon"))!;
    // A newer run replaces the pointer between the query and the delete.
    const racing = {
      query: async (request: Parameters<MemoryDocumentStore["query"]>[0]) => {
        const answer = await w.store.query(request);
        await w.store.update({ key: wikiBuildRunKey({ orgId: w.company, project: "beacon" }), ops: [change.set("taskId", "newer-run")], condition: when.present() });
        return answer;
      },
      delete: (request: Parameters<MemoryDocumentStore["delete"]>[0]) => w.store.delete(request),
    };
    await deleteWikiBuildRows(racing, { orgId: w.company, project: "beacon" });
    const after = await readWikiBuildPointer(w.store, w.company, "beacon");
    expect(after?.taskId).toBe("newer-run");
    expect(after?.taskId).not.toBe(seen.taskId);
  });
});
