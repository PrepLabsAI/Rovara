// L4-EVW2 (DEC 254zzz20 D2): the hosted routes of Rovara's proposed wrapper file. GET eval reads where each proposed pull request stands from the code host; POST eval-wrapper is "Try again" for the proposal. Through the real
// hosted approvers point and the setup run's own live standing, over the company's own store, with the fake code host (which refuses what the real adapter refuses).
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type AuditEvent, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { SETUP_RUN_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, EVAL_WRAPPER_UNAVAILABLE, type HostedSetupRunWiring, type SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHostedSetupApproval } from "../../packages/broker/src/core-host/setup-approval.js";
import { createHostedApprovers, stepUpApprovalKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { CAP, company, filesOf, gitReader, project as PROJECT, reportOf } from "../support/eval-card-world.js";

const OTHER = "org_corehost00000000000b";
const KEY = stepUpApprovalKeyOf("callback-signing-key-for-tests-0123456789abcdef");
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const definition = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }],
});
const appOver = (world: FakeWorld): CoreHostApp => createCoreHostApp({
  env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
  runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
});
async function register(world: FakeWorld, companyId: string, name: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition(name))) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await world.store.put({ item: { ...projectMetaKey(companyId, name), entityType: "PROJECT_META", status: "active" } });
}

const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const RUN = `/v1/app/projects/${PROJECT}/setup-agent`;
interface Person { companyId: OrgId; role: OrgRole; grants: Record<string, "developer" | "administrator"> }

async function hosted(options: { evalWiring?: boolean; wrapper?: boolean } = {}) {
  const world = createFakeWorld();
  const repo = new FakeHostModel({ url: "https://github.com/acme/web", id: "4242", fullName: "acme/web", webBase: "https://github.com" });
  const codeHost = new FakeCodeHost(repo);
  await register(world, FAKE_COMPANY, PROJECT); await register(world, OTHER, PROJECT);
  const app = appOver(world);
  const people = new Map<string, Person>();
  const membershipOf = async (personId: string) => { const found = people.get(personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; };
  const projectGrantRole = async (personId: string, name: string) => people.get(personId)?.grants[name];
  const person = (personId: string, companyId: OrgId, role: OrgRole, grants: Person["grants"] = {}, stepUpAgoMs: number | null = 60_000): DeployedCaller => {
    people.set(personId, { companyId, role, grants });
    return { principal: { companyId, personId, displayName: personId, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud",
      ...(stepUpAgoMs === null ? {} : { stepUp: { at: new Date(world.clock.now - stepUpAgoMs).toISOString(), method: "passkey" } }) };
  };
  const standing = async (personId: string, companyId: string, name: string): Promise<SetupRunStanding> => {
    const found = people.get(personId);
    if (found === undefined || found.companyId !== companyId) return { access: "none" };
    if (found.role === "owner") return { access: "manage", basis: "company-owner" };
    if (found.role === "admin") return { access: "manage", basis: "company-admin" };
    if (found.grants[name] === "administrator") return { access: "manage", basis: "project-admin" };
    return found.grants[name] === "developer" ? { access: "view" } : { access: "none" };
  };
  const identity = createHostedIdentity({ membershipOf, displayNameOf: async (id) => id });
  const approvers = createHostedApprovers({ store: world.store, identity, key: KEY, now: () => new Date(world.clock.now) });
  const audit: AuditEvent[] = [];
  const sink = { stage: (event: AuditEvent) => { audit.push(event); return []; }, record: async (event: AuditEvent) => { audit.push(event); } };
  const reader: { read?: ReturnType<typeof gitReader>; cap: number | undefined } = { cap: CAP };
  const wiringFor = (companyId: OrgId): HostedSetupRunWiring => ({
    standing, modelAccessConfigured: () => true,
    approval: createHostedSetupApproval({ flow: { store: world.store, companyId, now: () => new Date(world.clock.now) }, store: world.store, approvers, audit: sink, identity, people: { membershipOf, projectGrantRole }, proofKey: KEY, now: () => new Date(world.clock.now) }),
    ...(options.evalWiring === false ? {} : { eval: { monthlyCap: async () => reader.cap, readFile: (...args: Parameters<NonNullable<ReturnType<typeof gitReader>>>) => reader.read!(...args),
      ...(options.wrapper === false ? {} : { wrapperTargets: async () => [{ name: "web", place: "fake:repo/4242", repository: { url: "https://github.com/acme/web" }, scope: { orgId: companyId }, host: codeHost }] }) } }),
  });
  const wirings = new Map<string, HostedSetupRunWiring>([[FAKE_COMPANY, wiringFor(FAKE_COMPANY)], [OTHER, wiringFor(OTHER)]]);
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller): Promise<CompanyMembership | undefined> => { const found = people.get(caller.principal.personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; },
    wiring: (runtime) => ({ origin: () => "https://api.example", setupRun: wirings.get(runtime.companyId)!, auditFor: (_caller, inner) => ({ stage: (event) => { audit.push(event); return inner.stage(event); }, record: async (event) => { audit.push(event); } }) }),
  });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown>, raw: answer.body };
  };
  /** A setup run of this company that reported an eval (in the world's own store), and the code host's read of its files. */
  const reported = async (companyId: OrgId, n = 2, edits: Record<string, string> = {}, over: Record<string, unknown> = {}) => {
    const w = company(companyId, {}, world.store);
    const r = await w.run(filesOf(n, edits), reportOf(n, over));
    reader.read = gitReader(r.repo.dir);
    return { w, r };
  };
  return { world, person, call, audit, reader, reported, wirings, repo, codeHost };
}


const ROWS = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } } as const;
const WRAPPER_FILE = "rovara/eval-wrapper.py";

describe("GET eval: the proposed file", () => {
  it("says where each proposal stands, read from the code host: open, merged (set up again), closed", async () => {
    const h = await hosted();
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    await h.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    // The setup run's report opened nothing yet (no callback host wiring here): "Try again" proposes it.
    expect((await h.call(get(`${RUN}/eval`), admin)).body).toMatchObject({ wrappers: [], suites: [{ readable: false }] });
    const tried = await h.call(post(`${RUN}/eval-wrapper`, { requestId: crypto.randomUUID() }), admin);
    expect(tried.status, tried.raw).toBe(200);
    expect(tried.body).toMatchObject({ proposals: [{ selection: "evals/demo", state: "open", number: "1" }] });
    expect((await h.call(get(`${RUN}/eval`), admin)).body).toMatchObject({ wrappers: [{ state: "open", number: "1", line: "Rovara proposed a small file so it can read your eval results: review PR #1" }] });
    const cr = h.repo.changeRequests[0]!;
    h.repo.merge(cr.id, { revision: h.repo.headRevisionOf(cr), method: "squash" });
    expect((await h.call(get(`${RUN}/eval`), admin)).body).toMatchObject({ wrappers: [{ state: "merged", rediscover: true }] });
  });

  it("a person who may only read sees the line but a read never writes anything to the host", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const dev = h.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    const before = h.repo.branches.size;
    expect((await h.call(get(`${RUN}/eval`), dev)).status).toBe(200);
    expect(h.repo.branches.size).toBe(before);
    expect(h.repo.changeRequests).toHaveLength(0);
  });
});

describe("POST eval-wrapper: Try again", () => {
  it.each([["admin", {}], ["owner", {}], ["member", { [PROJECT]: "administrator" as const }]])("%s %j opens the proposal; the audit names the person and is written before the host is written to", async (role, grants) => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const order: string[] = [];
    const commit = h.codeHost.commitFiles.bind(h.codeHost);
    h.codeHost.commitFiles = async (input, scope) => { order.push(`write:${h.audit.some((e) => e.action === "eval_wrapper.retry") ? "after-audit" : "BEFORE-AUDIT"}`); return commit(input, scope); };
    const who = h.person(`p-${role}`, FAKE_COMPANY, role as OrgRole, grants);
    const answer = await h.call(post(`${RUN}/eval-wrapper`, { requestId: crypto.randomUUID() }), who);
    expect(answer.status, answer.raw).toBe(200);
    expect(order).toEqual(["write:after-audit"]);
    expect(h.audit.find((e) => e.action === "eval_wrapper.retry")).toMatchObject({ companyId: FAKE_COMPANY, actor: { id: `p-${role}` }, subject: { type: "project", id: PROJECT } });
    expect(h.repo.changeRequests).toHaveLength(1);
    expect(h.repo.revision(h.repo.headOf(h.repo.changeRequests[0]!.sourceBranch)).files.has(WRAPPER_FILE)).toBe(true);
  });

  it("a repeat of the request opens nothing more", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    const requestId = crypto.randomUUID();
    await h.call(post(`${RUN}/eval-wrapper`, { requestId }), admin);
    const again = await h.call(post(`${RUN}/eval-wrapper`, { requestId }), admin);
    expect(again.body).toMatchObject({ proposals: [{ state: "open" }] });
    expect(h.repo.changeRequests).toHaveLength(1);
    expect(h.repo.branches.size).toBe(2);
  });

  it("refuses a project user and a member with no grant, and writes nothing to the host", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const body = { requestId: crypto.randomUUID() };
    expect((await h.call(post(`${RUN}/eval-wrapper`, body), h.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" }))).body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    expect((await h.call(post(`${RUN}/eval-wrapper`, body), h.person("p-member", FAKE_COMPANY, "member"))).body).toEqual({ error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } });
    expect(h.repo.changeRequests).toHaveLength(0);
    expect(h.repo.branches.size).toBe(1);
    expect(h.audit.filter((e) => e.action.startsWith("eval_wrapper"))).toEqual([]);
  });

  it("is not served where no code host target is wired, or with a body that is not exactly a request id", async () => {
    const off = await hosted({ wrapper: false });
    await off.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const admin = off.person("p-admin", FAKE_COMPANY, "admin");
    expect((await off.call(post(`${RUN}/eval-wrapper`, { requestId: crypto.randomUUID() }), admin)).body).toEqual({ error: { code: "NOT_FOUND", message: EVAL_WRAPPER_UNAVAILABLE } });
    const on = await hosted();
    await on.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const who = on.person("p-admin", FAKE_COMPANY, "admin");
    for (const body of [{}, { requestId: "x" }, { requestId: crypto.randomUUID(), repository: "other" }]) expect((await on.call(post(`${RUN}/eval-wrapper`, body), who)).status).toBe(400);
    expect(on.repo.changeRequests).toHaveLength(0);
  });

  it("another company's admin cannot ask for this company's proposal, and each company's proposal is its own (two companies)", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: ROWS });
    const other = h.person("o-admin", OTHER, "admin");
    const answer = await h.call(post(`${RUN}/eval-wrapper`, { requestId: crypto.randomUUID() }), other);
    // The other company has no eval report for this project: nothing is proposed, and nothing of ours is touched.
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(h.repo.changeRequests).toHaveLength(0);
    expect((await h.call(get(`${RUN}/eval`), other)).body).toMatchObject({ wrappers: [] });
  });

  it("answers an eval with nothing to propose without writing anything", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: { kind: "junit" } });
    const answer = await h.call(post(`${RUN}/eval-wrapper`, { requestId: crypto.randomUUID() }), h.person("p-admin", FAKE_COMPANY, "admin"));
    expect(answer.body).toMatchObject({ proposals: [] });
    expect(h.repo.changeRequests).toHaveLength(0);
  });
});
