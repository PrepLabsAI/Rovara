// L4-EVW4 (DEC 254zzz43): the hosted routes of the wrapper card. GET eval gives the file (path and text) to everyone who can see the project and reads where the pull request and the file on the default branch stand from the code
// host; POST eval-wrapper is a PERSON's act (open a pull request, Not now, Set up now, Check now). Through the real hosted approvers point and the setup run's own live standing, over the company's own store, with the fake code
// host (which refuses what the real adapter refuses).
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type AuditEvent, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { SETUP_RUN_PROJECT_NOT_FOUND, EVAL_WRAPPER_UNAVAILABLE, type HostedSetupRunWiring, type SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHostedSetupApproval } from "../../packages/broker/src/core-host/setup-approval.js";
import { createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { CAP, company, filesOf, gitReader, project as PROJECT, reportOf } from "../support/eval-card-world.js";

const OTHER = "org_corehost00000000000b";
const KEY = approvalProofKeyOf("callback-signing-key-for-tests-0123456789abcdef");
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
  const person = (personId: string, companyId: OrgId, role: OrgRole, grants: Person["grants"] = {}): DeployedCaller => {
    people.set(personId, { companyId, role, grants });
    return { principal: { companyId, personId, displayName: personId, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud" };
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
const OFFERED = { output: ROWS, wrapperDryRun: "passed", repository: "web" } as const;
const WRAPPER_FILE = "rovara/eval-wrapper.py";
const act = (action: string, extra: Record<string, unknown> = {}) => post(`${RUN}/eval-wrapper`, { requestId: crypto.randomUUID(), action, ...extra });
const open = () => act("open_pull_request", { selection: "evals/demo" });

describe("GET eval: the file and where it stands", () => {
  it("gives everyone who can see the project the file's path and text, and reads the pull request and the default branch from the code host", async () => {
    const h = await hosted();
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    const dev = h.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    await h.reported(FAKE_COMPANY, 2, {}, OFFERED);
    // The setup run's report opened NOTHING: only a person's act does.
    const first = (await h.call(get(`${RUN}/eval`), admin)).body;
    expect(first).toMatchObject({ suites: [{ readable: false }], wrappers: [{ step: "needs_file", offered: true, kind: "template", path: WRAPPER_FILE, canOpenPullRequest: true, title: "Rovara can't read the results of evals/demo yet" }] });
    expect((first["wrappers"] as Array<{ content: string }>)[0]!.content).toMatch(/rovara-eval-wrapper-template: 1/u);
    expect(h.repo.changeRequests).toHaveLength(0);
    // A member sees and copies the same file and cannot open the pull request.
    const seen = (await h.call(get(`${RUN}/eval`), dev)).body["wrappers"] as Array<Record<string, unknown>>;
    expect(seen[0]).toMatchObject({ path: WRAPPER_FILE, canOpenPullRequest: false });
    expect(seen[0]!["content"]).toBe((first["wrappers"] as Array<Record<string, unknown>>)[0]!["content"]);
    // Click, then merge: the next read finds the file on the default branch by itself.
    const tried = await h.call(open(), admin);
    expect(tried.status, tried.raw).toBe(200);
    expect(tried.body).toMatchObject({ outcome: { selection: "evals/demo", state: "open", number: "1" }, wrappers: [{ step: "pull_request_open" }] });
    const cr = h.repo.changeRequests[0]!;
    h.repo.merge(cr.id, { revision: h.repo.headRevisionOf(cr), method: "squash" });
    // A check younger than a minute is left as it is (one read of the host per minute); after that a plain read finds the file by itself.
    expect((await h.call(get(`${RUN}/eval`), admin)).body).toMatchObject({ wrappers: [{ step: "pull_request_open" }] });
    h.world.clock.now += 61_000;
    expect((await h.call(get(`${RUN}/eval`), admin)).body).toMatchObject({ suites: [{ readable: true }], wrappers: [{ step: "file_found", fileStatus: "same" }] });
  });
});

describe("POST eval-wrapper: a person's click opens the pull request", () => {
  it.each([["admin", {}], ["owner", {}], ["member", { [PROJECT]: "administrator" as const }]])("%s %j opens it; the audit names the person and is written before the host is written to", async (role, grants) => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, OFFERED);
    const order: string[] = [];
    const commit = h.codeHost.evalWrapperPullRequest.open.bind(h.codeHost.evalWrapperPullRequest);
    h.codeHost.evalWrapperPullRequest.open = async (input, scope) => { order.push(`write:${h.audit.some((e) => e.action === "eval_wrapper.pull_request_requested") ? "after-audit" : "BEFORE-AUDIT"}`); return commit(input, scope); };
    const who = h.person(`p-${role}`, FAKE_COMPANY, role as OrgRole, grants);
    const answer = await h.call(open(), who);
    expect(answer.status, answer.raw).toBe(200);
    expect(order).toEqual(["write:after-audit"]);
    expect(h.audit.find((e) => e.action === "eval_wrapper.pull_request_requested")).toMatchObject({ companyId: FAKE_COMPANY, actor: { type: "person", id: `p-${role}` }, subject: { type: "project", id: PROJECT }, details: { by: `p-${role}` } });
    expect(h.repo.changeRequests).toHaveLength(1);
    expect(h.repo.revision(h.repo.headOf(h.repo.changeRequests[0]!.sourceBranch)).files.has(WRAPPER_FILE)).toBe(true);
  });

  it("a repeat of the click opens nothing more", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, OFFERED);
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    await h.call(open(), admin);
    const again = await h.call(open(), admin);
    expect(again.body).toMatchObject({ outcome: { state: "open", number: "1" } });
    expect(h.repo.changeRequests).toHaveLength(1);
    expect(h.repo.branches.size).toBe(2);
  });

  it("REFUSES an AI-written (custom) file on this path, and a file the dry-run did not pass: nothing is written and nothing is audited", async () => {
    const custom = await hosted();
    await custom.reported(FAKE_COMPANY, 2, {}, { output: { kind: "custom", language: "python", summary: "reads out.csv", source: "print('x')\n" }, wrapperDryRun: "passed", repository: "web" });
    const admin = custom.person("p-admin", FAKE_COMPANY, "admin");
    expect((await custom.call(open(), admin)).body).toMatchObject({ outcome: { state: "failed", failure: "copy_only" }, wrappers: [{ kind: "custom", copyOnly: { reason: "custom" }, canOpenPullRequest: false }] });
    expect(custom.repo.changeRequests).toHaveLength(0);
    expect(custom.audit.filter((e) => e.action.startsWith("eval_wrapper"))).toEqual([]);
    const unchecked = await hosted();
    await unchecked.reported(FAKE_COMPANY, 2, {}, { output: ROWS, repository: "web" });
    expect((await unchecked.call(open(), unchecked.person("p-admin", FAKE_COMPANY, "admin"))).body).toMatchObject({ outcome: { failure: "not_offered" }, wrappers: [{ offered: false, content: "" }] });
    expect(unchecked.repo.changeRequests).toHaveLength(0);
  });

  it("the role matrix: owner, admin and maintainer act; a project member only looks and checks; no grant sees nothing; a revoked person is refused", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, OFFERED);
    const dev = h.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    for (const body of [open(), act("dismiss"), act("reopen")]) {
      expect((await h.call(body, dev)).body).toEqual({ error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer can ask Rovara to open a pull request for the eval's file, set it aside, or approve its test run." } });
    }
    expect(h.repo.changeRequests).toHaveLength(0);
    expect(h.audit.filter((e) => e.action.startsWith("eval_wrapper"))).toEqual([]);
    // Check now is a read: a member may ask it.
    expect((await h.call(act("check"), dev)).status).toBe(200);
    expect((await h.call(act("check"), h.person("p-member", FAKE_COMPANY, "member"))).body).toEqual({ error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } });
    expect((await h.call(open(), h.person("p-member", FAKE_COMPANY, "member"))).body).toEqual({ error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } });
    expect(h.repo.changeRequests).toHaveLength(0);
  });

  it("Not now sets the card aside for the project (audited, naming the person); Set up now brings it back; Check now finds a file a person added", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, OFFERED);
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    const dev = h.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    expect((await h.call(act("dismiss"), admin)).body).toMatchObject({ wrappers: [{ step: "dismissed", dismissed: true }] });
    expect(h.audit.find((e) => e.action === "eval_wrapper.dismissed")).toMatchObject({ actor: { id: "p-admin" }, details: { by: "p-admin" } });
    // Everyone sees it is set aside (the Evals page row).
    expect((await h.call(get(`${RUN}/eval`), dev)).body).toMatchObject({ wrappers: [{ step: "dismissed", dismissed: true }] });
    expect((await h.call(act("reopen"), admin)).body).toMatchObject({ wrappers: [{ step: "needs_file", dismissed: false }] });
    expect(h.audit.find((e) => e.action === "eval_wrapper.reopened")).toMatchObject({ details: { by: "p-admin" } });
    // A person commits the file; a member's Check now finds it on the default branch.
    h.repo.commit("main", { [WRAPPER_FILE]: "their own wrapper\n" });
    // A first Check now (the read above already looked) is held for a few seconds: nobody can drain the code host's quota with it.
    expect((await h.call(act("check"), dev)).status).toBe(200);
    h.world.clock.now += 16_000;
    expect((await h.call(act("check"), dev)).body).toMatchObject({ wrappers: [{ step: "file_found", fileStatus: "edited" }] });
  });

  it("is not served where no code host target is wired, or with a body that is not an action", async () => {
    const off = await hosted({ wrapper: false });
    await off.reported(FAKE_COMPANY, 2, {}, OFFERED);
    expect((await off.call(open(), off.person("p-admin", FAKE_COMPANY, "admin"))).body).toEqual({ error: { code: "NOT_FOUND", message: EVAL_WRAPPER_UNAVAILABLE } });
    const on = await hosted();
    await on.reported(FAKE_COMPANY, 2, {}, OFFERED);
    const who = on.person("p-admin", FAKE_COMPANY, "admin");
    for (const body of [{}, { requestId: "x", action: "check" }, { requestId: crypto.randomUUID() }, { requestId: crypto.randomUUID(), action: "merge" }, { requestId: crypto.randomUUID(), action: "open_pull_request" }, { requestId: crypto.randomUUID(), action: "check", repository: "other" }]) {
      expect((await on.call(post(`${RUN}/eval-wrapper`, body), who)).status, JSON.stringify(body)).toBe(400);
    }
    expect(on.repo.changeRequests).toHaveLength(0);
  });

  it("another company's admin cannot act on this company's card, and each company's card is its own (two companies)", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, OFFERED);
    const other = h.person("o-admin", OTHER, "admin");
    const answer = await h.call(open(), other);
    // The other company has no eval report for this project: nothing is opened, and nothing of ours is touched.
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(h.repo.changeRequests).toHaveLength(0);
    expect((await h.call(get(`${RUN}/eval`), other)).body).toMatchObject({ wrappers: [] });
    await h.call(act("dismiss"), h.person("p-admin", FAKE_COMPANY, "admin"));
    expect((await h.call(get(`${RUN}/eval`), other)).body).toMatchObject({ wrappers: [] });
  });

  it("answers an eval with nothing to propose without writing anything", async () => {
    const h = await hosted();
    await h.reported(FAKE_COMPANY, 2, {}, { output: { kind: "junit" } });
    const answer = await h.call(open(), h.person("p-admin", FAKE_COMPANY, "admin"));
    expect(answer.body).toMatchObject({ outcome: { failure: "not_needed" }, wrappers: [] });
    expect(h.repo.changeRequests).toHaveLength(0);
  });
});
