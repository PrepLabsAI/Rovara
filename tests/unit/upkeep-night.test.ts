// Lead 4 N1: one night of nightly upkeep, from the scheduler's fire to the wiki refresh behind the one unattended door. The rules under test: OFF does nothing; the order is setup check, mock checks, wiki refresh;
// the AI step starts only with an enforced dollar cap, only for pages that are out of date, only as the project's system owner with origin `nightly`, and never builds a first wiki; a pause (the limit read, or the
// gateway's refusal of a started run) writes the admins' notice once; a night that is fine is silent. Every read and write is keyed by company AND project (two-project and two-company cases below). Mutants are
// listed in the PR body with the test that kills each.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UPKEEP_TARGET_KIND, queryAll, type DueSchedule, type OrgId, type WikiBuildRecord, type WikiPageWrite } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { modulePageId } from "../../packages/broker/src/core/wiki-build/plan.js";
import { nextWikiPage, readWikiBuildPointer, submitWikiPage, type WikiBuildDeps, type WikiBuildStanding, type WikiPageLoopDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import { PENDING_PK } from "../../packages/broker/src/core/notify/index.js";
import { runUpkeepNight, type UpkeepNightDeps } from "../../packages/broker/src/core/upkeep/night.js";
import { nightRequestId, startUpkeepWikiRefresh, type UpkeepRefreshDeps } from "../../packages/broker/src/core/upkeep/refresh.js";
import { setUpkeepEnabled, upkeepIsOn, type UpkeepSettingsDeps } from "../../packages/broker/src/core/upkeep/settings.js";
import { UPKEEP_DEFAULT_CRON_UTC, createUpkeepSchedule, fireUpkeep, subscribeUpkeep, upkeepPauseHooks, upkeepScheduleName } from "../../packages/broker/src/core/upkeep/wiring.js";
import { API_SHA, COMPANY_A, COMPANY_B, FakeSink, FakeStarter, WEB_SHA, area, fileMap, reader, repoEntry } from "../support/wiki-build-fixtures.js";

const ADMIN = "d1".repeat(32);
const PERSON_ADMIN = "e1".repeat(32);
const T0 = Date.parse("2026-11-17T04:30:00.000Z");
const API_FILE = "export function startServer(port: number) {\n  return listen(port, routes);\n}\n";
const CLAIM = { claimId: "c0001", text: "A claim", citations: [{ repo: "api", path: "src/server.ts", commit: API_SHA, line: 1, quote: "export function startServer(port: number) {" }], source: "found" as const, checkedAt: "2026-11-17T09:00:00.000Z" };
const page = (pageId: string): WikiPageWrite => ({
  pageId, kind: pageId === "overview" ? "overview" : pageId.startsWith("repo-") ? "repo" : "module", title: `Page ${pageId}`, summary: "Summary", order: 0, repos: [{ repo: "api", commit: API_SHA }],
  blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }], claims: [CLAIM], buildId: "build-0001",
});
const FULL = ["overview", "repo-api", "repo-web", modulePageId("api", "src"), modulePageId("web", "app"), "connections"];

interface Options { store?: MemoryDocumentStore; company?: OrgId; enforces?: boolean; aiKey?: "connected" | "missing" | "unknown"; admissionRefuses?: string; limit?: UpkeepNightDeps["limit"]; heads?: UpkeepNightDeps["heads"]; recipients?: string[] }

function world(options: Options = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const clock = { ms: T0 };
  const now = () => clock.ms;
  const starter = new FakeStarter(store);
  const records: WikiBuildRecord[] = [];
  const sink = new FakeSink(company, "beacon");
  const map = fileMap([repoEntry("api", [area("src", { rank: 1 })]), repoEntry("web", [area("app", { rank: 1 })])]);
  const standing = async (): Promise<WikiBuildStanding> => ({ access: "none" });
  const build: WikiBuildDeps = {
    store, companyId: company, now, starter, standing, modelAccessConfigured: true, aiKey: async () => options.aiKey ?? "connected", fileMap: async () => map,
    defaultBranchHeads: async () => [{ repo: "api", commit: API_SHA }, { repo: "web", commit: WEB_SHA }], limitSetting: async () => ({ budgetCents: 1_000, pageReserveCents: 100 }),
    recordBuild: async (record) => { records.push(record); },
  };
  const wiki = createWikiStore({ store, companyId: company, now });
  const admissions: Array<{ action: string; project?: string | undefined; estimate?: unknown }> = [];
  const enforces = { dollars: options.enforces ?? true };
  const refreshDeps: UpkeepRefreshDeps = {
    build, wiki,
    run: {
      companyId: company, admission: {
        enforcesCost: enforces.dollars,
        admit: async (request) => { admissions.push({ action: request.action, projectName: request.projectName, estimate: request.estimate } as never); return options.admissionRefuses === undefined ? { allowed: true } : { allowed: false, code: options.admissionRefuses, message: "no" }; },
        stage: async () => ({ decision: { allowed: true }, items: [] }), settle: async () => undefined, release: async () => undefined,
      }, audit: { stage: () => [], record: async () => undefined }, enforces, now,
    },
  };
  const settings: UpkeepSettingsDeps = { store, companyId: company, now, standing: async (person) => ({ access: person === PERSON_ADMIN ? "manage" : "none" }) };
  const calls: string[] = [];
  const noticePeople = options.recipients ?? [ADMIN];
  const hooks = upkeepPauseHooks({ store, companyId: company, now, recipients: async () => noticePeople });
  const logs: Array<Record<string, unknown>> = [];
  const night: UpkeepNightDeps = {
    store, companyId: company, now, enforces, heads: options.heads ?? (async () => [{ repo: "api", commit: API_SHA }, { repo: "web", commit: WEB_SHA }]),
    setupCheck: async (project) => { calls.push(`setup:${project}`); }, mockChecks: async (project) => { calls.push(`mock:${project}`); },
    ...(options.limit === undefined ? {} : { limit: options.limit }), refresh: async (project, day, options) => { calls.push(`wiki:${project}`); return startUpkeepWikiRefresh(refreshDeps, { project, day, ...options }); },
    paused: (input) => hooks.paused(input), log: (entry) => logs.push(entry),
  };
  const loop: WikiPageLoopDeps = {
    store, companyId: company, now, standing, read: reader({ [`api:src/server.ts@${API_SHA}`]: API_FILE }).read, sink, recordBuild: async (record) => { records.push(record); },
    upkeepOn: (project) => upkeepIsOn({ store, companyId: company }, project), onUpkeepPaused: (scope, reason) => hooks.onRunPaused(scope, reason),
  };
  const on = async (project = "beacon") => { await setUpkeepEnabled(settings, { personId: PERSON_ADMIN, project, requestId: randomUUID(), on: true, fromPage: true }); };
  const seed = async (project: string, ids: string[] = FULL) => { for (const id of ids) await wiki.writePage(project, page(id)); };
  const pendingRows = async () => (await store.query({ pk: PENDING_PK })).items;
  return { store, company, clock, starter, records, wiki, build, refreshDeps, settings, night, loop, calls, logs, on, seed, admissions, pendingRows, hooks };
}
type World = ReturnType<typeof world>;
const stale = async (w: World, project = "beacon") => { await w.wiki.addFlag(project, { pageId: "repo-api", by: { kind: "person", personId: "p1" } }); };

describe("the switch: off does nothing, on is the project's own row", () => {
  it("a project with upkeep off runs nothing and reads nothing else (no heads, no checks, no refresh)", async () => {
    const w = world();
    await w.seed("beacon");
    await stale(w);
    const result = await runUpkeepNight(w.night, { project: "beacon" });
    expect(result).toEqual({ outcome: "off", setupCheck: "skipped", mockChecks: "skipped", wiki: "skipped" });
    expect(w.calls).toEqual([]);
    expect(w.starter.started).toHaveLength(0);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
  });

  it("is switched by a manager on the page only: not by a viewer, not by a token, not without a valid request id; the record is written BEFORE the row", async () => {
    const w = world();
    const order: string[] = [];
    const settings: UpkeepSettingsDeps = { ...w.settings, record: async (_action, _project, details) => { order.push(`record:${String(details.on)}`); expect(await upkeepIsOn(w.settings, "beacon")).toBe(false); } };
    const ask = (over: Record<string, unknown> = {}) => setUpkeepEnabled(settings, { personId: PERSON_ADMIN, project: "beacon", requestId: randomUUID(), on: true, fromPage: true, ...over });
    await expect(ask({ personId: "viewer" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(setUpkeepEnabled({ ...settings, standing: async () => ({ access: "view" }) }, { personId: "v", project: "beacon", requestId: randomUUID(), on: true, fromPage: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ask({ fromPage: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ask({ requestId: "nope" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(ask({ on: "yes" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await upkeepIsOn(w.settings, "beacon")).toBe(false);
    const requestId = randomUUID();
    expect(await ask({ requestId })).toMatchObject({ enabled: true, changed: true });
    expect(order).toEqual(["record:true"]);
    // A repeat of the request is one act: nothing more is recorded.
    expect(await ask({ requestId })).toMatchObject({ enabled: true, changed: false });
    expect(order).toEqual(["record:true"]);
    // An act whose record cannot be written is not done.
    const broken: UpkeepSettingsDeps = { ...settings, record: async () => { throw new Error("audit down"); } };
    await expect(setUpkeepEnabled(broken, { personId: PERSON_ADMIN, project: "beacon", requestId: randomUUID(), on: false, fromPage: true })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await upkeepIsOn(w.settings, "beacon")).toBe(true);
  });

  it("the schedule follows the switch: ON puts the project's night at the default time, OFF removes it", async () => {
    const puts: unknown[] = [];
    const removes: unknown[] = [];
    const schedule = createUpkeepSchedule({ put: async (entry) => { puts.push(entry); }, remove: async (...args) => { removes.push(args); return true; } });
    const w = world();
    const settings = { ...w.settings, schedule };
    await setUpkeepEnabled(settings, { personId: PERSON_ADMIN, project: "beacon", requestId: randomUUID(), on: true, fromPage: true });
    expect(puts).toEqual([expect.objectContaining({ companyId: COMPANY_A, scheduleId: upkeepScheduleName(COMPANY_A, "beacon"), when: { kind: "cron", cron: UPKEEP_DEFAULT_CRON_UTC, timezone: "UTC" }, enabled: true, target: { kind: UPKEEP_TARGET_KIND, ref: { project: "beacon" } } })]);
    await setUpkeepEnabled(settings, { personId: PERSON_ADMIN, project: "beacon", requestId: randomUUID(), on: false, fromPage: true });
    expect(removes).toEqual([[COMPANY_A, upkeepScheduleName(COMPANY_A, "beacon")]]);
    expect(upkeepScheduleName(COMPANY_A, "beacon")).not.toBe(upkeepScheduleName(COMPANY_B, "beacon"));
    expect(upkeepScheduleName(COMPANY_A, "beacon")).not.toBe(upkeepScheduleName(COMPANY_A, "other"));
  });
});

describe("the order of a night and what it is silent about", () => {

  it("a free step that fails never stops the next step, and is logged in fixed words", async () => {
    const w = world();
    await w.on();
    await w.seed("beacon");
    await stale(w);
    const night: UpkeepNightDeps = { ...w.night, setupCheck: async () => { throw new Error("secret-token-xyz in a path /repo/src"); } };
    const result = await runUpkeepNight(night, { project: "beacon" });
    expect(result).toMatchObject({ setupCheck: "failed", mockChecks: "done", wiki: "started" });
    expect(JSON.stringify(w.logs)).not.toContain("secret-token");
    expect(w.logs).toContainEqual({ event: "upkeep.step_failed", step: "setup_check", error: "Error" });
  });

  it("a night with nothing merged skips the free checks; with nothing stale the wiki is silent too, and the night says nothing_changed", async () => {
    const w = world();
    await w.on();
    await w.seed("beacon");
    expect((await runUpkeepNight(w.night, { project: "beacon" })).outcome).toBe("ran");
    expect(w.calls).toEqual(["setup:beacon", "mock:beacon", "wiki:beacon"]);
    w.calls.length = 0;
    w.clock.ms += 86_400_000;
    const second = await runUpkeepNight(w.night, { project: "beacon" });
    expect(w.calls).toEqual(["wiki:beacon"]);
    expect(second).toMatchObject({ outcome: "nothing_changed", setupCheck: "skipped", mockChecks: "skipped", wiki: "nothing_to_refresh" });
    expect(w.starter.started).toHaveLength(0);
    expect(await w.pendingRows()).toHaveLength(0);
    // A merge (a new head) brings the free checks back.
    w.calls.length = 0;
    w.clock.ms += 86_400_000;
    const moved = { ...w.night, heads: async () => [{ repo: "api", commit: "c".repeat(40) }, { repo: "web", commit: WEB_SHA }] };
    expect((await runUpkeepNight(moved, { project: "beacon" })).setupCheck).toBe("done");
    expect(w.calls.slice(0, 2)).toEqual(["setup:beacon", "mock:beacon"]);
  });

  it("an unreadable code host counts as merged for the free checks, but no AI is bought on a night that cannot tell what it would refresh", async () => {
    const w = world({ heads: async () => { throw new Error("host down"); } });
    await w.on();
    await w.seed("beacon");
    await stale(w);
    const result = await runUpkeepNight(w.night, { project: "beacon" });
    expect(result).toMatchObject({ outcome: "failed", setupCheck: "done", wiki: "heads_unreadable" });
    expect(w.starter.started).toHaveLength(0);
    expect(w.admissions).toHaveLength(0);
  });

  it("a double fire of one night starts one run (the night's own request id), and a run in flight is busy, not a second run", async () => {
    const w = world();
    await w.on();
    await w.seed("beacon");
    await stale(w);
    const first = await startUpkeepWikiRefresh(w.refreshDeps, { project: "beacon", day: "2026-11-17" });
    const again = await startUpkeepWikiRefresh(w.refreshDeps, { project: "beacon", day: "2026-11-17" });
    expect(first).toMatchObject({ outcome: "started", duplicate: false });
    expect(again).toMatchObject({ outcome: "started", duplicate: true, taskId: (first as { taskId: string }).taskId });
    expect(w.starter.started).toHaveLength(1);
    expect(await startUpkeepWikiRefresh(w.refreshDeps, { project: "beacon", day: "2026-11-18" })).toEqual({ outcome: "busy" });
    expect(w.starter.started).toHaveLength(1);
    expect(nightRequestId(COMPANY_A, "beacon", "2026-11-17")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(nightRequestId(COMPANY_A, "beacon", "2026-11-17")).not.toBe(nightRequestId(COMPANY_A, "other", "2026-11-17"));
    expect(nightRequestId(COMPANY_A, "beacon", "2026-11-17")).not.toBe(nightRequestId(COMPANY_B, "beacon", "2026-11-17"));
  });
});

describe("no paying again for the same commits", () => {
  it("a refresh already started at these commits is not started again the next night, even with a flagged page; a merge (new head) brings it back", async () => {
    const w = world();
    await w.on();
    await w.seed("beacon");
    await stale(w);
    expect((await runUpkeepNight(w.night, { project: "beacon" })).wiki).toBe("started");
    // The run ended with the page still flagged (its rewrite did not clear the flag) and nothing merged since.
    await w.wiki.addFlag("beacon", { pageId: "repo-web", by: { kind: "person", personId: "p1" } });
    w.clock.ms += 86_400_000;
    const second = await runUpkeepNight(w.night, { project: "beacon" });
    expect(second).toMatchObject({ outcome: "nothing_changed", wiki: "already_refreshed" });
    expect(w.starter.started).toHaveLength(1);
    expect(w.admissions).toHaveLength(1);
    w.clock.ms += 86_400_000;
    const moved = { ...w.night, heads: async () => [{ repo: "api", commit: "c".repeat(40) }, { repo: "web", commit: WEB_SHA }] };
    await w.store.delete({ key: { pk: `ORG#${COMPANY_A}#WIKI_BUILD#beacon`, sk: "RUN" } });
    expect((await runUpkeepNight(moved, { project: "beacon" })).wiki).toBe("started");
  });

});

describe("money: the AI step needs an enforced dollar cap, upkeep ON for the project and the company's key", () => {
  it("refuses without an enforced cost cap before Admission is asked, starts nothing, writes no run, and says no_cost_cap", async () => {
    const w = world({ enforces: false });
    await w.on();
    await w.seed("beacon");
    await stale(w);
    const result = await runUpkeepNight(w.night, { project: "beacon" });
    expect(result).toMatchObject({ outcome: "no_cost_cap", wiki: "no_cost_cap" });
    // The free steps still ran (they use no AI).
    expect(result.setupCheck).toBe("done");
    expect(w.admissions).toHaveLength(0);
    expect(w.starter.started).toHaveLength(0);
    expect(await readWikiBuildPointer(w.store, w.company, "beacon")).toBeUndefined();
    // The door itself refuses too (a caller that skipped the night's own check): the refresh answers no_cost_cap.
    expect(await startUpkeepWikiRefresh(w.refreshDeps, { project: "beacon", day: "2026-11-17" })).toEqual({ outcome: "no_cost_cap" });
    expect(w.starter.started).toHaveLength(0);
  });

  it("the door reads THIS project's switch: ON for beacon never starts a run for other", async () => {
    const w = world();
    await w.on("beacon");
    await w.seed("other", FULL);
    await w.wiki.addFlag("other", { pageId: "repo-api", by: { kind: "person", personId: "p1" } });
    await expect(startUpkeepWikiRefresh(w.refreshDeps, { project: "other", day: "2026-11-17" })).rejects.toMatchObject({ code: "NOT_AVAILABLE_HERE" });
    expect(w.starter.started).toHaveLength(0);
    expect(w.admissions).toHaveLength(0);
  });

  it("no AI key connected: nothing starts, and the night says needs_ai_key without a notice", async () => {
    const w = world({ aiKey: "missing" });
    await w.on();
    await w.seed("beacon");
    await stale(w);
    expect(await runUpkeepNight(w.night, { project: "beacon" })).toMatchObject({ outcome: "needs_ai_key", wiki: "needs_ai_key" });
    expect(w.starter.started).toHaveLength(0);
    expect(await w.pendingRows()).toHaveLength(0);
  });

  it("an Admission refusal starts nothing and is thrown as the door threw it (the night records failed)", async () => {
    const w = world({ admissionRefuses: "budget_exhausted" });
    await w.on();
    await w.seed("beacon");
    await stale(w);
    const result = await runUpkeepNight(w.night, { project: "beacon" });
    expect(result).toMatchObject({ outcome: "failed", wiki: "failed" });
    expect(w.starter.started).toHaveLength(0);
  });

  it("a limit read that fails or is absent leaves the gateway's own refusal as the wall: the refresh is attempted", async () => {
    const down = world({ limit: async () => { throw new Error("cloud down"); } });
    await down.on();
    await down.seed("beacon");
    await stale(down);
    expect((await runUpkeepNight(down.night, { project: "beacon" })).wiki).toBe("started");
  });
});

describe("an unattended run: no person's standing, upkeep ON read before every page, and the gateway's pause", () => {
  async function started(w: World) {
    await w.on();
    await w.seed("beacon", ["overview", "repo-api", "repo-web", modulePageId("api", "src")]);
    await stale(w);
    const answer = await startUpkeepWikiRefresh(w.refreshDeps, { project: "beacon", day: "2026-11-17" });
    expect(answer.outcome).toBe("started");
    return { scope: { orgId: w.company, project: "beacon", taskId: (answer as { taskId: string }).taskId } };
  }

  it("grants a page while upkeep is ON and ends the run access_lost the moment it is switched off (a system owner has no standing as a person)", async () => {
    const w = world();
    const { scope } = await started(w);
    const first = await nextWikiPage(w.loop, scope, { spentCents: 0 });
    expect(first).toMatchObject({ kind: "page", page: { id: "repo-api" } });
    await setUpkeepEnabled(w.settings, { personId: PERSON_ADMIN, project: "beacon", requestId: randomUUID(), on: false, fromPage: true });
    expect(await nextWikiPage(w.loop, scope, { spentCents: 0 })).toEqual({ kind: "end", word: "access_lost" });
    expect((await readWikiBuildPointer(w.store, w.company, "beacon"))!.end?.word).toBe("access_lost");
  });

  it("the gateway's pause ends the run upkeep_paused, keeps finished pages, and writes the admins' notice once", async () => {
    const w = world();
    const { scope } = await started(w);
    await nextWikiPage(w.loop, scope, { spentCents: 0 });
    const receipt = await submitWikiPage(w.loop, scope, { pageId: "repo-api", spentCents: 20, failure: "upkeep_paused", pause: "monthly_limit" });
    expect(receipt).toMatchObject({ kept: false, complete: false });
    const pointer = (await readWikiBuildPointer(w.store, w.company, "beacon"))!;
    expect(pointer.end?.word).toBe("upkeep_paused");
    expect(w.records.at(-1)).toMatchObject({ kind: "nightly", state: "stopped", stopReason: "cap" });
    expect((await w.pendingRows()).map((row) => row["kind"])).toEqual(["upkeep_paused"]);
    expect(await nextWikiPage(w.loop, scope, { spentCents: 20 })).toEqual({ kind: "end", word: "upkeep_paused" });
    // The same pause seen again (another worker, the next night) is not a second notice.
    await w.hooks.onRunPaused(scope, "monthly_limit");
    expect(await w.pendingRows()).toHaveLength(1);
  });

  it("a PERSON's build never ends upkeep_paused or writes the notice: the same failure word from it is a fault", async () => {
    const w = world();
    // A person-started pointer: seeded through the build's own start with a person's standing.
    const { startWikiBuild } = await import("../../packages/broker/src/core/wiki-build/run.js");
    await w.seed("beacon", ["overview"]);
    const person: WikiBuildDeps = { ...w.build, standing: async () => ({ access: "manage" }) };
    await startWikiBuild(person, "p-person", "beacon", { requestId: randomUUID() });
    const pointer = (await readWikiBuildPointer(w.store, w.company, "beacon"))!;
    expect(pointer.unattended).toBeUndefined();
    const scope = { orgId: w.company, project: "beacon", taskId: pointer.taskId };
    const loop = { ...w.loop, standing: async (): Promise<WikiBuildStanding> => ({ access: "manage" }) };
    const job = await nextWikiPage(loop, scope, { spentCents: 0 });
    expect(job.kind).toBe("page");
    await submitWikiPage(loop, scope, { pageId: (job as { page: { id: string } }).page.id, spentCents: 10, failure: "upkeep_paused", pause: "no_budget" });
    expect((await readWikiBuildPointer(w.store, w.company, "beacon"))!.end?.word).toBe("infrastructure");
    expect(await w.pendingRows()).toHaveLength(0);
  });

});

describe("the fire: only upkeep targets, only a company this install serves, only a project name", () => {
  const due = (over: Partial<DueSchedule> = {}): DueSchedule => ({ companyId: COMPANY_A, scheduleId: "s", scheduledAt: new Date(T0).toISOString(), slotId: "slot", attempt: 1, target: { kind: UPKEEP_TARGET_KIND, ref: { project: "beacon" } }, ...over });

  it("runs the night for the company the fire names; ignores another kind, another company, a bad project", async () => {
    const w = world();
    await w.on();
    await w.seed("beacon");
    const forCompany = (company: string) => (company === COMPANY_A ? w.night : undefined);
    expect(await fireUpkeep(forCompany, due())).toMatchObject({ project: "beacon", outcome: "ran" });
    expect(await fireUpkeep(forCompany, due({ target: { kind: "nightly", ref: { project: "beacon" } } }))).toEqual({ outcome: "ignored" });
    expect(await fireUpkeep(forCompany, due({ companyId: COMPANY_B }))).toEqual({ outcome: "ignored" });
    expect(await fireUpkeep(forCompany, due({ target: { kind: UPKEEP_TARGET_KIND, ref: { project: "Bad Name" } } }))).toEqual({ outcome: "ignored" });
    expect(await fireUpkeep(forCompany, due({ target: { kind: UPKEEP_TARGET_KIND, ref: {} } }))).toEqual({ outcome: "ignored" });
    // A company's deps that name another company are never run for this fire.
    expect(await fireUpkeep(() => ({ ...w.night, companyId: COMPANY_B }), due())).toEqual({ outcome: "ignored" });
  });

  it("the subscription hears upkeep fires only and logs the outcome in fixed words", async () => {
    const w = world();
    await w.on();
    const handlers: Array<(due: DueSchedule) => Promise<void>> = [];
    const logs: unknown[] = [];
    subscribeUpkeep({ scheduler: { subscribe: (handler) => { handlers.push(handler); return { stop: async () => undefined }; } }, forCompany: () => w.night, log: (entry) => logs.push(entry) });
    await handlers[0]!(due({ target: { kind: "nightly", ref: { project: "beacon" } } }));
    expect(logs).toEqual([]);
    await handlers[0]!(due());
    expect(logs).toEqual([{ event: "upkeep.fire", outcome: expect.any(String) as string, attempt: 1 }]);
  });
});
