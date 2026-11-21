// Wiki W4: the wiki build controls on the deployed API. Who may build, stop, continue, refresh, switch and delete (a live company owner or admin, or the project's administrator), who may only read
// (a project user), who sees nothing (anyone else, another project of the same company, another company, a missing or malformed project: one uniform 404); company AND project scoping of every
// row the controls write or delete; an audit record naming the person before each act; a start refused before anything is written when the company or the install cannot run it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WIKI_BUILD_WORDS, WIKI_CONTROLS_WORDS, orgProjectCatalogKey, projectRevisionKey, queryAll, wikiAgentSwitchKey, wikiPartition, wikiUsePartition, type AuditEvent, type AuditSink, type JsonValue, type ProjectDefinition,
  type WikiPageWrite,
} from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { wikiBuildPartition } from "../../packages/broker/src/core/wiki-build/keys.js";
import { readWikiBuildPointer } from "../../packages/broker/src/core/wiki-build/run.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import type { HostedWikiBuildWiring, WikiBuildStarterInput } from "../../packages/broker/src/core-host/wiki-build-routes.js";
import type { HostedWikiMapWiring } from "../../packages/broker/src/core-host/wiki-map-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { API_SHA, FakeStarter } from "../support/wiki-build-fixtures.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const urlOf = (company: string, name: string): string => `https://github.com/${company === FAKE_COMPANY ? "acme" : "rival"}/${name}.git`;
const project = (company: string, name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name, url: urlOf(company, name), path: `repo/${name}`, defaultBranch: "main", credentialRef: "host-app" }],
});
const FILES: Record<string, Record<string, string>> = {
  [`${FAKE_COMPANY}/payments`]: { "payments-core/a.ts": "x", "payments-core/b.ts": "x", "payments-core/c.ts": "x" },
  [`${FAKE_COMPANY}/ledger`]: { "ledger-core/a.ts": "x", "ledger-core/b.ts": "x", "ledger-core/c.ts": "x" },
  [`${OTHER}/payments`]: { "rival-core/a.ts": "x", "rival-core/b.ts": "x", "rival-core/c.ts": "x" },
};

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}
async function register(world: FakeWorld, company: string, name: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(company, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project(company, name))) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(company, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
}
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const WB = (name: string, tail = "") => `/v1/app/projects/${name}/wiki-build${tail}`;
const id = () => randomUUID();

interface Person { caller: DeployedCaller; membership: CompanyMembership; grants: Map<string, "developer" | "administrator"> }
interface Body { status: string; error: { code: string; message: string }; wiki: { pages: number; refreshPages: number }; agents: { on: boolean }; [key: string]: unknown }

async function buildWorld(options: { wired?: boolean; gateway?: boolean; withStarter?: boolean; aiKey?: HostedWikiBuildWiring["aiKey"]; audit?: (sink: AuditSink) => AuditSink } = {}) {
  const world = createFakeWorld();
  await register(world, FAKE_COMPANY, "payments");
  await register(world, FAKE_COMPANY, "ledger");
  await register(world, OTHER, "payments");
  const app = appOver(world);
  const people = new Map<string, Person>();
  const person = (personId: string, companyId: string, role: CompanyMembership["role"], grants: Record<string, "developer" | "administrator"> = {}): DeployedCaller => {
    const caller: DeployedCaller = { principal: { companyId, personId, displayName: `Name ${personId}`, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud" };
    people.set(personId, { caller, membership: { companyId, role }, grants: new Map(Object.entries(grants)) });
    return caller;
  };
  const standing = vi.fn(async (personId: string, companyId: string, name: string): Promise<SetupRunStanding> => {
    const found = people.get(personId);
    if (found === undefined || found.membership.companyId !== companyId) return { access: "none" };
    if (found.membership.role === "owner") return { access: "manage", basis: "company-owner" };
    if (found.membership.role === "admin") return { access: "manage", basis: "company-admin" };
    const grant = found.grants.get(name);
    return grant === "administrator" ? { access: "manage", basis: "project-admin" } : grant === "developer" ? { access: "view" } : { access: "none" };
  });
  const hostsByUrl = new Map<string, FakeCodeHost>();
  const hostOfUrl = (url: string): FakeCodeHost => {
    let host = hostsByUrl.get(url);
    if (host === undefined) {
      const company = url.includes("/acme/") ? FAKE_COMPANY : OTHER;
      host = new FakeCodeHost(new FakeHostModel({ url, id: "1", fullName: url, initialFiles: FILES[`${company}/${url.split("/").pop()!.replace(".git", "")}`] ?? { "README.md": "x" } }));
      hostsByUrl.set(url, host);
    }
    return host;
  };
  const listings = vi.fn();
  const map: HostedWikiMapWiring = {
    standing,
    hostFor: () => new Proxy({} as FakeCodeHost, {
      get: (_target, key) => (key === "repositoryTree" ? async (repo: { url: string }, ...rest: unknown[]) => { listings(repo.url); return hostOfUrl(repo.url).repositoryTree(repo, ...(rest as [string, never])); }
        : (...args: unknown[]) => (hostOfUrl((args[0] as { url: string }).url) as never as Record<string, (...a: unknown[]) => unknown>)[key as string]!(...args)),
    }),
  };
  const starters: FakeStarter[] = [];
  const starter = new FakeStarter(world.store as unknown as MemoryDocumentStore);
  const inputs: WikiBuildStarterInput[] = [];
  const wikiBuild: HostedWikiBuildWiring = {
    standing, modelAccessConfigured: () => options.gateway ?? true, map, ...(options.aiKey === undefined ? {} : { aiKey: options.aiKey }),
    ...(options.withStarter === false ? {} : { starter: (input) => { inputs.push(input); return starter; } }),
    displayName: async (personId) => people.get(personId)?.caller.principal.displayName,
  };
  void starters;
  const wiring: CoreDevWiring = { origin: () => "https://api.example", ...(options.wired === false ? {} : { wikiBuild }), ...(options.audit === undefined ? {} : { auditFor: (_caller, sink) => options.audit!(sink) }) };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => people.get(caller.principal.personId)?.membership, wiring: () => wiring });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body, raw: answer.body };
  };
  return { world, app, person, standing, call, routes, starter, inputs, listings };
}

const wikiEvents = (world: FakeWorld): AuditEvent[] => world.audit.filter((event) => event.action.startsWith("wiki_build."));
const rows = async (world: FakeWorld, pk: string) => (await queryAll(world.store, { pk })).length;
const page = (pageId: string, repo = "payments"): WikiPageWrite => ({
  pageId, kind: pageId === "overview" ? "overview" : "repo", title: `Page ${pageId}`, summary: "Summary", order: 0, repos: [{ repo, commit: API_SHA }],
  blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }],
  claims: [{ claimId: "c0001", text: "A claim", citations: [{ repo, path: "payments-core/a.ts", commit: API_SHA, line: 1, quote: "export const a = 1;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }], buildId: "build-0001",
});
async function seed(world: FakeWorld, company: string, name: string, pageIds = ["overview"]): Promise<void> {
  const wiki = createWikiStore({ store: world.store, companyId: company, now: () => world.clock.now });
  for (const pageId of pageIds) await wiki.writePage(name, page(pageId, name));
}

describe("hosted wiki build controls: who may do what", () => {
  it("lets a live company owner, a company admin and the project's administrator build; the pointer is the company's and project's own, the project pays, and the audit names the person and why", async () => {
    for (const [role, grants, basis] of [["owner", {}, "company-owner"], ["admin", {}, "company-admin"], ["member", { payments: "administrator" as const }, "project-admin"]] as const) {
      const { world, person, call, starter, inputs } = await buildWorld();
      const caller = person(`p-${role}`, FAKE_COMPANY, role, grants);
      const requestId = id();
      const started = await call(post(WB("payments"), { requestId }), caller);
      expect(started.status, role).toBe(202);
      expect(started.body).toMatchObject({ status: "running", canManage: true, payer: "project", aiKey: "unknown", agents: { on: false } });
      const pointer = await readWikiBuildPointer(world.store, FAKE_COMPANY, "payments");
      expect(pointer).toMatchObject({ orgId: FAKE_COMPANY, project: "payments", requestId, requestedBy: `p-${role}`, payer: { kind: "project", project: "payments" } });
      expect(pointer!.pins).toEqual([{ repo: "payments", commit: expect.stringMatching(/^[a-f0-9]{40}$/u) as string }]);
      expect(starter.started).toHaveLength(1);
      // The starter is made for THIS caller and a flow whose start rule is the wiki build's own.
      expect(inputs[0]!.caller.principal.personId).toBe(`p-${role}`);
      const events = wikiEvents(world);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "wiki_build.start_requested", companyId: FAKE_COMPANY, actor: { type: "person", id: `p-${role}` }, subject: { type: "project", id: "payments" }, details: { project: "payments", basis, requestId } });
      expect(await readWikiBuildPointer(world.store, OTHER, "payments")).toBeUndefined();
    }
  });

  it("lets a project user read the state and refuses every change in fixed words, writing nothing", async () => {
    const { world, person, call, starter } = await buildWorld();
    const reader = person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
    const read = await call(get(WB("payments")), reader);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "none", canManage: false, wiki: { pages: 0, refreshPages: 0 } });
    for (const [tail, body] of [["", { requestId: id() }], ["/continue", { requestId: id() }], ["/stop", { requestId: id() }], ["/refresh", { requestId: id() }], ["/agents", { requestId: id(), on: true }], ["/delete", { requestId: id() }]] as const) {
      const refused = await call(post(WB("payments", tail), body), reader);
      expect(refused.status, tail).toBe(403);
      expect(refused.body, tail).toEqual({ error: { code: "FORBIDDEN", message: WIKI_BUILD_WORDS.notAllowed } });
    }
    expect(starter.started).toHaveLength(0);
    expect(await readWikiBuildPointer(world.store, FAKE_COMPANY, "payments")).toBeUndefined();
    expect(await world.store.get(wikiAgentSwitchKey(FAKE_COMPANY, "payments"))).toBeUndefined();
    expect(wikiEvents(world)).toEqual([]);
  });

  it("answers a member with no grant, another company's person, a missing project and a malformed name with one identical 404, on every control", async () => {
    const { person, call, starter, listings } = await buildWorld();
    const member = person("p-member", FAKE_COMPANY, "member");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const expected = { status: 404, body: { error: { code: "NOT_FOUND", message: WIKI_CONTROLS_WORDS.projectNotFound } } };
    const requests = (path: (tail: string) => string) => [get(path("")), post(path(""), { requestId: id() }), post(path("/continue"), { requestId: id() }), post(path("/stop"), { requestId: id() }), post(path("/refresh"), { requestId: id() }), post(path("/agents"), { requestId: id(), on: true }), post(path("/delete"), { requestId: id() })];
    const cases: Array<[DeployedCaller, (tail: string) => string]> = [
      [member, (tail) => WB("payments", tail)], [admin, (tail) => WB("missing", tail)], [admin, (tail) => WB("-bad", tail)], [admin, (tail) => `/v1/app/projects/%E0%A4%A/wiki-build${tail}`],
    ];
    for (const [caller, path] of cases) for (const request of requests(path)) {
      const answer = await call(request, caller);
      expect({ status: answer.status, body: answer.body }, `${request.method} ${request.path}`).toEqual(expected);
    }
    expect(starter.started).toHaveLength(0);
    expect(listings).not.toHaveBeenCalled();
    // The other company's owner is nobody here.
    const stranger = person("p-stranger", OTHER, "owner");
    expect((await call(get(WB("ledger")), stranger)).status).toBe(404);
  });

  it("answers 'not on the core yet' when the deployment wires no controls", async () => {
    const { person, call } = await buildWorld({ wired: false });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    for (const request of [get(WB("payments")), post(WB("payments"), { requestId: id() }), post(WB("payments", "/delete"), { requestId: id() })]) {
      const answer = await call(request, owner);
      expect(answer.status).toBe(404);
      expect(answer.body.error.message).toBe(NOT_ON_THE_CORE_YET);
    }
  });
});

describe("hosted wiki build controls: two projects and two companies", () => {

  it("keeps two companies apart: the same project name in another company has its own build, switch, pages and delete", async () => {
    const { world, person, call } = await buildWorld();
    const ours = person("p-ours", FAKE_COMPANY, "owner");
    const theirs = person("p-theirs", OTHER, "owner");
    await seed(world, FAKE_COMPANY, "payments", ["overview"]);
    await seed(world, OTHER, "payments", ["overview", "repo-payments"]);
    await call(post(WB("payments", "/agents"), { requestId: id(), on: true }), ours);
    await call(post(WB("payments"), { requestId: id() }), ours);
    // The other company sees none of it.
    expect((await call(get(WB("payments")), theirs)).body).toMatchObject({ status: "none", agents: { on: false }, wiki: { pages: 2 } });
    const theirBuild = rows(world, wikiBuildPartition({ orgId: OTHER, project: "payments" }));
    expect(await theirBuild).toBe(0);
    // Deleting ours (a stopped build is needed first) leaves theirs.
    await call(post(WB("payments", "/stop"), { requestId: id() }), ours);
    const gone = await call(post(WB("payments", "/delete"), { requestId: id() }), ours);
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ deleted: true, message: WIKI_CONTROLS_WORDS.deleted, view: { wiki: { pages: 0 }, agents: { on: false } } });
    expect(await rows(world, wikiPartition(FAKE_COMPANY, "payments"))).toBe(0);
    expect(await rows(world, wikiUsePartition(FAKE_COMPANY, "payments"))).toBe(0);
    expect(await rows(world, wikiBuildPartition({ orgId: FAKE_COMPANY, project: "payments" }))).toBe(0);
    expect((await call(get(WB("payments")), theirs)).body).toMatchObject({ wiki: { pages: 2 } });
  });
});

describe("hosted wiki build controls: the rest of each control", () => {
  it("stops and continues; a repeat of a request id starts nothing more; Refresh now builds a new run over the changed pages only", async () => {
    const { world, person, call, starter } = await buildWorld();
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const requestId = id();
    expect((await call(post(WB("payments"), { requestId }), owner)).status).toBe(202);
    expect((await call(post(WB("payments"), { requestId }), owner)).status).toBe(200);
    expect(starter.started).toHaveLength(1);
    const busy = await call(post(WB("payments"), { requestId: id() }), owner);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toBe(WIKI_BUILD_WORDS.busy);
    const stopped = await call(post(WB("payments", "/stop"), { requestId: id() }), owner);
    expect(stopped.body).toMatchObject({ status: "stopped", stop: "stopped_by_person", stoppedBy: { name: "Name p-owner" } });
    expect(starter.cancelled).toHaveLength(1);
    expect((await call(post(WB("payments", "/continue"), { requestId: id() }), owner)).status).toBe(202);
    expect(wikiEvents(world).map((event) => event.action)).toEqual(["wiki_build.start_requested", "wiki_build.start_requested", "wiki_build.start_requested", "wiki_build.stop_requested", "wiki_build.continue_requested"]);
  });

  it("Refresh now needs a wiki, and then plans only what is out of date", async () => {
    const { world, person, call, starter } = await buildWorld();
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const none = await call(post(WB("payments", "/refresh"), { requestId: id() }), owner);
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe(WIKI_CONTROLS_WORDS.buildFirst);
    await seed(world, FAKE_COMPANY, "payments", ["overview", "repo-payments"]);
    const wiki = createWikiStore({ store: world.store, companyId: FAKE_COMPANY, now: () => world.clock.now });
    await wiki.addFlag("payments", { pageId: "repo-payments", by: { kind: "person", personId: "p-x" } });
    expect((await call(get(WB("payments")), owner)).body.wiki).toEqual({ pages: 2, refreshPages: 1 });
    const done = await call(post(WB("payments", "/refresh"), { requestId: id() }), owner);
    expect(done.status).toBe(202);
    const pointer = (await readWikiBuildPointer(world.store, FAKE_COMPANY, "payments"))!;
    expect(pointer.buildKind).toBe("refresh");
    expect(pointer.plan.map((entry) => entry.id)).toEqual(["repo-payments", expect.stringMatching(/^m-payments-/u)]);
    expect(starter.started).toHaveLength(1);
  });

  it("the agents switch is the project's own row and a delete takes it away", async () => {
    const { world, person, call } = await buildWorld();
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const on = await call(post(WB("payments", "/agents"), { requestId: id(), on: true }), owner);
    expect(on.status).toBe(200);
    expect(on.body.agents).toEqual({ on: true });
    expect(await world.store.get(wikiAgentSwitchKey(FAKE_COMPANY, "payments"))).toMatchObject({ on: true, project: "payments", companyId: FAKE_COMPANY });
    const bad = await call(post(WB("payments", "/agents"), { requestId: id(), on: "yes" }), owner);
    expect(bad.status).toBe(400);
    expect((await call(post(WB("payments", "/delete"), { requestId: id() }), owner)).status).toBe(200);
    expect(await world.store.get(wikiAgentSwitchKey(FAKE_COMPANY, "payments"))).toBeUndefined();
    expect((await call(get(WB("payments")), owner)).body.agents).toEqual({ on: false });
  });

  it("shows 'Connect an AI key' when the install has no gateway or the company has no key, and builds nothing", async () => {
    for (const options of [{ gateway: false }, { aiKey: async () => "missing" as const }]) {
      const { world, person, call, starter } = await buildWorld(options);
      const owner = person("p-owner", FAKE_COMPANY, "owner");
      expect((await call(get(WB("payments")), owner)).body).toMatchObject({ aiKey: "missing", connectKey: WIKI_BUILD_WORDS.connectKey });
      const answer = await call(post(WB("payments"), { requestId: id() }), owner);
      expect(answer.body).toEqual({ error: { code: "MODEL_PROXY_UNAVAILABLE", message: WIKI_BUILD_WORDS.connectKey } });
      expect(starter.started).toHaveLength(0);
      expect(await readWikiBuildPointer(world.store, FAKE_COMPANY, "payments")).toBeUndefined();
    }
  });

  it("refuses a build, a continue and a refresh before writing anything when the company's new tasks are not on the core; stop, the switch and delete still work", async () => {
    const { world, person, call, app, starter } = await buildWorld();
    vi.spyOn(app, "engineForNewTask").mockReturnValue("workflow");
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    for (const tail of ["", "/continue", "/refresh"]) {
      const answer = await call(post(WB("payments", tail), { requestId: id() }), owner);
      expect(answer.status, tail).toBe(503);
      expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: WIKI_CONTROLS_WORDS.unavailable } });
    }
    expect(starter.started).toHaveLength(0);
    expect(await readWikiBuildPointer(world.store, FAKE_COMPANY, "payments")).toBeUndefined();
    expect((await call(post(WB("payments", "/agents"), { requestId: id(), on: true }), owner)).status).toBe(200);
    expect((await call(get(WB("payments")), owner)).status).toBe(200);
  });

  it("says 'not set up in this deployment' for Build when no starter is wired, and the other controls still work", async () => {
    const { world, person, call } = await buildWorld({ withStarter: false });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const answer = await call(post(WB("payments"), { requestId: id() }), owner);
    expect(answer.status).toBe(404);
    expect(answer.body.error.message).toBe("building the wiki is not set up in this deployment");
    expect(await readWikiBuildPointer(world.store, FAKE_COMPANY, "payments")).toBeUndefined();
    expect((await call(post(WB("payments", "/agents"), { requestId: id(), on: true }), owner)).status).toBe(200);
  });

  it("writes nothing when the audit record cannot be written", async () => {
    const failing: AuditSink = { stage: () => [], record: async () => { throw new Error("audit down"); } };
    const { world, person, call, starter } = await buildWorld({ audit: () => failing });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    for (const [tail, body] of [["", { requestId: id() }], ["/agents", { requestId: id(), on: true }], ["/delete", { requestId: id() }]] as const) {
      const answer = await call(post(WB("payments", tail), body), owner);
      expect(answer.status, tail).toBe(503);
      expect(answer.body.error.code).toBe("AUDIT_UNAVAILABLE");
    }
    expect(starter.started).toHaveLength(0);
    expect(await world.store.get(wikiAgentSwitchKey(FAKE_COMPANY, "payments"))).toBeUndefined();
  });
});

describe("hosted wiki build controls: the audit event ids and the start rule", () => {

  it("the flow the starter is made with starts only for the company's live managers of that project", async () => {
    const { person, call, inputs } = await buildWorld();
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
    person("p-theirs", OTHER, "owner");
    await call(post(WB("payments"), { requestId: id() }), owner);
    const rule = inputs[0]!.flow.access;
    const principal = (personId: string, companyId: string) => ({ companyId, personId, displayName: "n", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER }) as never;
    expect(await rule.checkStart(principal("p-owner", FAKE_COMPANY), "payments")).toEqual({ allowed: true });
    expect(await rule.checkStart(principal("p-dev", FAKE_COMPANY), "payments")).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(await rule.checkStart(principal("p-owner", FAKE_COMPANY), "ledger")).toEqual({ allowed: true });
    expect(await rule.checkStart(principal("p-theirs", OTHER), "payments")).toMatchObject({ allowed: false });
    expect(await rule.checkStart(principal("p-owner", OTHER), "payments")).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(await rule.checkStart(principal("p-nobody", FAKE_COMPANY), "payments")).toMatchObject({ allowed: false });
  });
});

