// L4-AK1H: the hosted twin of the laptop's team knowledge routes (core-host/knowledge-api.ts). Same request, same answer, same limits as the laptop; what is hosted is WHO asks and for WHICH company: a signed-in person (live
// membership, on the project's roster now) or a script token with the Team knowledge (`lessons`) permission naming the project. Two companies, two projects; every guard has a mutant (briefs/lead4/l4-ak1h/MUTANTS).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentXError, LOCAL_KNOWLEDGE_ANSWER_BYTES_MAX, LOCAL_KNOWLEDGE_DAY_CALLS_MAX, LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE, LOCAL_KNOWLEDGE_NO_BULK_MESSAGE, companyScoped, orgProjectCatalogKey, projectRevisionKey,
  type AuditSink, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition, type ProjectRole,
} from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal, createLocalOwnerApprovers, createLocalOwnerIdentity, createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { createMemoryModelKeyStore } from "../../packages/broker/src/ports/model-key-stores.js";
import { builtinModelProviderBook } from "../../packages/broker/src/local/model-proxy/index.js";
import { createLocalLessons } from "../../packages/broker/src/local/app/lessons.js";
import { createLessonRoutes } from "../../packages/broker/src/local/app/lessons-routes.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import { createKnowledgeApi, knowledgeSwitchedOff, knowledgeToolOf, scriptTokenAuthenticator, type KnowledgeApi, type KnowledgeApiOptions, type KnowledgeCaller } from "../../packages/broker/src/core-host/knowledge-api.js";
import { isLessonsApiPath } from "../../packages/broker/src/core-host/lessons-api.js";
import { KNOWLEDGE_API_ROUTES } from "../../packages/broker/src/aws/developer-routes.js";
import { createHostedIdentity, HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { DEV_ROUTES, devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createScriptToken, revokeScriptToken } from "../../packages/broker/src/core/script-tokens/store.js";
import { PENDING_PK } from "../../packages/broker/src/core/notify/attention.js";
import { KNOWLEDGE_TOOLS, ToolError, httpControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";
import { COMPANY, createHarness, definition } from "../support/task-flow-harness.js";
import { lessonRecord, draft } from "./lessons/lesson-helpers.js";

afterEach(() => setLearnedLessonsGate(undefined));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const REPO = "https://github.com/example/demo.git";
const TEXT = "BODYTEXTMARKER";
const PROJECTS: ProjectDefinition[] = [
  { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: REPO, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] },
  { name: "billing", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "ledger", url: "https://github.com/example/billing.git", path: "repo/ledger", defaultBranch: "main", credentialRef: "host-app" }] },
];
// People: in each company an admin (company role admin), a maintainer and a contributor on the roster, and an outsider who is in the company but on no project.
const PEOPLE = {
  [A]: { admin: "a-admin", maintainer: "a-maint", contributor: "a-contrib", outsider: "a-out" },
  [B]: { admin: "b-admin", maintainer: "b-maint", contributor: "b-contrib", outsider: "b-out" },
} as const;
const ROLE: Record<string, { companyId: OrgId; role: OrgRole; project?: ProjectRole }> = {
  "a-admin": { companyId: A, role: "admin" }, "a-maint": { companyId: A, role: "member", project: "maintainer" }, "a-contrib": { companyId: A, role: "member", project: "contributor" }, "a-out": { companyId: A, role: "member" },
  "b-admin": { companyId: B, role: "admin" }, "b-maint": { companyId: B, role: "member", project: "maintainer" }, "b-contrib": { companyId: B, role: "member", project: "contributor" }, "b-out": { companyId: B, role: "member" },
};

async function registerProjects(world: FakeWorld, companyId: string): Promise<void> {
  for (const project of PROJECTS) {
    await world.store.put({ item: { ...projectRevisionKey(companyId, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
  }
}

/** The people port: the roster is everyone of the company but the outsider and the people in `removed`; `projects` limits who is on which project. */
function peopleOf(removed: Set<string>): HostedLessonPeople & { asked: string[] } {
  const asked: string[] = [];
  const of = (companyId: string): { admin: string; maintainer: string; contributor: string } => { const found = companyId === A || companyId === B ? PEOPLE[companyId] : undefined; if (found === undefined) throw new Error("asked about another company"); return found; };
  return {
    asked,
    async approvers(companyId) { asked.push(companyId); const p = of(companyId); return { complete: true, membershipVersion: 1, ownerIds: [p.admin], eligibleIds: [p.admin, p.maintainer], lastEligibleLossAtMs: null }; },
    async onProjectRoster(companyId, project, personId) { asked.push(companyId); const p = of(companyId); return project === "payments" && !removed.has(personId) && [p.admin, p.maintainer, p.contributor].includes(personId); },
    async projectMembers(companyId, project) { asked.push(companyId); const p = of(companyId); return { complete: true, ids: project === "payments" ? [p.admin, p.maintainer, p.contributor] : [] }; },
    async linkedAccounts(companyId) { asked.push(companyId); return []; },
    async displayName(companyId, personId) { asked.push(companyId); return ROLE[personId]?.companyId === companyId ? `Name ${personId}` : undefined; },
    async isErased(companyId) { asked.push(companyId); return false; },
  };
}

interface World {
  world: FakeWorld; lessons: Map<OrgId, CoreLessons>; audits: Map<OrgId, AuditSink>; people: ReturnType<typeof peopleOf>; removed: Set<string>;
  /** Whose membership is gone (a person removed from the company: `membershipOf` answers nothing). */
  left: Set<string>;
  roles: Map<string, { companyId: OrgId; role: OrgRole }>;
}

async function setUp(env: NodeJS.ProcessEnv = { [CORE_LESSONS_VARIABLE]: "on" }): Promise<World> {
  const world = createFakeWorld();
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const removed = new Set<string>();
  const people = peopleOf(removed);
  const lessons = new Map<OrgId, CoreLessons>();
  const audits = new Map<OrgId, AuditSink>();
  for (const companyId of [A, B]) {
    await registerProjects(world, companyId);
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const built = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch, people, hostFor: async (id) => lessons.get(id as OrgId)?.host, now: () => world.clock.now });
    built?.attach();
    if (built !== undefined) lessons.set(companyId, built);
    audits.set(companyId, runtime.flow.deps.audit);
  }
  const roles = new Map(Object.entries(ROLE).map(([id, value]) => [id, { companyId: value.companyId, role: value.role }] as const));
  return { world, lessons, audits, people, removed, left: new Set(), roles };
}

const identityOf = (w: World) => createHostedIdentity({
  membershipOf: async (personId) => (w.left.has(personId) ? undefined : w.roles.get(personId)),
  displayNameOf: async (personId) => `Name ${personId}`,
});

interface Built { api: KnowledgeApi; notices: () => Promise<Array<Record<string, unknown>>>; options: KnowledgeApiOptions }
function build(w: World, over: Partial<KnowledgeApiOptions> = {}): Built {
  const identity = identityOf(w);
  const lessonsSwitch = { mode: "on" } as const;
  const options: KnowledgeApiOptions = {
    lessonsSwitch,
    companyOf: async (caller) => (w.left.has(caller.personId) ? undefined : w.roles.get(caller.personId)),
    lessonsOf: async (companyId) => w.lessons.get(companyId),
    people: w.people,
    authenticateToken: scriptTokenAuthenticator({ lessonsSwitch, now: () => w.world.clock.now, companyOf: async (companyId) => ({ store: w.world.store, audit: w.audits.get(companyId)!, identity }) }),
    adminsOf: async (companyId) => { const principals = [await identity.getPrincipal(companyId, companyId === A ? PEOPLE[A].admin : PEOPLE[B].admin)]; return principals.flatMap((p) => (p === undefined ? [] : [developerIdOf(p)])); },
    now: () => w.world.clock.now, ...over,
  };
  return { api: createKnowledgeApi(options), options, notices: async () => (await w.world.store.query({ pk: PENDING_PK })).items as Array<Record<string, unknown>> };
}

const P = "/v1/dev/projects/payments";
const lessonsPath = (project = "payments") => `/v1/dev/projects/${project}/lessons`;
const areasPath = (project = "payments") => `/v1/dev/projects/${project}/knowledge/areas`;

interface Reply { ok: boolean; status?: number; code?: string; message?: string; body?: { status?: string; reason?: string; project?: string; lessons: Array<{ id: string }>; markdown: string; repos: Array<{ repo: string; areas: unknown[] }>; more: number } }
async function call(api: KnowledgeApi, caller: KnowledgeCaller, path: string, body: unknown = {}, authorization?: string): Promise<Reply> {
  try {
    const answer = await api.answer({ method: "POST", path, ...(authorization === undefined ? {} : { authorization }), body: typeof body === "string" ? body : JSON.stringify(body) }, caller);
    return { ok: true, body: answer as Reply["body"] };
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return { ok: false, code: error.code, status: error.statusCode, message: error.message.slice(error.code.length + 2) };
  }
}
const person = (id: string): KnowledgeCaller => ({ kind: "person", personId: id });
const asPerson = (b: Built, id: string, path: string, body?: unknown) => call(b.api, person(id), path, body);
const asToken = (b: Built, secret: string, path: string, body?: unknown) => call(b.api, { kind: "token" }, path, body, `Bearer ${secret}`);

const lesson = (companyId: string, id: string, over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id, workspaceId: companyId, project: "payments", type: "convention", tier: 1, tierReasons: [], approvals: [{ approvalId: "a1", by: "a-admin", at: 1, mode: "one" }], scope: {}, citations: [], citationChecks: [],
  stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"], provenance: { ...draft().provenance, supportTasks: [], authors: ["ann"] },
  title: "Use the retry helper", description: "Retries go through withRetry.", body: `Wrap network calls in withRetry instead of looping by hand. ${TEXT}`, ...over,
});
async function put(w: World, companyId: OrgId, ...list: ReturnType<typeof lessonRecord>[]): Promise<void> {
  const store = w.lessons.get(companyId)!.runtime.store;
  for (const one of list) { const key = { workspaceId: companyId, project: one.project }; await store.commit(key, await store.setVersion(key), [one], 1); }
}
async function makeToken(w: World, personId: string, over: { permissions?: Array<"read" | "start" | "lessons">; projects?: string[]; companyId?: OrgId } = {}): Promise<string> {
  const companyId = over.companyId ?? ROLE[personId]!.companyId;
  const principal = (await identityOf(w).getPrincipal(companyId, personId))!;
  const made = await createScriptToken(
    { store: w.world.store, audit: w.audits.get(companyId)!, now: () => w.world.clock.now },
    { developerId: developerIdOf(principal), personId, orgId: companyId, orgRole: ROLE[personId]!.role },
    { requestId: randomUUID(), name: "tool", projects: over.projects ?? ["payments"], permissions: over.permissions ?? ["lessons"] }, async () => undefined);
  return made.secret;
}
const knowledgeAudit = (w: World) => w.world.audit.filter((event) => event.action === "lesson.knowledge_read");
const ids = (r: Reply) => (r.body?.lessons ?? []).map((l) => l.id);

describe("the route table and the paths", () => {
  it("adds exactly two rows (full access only), recognises exactly those two paths, and leaves the lessons API's own path test alone", () => {
    const rows = DEV_ROUTES.filter((route) => route.path.endsWith("/knowledge/areas") || (route.method === "POST" && route.path === "/v1/dev/projects/{project}/lessons"));
    expect(rows).toEqual([{ method: "POST", path: "/v1/dev/projects/{project}/lessons", requires: "full" }, { method: "POST", path: "/v1/dev/projects/{project}/knowledge/areas", requires: "full" }]);
    expect(knowledgeToolOf("POST", lessonsPath())).toBe("lessons");
    expect(knowledgeToolOf("POST", areasPath())).toBe("areas");
    for (const [method, path] of [["GET", lessonsPath()], ["PUT", lessonsPath()], ["POST", `${P}/lessons/mode`], ["POST", `${P}/lessons/x1/approve`], ["POST", `${P}/knowledge`], ["POST", `${P}/knowledge/areas/x`], ["POST", `${P}/knowledgex/areas`], ["POST", "/v1/dev/projects/a/b/lessons"]] as const) {
      expect(knowledgeToolOf(method, path), `${method} ${path}`).toBeUndefined();
    }
    // The developer router and the API recognise exactly the same paths.
    const samples = [lessonsPath(), areasPath(), areasPath("a.b-c_d"), `${P}/lessons/`, `${P}/knowledge`, `${P}/knowledge/areas/`, `${P}/lessons/x`, "/v1/dev/projects//lessons", "/v1/dev/projects/a/b/knowledge/areas", `${P}/lessonsx`];
    for (const path of samples) expect(KNOWLEDGE_API_ROUTES.test(path), path).toBe(knowledgeToolOf("POST", path) !== undefined);
    // The GET list row is untouched, and the new POST row is answered by the knowledge API first (the lessons API never sees it).
    expect(devRouteOf("GET", lessonsPath())).toEqual({ method: "GET", path: "/v1/dev/projects/{project}/lessons", requires: "full" });
    expect(isLessonsApiPath(lessonsPath())).toBe(true);
    expect(devRouteOf("POST", lessonsPath())?.requires).toBe("full");
  });
});

describe("a signed-in person", () => {
  it("a person on the project's roster gets the project's approved, live units and the tree; only the whole-project view", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001", { scope: { paths: ["src/pay/**"] } }), lesson(A, "les_pend0001", { status: "pending", approvals: [], pendingExpiresAt: 1_900_000_000_000 }));
    const answer = await asPerson(b, "a-contrib", lessonsPath(), { files: ["src/pay/a.ts"] });
    expect(answer).toMatchObject({ ok: true, body: { status: "ok", project: "payments" } });
    expect(ids(answer)).toEqual(["les_pay00001"]);
    expect(answer.body!.markdown).toContain("withRetry");
    const tree = await asPerson(b, "a-contrib", areasPath());
    expect(tree.body).toMatchObject({ status: "ok", project: "payments" });
    expect(JSON.stringify(tree.body)).not.toContain("les_pay");
    // A company admin is on every project of their company.
    expect((await asPerson(b, "a-admin", lessonsPath())).ok).toBe(true);
  });

  it("someone in the company but not on the project's roster, a project that does not exist and another company's project all answer the same words", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const same = { ok: false, code: "NOT_FOUND", message: "No such project." };
    expect(await asPerson(b, "a-out", lessonsPath())).toMatchObject(same);
    expect(await asPerson(b, "a-out", areasPath())).toMatchObject(same);
    expect(await asPerson(b, "a-contrib", lessonsPath("nope"))).toMatchObject(same);
    expect(await asPerson(b, "a-contrib", lessonsPath("billing"))).toMatchObject(same);
    // B's person asking for A's project name reads B's own (empty) project: never A's units.
    const theirs = await asPerson(b, "b-contrib", lessonsPath());
    expect(theirs.ok).toBe(true);
    expect(ids(theirs)).toEqual([]);
    expect(knowledgeAudit(w).every((event) => event.actor.id === "b-contrib")).toBe(true);
  });

  it("a person with no company (or one whose membership cannot be read) is told to sign in again and nothing is read", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    expect(await asPerson(b, "stranger", lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED", message: "Sign in again." });
    const broken = build(w, { companyOf: async () => { throw new Error("down"); } });
    expect(await asPerson(broken, "a-contrib", lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    const malformed = build(w, { companyOf: async () => ({ companyId: "not-a-company", role: "member" }) as never });
    expect(await asPerson(malformed, "a-contrib", lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(knowledgeAudit(w)).toEqual([]);
  });

  it("the project roster is read live: a person removed from the project is refused at once, on the very next call, with no cache", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    expect((await asPerson(b, "a-contrib", lessonsPath())).ok).toBe(true);
    w.removed.add("a-contrib");
    expect(await asPerson(b, "a-contrib", lessonsPath())).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No such project." });
    expect(await asPerson(b, "a-contrib", areasPath())).toMatchObject({ ok: false, code: "NOT_FOUND" });
    w.removed.delete("a-contrib");
    expect((await asPerson(b, "a-contrib", lessonsPath())).ok).toBe(true);
    // A roster that cannot be read refuses (fail closed), with fixed words.
    const down = build(w, { people: { onProjectRoster: async () => { throw new Error("roster down"); } } });
    expect(await asPerson(down, "a-contrib", lessonsPath())).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE", message: "Rovara can't read lessons right now. Try again." });
  });
});

describe("a script token", () => {
  it("a token with the Team knowledge permission naming the project reads the whole-project answer and the tree, as its creator", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const secret = await makeToken(w, "a-contrib");
    const answer = await asToken(b, secret, lessonsPath());
    expect(answer).toMatchObject({ ok: true, body: { status: "ok" } });
    expect(ids(answer)).toEqual(["les_pay00001"]);
    expect((await asToken(b, secret, areasPath())).ok).toBe(true);
    const events = knowledgeAudit(w);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ actor: { id: "a-contrib" }, details: { tool: "lessons", via: "token", units: 1, u1: "les_pay00001" } });
  });

  it("a token without the permission, for another project, or on a route that is not on the token list is refused and reads, counts and audits nothing", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const noPermission = await makeToken(w, "a-contrib", { permissions: ["read", "start"] });
    const otherProject = await makeToken(w, "a-contrib", { projects: ["billing"] });
    for (const path of [lessonsPath(), areasPath()]) {
      expect(await asToken(b, noPermission, path), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await asToken(b, otherProject, path), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    const good = await makeToken(w, "a-contrib");
    expect(await call(b.api, { kind: "token" }, `${P}/lessons/mode`, {}, `Bearer ${good}`)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(knowledgeAudit(w)).toEqual([]);
    expect((await w.world.store.query({ pk: companyScoped(A, "KNOWLEDGE_READ_DAY") })).items).toEqual([]);
    // The server checks the token's scope again: a wiring that let one through still refuses it.
    const passthrough = build(w, { authenticateToken: async () => ({ companyId: A, personId: "a-contrib", token: { tokenId: "stk_x", permissions: ["read"], projects: ["payments"] } }) });
    expect(await asToken(passthrough, good, lessonsPath())).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No such project." });
    const otherScope = build(w, { authenticateToken: async () => ({ companyId: A, personId: "a-contrib", token: { tokenId: "stk_x", permissions: ["lessons"], projects: ["billing"] } }) });
    expect(await asToken(otherScope, good, lessonsPath())).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No such project." });
    expect(knowledgeAudit(w)).toEqual([]);
  });

  it("a made-up, malformed, revoked or switched-off token is refused with fixed words, and so is every token when script tokens are not served", async () => {
    const w = await setUp();
    const b = build(w);
    const secret = await makeToken(w, "a-contrib");
    for (const bad of ["rvst_notatoken", `${secret}x`, `${secret.slice(0, -1)}A`, "garbage", ""]) {
      const refused = await asToken(b, bad, lessonsPath());
      expect(refused, bad).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
      expect(refused.message ?? "").not.toContain(bad === "" ? "never" : bad);
    }
    // Revoked: at once.
    expect((await asToken(b, secret, lessonsPath())).ok).toBe(true);
    const principal = (await identityOf(w).getPrincipal(A, "a-contrib"))!;
    const tokenId = `stk_${secret.split("_")[2]!}`;
    await revokeScriptToken({ store: w.world.store, audit: w.audits.get(A)!, now: () => w.world.clock.now }, { developerId: developerIdOf(principal), personId: "a-contrib", orgId: A, orgRole: "member" }, tokenId);
    expect(await asToken(b, secret, lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED", message: "This script token was revoked." });
    // Script tokens switched off on the install, or no authenticator wired: refused before anything is read.
    const fresh = await makeToken(w, "a-contrib");
    const off = build(w, { authenticateToken: scriptTokenAuthenticator({ lessonsSwitch: { mode: "on" }, now: () => w.world.clock.now, enabled: () => false, companyOf: async (companyId) => ({ store: w.world.store, audit: w.audits.get(companyId)!, identity: identityOf(w) }) }) });
    expect(await asToken(off, fresh, lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED", message: "Script tokens are turned off here." });
    const unwired = build(w, { authenticateToken: undefined });
    expect(await asToken(unwired, fresh, lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("a token's creator is read live: removed from the company, role changed, or removed from the project, and the token stops at once", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const roster = await makeToken(w, "a-contrib");
    expect((await asToken(b, roster, lessonsPath())).ok).toBe(true);
    w.removed.add("a-contrib");
    expect(await asToken(b, roster, lessonsPath())).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No such project." });
    w.removed.delete("a-contrib");
    expect((await asToken(b, roster, lessonsPath())).ok).toBe(true);
    const left = await makeToken(w, "a-maint");
    expect((await asToken(b, left, lessonsPath())).ok).toBe(true);
    w.left.add("a-maint");
    expect(await asToken(b, left, lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    const changed = await makeToken(w, "a-admin");
    w.roles.set("a-admin", { companyId: A, role: "member" });
    expect(await asToken(b, changed, lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("company isolation: a token of company B never reads company A, and a token that claims A is looked up in A only", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_mine0001", { title: "Company A only" }));
    await put(w, B, lesson(B, "les_theirs01", { title: "Company B only" }));
    const bToken = await makeToken(w, "b-contrib");
    const answer = await asToken(b, bToken, lessonsPath());
    expect(ids(answer)).toEqual(["les_theirs01"]);
    expect(JSON.stringify(answer)).not.toContain("les_mine");
    const aToken = await makeToken(w, "a-contrib");
    expect(ids(await asToken(b, aToken, lessonsPath()))).toEqual(["les_mine0001"]);
    // A's token with B's company id swapped into it is B's lookup, which holds no such token.
    const swapped = aToken.replace(/^rvst_[0-9a-z]{20}/u, `rvst_${B.slice(4)}`);
    expect(await asToken(b, swapped, lessonsPath())).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    // Every counter and record of A's read is under A's partition.
    expect((await w.world.store.query({ pk: companyScoped(A, "KNOWLEDGE_READ_DAY") })).items.length).toBe(1);
    expect((await w.world.store.query({ pk: companyScoped(B, "KNOWLEDGE_READ_DAY") })).items.length).toBe(1);
    expect(knowledgeAudit(w).map((event) => event.companyId).sort()).toEqual([A, B]);
  });

  it("a token for a company the lessons switch does not cover builds nothing and is refused", async () => {
    const w = await setUp({ [CORE_LESSONS_VARIABLE]: `on:${A}` });
    const secretB = await makeToken(w, "b-contrib");
    const lessonsSwitch = readCoreLessonsSwitch({ [CORE_LESSONS_VARIABLE]: `on:${A}` }).value;
    const looked: string[] = [];
    const authenticate = scriptTokenAuthenticator({ lessonsSwitch, now: () => w.world.clock.now, companyOf: async (companyId) => { looked.push(companyId); return { store: w.world.store, audit: w.audits.get(companyId)!, identity: identityOf(w) }; } });
    await expect(authenticate({ method: "POST", path: lessonsPath(), authorization: `Bearer ${secretB}` })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(looked).toEqual([]);
  });
});

describe("names: a unit that names a person of the project never leaves Rovara", () => {
  it("is left out when it names the asker, an approver (owner, admin or maintainer) or, where the port lists the roster, any member of the project", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_clean001", { title: "Use the retry helper" }),
      lesson(A, "les_asker001", { title: "Ask Name a-contrib about it", body: "Name a-contrib knows." }),
      lesson(A, "les_maint001", { title: "Ask Name a-maint before billing changes", body: "Name a-maint decides." }),
      lesson(A, "les_admin001", { title: "Ask Name a-admin", body: "x" }));
    // The maintainer and the admin are the project's approvers; the asker is the person asking.
    const answer = await asPerson(b, "a-contrib", lessonsPath());
    expect(ids(answer)).toEqual(["les_clean001"]);
    // Another member who is NOT an approver and not the asker is named by the roster list (the port gives it).
    await put(w, A, lesson(A, "les_other001", { title: "Ask Name a-contrib" }));
    const viaMaint = await asPerson(b, "a-maint", lessonsPath());
    expect(ids(viaMaint)).toEqual(["les_clean001"]);
    // Without a roster list from the port the contributor is covered only while they are the asker.
    const noRoster = build(w, { people: { onProjectRoster: (...args) => w.people.onProjectRoster(...args), approvers: (...args) => w.people.approvers(...args) } });
    expect(ids(await asPerson(noRoster, "a-maint", lessonsPath()))).toEqual(["les_asker001", "les_clean001", "les_other001"]);
  });

  it("an approver list or a roster that cannot be completed, or read, withholds everything (fail closed, fixed words)", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_clean001"));
    const incompleteApprovers = build(w, { people: { onProjectRoster: (...args) => w.people.onProjectRoster(...args), approvers: async () => ({ complete: false, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }) } });
    const incompleteRoster = build(w, { people: { onProjectRoster: (...args) => w.people.onProjectRoster(...args), approvers: (...args) => w.people.approvers(...args), projectMembers: async () => ({ complete: false, ids: [] }) } });
    const failingRoster = build(w, { people: { onProjectRoster: (...args) => w.people.onProjectRoster(...args), approvers: (...args) => w.people.approvers(...args), projectMembers: async () => { throw new Error("down"); } } });
    for (const b of [incompleteApprovers, incompleteRoster, failingRoster]) {
      const refused = await asPerson(b, "a-contrib", lessonsPath());
      expect(refused).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE", message: "Rovara can't read lessons right now. Try again." });
      expect(JSON.stringify(refused)).not.toContain("withRetry");
    }
    expect(knowledgeAudit(w)).toEqual([]);
  });
});

describe("limits", () => {
  it("an answer holds at most 10 units and 2 KB whatever the project holds, and `all` is refused in fixed words before anything is read", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, ...Array.from({ length: 14 }, (_, i) => lesson(A, `les_many${String(i).padStart(4, "0")}`)));
    const answer = await asPerson(b, "a-contrib", lessonsPath());
    expect(answer.body!.lessons.length).toBeLessThanOrEqual(10);
    expect(answer.body!.lessons.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(answer.body!.markdown, "utf8")).toBeLessThanOrEqual(LOCAL_KNOWLEDGE_ANSWER_BYTES_MAX);
    const before = knowledgeAudit(w).length;
    expect(await asPerson(b, "a-contrib", lessonsPath(), { all: true })).toMatchObject({ ok: false, code: "CONFIG_INVALID", message: `all: ${LOCAL_KNOWLEDGE_NO_BULK_MESSAGE}` });
    expect(knowledgeAudit(w).length).toBe(before);
    expect((await asPerson(b, "a-contrib", lessonsPath(), { all: false })).ok).toBe(true);
    // A body with a field this route does not take, or that is not JSON, is refused with field names only.
    expect(await asPerson(b, "a-contrib", lessonsPath(), { who: "someone-else-SECRET" })).toMatchObject({ ok: false, code: "CONFIG_INVALID", message: "body: has a field this route does not take" });
    expect(await asPerson(b, "a-contrib", lessonsPath(), "not json SECRET")).toMatchObject({ ok: false, code: "CONFIG_INVALID", message: "body: is not JSON" });
  });

  it("300 reads a day a person: the 301st is refused in fixed words with no unit, a person and a token share one day, another person has their own, and the next UTC day opens again", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const secret = await makeToken(w, "a-contrib");
    for (let n = 0; n < LOCAL_KNOWLEDGE_DAY_CALLS_MAX; n += 1) {
      if (n % 50 === 0) w.world.clock.advance(60);
      // Both doors count: the person's own sign-in and the person's token are one person.
      const result = n % 2 === 0 ? await asPerson(b, "a-contrib", lessonsPath()) : await asToken(b, secret, lessonsPath());
      expect(result.ok, String(n)).toBe(true);
    }
    w.world.clock.advance(60);
    const refused = await asPerson(b, "a-contrib", lessonsPath());
    expect(refused).toMatchObject({ ok: false, code: "TOO_MANY_REQUESTS", message: LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE });
    expect(JSON.stringify(refused)).not.toContain("withRetry");
    expect(await asToken(b, secret, areasPath())).toMatchObject({ ok: false, code: "TOO_MANY_REQUESTS", message: LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE });
    expect((await asPerson(b, "a-maint", lessonsPath())).ok).toBe(true);
    // Another company's person with the same project name is another day entirely.
    expect((await asPerson(b, "b-contrib", lessonsPath())).ok).toBe(true);
    expect(knowledgeAudit(w)).toHaveLength(LOCAL_KNOWLEDGE_DAY_CALLS_MAX + 2);
    w.world.clock.advance(86_400);
    expect((await asPerson(b, "a-contrib", lessonsPath())).ok).toBe(true);
  }, 60_000);

  it("a counter that cannot be read refuses the call (fail closed) with fixed words and returns no unit", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const realUpdate = w.world.store.update.bind(w.world.store);
    w.world.store.update = (async (request: Parameters<typeof realUpdate>[0]) => { if (String(request.key.pk).includes("KNOWLEDGE_READ_DAY") || String(request.key.pk).includes("RATE")) throw new Error("store down"); return realUpdate(request); }) as typeof w.world.store.update;
    const refused = await asPerson(b, "a-contrib", lessonsPath());
    expect(refused).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE", message: "Rovara can't read lessons right now. Try again." });
    expect(JSON.stringify(refused)).not.toContain("withRetry");
    expect(knowledgeAudit(w)).toEqual([]);
  });

  it("60 reads a minute a person, across both tools", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    for (let n = 0; n < 60; n += 1) expect((await asPerson(b, "a-contrib", n % 2 === 0 ? lessonsPath() : areasPath())).ok, String(n)).toBe(true);
    expect(await asPerson(b, "a-contrib", lessonsPath())).toMatchObject({ ok: false, code: "TOO_MANY_REQUESTS", message: "Too many lesson requests. Try again in a minute." });
    // Another person has their own minute.
    expect((await asPerson(b, "a-maint", lessonsPath())).ok).toBe(true);
    w.world.clock.advance(61);
    expect((await asPerson(b, "a-contrib", lessonsPath())).ok).toBe(true);
  });
});

describe("audit: one record per answer, unit ids only, written before the answer", () => {
  it("records the tool, how it asked and the ids, never a title, a reason, a body, the task text, a file or a repository", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_aaaa1111", { title: "Title-should-not-leak" }), lesson(A, "les_bbbb2222", { title: "Another-title" }));
    const secret = await makeToken(w, "a-contrib");
    const answer = await asToken(b, secret, lessonsPath(), { task: "TASK-WORDS-never-audited", files: ["src/secret-file.ts"], repo: REPO });
    expect(ids(answer).sort()).toEqual(["les_aaaa1111", "les_bbbb2222"]);
    const events = knowledgeAudit(w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { id: "a-contrib" }, companyId: A, details: { tool: "lessons", via: "token", units: 2, tokenId: `stk_${secret.split("_")[2]!}` } });
    expect(JSON.stringify(events)).not.toContain(secret);
    const written = JSON.stringify(events);
    for (const text of ["Title-should-not-leak", "Another-title", "withRetry", TEXT, "TASK-WORDS", "secret-file", "example/demo"]) expect(written, text).not.toContain(text);
    // The tree is one record with no units; an answer of none is still one record.
    await asPerson(b, "a-contrib", areasPath());
    expect(knowledgeAudit(w)).toHaveLength(2);
    expect(knowledgeAudit(w)[1]).toMatchObject({ details: { tool: "areas", via: "person", units: 0 } });
  });

  it("no record, no answer: when the audit cannot be written nothing is returned", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const sink = w.audits.get(A)!;
    const real = sink.record.bind(sink);
    sink.record = async (event) => { if (event.action === "lesson.knowledge_read") throw new Error("ledger down"); return real(event); };
    const answer = await asPerson(b, "a-contrib", lessonsPath());
    expect(answer).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
    expect(JSON.stringify(answer)).not.toContain("withRetry");
    expect((await asPerson(b, "a-contrib", areasPath()))).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the admin notice: above 150 distinct units, once a day, to the company's admins", () => {
  it("queues one notice for the admins of THAT company on the call that crosses the line, with an audit alert, and tells nobody for repeats", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, ...Array.from({ length: 152 }, (_, i) => lesson(A, `les_dist${String(i).padStart(5, "0")}`, { scope: { paths: [`src/f${String(i)}.ts`] } })));
    let calls = 0;
    const read = async (i: number) => { if (calls % 50 === 0) w.world.clock.advance(60); calls += 1; return asPerson(b, "a-contrib", lessonsPath(), { files: [`src/f${String(i)}.ts`] }); };
    for (let i = 0; i < 150; i += 1) expect(ids(await read(i))).toHaveLength(1);
    for (let i = 0; i < 20; i += 1) await read(i);
    expect(await b.notices()).toEqual([]);
    await read(150);
    const rows = await b.notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "knowledge_read", orgId: A, developerId: developerIdOf((await identityOf(w).getPrincipal(A, "a-admin"))!) });
    await read(151);
    expect(await b.notices()).toHaveLength(1);
    const alerts = w.world.audit.filter((event) => event.action === "lesson.knowledge_read_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ companyId: A, details: { distinct: 151, line: 150 } });
    expect(JSON.stringify(rows)).not.toMatch(/les_dist|src\/f/u);
  }, 60_000);

  it("a failing admin lookup or notice leaves the answer standing and tells nobody (fail closed)", async () => {
    const w = await setUp();
    const logs: Array<Record<string, unknown>> = [];
    for (const adminsOf of [async () => { throw new Error("down"); }, async () => []]) {
      const b = build(w, { adminsOf, log: (entry) => logs.push(entry) });
      await put(w, A, ...Array.from({ length: 151 }, (_, i) => lesson(A, `les_fail${String(i).padStart(5, "0")}`, { scope: { paths: [`src/f${String(i)}.ts`] } })));
      let last: Reply | undefined;
      for (let i = 0; i < 151; i += 1) { if (i % 50 === 0) w.world.clock.advance(60); last = await asPerson(b, "a-maint", lessonsPath(), { files: [`src/f${String(i)}.ts`] }); }
      expect(last!.ok).toBe(true);
      expect(await b.notices()).toEqual([]);
      w.world.clock.advance(86_400);
    }
    expect(logs.filter((entry) => entry["event"] === "knowledge.note_failed")).toEqual([{ component: "lessons", event: "knowledge.note_failed", error: "Error" }]);
  }, 60_000);
});

describe("the switches", () => {
  it("the install's lessons switch off: the laptop's fixed off answer, nothing read, not even who is asking; a token is not looked up", async () => {
    const w = await setUp({});
    const secret = await makeToken(w, "a-contrib");
    const looked: string[] = [];
    const off = build(w, { lessonsSwitch: { mode: "off" }, authenticateToken: async () => { looked.push("token"); throw new Error("must not be asked"); } });
    const before = w.people.asked.length;
    for (const path of [lessonsPath(), areasPath()]) {
      const answer = await asPerson(off, "a-contrib", path);
      expect(answer.body).toMatchObject({ status: "off", reason: "install_switch", project: "payments" });
      expect((await asToken(off, secret, path)).body).toMatchObject({ status: "off", reason: "install_switch" });
    }
    expect(looked).toEqual([]);
    expect(w.people.asked.length).toBe(before);
    expect(knowledgeAudit(w)).toEqual([]);
    expect(knowledgeSwitchedOff({ method: "POST", path: lessonsPath() }, 0)).toMatchObject({ status: "off", reason: "install_switch", lessons: [] });
    expect(knowledgeSwitchedOff({ method: "POST", path: areasPath("billing") }, 0)).toMatchObject({ status: "off", project: "billing", repos: [], more: 0 });
    expect(() => knowledgeSwitchedOff({ method: "GET", path: lessonsPath() }, 0)).toThrow();
  });

  it("a company the switch does not cover, or one whose lessons are not built, gets the off answer; nothing is read for it", async () => {
    const w = await setUp({ [CORE_LESSONS_VARIABLE]: `on:${A}` });
    const covered = build(w, { lessonsSwitch: readCoreLessonsSwitch({ [CORE_LESSONS_VARIABLE]: `on:${A}` }).value });
    await put(w, A, lesson(A, "les_pay00001"));
    expect(ids(await asPerson(covered, "a-contrib", lessonsPath()))).toEqual(["les_pay00001"]);
    expect((await asPerson(covered, "b-contrib", lessonsPath())).body).toMatchObject({ status: "off", reason: "install_switch" });
    const unbuilt = build(w, { lessonsOf: async () => undefined });
    expect((await asPerson(unbuilt, "a-contrib", areasPath())).body).toMatchObject({ status: "off" });
    const throwing = build(w, { lessonsOf: async () => { throw new Error("down"); } });
    expect(await asPerson(throwing, "a-contrib", lessonsPath())).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
  });

  it("lessons handed back for another company are a wiring fault: refused before any read, with fixed words", async () => {
    const w = await setUp();
    await put(w, B, lesson(B, "les_theirs01"));
    const crossed = build(w, { lessonsOf: async () => w.lessons.get(B) });
    const refused = await asPerson(crossed, "a-contrib", lessonsPath());
    expect(refused).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE", message: "Rovara can't read lessons right now. Try again." });
    expect(JSON.stringify(refused)).not.toContain("withRetry");
    expect(knowledgeAudit(w)).toEqual([]);
  });

  it("the company's \"lessons stay in Rovara\" switch and the project's own switch end every answer with the fixed sentence, for a person and a token, at once", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const secret = await makeToken(w, "a-contrib");
    const runtime = w.lessons.get(A)!.runtime;
    expect(ids(await asPerson(b, "a-contrib", lessonsPath()))).toEqual(["les_pay00001"]);
    await runtime.localTools.setCompany(A, true, w.world.clock.now);
    for (const reply of [await asPerson(b, "a-contrib", lessonsPath()), await asToken(b, secret, lessonsPath())]) expect(reply.body).toMatchObject({ status: "off", reason: "company_stays", lessons: [] });
    expect((await asPerson(b, "a-contrib", areasPath())).body).toMatchObject({ status: "off", reason: "company_stays", repos: [] });
    // Another company is not affected by it.
    await put(w, B, lesson(B, "les_theirs01"));
    expect(ids(await asPerson(b, "b-contrib", lessonsPath()))).toEqual(["les_theirs01"]);
    await runtime.localTools.setCompany(A, false, w.world.clock.now);
    expect(ids(await asPerson(b, "a-contrib", lessonsPath()))).toEqual(["les_pay00001"]);
    await runtime.localTools.setProject(A, "payments", false, w.world.clock.now);
    expect((await asPerson(b, "a-contrib", lessonsPath())).body).toMatchObject({ status: "off", reason: "project_setting" });
  });
});

describe("repositories and projects inside one company", () => {
  it("a project's answer and tree hold only its own units, and a repository of another project answers like a missing project", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001", { scope: { paths: ["src/pay/**"] } }), lesson(A, "les_bill0001", { project: "billing", scope: { paths: ["src/bill/**"] } }));
    const pay = await asPerson(b, "a-admin", lessonsPath(), { files: ["src/pay/a.ts"] });
    expect(ids(pay)).toEqual(["les_pay00001"]);
    expect(JSON.stringify((await asPerson(b, "a-admin", areasPath())).body)).not.toContain("bill");
    expect(await asPerson(b, "a-admin", lessonsPath(), { repo: "https://github.com/example/billing.git" })).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No such project." });
    expect(await asPerson(b, "a-admin", areasPath(), { repo: "https://github.com/example/billing.git" })).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No such project." });
    expect((await asPerson(b, "a-admin", lessonsPath(), { repo: REPO })).ok).toBe(true);
  });
});

describe("hosted answers match the laptop's for the same data", () => {
  /** The laptop's own route over the same lessons (the same shared implementation, but its own harness, store and caller). */
  async function laptop() {
    const h = createHarness({ audit: "recording" });
    await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, url: REPO }] });
    const owner = localOwnerPrincipal({ companyId: COMPANY });
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", h.store, { isDefault: true });
    registry.register("queue", "memory", h.queues, { isDefault: true });
    registry.register("code-host", "github", { kind: "github", repositoryIdentity: async () => ({ id: "77", fullName: "example/demo", private: true }) } as never, { isDefault: true });
    const lessons = createLocalLessons({
      flow: h.deps, registry, companyId: COMPANY, owner, blobs: { get: async () => undefined } as never, milestones: { register: () => () => undefined },
      audit: h.deps.audit, admission: h.deps.admission, metering: createPriceTableMetering({ currency: "USD", models: {} }),
      approvers: createLocalOwnerApprovers({ owner, verifySession: () => false }), identity: createLocalOwnerIdentity({ companyId: COMPANY, linkedAccounts: [{ provider: "github", tenant: "", accountId: "owner-gh" }] }),
      model: { choice: async () => ({ provider: "anthropic", model: "claude-test" }), keys: createMemoryModelKeyStore({ anthropic: ["sk", "ant", "test", "never", "real"].join("-") }), providers: builtinModelProviderBook(), fetch: () => Promise.resolve(new Response("{}", { status: 500 })) },
      enabled: () => true, now: () => h.clock.now, log: () => undefined,
    });
    const route = createLessonRoutes({ lessons, flow: h.deps });
    return {
      async put(...list: ReturnType<typeof lessonRecord>[]) { for (const one of list) { const key = { workspaceId: one.workspaceId, project: one.project }; await lessons.runtime.store.commit(key, await lessons.runtime.store.setVersion(key), [one], 1); } },
      async post(path: string, body: unknown): Promise<unknown> { const answer = await route({ method: "POST", path, headers: {}, body: JSON.stringify(body) }, h.owner); return JSON.parse(answer!.body); },
    };
  }
  const normal = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/Checked [0-9-]+ [0-9:]+ UTC/gu, "Checked <time> UTC"));

  it("the same units, the same words, byte for byte: answers, trees, an unknown repository, the off answer and the day limit's words", async () => {
    const w = await setUp();
    const b = build(w);
    const local = await laptop();
    const make = (workspace: string) => [
      lesson(workspace, "les_pay00001", { scope: { repos: ["demo"], paths: ["src/pay/**"] }, title: "Pay folder rule" }), lesson(workspace, "les_pay00002", { scope: { repos: ["demo"], paths: ["src/queue/**", "tests/**"] }, title: "Queue rule" }),
      lesson(workspace, "les_any00001", { scope: {}, title: "Everywhere rule" }), lesson(workspace, "les_sql00001", { scope: { paths: ["**/*.sql"] }, title: "SQL rule" }),
      lesson(workspace, "les_pend0001", { status: "pending", approvals: [], pendingExpiresAt: 1_900_000_000_000 }),
      ...Array.from({ length: 12 }, (_, i) => lesson(workspace, `les_more${String(i).padStart(4, "0")}`, { scope: { paths: ["lib/**"] }, title: `Library rule ${String(i)}` })),
    ];
    await put(w, A, ...make(A));
    await local.put(...make(COMPANY));
    const asks: Array<[string, unknown]> = [
      [lessonsPath(), {}], [lessonsPath(), { files: ["src/pay/a.ts"] }], [lessonsPath(), { files: ["lib/x.ts"], stage: "review", task: "retry the queue" }], [lessonsPath(), { repo: REPO, files: ["tests/a.test.ts"] }],
      [lessonsPath(), { task: "withRetry network" }], [areasPath(), {}], [areasPath(), { repo: REPO }],
    ];
    let nonEmpty = 0;
    for (const [path, body] of asks) {
      const hosted = (await asPerson(b, "a-contrib", path, body)).body;
      expect(hosted, path).toBeDefined();
      if ((hosted?.lessons?.length ?? 0) > 0 || (hosted?.repos?.length ?? 0) > 0) nonEmpty += 1;
      expect(normal(hosted), `${path} ${JSON.stringify(body)}`).toEqual(normal(await local.post(path, body)));
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(5);
    // Refusals carry the same words.
    for (const [path, body] of [[lessonsPath(), { all: true }], [lessonsPath(), { extra: 1 }], [lessonsPath(), { repo: "https://github.com/example/billing.git" }], [areasPath(), { repo: "https://github.com/example/billing.git" }]] as Array<[string, unknown]>) {
      const hosted = await asPerson(b, "a-contrib", path, body);
      const laptopAnswer = (await local.post(path, body)) as { error: { code: string; message: string } };
      expect({ code: hosted.code, message: hosted.message }, `${path} ${JSON.stringify(body)}`).toEqual(laptopAnswer.error);
    }
    // The off answer is the laptop's own (company switch), word for word.
    await w.lessons.get(A)!.runtime.localTools.setCompany(A, true, w.world.clock.now);
    expect((await asPerson(b, "a-contrib", lessonsPath())).body).toMatchObject({ status: "off", reason: "company_stays", message: "Your company keeps lessons inside Rovara, so local coding tools get none." });
  });

  it("the install-switch-off answer of the hosted API has the laptop's shape and words", async () => {
    const laptopOff = knowledgeSwitchedOff({ method: "POST", path: lessonsPath() }, Date.parse("2026-11-15T10:00:00Z")) as { status: string; reason: string; message: string; project: string; lessons: unknown[]; markdown: string; complete: boolean };
    expect(laptopOff).toMatchObject({ status: "off", reason: "install_switch", message: "Lessons are switched off for this Rovara installation, so there are no lessons to give.", project: "payments", lessons: [], complete: true });
    expect(laptopOff.markdown).toContain("Lessons are switched off for this Rovara installation");
  });
});

describe("the principal a hosted token is made for", () => {
  it("is the hosted identity: a person's hosted sign-in and their token key every limit the same way", async () => {
    const w = await setUp();
    const principal = (await identityOf(w).getPrincipal(A, "a-contrib"))!;
    expect(principal.provider).toBe(HOSTED_IDENTITY_PROVIDER);
    const secret = await makeToken(w, "a-contrib");
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    await asToken(b, secret, lessonsPath());
    await asPerson(b, "a-contrib", lessonsPath());
    const day = (await w.world.store.query({ pk: companyScoped(A, "KNOWLEDGE_READ_DAY") })).items;
    expect(day).toHaveLength(1);
    expect(day[0]!["sk"]).toBe("a-contrib");
    vi.fn();
  });
});

describe("the MCP tools against a hosted install (the CLI client targets the same routes)", () => {
  /** A fetch that is the hosted broker's door for one signed-in person: the two routes go to the knowledge API, the project list is the person's. */
  function hostedFetch(b: Built, personId: string, seen: string[]): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL((typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      const method = init?.method ?? "GET";
      seen.push(`${method} ${url.pathname}`);
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && url.pathname === "/v1/dev/projects") return json(200, { developer: { id: "a".repeat(64), name: "Ada", provider: "oidc" }, projects: [{ name: "billing", latestRevision: 1, access: "granted", channels: [] }, { name: "payments", latestRevision: 1, access: "granted", channels: [] }], notices: [] });
      try { return json(200, await b.api.answer({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : "{}" }, person(personId))); }
      catch (error) { if (!(error instanceof AgentXError)) throw error; return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } }); }
    }) as typeof fetch;
  }
  const contextOf = (b: Built, personId: string, seen: string[]): ToolContext => ({
    client: httpControlPlaneClient({ session: async () => ({ baseUrl: "https://api.hosted.test", accessToken: "cli-token-for-the-test", signInCommand: "x" }), fetch: hostedFetch(b, personId, seen), sleep: async () => undefined }),
    clientName: "claude-code", serverVersion: "0.4.0", adminSignedIn: async () => false, compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined,
    newRequestId: () => "33333333-3333-4333-8333-333333333333", checkoutRemote: async () => REPO,
  });
  const tool = (name: string) => KNOWLEDGE_TOOLS.find((entry) => entry.name === name)!;

  it("team_knowledge and team_knowledge_areas find the project from the checkout's remote on the hosted routes and show the same units", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001", { scope: { paths: ["src/pay/**"] } }));
    const seen: string[] = [];
    const context = contextOf(b, "a-contrib", seen);
    const briefing = await tool("team_knowledge").handler(context, { files: ["src/pay/a.ts"] });
    expect(briefing.structured).toMatchObject({ status: "ok", project: "payments", units: [{ id: "les_pay00001" }] });
    expect(briefing.text).toContain("[les_pay00001]");
    expect(seen).toContain("POST /v1/dev/projects/billing/lessons");
    expect(seen).toContain("POST /v1/dev/projects/payments/lessons");
    const tree = await tool("team_knowledge_areas").handler(context, { project: "payments" });
    expect(tree.structured).toMatchObject({ status: "ok", project: "payments" });
    // The hosted off answer and a project the person is not on read as the laptop's do.
    const off = await tool("team_knowledge").handler(contextOf(build(w, { lessonsSwitch: { mode: "off" } }), "a-contrib", []), { project: "payments" });
    expect(off.structured).toMatchObject({ status: "off" });
    const stranger = await tool("team_knowledge").handler(contextOf(b, "a-out", []), { project: "payments" });
    expect(stranger.structured).toMatchObject({ status: "none" });
  });

  it("the day's limit reaches the tool as the one fixed refusal", async () => {
    const w = await setUp();
    const b = build(w);
    await put(w, A, lesson(A, "les_pay00001"));
    const context = contextOf(b, "a-contrib", []);
    for (let n = 0; n < LOCAL_KNOWLEDGE_DAY_CALLS_MAX; n += 1) {
      if (n % 50 === 0) w.world.clock.advance(60);
      await asPerson(b, "a-contrib", lessonsPath());
    }
    w.world.clock.advance(60);
    const refused = await tool("team_knowledge").handler(context, { project: "payments" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolError);
    expect((refused as ToolError).code).toBe("RATE_LIMITED");
    expect((refused as ToolError).message).toBe(LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE);
  }, 60_000);
});
