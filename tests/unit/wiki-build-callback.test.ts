// Wiki W3b: the wiki build's callback (`handleWikiBuildCallback`). The run, the company and the project come ONLY from the authenticated operation (never the body); two projects and two companies in one
// store cannot reach each other's page loop, pointer, sink or spend; an operation that is not a running wiki build of this company is refused. Mutants (listed in the PR body) are killed by the tests named in the comments.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { change, orgLimitKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { handleWikiBuildCallback, wikiBuildRunOfOperation, type WikiBuildCallbackDeps, type WikiBuildOperation } from "../../packages/broker/src/core/wiki-build/callback.js";
import { readWikiBuildPointer, startWikiBuild, type WikiBuildDeps, type WikiBuildStanding } from "../../packages/broker/src/core/wiki-build/run.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { API_SHA, COMPANY_A, COMPANY_B, FakeSink, FakeStarter, area, fileMap, reader, repoEntry } from "../support/wiki-build-fixtures.js";

const ADMIN = "person-admin";
const API_FILE = "export function startServer(port: number) {\n  return listen(port, routes);\n}\n";
const NOW = Date.parse("2026-11-17T12:00:00.000Z");

interface Run { company: typeof COMPANY_A; project: string; taskId: string; workspaceId: string; operation: WikiBuildOperation }

/** One store, several companies and projects: each build is started through the real start (pointer written by the starter), its task and task pointer written the way the task flow writes them. */
function stage() {
  const store = new MemoryDocumentStore();
  const sinks = new Map<string, FakeSink>();
  const sinkOf = (company: string, project: string): FakeSink => {
    const key = `${company}/${project}`;
    if (!sinks.has(key)) sinks.set(key, new FakeSink(company, project));
    return sinks.get(key)!;
  };
  const standing = async (): Promise<WikiBuildStanding> => ({ access: "manage" });
  const calls: Array<{ company: string; project: string }> = [];
  const begin = async (company: typeof COMPANY_A, project: string, extra: { purpose?: string; taskCompany?: string; closed?: boolean; taskWorkspace?: string } = {}): Promise<Run> => {
    const map = { ...fileMap([repoEntry("api", [area("src", { rank: 1 })])]), project };
    const deps: WikiBuildDeps = {
      store, companyId: company, now: () => NOW, starter: new FakeStarter(store), standing, modelAccessConfigured: true, aiKey: async () => "connected",
      fileMap: async () => map, defaultBranchHeads: async () => [{ repo: "api", commit: API_SHA }], limitSetting: async () => ({ budgetCents: 1_000, pageReserveCents: 100 }),
    };
    await startWikiBuild(deps, ADMIN, project, { requestId: randomUUID() });
    const pointer = (await readWikiBuildPointer(store, company, project))!;
    const workspaceId = randomUUID();
    await store.put({ item: { ...taskKey(pointer.taskId), entityType: "DEVELOPER_TASK", taskId: pointer.taskId, project, companyId: extra.taskCompany ?? company, workspaceId: extra.taskWorkspace ?? workspaceId, purpose: extra.purpose ?? "wiki_build", ...(extra.closed === true ? { closedAt: "2026-11-17T11:00:00.000Z" } : {}) } });
    await store.put({ item: { pk: workspaceKey(company, workspaceId).pk, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: pointer.taskId } });
    return { company, project, taskId: pointer.taskId, workspaceId, operation: { kind: "task", workflowMode: "WIKI_BUILD", status: "RUNNING", workspaceId, companyId: company } };
  };
  const callbackDeps = (company: typeof COMPANY_A): WikiBuildCallbackDeps => ({
    store, companyId: company, now: () => NOW, standing, read: reader({ [`api:src/server.ts@${API_SHA}`]: API_FILE }).read,
    sinkFor: (project) => { calls.push({ company, project }); return sinkOf(company, project); },
  });
  return { store, begin, callbackDeps, sinkOf, calls };
}

const draft = (pageId: string) => ({
  pageId, sections: [{ heading: "Start", claims: [{ sentence: "The server starts in `startServer` with a port.", citations: [{ repo: "api", path: "src/server.ts", commit: API_SHA, line: 1, quote: "export function startServer(port: number) {" }] }] }],
});

describe("the callback's scope is the operation's", () => {

  // MUTANT scope-from-body: the handler reads project / company / task from the body. Killed here: any such field is refused, and nothing is read for it.
  it("a body that names a company, project or task is refused; the strict shapes are the only ones", async () => {
    const s = stage();
    const run = await s.begin(COMPANY_A, "beacon");
    for (const body of [
      { kind: "next", spentCents: 0, project: "other" }, { kind: "next", spentCents: 0, orgId: COMPANY_B }, { kind: "next", spentCents: 0, taskId: randomUUID() },
      { kind: "page", answer: {}, project: "other" }, { kind: "poll" }, { kind: "next" }, { kind: "next", spentCents: -1 }, {},
    ]) {
      await expect(handleWikiBuildCallback(s.callbackDeps(COMPANY_A), run.operation, body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(s.calls).toHaveLength(0);
  });

  // MUTANT scope-from-operation: the run is found from anything but the operation's own task (e.g. the project's current pointer alone).
  it("an operation that is not a running wiki build is refused: wrong kind, wrong mode, ended, or a task that is not a wiki build, not this company's, or closed", async () => {
    const s = stage();
    const good = await s.begin(COMPANY_A, "beacon");
    const refused = (operation: WikiBuildOperation) => expect(handleWikiBuildCallback(s.callbackDeps(COMPANY_A), operation, { kind: "next", spentCents: 0 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await refused({ ...good.operation, kind: "prepare" });
    await refused({ ...good.operation, workflowMode: "SETUP_AGENT" });
    await refused({ ...good.operation, workflowMode: undefined });
    await refused({ ...good.operation, status: "SUCCEEDED" });
    await refused({ ...good.operation, status: "CANCELLED" });
    await refused({ ...good.operation, companyId: COMPANY_B });
    const notWiki = await s.begin(COMPANY_A, "other-project", { purpose: "setup_agent" });
    await refused(notWiki.operation);
    // #934 admits two wiki builds per company at a time: free company A's two slots (this test is about the callback's scope, not the cap) before a third build starts.
    await s.store.update({ key: orgLimitKey(COMPANY_A), ops: [change.remove("wikiBuildSlot0"), change.remove("wikiBuildSlot1")] });
    const foreignTask = await s.begin(COMPANY_A, "third", { taskCompany: COMPANY_B });
    await refused(foreignTask.operation);
    // Each task check holds on its own: an operation that names no company (so the operation's own company cannot refuse it) still meets the task's.
    await refused({ ...foreignTask.operation, companyId: undefined });
    await s.store.update({ key: orgLimitKey(COMPANY_A), ops: [change.remove("wikiBuildSlot0"), change.remove("wikiBuildSlot1")] });
    const closed = await s.begin(COMPANY_A, "fourth", { closed: true });
    await refused(closed.operation);
    // A task that belongs to another workspace than the operation's is not this operation's run.
    await s.store.update({ key: orgLimitKey(COMPANY_A), ops: [change.remove("wikiBuildSlot0"), change.remove("wikiBuildSlot1")] });
    const elsewhere = await s.begin(COMPANY_A, "fifth", { taskWorkspace: randomUUID() });
    await refused(elsewhere.operation);
    // The good one still works, and none of the refusals wrote anything.
    expect(await handleWikiBuildCallback(s.callbackDeps(COMPANY_A), good.operation, { kind: "next", spentCents: 0 })).toMatchObject({ kind: "page" });
    expect(s.calls.filter((call) => call.project !== "beacon")).toHaveLength(0);
  });

});

describe("a page the worker could not finish", () => {
  // MUTANT: the failure word is dropped or the page is marked done, so a continue would skip a page that was never written (or a budget stop ends as a fault).
  it.each(["budget_used", "needs_ai_key", "repo_unreadable", "infrastructure"] as const)("%s ends the run with that word, charges what was spent, and the page is not done (a continue writes it again)", async (word) => {
    const s = stage();
    const run = await s.begin(COMPANY_A, "beacon");
    await handleWikiBuildCallback(s.callbackDeps(COMPANY_A), run.operation, { kind: "next", spentCents: 0 });
    await handleWikiBuildCallback(s.callbackDeps(COMPANY_A), run.operation, { kind: "page", answer: { pageId: "overview", spentCents: 240, failure: word } });
    const pointer = (await readWikiBuildPointer(s.store, COMPANY_A, "beacon"))!;
    expect(pointer).toMatchObject({ end: { word }, spentCents: 240, doneIds: [] });
    expect(pointer.granted).toBeUndefined();
    expect(s.sinkOf(COMPANY_A, "beacon").pages.size).toBe(0);
    expect(await handleWikiBuildCallback(s.callbackDeps(COMPANY_A), run.operation, { kind: "next", spentCents: 240 })).toEqual({ kind: "end", word });
  });

  it("a failure word that is not one of the fixed four is refused", async () => {
    const s = stage();
    const run = await s.begin(COMPANY_A, "beacon");
    await handleWikiBuildCallback(s.callbackDeps(COMPANY_A), run.operation, { kind: "next", spentCents: 0 });
    await expect(handleWikiBuildCallback(s.callbackDeps(COMPANY_A), run.operation, { kind: "page", answer: { pageId: "overview", spentCents: 0, failure: "built" } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("two companies in one store", () => {

  // MUTANT: the company comes from the operation record instead of the callback's own company. Killed: company B's service, given company A's operation, finds no run and refuses.
  it("company B's callback service cannot act on company A's operation, with or without A's company id on it", async () => {
    const s = stage();
    const a = await s.begin(COMPANY_A, "beacon");
    const asB = s.callbackDeps(COMPANY_B);
    await expect(handleWikiBuildCallback(asB, a.operation, { kind: "next", spentCents: 0 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(handleWikiBuildCallback(asB, { ...a.operation, companyId: undefined }, { kind: "next", spentCents: 0 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await wikiBuildRunOfOperation(asB, a.operation)).toBeUndefined();
    expect((await readWikiBuildPointer(s.store, COMPANY_A, "beacon"))!.granted).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });

  it("a sink of another company or project is refused by the loop (the sink is a seam the host fills, and the run still checks it)", async () => {
    const s = stage();
    const a = await s.begin(COMPANY_A, "beacon");
    const wrongProject = { ...s.callbackDeps(COMPANY_A), sinkFor: () => s.sinkOf(COMPANY_A, "elsewhere") };
    await expect(handleWikiBuildCallback(wrongProject, a.operation, { kind: "next", spentCents: 0 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    const wrongCompany = { ...s.callbackDeps(COMPANY_A), sinkFor: (project: string) => s.sinkOf(COMPANY_B, project) };
    await expect(handleWikiBuildCallback(wrongCompany, a.operation, { kind: "next", spentCents: 0 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });
});

describe("through the callback service's route", () => {
  const KEY = Buffer.alloc(32, 9);
  async function routed(options: { served?: boolean; status?: string } = {}) {
    const s = stage();
    const run = await s.begin(COMPANY_A, "beacon");
    const operationId = randomUUID();
    await s.store.put({ item: { ...workspaceKey(COMPANY_A, run.workspaceId), entityType: "WORKSPACE", id: run.workspaceId, companyId: COMPANY_A } });
    await s.store.put({ item: { ...operationKey(COMPANY_A, run.workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId: run.workspaceId, kind: "task", workflowMode: "WIKI_BUILD", status: options.status ?? "RUNNING", fence: 3, companyId: COMPANY_A, dispatch: { kind: "task", payload: {} } } });
    const { store, companyId, now: _now, ...seams } = s.callbackDeps(COMPANY_A);
    void store; void companyId; void _now;
    const handler = createCallbackHandler({ flow: { store: s.store, companyId: COMPANY_A, callbackSigningKey: KEY, now: () => new Date(NOW) } as never, blobs: {} as never, grants: {} as never, ...(options.served === false ? {} : { wikiBuild: seams }) });
    const token = (actions: string[]) => new CallbackCapabilities(KEY).issue({ workspaceId: run.workspaceId, operationId, fence: 3, actions: actions as never, expiresInSeconds: 60 });
    const call = (capability: string, body: unknown) => handler({ method: "POST", path: `/v1/internal/workspaces/${run.workspaceId}/operations/${operationId}/wiki-build`, headers: { "x-agentx-callback-capability": capability, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { s, run, call, token, operationId };
  }
  const json = (reply: { body?: string }) => JSON.parse(reply.body ?? "{}") as Record<string, unknown>;

  it("serves a running wiki build with its own capability: next, then the page", async () => {
    const r = await routed();
    const next = await r.call(r.token(["wiki-build"]), { kind: "next", spentCents: 0 });
    expect(next.statusCode).toBe(200);
    expect(json(next)).toMatchObject({ kind: "page", page: { id: "overview" } });
    const page = await r.call(r.token(["wiki-build"]), { kind: "page", answer: { pageId: "overview", spentCents: 20, draft: draft("overview") } });
    expect(json(page)).toMatchObject({ kept: true });
    expect(r.s.sinkOf(COMPANY_A, "beacon").pages.has("overview")).toBe(true);
  });

  it("a capability for any other action is refused, and an install that does not serve the action answers 'not available' after checking the capability", async () => {
    const r = await routed();
    for (const actions of [["setup-agent"], ["events"], ["result"], ["model-access"], ["events", "artifacts", "result", "setup-agent"]]) {
      const reply = await r.call(r.token(actions), { kind: "next", spentCents: 0 });
      expect(reply.statusCode, actions.join()).toBeGreaterThanOrEqual(400);
      expect(json(reply)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    }
    const unserved = await routed({ served: false });
    expect(json(await unserved.call(unserved.token(["wiki-build"]), { kind: "next", spentCents: 0 }))).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(json(await unserved.call(unserved.token(["events"]), { kind: "next", spentCents: 0 }))).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
  });

});
