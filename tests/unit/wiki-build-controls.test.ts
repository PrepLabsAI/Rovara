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
import { API_SHA, COMPANY_A, COMPANY_B, FakeSink, FakeStarter, WEB_SHA, area, fileMap, reader, repoEntry } from "../support/wiki-build-fixtures.js";

const ADMIN = "person-admin";
const VIEWER = "person-viewer";
const OUTSIDER = "person-outsider";
const T0 = Date.parse("2026-11-17T12:00:00.000Z");
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
    store, companyId: company, now: () => T0, starter, standing, modelAccessConfigured: true, aiKey: async () => "connected", fileMap: async () => map,
    defaultBranchHeads: async () => [{ repo: "api", commit: API_SHA }, { repo: "web", commit: WEB_SHA }], limitSetting: async () => ({ budgetCents: 1_000, pageReserveCents: 100 }),
    recordBuild: async (record) => { records.push(record); }, ...options.deps,
  };
  const wiki = createWikiStore({ store, companyId: company, now: () => T0 });
  const audited: Array<{ action: WikiControlAction; project: string; requestId: string; on?: boolean }> = [];
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

  it("is per company: company B's wiki and switch for the same project name never show in company A's view", async () => {
    const store = new MemoryDocumentStore();
    const a = world({ store });
    const b = world({ store, company: COMPANY_B });
    await seedWiki(b, "beacon", ["overview", "repo-api", "repo-web"]);
    await setWikiAgentSwitch(b.controls.agents, "beacon", true);
    expect(await wikiControlsView(a.controls, ADMIN, "beacon")).toMatchObject({ agents: { on: false }, wiki: { pages: 0 } });
    expect(await wikiControlsView(b.controls, ADMIN, "beacon")).toMatchObject({ agents: { on: true }, wiki: { pages: 3 } });
  });
});

describe("Build, Stop and Continue: manage only, the run's own rules, audited first", () => {
  it("a manager builds: the project pays, the request is audited BEFORE the task starts, and the answer is the full view", async () => {
    const order: string[] = [];
    const w = world({ record: async (action) => { order.push(`audit:${action}`); } });
    const origStart = w.starter.start.bind(w.starter);
    w.starter.start = async (request) => { order.push("start"); return origStart(request); };
    const requestId = id();
    const done = await startWikiControl(w.controls, ADMIN, "beacon", { requestId });
    expect(done.status).toBe(202);
    expect(done.view).toMatchObject({ status: "running", canManage: true, payer: "project", wiki: { pages: 0 } });
    expect(order).toEqual(["audit:start_requested", "start"]);
    expect(w.starter.started[0]).toMatchObject({ project: "beacon", payer: { kind: "project", project: "beacon" } });
    // A repeat of the request id starts nothing more.
    expect((await startWikiControl(w.controls, ADMIN, "beacon", { requestId })).status).toBe(200);
    expect(w.starter.started).toHaveLength(1);
  });

  it("a viewer and a person with no role start, stop and continue nothing, and nothing is audited", async () => {
    const w = world();
    await startWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    const before = w.audited.length;
    for (const control of [startWikiControl, stopWikiControl, continueWikiControl]) {
      await expect(control(w.controls, VIEWER, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "FORBIDDEN", message: `FORBIDDEN: ${WIKI_BUILD_WORDS.notAllowed}` });
      await expect(control(w.controls, OUTSIDER, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
    expect(w.audited).toHaveLength(before);
    expect(w.starter.started).toHaveLength(1);
    expect(w.starter.cancelled).toHaveLength(0);
    expect((await readWikiBuildPointer(w.store, w.company, "beacon"))?.stop).toBeUndefined();
  });

  it("a manager of project A cannot build, stop or continue project B they do not manage", async () => {
    const w = world({ manages: ["beacon"] });
    for (const control of [startWikiControl, stopWikiControl, continueWikiControl]) {
      await expect(control(w.controls, ADMIN, "other", { requestId: id() })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
    expect(w.starter.started).toHaveLength(0);
    expect(await readWikiBuildPointer(w.store, w.company, "other")).toBeUndefined();
  });

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

  it("rewrites only the pages marked wrong, with changed claims, or not yet written (kind refresh, at today's commits); up-to-date pages are left alone", async () => {
    const w = world();
    await seedWiki(w, "beacon", ["overview", "repo-api", "repo-web", modulePageId("api", "src")]);
    await w.wiki.addFlag("beacon", { pageId: "repo-api", by: { kind: "person", personId: "p1" } });
    await w.wiki.markClaims("beacon", modulePageId("api", "src"), [{ claimId: "c0001", source: "changed" }]);
    const done = await refreshWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    expect(done.status).toBe(202);
    const pointer = (await readWikiBuildPointer(w.store, w.company, "beacon"))!;
    // Not planned: overview and repo-web (up to date). Planned: flagged, changed, and the two planned pages that were never written.
    expect(pointer.plan.map((p) => p.id)).toEqual(["repo-api", modulePageId("api", "src"), modulePageId("web", "app"), "connections"]);
    expect(FULL.filter((id) => !pointer.plan.some((p) => p.id === id))).toEqual(["overview", "repo-web"]);
    expect(pointer).toMatchObject({ buildKind: "refresh", payer: { kind: "project", project: "beacon" } });
    expect(w.records.at(-1)).toMatchObject({ kind: "refresh", state: "running" });
    expect(w.audited.map((entry) => entry.action)).toEqual(["refresh_requested"]);
  });

  it("refuses with nothing started when there is no wiki, or when everything is up to date", async () => {
    const empty = world();
    await expect(refreshWikiControl(empty.controls, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: `CONFIG_INVALID: ${WIKI_CONTROLS_WORDS.buildFirst}` });
    const w = world();
    await seedWiki(w, "beacon", FULL);
    await expect(refreshWikiControl(w.controls, ADMIN, "beacon", { requestId: id() })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: `CONFIG_INVALID: ${WIKI_CONTROLS_WORDS.nothingToRefresh}` });
    expect(empty.starter.started.length + w.starter.started.length).toBe(0);
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

  it("a viewer and a person with no role cannot change it, and nothing is written or audited; a manager of another project cannot reach this one", async () => {
    const w = world({ manages: ["other"], views: ["beacon"] });
    await expect(agentsSwitchControl(w.controls, VIEWER, "beacon", { requestId: id(), on: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agentsSwitchControl(w.controls, OUTSIDER, "beacon", { requestId: id(), on: true })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(agentsSwitchControl(w.controls, ADMIN, "beacon", { requestId: id(), on: true })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await store(w).get(wikiAgentSwitchKey(w.company, "beacon"))).toBeUndefined();
    expect(w.audited).toHaveLength(0);
  });

  it("the body is strict: on must be a boolean and nothing else is allowed", async () => {
    const w = world();
    for (const body of [{ requestId: id() }, { requestId: id(), on: "yes" }, { requestId: id(), on: true, project: "other" }, { on: true }]) {
      await expect(agentsSwitchControl(w.controls, ADMIN, "beacon", body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(await store(w).get(wikiAgentSwitchKey(w.company, "beacon"))).toBeUndefined();
  });
});
const store = (w: World): MemoryDocumentStore => w.store;

describe("Delete wiki: W2's deleteWiki AND A1's deleteWikiUse AND the build's own rows, for this company and project only", () => {
  const partitions = (company: OrgId, project: string) => ({ wiki: wikiPartition(company, project), use: wikiUsePartition(company, project), build: wikiBuildPartition({ orgId: company, project }) });

  async function fill(w: World, project: string): Promise<void> {
    await seedWiki(w, project, ["overview", "repo-api"]);
    await w.wiki.addNote(project, { pageId: "overview", text: "a note", authorId: "p1" });
    await w.wiki.addFlag(project, { pageId: "overview", by: { kind: "person", personId: "p1" } });
    await w.wiki.writeBuild(project, { buildId: "build-0001", kind: "first", state: "done", startedBy: "p1", startedAt: "2026-11-17T10:00:00.000Z", repos: [{ repo: "api", commit: API_SHA }], counts: { pagesWritten: 1, claimsKept: 1, claimsDropped: 0, skipped: 0 }, dropped: [], skipped: [] } as WikiBuildRecord);
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

  it("a project made again under the same name never inherits the switch: it is off after the delete", async () => {
    const w = world();
    await fill(w, "beacon");
    expect(await wikiAgentSwitchIsOn(w.controls.agents, "beacon")).toBe(true);
    await deleteWikiControl(w.controls, ADMIN, "beacon", { requestId: id() }, { store: w.store, now: () => T0 });
    expect(await wikiAgentSwitchIsOn(w.controls.agents, "beacon")).toBe(false);
    expect(await w.store.get(wikiAgentSwitchKey(w.company, "beacon"))).toBeUndefined();
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

describe("the answers match the contract the setup page reads", () => {
  it("every state answer parses with WikiControlsViewSchema, in each status", async () => {
    const { WikiControlsViewSchema } = await import("@agentx/contracts");
    const w = world();
    expect(WikiControlsViewSchema.parse(await wikiControlsView(w.controls, ADMIN, "beacon"))).toMatchObject({ status: "none" });
    const running = await startWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    expect(WikiControlsViewSchema.parse(running.view)).toMatchObject({ status: "running" });
    const stopped = await stopWikiControl(w.controls, ADMIN, "beacon", { requestId: id() });
    expect(WikiControlsViewSchema.parse(stopped.view)).toMatchObject({ status: "stopped", stop: "stopped_by_person" });
    const missing = world({ deps: { aiKey: async () => "missing" } });
    expect(WikiControlsViewSchema.parse(await wikiControlsView(missing.controls, ADMIN, "beacon"))).toMatchObject({ aiKey: "missing", connectKey: WIKI_BUILD_WORDS.connectKey });
  });
});
