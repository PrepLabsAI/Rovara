// Wiki W0 (DEC 254zh): the free file map on the deployed API. Who may make a map (a live company owner or admin, or the project's administrator), who may only read a kept one (a project user), who sees nothing
// (anyone else, another project of the same company, another company, a missing or malformed project: one uniform 404); the cache is keyed by company AND project; no AI key is involved.
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, WIKI_MAP_NOT_ALLOWED, WikiFileMapViewSchema, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { WIKI_MAP_UNREADABLE, type HostedWikiMapWiring } from "../../packages/broker/src/core-host/wiki-map-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const urlOf = (company: string, name: string): string => `https://github.com/${company === FAKE_COMPANY ? "acme" : "rival"}/${name}.git`;
const project = (company: string, name: string, extraRepos: string[] = []): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [name, ...extraRepos].map((repo) => ({ name: repo, url: urlOf(company, repo), path: `repo/${repo}`, defaultBranch: "main", credentialRef: "host-app" })),
});
const FILES: Record<string, Record<string, string>> = {
  [`${FAKE_COMPANY}/payments`]: { "payments-core/a.ts": "x", "payments-core/b.ts": "x", "payments-core/c.ts": "x", ".env": "TOKEN=1" },
  [`${FAKE_COMPANY}/ledger`]: { "ledger-core/a.ts": "x", "ledger-core/b.ts": "x", "ledger-core/c.ts": "x" },
  [`${OTHER}/payments`]: { "rival-core/a.ts": "x", "rival-core/b.ts": "x", "rival-core/c.ts": "x" },
};

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}
async function register(world: FakeWorld, company: string, name: string, extra: string[] = []): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(company, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project(company, name, extra))) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(company, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
}
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string) => ({ method: "POST", path, headers: {}, body: "{}" });
const MAP = (name: string) => `/v1/app/projects/${name}/wiki-map`;

interface Person { caller: DeployedCaller; membership: CompanyMembership; grants: Map<string, "developer" | "administrator"> }

async function mapWorld(options: { standing?: HostedWikiMapWiring["standing"] } = {}) {
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
  const standing = vi.fn(options.standing ?? (async (personId: string, companyId: string, name: string): Promise<SetupRunStanding> => {
    const found = people.get(personId);
    if (found === undefined || found.membership.companyId !== companyId) return { access: "none" };
    if (found.membership.role === "owner") return { access: "manage", basis: "company-owner" };
    if (found.membership.role === "admin") return { access: "manage", basis: "company-admin" };
    const grant = found.grants.get(name);
    return grant === "administrator" ? { access: "manage", basis: "project-admin" } : grant === "developer" ? { access: "view" } : { access: "none" };
  }));
  // One fake host per repository, each with the files its company's repository holds; counts the listings made.
  const listings = vi.fn();
  const hostsByUrl = new Map<string, FakeCodeHost>();
  const hostOfUrl = (company: string, name: string): FakeCodeHost => {
    const url = urlOf(company, name);
    let host = hostsByUrl.get(url);
    if (host === undefined) { host = new FakeCodeHost(new FakeHostModel({ url, id: "1", fullName: url, initialFiles: FILES[`${company}/${name}`] ?? { "README.md": "x" } })); hostsByUrl.set(url, host); }
    return host;
  };
  const wikiMap: HostedWikiMapWiring = {
    standing,
    hostFor: (repository) => {
      // The fake host is registered for ONE url; route by the repository's address.
      void repository;
      const wrapped = new Proxy({} as FakeCodeHost, {
        get: (_target, key) => (key === "repositoryTree" ? async (repo: { url: string }, ...rest: unknown[]) => { listings(repo.url); return (hostsByUrl.get(repo.url) ?? hostOfByUrl(repo.url)).repositoryTree(repo, ...(rest as [string, never])); } : (...args: unknown[]) => { const repo = args[0] as { url: string }; const host = hostsByUrl.get(repo.url) ?? hostOfByUrl(repo.url); return (host as never as Record<string, (...a: unknown[]) => unknown>)[key as string]!(...args); }),
      });
      return wrapped;
    },
  };
  function hostOfByUrl(url: string): FakeCodeHost {
    const company = url.includes("/acme/") ? FAKE_COMPANY : OTHER;
    return hostOfUrl(company, url.split("/").pop()!.replace(".git", ""));
  }
  const wiring: CoreDevWiring = { origin: () => "https://api.example", wikiMap };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => people.get(caller.principal.personId)?.membership, wiring: () => wiring });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, any>, raw: answer.body };
  };
  return { world, person, standing, call, routes, wiring, listings, hostOfUrl };
}

describe("hosted file map: who may do what", () => {
  it("lets a company owner, a company admin and the project's administrator make a map, and any of them read it back", async () => {
    for (const [role, grants] of [["owner", {}], ["admin", {}], ["member", { payments: "administrator" as const }]] as const) {
      const { person, call } = await mapWorld();
      const caller = person(`p-${role}`, FAKE_COMPANY, role, grants);
      const none = await call(get(MAP("payments")), caller);
      expect(none.body, role).toEqual({ status: "none", canManage: true });
      const made = await call(post(MAP("payments")), caller);
      expect(made.status, role).toBe(200);
      expect(WikiFileMapViewSchema.parse(made.body)).toMatchObject({ status: "ready", canManage: true });
      expect(made.body["map"].repositories[0]).toMatchObject({ name: "payments", status: "ok", files: 3 });
      const read = await call(get(MAP("payments")), caller);
      expect(read.body).toEqual(made.body);
    }
  });

  it("lets a project user read a kept map but not make one (403 in fixed words, nothing computed)", async () => {
    const { person, call, listings } = await mapWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const reader = person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
    expect((await call(get(MAP("payments")), reader)).body).toEqual({ status: "none", canManage: false });
    const refused = await call(post(MAP("payments")), reader);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: WIKI_MAP_NOT_ALLOWED } });
    expect(listings).not.toHaveBeenCalled();
    await call(post(MAP("payments")), admin);
    const read = await call(get(MAP("payments")), reader);
    expect(read.body).toMatchObject({ status: "ready", canManage: false });
    expect(read.body["map"].repositories[0].files).toBe(3);
  });

  it("answers a member with no grant, another company's person and a missing or malformed project with one identical 404", async () => {
    const { person, call, listings } = await mapWorld();
    const member = person("p-member", FAKE_COMPANY, "member");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const expected = { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    for (const [caller, path] of [[member, MAP("payments")], [admin, MAP("missing")], [admin, MAP("-bad")], [admin, "/v1/app/projects/%E0%A4%A/wiki-map"]] as const) {
      for (const make of [get, post]) {
        const answer = await call(make(path), caller);
        expect({ status: answer.status, body: answer.body }, `${path}`).toEqual(expected);
      }
    }
    expect(listings).not.toHaveBeenCalled();
  });

  it("keeps two projects of one company apart: a person with a role on project A cannot read or make project B's map, and a map of A never answers for B", async () => {
    const { person, call } = await mapWorld();
    const adminOfA = person("p-a", FAKE_COMPANY, "member", { payments: "administrator" });
    const readerOfB = person("p-b", FAKE_COMPANY, "member", { ledger: "developer" });
    const companyAdmin = person("p-admin", FAKE_COMPANY, "admin");
    await call(post(MAP("payments")), adminOfA);
    await call(post(MAP("ledger")), companyAdmin);
    // The administrator of A sees nothing of B, in either direction.
    for (const make of [get, post]) {
      const answer = await call(make(MAP("ledger")), adminOfA);
      expect(answer.status).toBe(404);
      expect(answer.raw).not.toContain("ledger-core");
    }
    // The reader of B sees B's map, never A's.
    const b = await call(get(MAP("ledger")), readerOfB);
    expect(b.body["map"].repositories[0].areas.map((a: { path: string }) => a.path)).toEqual(["ledger-core"]);
    expect(b.raw).not.toContain("payments-core");
    expect((await call(get(MAP("payments")), readerOfB)).status).toBe(404);
    // Each project's own kept map is its own.
    const a = await call(get(MAP("payments")), adminOfA);
    expect(a.body["map"].repositories[0].areas.map((x: { path: string }) => x.path)).toEqual(["payments-core"]);
  });

  it("keeps two companies apart: the same project name in another company has its own map and its own cache", async () => {
    const { person, call } = await mapWorld();
    const ours = person("p-ours", FAKE_COMPANY, "owner");
    const theirs = person("p-theirs", OTHER, "owner");
    await call(post(MAP("payments")), ours);
    // The other company has made nothing yet: it never sees ours.
    expect((await call(get(MAP("payments")), theirs)).body).toEqual({ status: "none", canManage: true });
    const made = await call(post(MAP("payments")), theirs);
    expect(made.body["map"].repositories[0].areas.map((a: { path: string }) => a.path)).toEqual(["rival-core"]);
    expect(made.raw).not.toContain("payments-core");
    const back = await call(get(MAP("payments")), ours);
    expect(back.body["map"].repositories[0].areas.map((a: { path: string }) => a.path)).toEqual(["payments-core"]);
    expect(back.raw).not.toContain("rival-core");
  });

  it("serves a kept map only while the project names the same repositories", async () => {
    const { world, person, call } = await mapWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    await call(post(MAP("payments")), admin);
    expect((await call(get(MAP("payments")), admin)).body["status"]).toBe("ready");
    // A second revision adds a repository: the kept map no longer describes the project.
    await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...project(FAKE_COMPANY, "payments", ["ledger"]), revision: 2 })) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 2 } });
    expect((await call(get(MAP("payments")), admin)).body).toEqual({ status: "none", canManage: true });
  });

  it("serves a kept map only for the branch it was read from, and makes a repository whose code host is missing unavailable, not an error", async () => {
    const { world, person, call } = await mapWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    await call(post(MAP("payments")), admin);
    const definition = project(FAKE_COMPANY, "payments");
    const changed = { ...definition, revision: 2, repositories: definition.repositories.map((repo) => ({ ...repo, defaultBranch: "develop" })) };
    await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(changed)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 2 } });
    expect((await call(get(MAP("payments")), admin)).body).toEqual({ status: "none", canManage: true });
    // The branch the project now names does not exist at the host: the repository is unavailable in the map, the request still answers 200.
    const made = await call(post(MAP("payments")), admin);
    expect(made.status).toBe(200);
    expect(made.body["map"].repositories[0].status).toBe("unavailable");
  });

  it("answers 200 with an unavailable repository when the company has no code host registered for it", async () => {
    const { person, call, wiring } = await mapWorld();
    (wiring.wikiMap as { hostFor: unknown }).hostFor = () => { throw new Error("no host for kind"); };
    const made = await call(post(MAP("payments")), person("p-admin", FAKE_COMPANY, "admin"));
    expect(made.status).toBe(200);
    expect(made.body["map"].repositories[0]).toMatchObject({ status: "unavailable", unavailable: "Rovara could not read this repository's files just now." });
    expect(made.raw).not.toContain("no host for kind");
  });

  it("makes a map once for a button pressed twice in a row", async () => {
    const { person, call, listings } = await mapWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const [one, two] = await Promise.all([call(post(MAP("payments")), admin), call(post(MAP("payments")), admin)]);
    await call(post(MAP("payments")), admin);
    expect(one.body).toEqual(two.body);
    expect(listings).toHaveBeenCalledTimes(1);
  });

  it("needs no model key: the route reads the code host only, and a company's setup standing is the one live read", async () => {
    const { person, call, standing } = await mapWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    await call(post(MAP("payments")), admin);
    expect(standing).toHaveBeenCalledWith("p-admin", FAKE_COMPANY, "payments");
  });

  it("refuses in fixed words when the standing cannot be read, and treats an unknown answer as none, never as manage", async () => {
    const broken = await mapWorld({ standing: async () => { throw new Error("secret detail"); } });
    const caller = broken.person("p", FAKE_COMPANY, "owner");
    const refused = await broken.call(get(MAP("payments")), caller);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: WIKI_MAP_UNREADABLE } });
    expect(refused.raw).not.toContain("secret");
    const odd = await mapWorld({ standing: async () => ({ access: "manage", basis: "somebody" }) as never });
    const answer = await odd.call(post(MAP("payments")), odd.person("p", FAKE_COMPANY, "owner"));
    expect(answer.status).toBe(404);
  });

  it("is 'not on the core yet' when the deployment wires no file map, and leaves other methods alone", async () => {
    const world = createFakeWorld();
    await register(world, FAKE_COMPANY, "payments");
    const app = appOver(world);
    const caller: DeployedCaller = { principal: { companyId: FAKE_COMPANY, personId: "p", displayName: "P", roles: ["owner"], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud" };
    const routes = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => ({ origin: () => "https://api.example" }) });
    const answer = await routes.route(get(MAP("payments")), caller);
    expect(answer?.statusCode).toBe(404);
    expect(JSON.parse(answer!.body).error.message).toBe(NOT_ON_THE_CORE_YET);
    expect(await routes.route({ method: "DELETE", path: MAP("payments"), headers: {}, body: "" }, caller)).toBeUndefined();
    expect(await routes.route({ method: "PUT", path: MAP("payments"), headers: {}, body: "{}" }, caller)).toBeUndefined();
  });
});
