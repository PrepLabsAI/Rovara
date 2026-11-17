// Wiki W4: the wiki build controls on `rovara up`. The owner of the install only (no script token); a missing project is PROJECT_NOT_FOUND; the answers are the hosted route's. Two projects keep
// their own rows (the build pointer, the agents switch, the pages), and a delete removes only the named project's.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, WIKI_BUILD_WORDS, WIKI_CONTROLS_WORDS, queryAll, wikiAgentSwitchKey, wikiPartition, wikiUsePartition, type WikiPageWrite } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { wikiBuildPartition } from "../../packages/broker/src/core/wiki-build/keys.js";
import { readWikiBuildPointer } from "../../packages/broker/src/core/wiki-build/run.js";
import { createLocalWikiBuild } from "../../packages/broker/src/local/app/wiki-build.js";
import { createLocalWikiMap } from "../../packages/broker/src/local/app/wiki-map.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { API_SHA, FakeStarter } from "../support/wiki-build-fixtures.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const FILES = { "src/a/one.ts": "x", "src/a/two.ts": "x", "src/a/three.ts": "x" };
const hosts = new Map<string, FakeCodeHost>();
const adapter = (url: string): FakeCodeHost => {
  let host = hosts.get(url);
  if (host === undefined) { host = new FakeCodeHost(new FakeHostModel({ url, id: "1", fullName: url, initialFiles: FILES })); hosts.set(url, host); }
  return host;
};
// One registered "github" host that answers for whichever repository address the call names.
const github = new Proxy({} as FakeCodeHost, { get: (_target, key) => (key === "kind" ? "github" : (...args: unknown[]) => (adapter((args[0] as { url: string }).url) as never as Record<string, (...a: unknown[]) => unknown>)[key as string]!(...args)) });
const registryOf = { names: () => ["github"], get: () => github } as never;
const projectOf = (name: string, archived = false) => ({ archived, definition: { name, revision: 1, repositories: [{ name, url: `https://github.com/acme/${name}.git`, defaultBranch: "main" }] } });
const PROJECTS: Record<string, ReturnType<typeof projectOf>> = { app: projectOf("app"), site: projectOf("site"), old: projectOf("old", true) };
const owner = { principal: { roles: ["owner"], personId: "owner-1", displayName: "Owner" } } as never;
const id = () => randomUUID();
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const WB = (name: string, tail = "") => `/v1/app/projects/${name}/wiki-build${tail}`;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field

function setup(options: { model?: boolean; starter?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  const starter = new FakeStarter(store);
  const flow = { store, projects: { latest: async (name: string) => PROJECTS[name] } } as never;
  const now = () => Date.parse("2026-11-17T12:00:00Z");
  const wikiMap = createLocalWikiMap({ flow, registry: registryOf, now });
  const routes = createLocalWikiBuild({ flow, wikiMap, owner: owner.principal, now, modelAccessConfigured: async () => options.model ?? true, ...(options.starter === false ? {} : { starter: () => starter }) });
  const call = async (request: ReturnType<typeof get>, caller = owner) => {
    const answer = await routes.routes(request, caller);
    if (answer === undefined) return undefined;
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  return { store, starter, call, now };
}
const rows = async (store: MemoryDocumentStore, pk: string) => (await queryAll(store, { pk })).length;
const page = (pageId: string, repo: string): WikiPageWrite => ({
  pageId, kind: "overview", title: `Page ${pageId}`, summary: "Summary", order: 0, repos: [{ repo, commit: API_SHA }],
  blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }],
  claims: [{ claimId: "c0001", text: "A claim", citations: [{ repo, path: "src/a/one.ts", commit: API_SHA, line: 1, quote: "export const a = 1;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }], buildId: "build-0001",
});

describe("local wiki build controls", () => {
  it("lets the owner see the state, build, stop, continue, switch and delete; the build pins the map's commits and the project pays", async () => {
    const { store, starter, call } = setup();
    expect((await call(get(WB("app"))))!.body).toMatchObject({ status: "none", canManage: true, aiKey: "connected", agents: { on: false }, wiki: { pages: 0 } });
    const started = await call(post(WB("app"), { requestId: id() }));
    expect(started!.status).toBe(202);
    expect(started!.body).toMatchObject({ status: "running", payer: "project" });
    expect(starter.started[0]).toMatchObject({ project: "app", payer: { kind: "project", project: "app" } });
    expect(starter.started[0]!.pins).toEqual([{ repo: "app", commit: expect.stringMatching(/^[a-f0-9]{40}$/u) }]);
    expect((await readWikiBuildPointer(store, COMPANY, "app"))?.requestedBy).toBe("owner-1");
    expect((await call(post(WB("app", "/stop"), { requestId: id() })))!.body).toMatchObject({ status: "stopped", canContinue: true });
    expect((await call(post(WB("app", "/continue"), { requestId: id() })))!.status).toBe(202);
    expect((await call(post(WB("app", "/agents"), { requestId: id(), on: true })))!.body.agents).toEqual({ on: true });
    await call(post(WB("app", "/stop"), { requestId: id() }));
    const gone = await call(post(WB("app", "/delete"), { requestId: id() }));
    expect(gone!.body).toMatchObject({ deleted: true, message: WIKI_CONTROLS_WORDS.deleted });
    expect(await store.get(wikiAgentSwitchKey(COMPANY, "app"))).toBeUndefined();
    expect(await readWikiBuildPointer(store, COMPANY, "app")).toBeUndefined();
  });

  it("keeps two projects apart: the switch, the build and a delete of one never touch the other", async () => {
    const { store, call } = setup();
    const wiki = createWikiStore({ store, companyId: COMPANY, now: () => 0 });
    await wiki.writePage("app", page("overview", "app"));
    await wiki.writePage("site", page("overview", "site"));
    await call(post(WB("site", "/agents"), { requestId: id(), on: true }));
    await call(post(WB("site"), { requestId: id() }));
    await call(post(WB("app", "/delete"), { requestId: id() }));
    expect(await rows(store, wikiPartition(COMPANY, "app"))).toBe(0);
    expect(await rows(store, wikiPartition(COMPANY, "site"))).toBeGreaterThan(0);
    expect(await rows(store, wikiUsePartition(COMPANY, "site"))).toBe(1);
    expect(await rows(store, wikiBuildPartition({ orgId: COMPANY, project: "site" }))).toBeGreaterThan(0);
    expect((await call(get(WB("app"))))!.body.agents).toEqual({ on: false });
    expect((await call(get(WB("site"))))!.body.agents).toEqual({ on: true });
  });

  it("refuses a script token and a caller that is not the owner, in fixed words, and writes nothing", async () => {
    const { store, starter, call } = setup();
    for (const caller of [{ principal: { roles: ["owner"], personId: "x" }, scriptToken: { id: "t" } }, { principal: { roles: ["developer"], personId: "x" } }] as never[]) {
      for (const request of [get(WB("app")), post(WB("app"), { requestId: id() }), post(WB("app", "/agents"), { requestId: id(), on: true }), post(WB("app", "/delete"), { requestId: id() })]) {
        const answer = await call(request, caller);
        expect(answer!.status).toBe(403);
        expect(answer!.body.error.message).toBe("only the owner of this install can build a project's wiki");
      }
    }
    expect(starter.started).toHaveLength(0);
    expect(await store.get(wikiAgentSwitchKey(COMPANY, "app"))).toBeUndefined();
  });

  it("says the project does not exist, and leaves other paths and methods to other routes", async () => {
    const { call } = setup();
    expect((await call(get(WB("nope"))))!.status).toBe(404);
    expect((await call(post(WB("nope", "/agents"), { requestId: id(), on: true })))!.status).toBe(404);
    for (const request of [{ ...get(WB("app")), method: "PUT" }, { ...get(WB("app")), method: "DELETE" }, get(WB("app", "/stop")), get(WB("app", "/delete")), post(WB("app", "/extra")), get("/v1/app/projects/app/wiki-map")]) {
      expect(await call(request)).toBeUndefined();
    }
  });

  it("no model: 'Connect an AI key' and nothing written; an archived project takes no new build; no starter: not set up, the other controls still work", async () => {
    const none = setup({ model: false });
    expect((await none.call(get(WB("app"))))!.body).toMatchObject({ aiKey: "missing", connectKey: WIKI_BUILD_WORDS.connectKey });
    expect((await none.call(post(WB("app"), { requestId: id() })))!.body.error).toEqual({ code: "MODEL_PROXY_UNAVAILABLE", message: WIKI_BUILD_WORDS.connectKey });
    expect(none.starter.started).toHaveLength(0);
    const normal = setup();
    const archived = await normal.call(post(WB("old"), { requestId: id() }));
    expect(archived!.body.error.code).toBe("PROJECT_ARCHIVED");
    expect(normal.starter.started).toHaveLength(0);
    const unwired = setup({ starter: false });
    const answer = await unwired.call(post(WB("app"), { requestId: id() }));
    expect(answer!.status).toBe(404);
    expect(answer!.body.error.message).toBe("building the wiki is not set up in this deployment");
    expect((await unwired.call(post(WB("app", "/agents"), { requestId: id(), on: true })))!.status).toBe(200);
  });
});
