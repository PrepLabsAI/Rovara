// L4-EVC (DEC 254zzz20 D5, D8): the hosted eval card routes on the deployed API (setup-run-routes.ts): GET eval (the card, dollars only), POST eval-approve (the confirm AND the spend approval in one
// act: a fresh step-up, the live owner/admin/maintainer rule, the dollars the person saw), POST eval-decide (a waiting item), POST eval-health (the opt-in). Through the real hosted approvers point, the
// real decision gate and the real eval spend subject over the company's own store.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type AuditEvent, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { SETUP_RUN_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, EVAL_APPROVAL_UNAVAILABLE, type HostedSetupRunWiring, type SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHostedSetupApproval } from "../../packages/broker/src/core-host/setup-approval.js";
import { createHostedApprovers, stepUpApprovalKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { evalSpendKey, readEvalSpendRecord } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { deployedSessionMembers } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { evalHealthState, readEvalHealthRequest } from "../../packages/broker/src/core/setup-agent/eval-health-request.js";
import { readEvalDiscovery } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
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

async function hosted(options: { evalWiring?: boolean; healthRuns?: boolean; healthRun?: (project: string) => Promise<unknown>; providerConnected?: (scope: { company: string; project: string }) => Promise<boolean | undefined> } = {}) {
  const world = createFakeWorld();
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
    ...(options.evalWiring === false ? {} : { eval: { healthRuns: options.healthRuns !== false, ...(options.healthRun === undefined ? {} : { healthRun: options.healthRun }), ...(options.providerConnected === undefined ? {} : { providerConnected: options.providerConnected }), monthlyCap: async () => reader.cap, readFile: (...args: Parameters<NonNullable<ReturnType<typeof gitReader>>>) => reader.read!(...args) } }),
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
  const reported = async (companyId: OrgId, n = 2, edits: Record<string, string> = {}) => {
    const w = company(companyId, {}, world.store);
    const r = await w.run(filesOf(n, edits), reportOf(n));
    reader.read = gitReader(r.repo.dir);
    return { w, r };
  };
  return { world, person, call, audit, reader, reported, wirings };
}

const approveBody = async (call: Awaited<ReturnType<typeof hosted>>["call"], caller: DeployedCaller, over: Record<string, unknown> = {}) => {
  const card = (await call(get(`${RUN}/eval`), caller)).body as { report: { taskId: string; reportDigest: string }; suites: Array<{ selection: string; files: string[]; seen: unknown }> };
  const suite = card.suites[0]!;
  return { taskId: card.report.taskId, reportDigest: card.report.reportDigest, selection: suite.selection, paths: suite.files, approve: true, seen: suite.seen, ...over };
};
const recordOf = (world: FakeWorld, companyId: OrgId) => readEvalSpendRecord({ store: world.store, companyId }, PROJECT);

describe("GET eval: the card", () => {
  it("shows the card in dollars to a person who may approve, and says so to one who may only read", async () => {
    const { person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const card = await call(get(`${RUN}/eval`), admin);
    expect(card.status, card.raw).toBe(200);
    expect(card.body).toMatchObject({ project: PROJECT, state: "propose", canApprove: true, suites: [{ selection: "evals/demo", cases: 2, sentence: "Running your evals on each AI change will cost about $0.20-$1.80 per PR, at most $50.00 a month. Approve?" }] });
    const words = JSON.stringify((card.body as { suites: Array<{ sentence: string; perPr: string; monthly: string }> }).suites.map((x) => [x.sentence, x.perPr, x.monthly]));
    expect(words).not.toMatch(/token|call|micro/iu);
    const reader = await call(get(`${RUN}/eval`), person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" }));
    expect(reader.body).toMatchObject({ canApprove: false, state: "propose" });
    expect((await call(get(`${RUN}/eval`), person("p-none", FAKE_COMPANY, "member"))).body).toEqual({ error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } });
  });
  it("L4-T3: the hosted card names the provider and carries the company's own connection answer (asked for exactly this company and project), and says neither where the install cannot tell", async () => {
    const asked: Array<{ company: string; project: string }> = [];
    const { person, call, reported } = await hosted({ providerConnected: async (scope) => { asked.push(scope); return scope.company === FAKE_COMPANY ? false : true; } });
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const card = await call(get(`${RUN}/eval`), admin);
    expect(card.body).toMatchObject({ state: "propose", provider: "Google Gemini", connected: false, suites: [{ provider: "Google Gemini" }] });
    expect(asked).toEqual([{ company: FAKE_COMPANY, project: PROJECT }]);
    // Another company never reads this one's eval or its connection: nothing is said of a provider.
    const other = await call(get(`${RUN}/eval`), person("o-admin", OTHER, "admin"));
    expect(other.body).toMatchObject({ state: "none" }); expect(other.body["provider"]).toBeUndefined(); expect(other.body["connected"]).toBeUndefined();
    expect(asked.every((scope) => scope.company === FAKE_COMPANY || scope.company === OTHER)).toBe(true);
    const unknown = await hosted(); await unknown.reported(FAKE_COMPANY);
    const plain = await unknown.call(get(`${RUN}/eval`), unknown.person("p-admin", FAKE_COMPANY, "admin"));
    expect(plain.body).toMatchObject({ provider: "Google Gemini" }); expect(plain.body["connected"]).toBeUndefined();
  });
  it("answers 'not available' where the deployment wires no eval card", async () => {
    const { person, call } = await hosted({ evalWiring: false });
    expect((await call(get(`${RUN}/eval`), person("p-admin", FAKE_COMPANY, "admin"))).body).toEqual({ error: { code: "NOT_FOUND", message: EVAL_APPROVAL_UNAVAILABLE } });
    expect((await call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: 1 }), person("p-admin", FAKE_COMPANY, "admin"))).body).toEqual({ error: { code: "NOT_FOUND", message: EVAL_APPROVAL_UNAVAILABLE } });
  });
  it("shows nothing of another company's eval (two companies)", async () => {
    const { person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const other = await call(get(`${RUN}/eval`), person("o-admin", OTHER, "admin"));
    expect(other.body).toMatchObject({ state: "none", suites: [] });
    expect(other.body["report"]).toBeUndefined();
  });
});

describe("POST eval-approve: one approval", () => {
  it.each([["admin", {}], ["owner", {}], ["member", { [PROJECT]: "administrator" as const }]])("%s %j confirms and approves in one act; the audit names the person, the gate records the decision", async (role, grants) => {
    const { world, person, call, reported, audit } = await hosted();
    await reported(FAKE_COMPANY);
    const who = person(`p-${role}`, FAKE_COMPANY, role as OrgRole, grants);
    const answer = await call(post(`${RUN}/eval-approve`, await approveBody(call, who)), who);
    expect(answer.status, answer.raw).toBe(200);
    expect(answer.body).toMatchObject({ project: PROJECT, state: "approved", perPr: "about $0.20-$1.80", monthly: "$50.00", carried: false });
    expect(await recordOf(world, FAKE_COMPANY)).toMatchObject({ state: "approved", approvedBy: { personId: `p-${role}` }, plan: { dollars: { perCheckHighMicros: 1_800_000 } } });
    expect(audit.find((e) => e.action === "eval.approve_requested")).toMatchObject({ companyId: FAKE_COMPANY, actor: { id: `p-${role}` }, subject: { type: "project", id: PROJECT } });
    expect(audit.find((e) => e.action === "decision.approved")).toMatchObject({ companyId: FAKE_COMPANY, actor: { id: `p-${role}` }, subject: { type: "eval_spend", id: PROJECT } });
  });
  it("needs a fresh step-up: without one the person is told to confirm it's them, and nothing is confirmed or approved", async () => {
    const { world, person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const stale = person("p-admin", FAKE_COMPANY, "admin", {}, 3_600_000);
    const refused = await call(post(`${RUN}/eval-approve`, await approveBody(call, stale)), stale);
    expect(refused.body).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
    expect(await world.store.get(evalSpendKey(FAKE_COMPANY, PROJECT))).toBeUndefined();
    expect((await readEvalDiscovery({ store: world.store, companyId: FAKE_COMPANY }, PROJECT))?.state).toBe("reported");
    const none = person("p-none-stepup", FAKE_COMPANY, "admin", {}, null);
    expect((await call(post(`${RUN}/eval-approve`, await approveBody(call, none)), none)).body).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
  });
  it("refuses a project user and a member with no grant, writing nothing", async () => {
    const { world, person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const body = await approveBody(call, person("p-admin", FAKE_COMPANY, "admin"));
    const dev = person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    expect((await call(post(`${RUN}/eval-approve`, body), dev)).body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    expect((await call(post(`${RUN}/eval-approve`, body), person("p-member", FAKE_COMPANY, "member"))).body).toEqual({ error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } });
    expect(await world.store.get(evalSpendKey(FAKE_COMPANY, PROJECT))).toBeUndefined();
  });
  it("refuses a yes that was shown other dollars, and a body that does not approve, writing nothing", async () => {
    const { world, person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const stale = await call(post(`${RUN}/eval-approve`, await approveBody(call, admin, { seen: { perCheckHighMicros: 1, monthlyCapMicros: CAP } })), admin);
    expect(stale.body).toMatchObject({ error: { code: "CHANGE_STALE" } });
    const noApprove = await approveBody(call, admin); delete (noApprove as Record<string, unknown>)["approve"]; delete (noApprove as Record<string, unknown>)["seen"];
    expect((await call(post(`${RUN}/eval-approve`, noApprove), admin)).status).toBe(400);
    expect((await call(post(`${RUN}/eval-approve`, { ...(await approveBody(call, admin)), company: OTHER }), admin)).status).toBe(400);
    expect(await world.store.get(evalSpendKey(FAKE_COMPANY, PROJECT))).toBeUndefined();
  });
  it("another company's admin can neither confirm nor approve this company's eval (two companies)", async () => {
    const { world, person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const body = await approveBody(call, person("p-admin", FAKE_COMPANY, "admin"));
    const other = person("o-admin", OTHER, "admin");
    const answer = await call(post(`${RUN}/eval-approve`, body), other);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await world.store.get(evalSpendKey(FAKE_COMPANY, PROJECT))).toBeUndefined();
    expect(await world.store.get(evalSpendKey(OTHER, PROJECT))).toBeUndefined();
  });
  it("a company with no eval budget source cannot confirm (no cap, no card, nothing marked)", async () => {
    const { world, person, call, reported, reader } = await hosted();
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const body = await approveBody(call, admin);
    reader.cap = undefined;
    expect((await call(get(`${RUN}/eval`), admin)).body).toMatchObject({ suites: [], unavailable: "This install has no eval budget, so an eval can't be approved here yet." });
    expect((await call(post(`${RUN}/eval-approve`, body), admin)).status).toBe(400);
    expect(await world.store.get(evalSpendKey(FAKE_COMPANY, PROJECT))).toBeUndefined();
  });
});

describe("POST eval-decide: a waiting item", () => {
  async function waiting() {
    const h = await hosted();
    await h.reported(FAKE_COMPANY);
    return { ...h, admin: h.person("p-admin", FAKE_COMPANY, "admin") };
  }
  it("approves or rejects the waiting item by the offer the card showed, with a fresh step-up and the live rule; a stale digest is refused", async () => {
    const h = await waiting();
    // Seed a waiting item through the broker's own confirm (no approve).
    const { confirmEvalDiscovery } = await import("../../packages/broker/src/core/setup-agent/eval-discovery.js");
    const card = (await h.call(get(`${RUN}/eval`), h.admin)).body as { report: { taskId: string; reportDigest: string } };
    const approval = h.wirings.get(FAKE_COMPANY)!.approval!;
    await confirmEvalDiscovery({ store: h.world.store, companyId: FAKE_COMPANY, now: () => h.world.clock.now, members: approval.evalMembers, monthlyCap: async () => CAP, readFile: (...a) => h.reader.read!(...a),
      latest: async () => ({ revision: 1, definition: definition(PROJECT) }) }, PROJECT, { taskId: card.report.taskId, reportDigest: card.report.reportDigest, selection: "evals/demo", paths: ["evals/demo/q1.txt", "evals/demo/q2.txt"] }, h.admin.principal);
    const after = (await h.call(get(`${RUN}/eval`), h.admin)).body as { state: string; spend: { approval: { requestId: string; revision: number; artifactDigest: string } } };
    expect(after.state).toBe("waiting");
    const offer = after.spend.approval;
    const stale = await h.call(post(`${RUN}/eval-decide`, { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: "f".repeat(64) } }), h.admin);
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect((await recordOf(h.world, FAKE_COMPANY))?.state).toBe("waiting");
    // An offer id the card did not show (right shape, another digest) is refused before any proof is made.
    const foreign = await h.call(post(`${RUN}/eval-decide`, { requestId: `eval-${"a".repeat(40)}-${offer.revision}`, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), h.admin);
    expect(foreign.body).toMatchObject({ error: { code: "CHANGE_STALE" } });
    expect((await recordOf(h.world, FAKE_COMPANY))?.state).toBe("waiting");
    const dev = h.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    expect((await h.call(post(`${RUN}/eval-decide`, { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), dev)).status).toBe(403);
    const lapsed = h.person("p-lapsed", FAKE_COMPANY, "admin", {}, 3_600_000);
    expect((await h.call(post(`${RUN}/eval-decide`, { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), lapsed)).body).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
    const done = await h.call(post(`${RUN}/eval-decide`, { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), h.admin);
    expect(done.status, done.raw).toBe(200);
    expect(done.body).toEqual({ project: PROJECT, decision: "approved" });
    expect((await recordOf(h.world, FAKE_COMPANY))?.state).toBe("approved");
    expect(h.audit.find((e) => e.action === "eval.spend_decision_requested")).toMatchObject({ actor: { id: "p-admin" }, details: { outcome: "approve" } });
  });
});

describe("POST eval-health: the opt-in", () => {
  it("a project reader sees the approved card but no health block", async () => {
    const { person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    await call(post(`${RUN}/eval-approve`, await approveBody(call, admin)), admin);
    expect((await call(get(`${RUN}/eval`), admin)).body["health"]).toBeDefined();
    expect((await call(get(`${RUN}/eval`), person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" }))).body["health"]).toBeUndefined();
  });
  it("is not offered where no health runner reads the yes: no button on the card, and the route says it is not available", async () => {
    const { person, call, reported } = await hosted({ healthRuns: false });
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    expect((await call(post(`${RUN}/eval-approve`, await approveBody(call, admin)), admin)).status).toBe(200);
    expect((await call(get(`${RUN}/eval`), admin)).body["health"]).toBeUndefined();
    expect((await call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: 600_000 }), admin)).body).toEqual({ error: { code: "NOT_FOUND", message: EVAL_APPROVAL_UNAVAILABLE } });
  });
  it("records a person's yes and runs nothing; approving alone never does", async () => {
    const { world, person, call, reported, audit } = await hosted();
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    expect((await call(post(`${RUN}/eval-approve`, await approveBody(call, admin)), admin)).status).toBe(200);
    const store = { store: world.store, companyId: FAKE_COMPANY };
    expect(await evalHealthState(store, PROJECT)).toBe("none");
    const card = (await call(get(`${RUN}/eval`), admin)).body as { health: { label: string; cost: string; seenCostMicros: number; state: string } };
    expect(card.health).toMatchObject({ label: "Check my evals now (about $0.60)", cost: "$0.60", state: "none" });
    const requestId = randomUUID();
    const yes = await call(post(`${RUN}/eval-health`, { requestId, seenCostMicros: card.health.seenCostMicros }), admin);
    expect(yes.status, yes.raw).toBe(200);
    expect(yes.body).toEqual({ project: PROJECT, requested: true, duplicate: false, cost: "$0.60" });
    expect(audit.find((e) => e.action === "eval.health_requested")).toMatchObject({ actor: { id: "p-admin" }, details: { requestId } });
    const members = deployedSessionMembers(FAKE_COMPANY, { membershipOf: async () => ({ companyId: FAKE_COMPANY, role: "admin" as OrgRole }), projectGrantRole: async () => undefined });
    expect(await evalHealthState({ ...store, members }, PROJECT)).toBe("requested");
    expect(await readEvalHealthRequest({ ...store, members }, PROJECT)).toMatchObject({ requestId, state: "requested", estimateMicros: 600_000 });
  });
  it("is refused for a project user, for a stale cost and before any approval", async () => {
    const { person, call, reported } = await hosted();
    await reported(FAKE_COMPANY);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    expect((await call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: 600_000 }), admin)).body).toMatchObject({ error: { code: "CHANGE_STALE" } });
    await call(post(`${RUN}/eval-approve`, await approveBody(call, admin)), admin);
    expect((await call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: 1 }), admin)).body).toMatchObject({ error: { code: "CHANGE_STALE" } });
    expect((await call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: 600_000 }), person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" }))).body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    expect((await call(post(`${RUN}/eval-health`, { requestId: "x", seenCostMicros: 600_000 }), admin)).status).toBe(400);
  });
});


describe("POST eval-health starts the run (L4-EVH)", () => {
  async function approvedWorld(options: Parameters<typeof hosted>[0]) {
    const h = await hosted(options);
    await h.reported(FAKE_COMPANY);
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    expect((await h.call(post(`${RUN}/eval-approve`, await approveBody(h.call, admin)), admin)).status).toBe(200);
    const card = (await h.call(get(`${RUN}/eval`), admin)).body as { health?: { seenCostMicros: number } };
    return { ...h, admin, seen: card.health?.seenCostMicros ?? 600_000 };
  }
  it("after a recorded yes the broker is asked to start the run, once per yes: a repeat of the same yes starts nothing", async () => {
    const started: string[] = [];
    const t = await approvedWorld({ healthRun: async (name) => { started.push(name); } });
    const requestId = randomUUID();
    expect((await t.call(post(`${RUN}/eval-health`, { requestId, seenCostMicros: t.seen }), t.admin)).status).toBe(200);
    expect(started).toEqual([PROJECT]);
    expect((await t.call(post(`${RUN}/eval-health`, { requestId, seenCostMicros: t.seen }), t.admin)).body).toMatchObject({ requested: true, duplicate: true });
    expect(started).toEqual([PROJECT]);
  });
  it("the person's answer does not wait on, or fail with, the worker: a run that cannot start still answers the recorded yes", async () => {
    const t = await approvedWorld({ healthRun: async () => { throw new Error("worker down"); } });
    const yes = await t.call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: t.seen }), t.admin);
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ requested: true, duplicate: false });
  });
  it("no start for a refused yes (a stale cost, a person who may not approve, a route that is not served)", async () => {
    const started: string[] = [];
    const t = await approvedWorld({ healthRun: async (name) => { started.push(name); } });
    expect((await t.call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: t.seen - 1 }), t.admin)).status).toBeGreaterThanOrEqual(400);
    const dev = t.person("p-dev", FAKE_COMPANY, "member", { [PROJECT]: "developer" });
    expect((await t.call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: t.seen }), dev)).status).toBe(403);
    expect(started).toEqual([]);
    const off = await approvedWorld({ healthRuns: false, healthRun: async (name) => { started.push(name); } });
    expect((await off.call(post(`${RUN}/eval-health`, { requestId: randomUUID(), seenCostMicros: off.seen }), off.admin)).status).toBe(404);
    expect(started).toEqual([]);
  });
});
