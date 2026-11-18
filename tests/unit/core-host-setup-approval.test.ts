// L4-D (DEC 254z b; answers #844's Question L2-3): the hosted approval of a project's setup candidate. "Use this setup" (confirm), discard, and the decision on a candidate whose check
// passed: a fresh step-up, the risk read from the candidate's diff (low and medium: a project maintainer; high: a company owner or admin), the hosted approvers point's proof bound to the
// candidate's digest, revision and card, and the ONE approval gate. Two companies and two projects never reach each other's candidate; a moved or stale candidate is refused.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  change, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, systemOwnerIdOf, type ApprovalProof, type ApprovalRequest, type AuditEvent, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition,
} from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { setupApplyDigest, setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { driftTaskKey, recheckRowKey, repairNoticeKey, setupBrokenTaskWords, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck-rows.js";
import { repairCurrentKey, repairRowKey } from "../../packages/broker/src/core/setup-agent/repair-rows.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  SETUP_APPROVAL_UNAVAILABLE, SETUP_DECIDE_ON_A_PAGE, SETUP_NOTHING_WAITING, SETUP_RUN_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, type HostedSetupRunWiring, type SetupRunStanding,
} from "../../packages/broker/src/core-host/setup-run-routes.js";
import { SETUP_NEEDS_ADMIN, SETUP_NEEDS_MAINTAINER, createHostedSetupApproval, setupDecisionRequestId } from "../../packages/broker/src/core-host/setup-approval.js";
import {
  SETUP_PROPOSAL_SUBJECT, APPROVAL_PROOF_METHOD, createHostedApprovers, issueSetupApprovalProof, issueApprovalProof, approvalProofKeyOf,
} from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";

const OTHER = "org_corehost00000000000b";
const KEY = approvalProofKeyOf("callback-signing-key-for-tests-0123456789abcdef");
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const command = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const project = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function register(world: FakeWorld, companyId: string, name: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project(name))) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await world.store.put({ item: { ...projectMetaKey(companyId, name), entityType: "PROJECT_META", status: "active" } });
}

/** A candidate revision 2 waiting for a decision, its check on a workspace in `status` (READY: passed). */
async function seedCandidate(world: FakeWorld, companyId: string, name: string, changes: Record<string, unknown>, status = "READY"): Promise<{ digest: string; workspaceId: string }> {
  const definition = { ...project(name), revision: 2, ...changes };
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 2), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  const workspaceId = randomUUID();
  await world.store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId, orgId: companyId, status } });
  const digest = setupApplyDigest(definition.setup, definition.readiness, changes["promptLocations"] === undefined ? {} : { promptLocations: changes["promptLocations"] });
  const at = new Date(world.clock.now).toISOString();
  await world.store.put({ item: {
    ...setupApplyKey(companyId, name), entityType: "SETUP_APPLY", orgId: companyId, project: name, taskId: "", requestId: randomUUID(), by: "p-runner", digest, baseRevision: 1, candidateRevision: 2,
    state: "checking", check: { workspaceId, revision: 2, startedAt: at, startedBy: "p-runner" }, reply: {}, createdAt: at,
  } });
  return { digest, workspaceId };
}

async function seedPausedTask(world: FakeWorld, name: string): Promise<string> {
  const h = createHarness({ companyId: FAKE_COMPANY, backend: () => ({ store: world.store, queues: world.queues }) });
  await h.registerProject(project(name));
  await world.store.put({ item: { ...projectMetaKey(FAKE_COMPANY, name), entityType: "PROJECT_META" } });
  const task = (await h.flow.start(h.owner, { requestId: newRequestId(), project: name, instructions: "Keep building", workflow: true, workflowPath: "QUICK" })).task;
  const before = (await readTask(h.deps, task.taskId))!;
  const brokenStep = "setup: npm ci failed";
  await world.store.update({ key: projectMetaKey(FAKE_COMPANY, name), ops: [change.set("setupCheck", { workspaceId: "failed-check", revision: 1, startedAt: "2026-11-16T10:00:00.000Z", startedBy: "system" })] });
  await world.store.put({ item: { ...driftTaskKey(FAKE_COMPANY, name, task.taskId), entityType: "SETUP_DRIFT_TASK", orgId: FAKE_COMPANY, project: name, taskId: task.taskId, recheckKey: "failed-recheck", state: "pending", at: "2026-11-16T10:00:00.000Z" } });
  const row: RecheckRow = { entityType: "SETUP_RECHECK", orgId: FAKE_COMPANY, project: name, key: "failed-recheck", setupRevision: 1, commits: {}, classes: ["lockfile"], state: "broken", attempt: 2, check: { workspaceId: "failed-check", revision: 1, startedAt: "2026-11-16T10:00:00.000Z", startedBy: "system" }, startedAt: "2026-11-16T10:00:00.000Z", failedStep: brokenStep };
  await world.store.put({ item: toDocument({ ...recheckRowKey(FAKE_COMPANY, name, row.key), ...row }) });
  await world.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", { ...before.workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: setupBrokenTaskWords(brokenStep) } as unknown as JsonValue)] });
  return task.taskId;
}

const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const RUN = "/v1/app/projects/payments/setup-agent";
const LEDGER = "/v1/app/projects/ledger/setup-agent";

interface Person { companyId: OrgId; role: OrgRole; grants: Record<string, "developer" | "administrator"> }

async function setupWorld(options: { approval?: boolean } = {}) {
  const world = createFakeWorld();
  for (const [company, name] of [[FAKE_COMPANY, "payments"], [FAKE_COMPANY, "ledger"], [OTHER, "payments"]] as const) await register(world, company, name);
  const app = appOver(world);
  const people = new Map<string, Person>();
  /** How many more project-grant reads answer before the grant is gone (to take a role away mid-decision). Undefined: never. */
  const grantReadsLeft: { value?: number; thenThrow?: boolean } = {};
  const membershipOf = async (personId: string) => { const found = people.get(personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; };
  const projectGrantRole = async (personId: string, name: string) => {
    if (grantReadsLeft.value !== undefined && grantReadsLeft.value-- <= 0) { if (grantReadsLeft.thenThrow === true) throw new Error("grant table down detail"); return undefined; }
    return people.get(personId)?.grants[name];
  };
  const person = (personId: string, companyId: OrgId, role: OrgRole, grants: Person["grants"] = {}, stepUpAgoMs: number | null = 60_000): DeployedCaller => {
    people.set(personId, { companyId, role, grants });
    return {
      principal: { companyId, personId, displayName: personId, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud",
      ...(stepUpAgoMs === null ? {} : { stepUp: { at: new Date(world.clock.now - stepUpAgoMs).toISOString(), method: "passkey" } }),
    };
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
  const wiringFor = (companyId: OrgId): HostedSetupRunWiring => ({
    standing, modelAccessConfigured: () => true,
    ...(options.approval === false ? {} : { approval: createHostedSetupApproval({
      flow: { store: world.store, companyId, now: () => new Date(world.clock.now) }, store: world.store, approvers, audit: sink, identity,
      people: { membershipOf, projectGrantRole }, proofKey: KEY, now: () => new Date(world.clock.now),
    }) }),
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
  return { world, person, call, routes, audit, grantReadsLeft, wirings };
}

const decideBody = (digest: string, outcome: "approve" | "reject" = "approve", revision = 2) => ({ requestId: setupDecisionRequestId(digest, revision) + randomUUID().slice(0, 8), outcome, seen: { revision, artifactDigest: digest } });
const applyRow = (world: FakeWorld, companyId: string, name = "payments") => world.store.get(setupApplyKey(companyId, name));
const latestOf = async (world: FakeWorld, companyId: string, name = "payments") => (await world.store.get(orgProjectCatalogKey(companyId, name)))?.["latestRevision"];

describe("hosted setup approval: who may decide, by the candidate's risk", () => {
  it("lets a project maintainer approve a LOW risk candidate (changed commands); the project moves to the candidate, the audit names the approver and the subject", async () => {
    const { world, person, call, audit } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["ci", "--cache", ".npm-cache"])] });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const view = await call(get(RUN), maintainer);
    expect(view.body["apply"]).toMatchObject({ candidateRevision: 2, baseRevision: 1, risk: "low", changes: [{ area: "setup_commands", risk: "low" }], approver: "maintainer", canApprove: true, canReject: true, approval: { revision: 2, artifactDigest: digest, kind: "setup", risk: "low" } });
    const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(decided.status, decided.raw).toBe(200);
    expect(decided.body).toMatchObject({ project: "payments", decision: "approved", risk: "low", revision: 2 });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "approved", decidedBy: "p-maint" });
    expect(audit.find((event) => event.action === "decision.approved")).toMatchObject({ companyId: FAKE_COMPANY, actor: { id: "p-maint" }, subject: { type: SETUP_PROPOSAL_SUBJECT, id: "payments" }, details: { risk: "low" } });
  });

  it("resumes an eligible task when a hosted approval approves its setup", async () => {
    const { world, person, call } = await setupWorld();
    const taskId = await seedPausedTask(world, "payments");
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["ci", "--cache", ".npm-cache"])] });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(decided.status, decided.raw).toBe(200);
    expect(decided.body).toMatchObject({ decision: "approved", revision: 2 });
    await vi.waitFor(async () => expect((await readTask(createHarness({ companyId: FAKE_COMPANY, backend: () => ({ store: world.store, queues: world.queues }) }).deps, taskId))?.workflow?.state).toBe("READY"));
    expect((await world.store.get(driftTaskKey(FAKE_COMPANY, "payments", taskId)))?.["resumedSetupRevision"]).toBe(2);
  });

  it("answers approved when the store fails during the best-effort auto-resume", async () => {
    const { world, person, call } = await setupWorld();
    await seedPausedTask(world, "payments");
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["ci", "--cache", ".npm-cache"])] });
    const query = world.store.query.bind(world.store);
    const querySpy = vi.spyOn(world.store, "query").mockImplementation((request) => request.pk === setupPartition(FAKE_COMPANY, "payments")
      ? Promise.reject(new Error("store unavailable"))
      : query(request));
    try {
      const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
      const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
      expect(decided.status, decided.raw).toBe(200);
      expect(decided.body).toMatchObject({ decision: "approved", revision: 2 });
      expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("lets a project maintainer approve a MEDIUM risk candidate (a test mock), shown with what changed", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { generalFakes: { enabled: true, services: [] } });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    expect((await call(get(RUN), maintainer)).body["apply"]).toMatchObject({ risk: "medium", changes: [{ area: "test_mocks", risk: "medium" }], approver: "maintainer", canApprove: true });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).body).toMatchObject({ decision: "approved", risk: "medium" });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
  });

  it("refuses a project maintainer on a HIGH risk candidate (a new website) in fixed words, writing nothing; a company admin and the owner approve it", async () => {
    for (const role of ["admin", "owner"] as const) {
      const { world, person, call } = await setupWorld();
      const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { network: { allowedDomains: ["api.stripe.com"] } });
      const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
      expect((await call(get(RUN), maintainer)).body["apply"]).toMatchObject({ risk: "high", approver: "admin", canApprove: false, canReject: true });
      const refused = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_NEEDS_ADMIN } });
      expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
      expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
      const boss = person(`p-${role}`, FAKE_COMPANY, role);
      expect((await call(get(RUN), boss)).body["apply"]).toMatchObject({ canApprove: true });
      const approved = await call(post(`${RUN}/decide`, decideBody(digest)), boss);
      expect(approved.status, approved.raw).toBe(200);
      expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
    }
  });

  it("counts a change it has no rule for as high (the instructions changed): a maintainer cannot approve it", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { orchestratorInstructions: "Do something else." });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(403);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
  });

  it("lets a maintainer reject even a high risk candidate: the candidate is removed and nothing is applied", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { network: { allowedDomains: ["api.stripe.com"] } });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const rejected = await call(post(`${RUN}/decide`, decideBody(digest, "reject")), maintainer);
    expect(rejected.status, rejected.raw).toBe(200);
    expect(rejected.body).toMatchObject({ decision: "rejected" });
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "rejected" });
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
  });

  it("refuses a project user (developer grant) and a member with no grant, writing nothing", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const developer = person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
    expect((await call(get(RUN), developer)).body["apply"]).toMatchObject({ canApprove: false, canReject: false });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), developer)).body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    const member = person("p-member", FAKE_COMPANY, "member");
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), member)).body).toEqual({ error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
  });

  it("re-reads the approver's standing inside the decision: a maintainer who lost the grant between the route's check and the decision decides nothing", async () => {
    const { world, person, call, grantReadsLeft } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    // The route's own check reads the grant once; the decision's rule reads it again and finds it gone.
    grantReadsLeft.value = 1;
    const refused = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_NEEDS_MAINTAINER } });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
  });
});

describe("hosted setup approval: the decision's own rule (behind the route's check)", () => {
  it("refuses when the approver's standing cannot be read inside the decision, deciding nothing and echoing nothing", async () => {
    const { world, person, call, grantReadsLeft } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    grantReadsLeft.value = 1;
    grantReadsLeft.thenThrow = true;
    const refused = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_NEEDS_MAINTAINER } });
    expect(refused.raw).not.toContain("detail");
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
  });

  it("holds the risk rule in the gate itself: a maintainer's valid proof on a high risk candidate, presented to the gate directly, is refused", async () => {
    const { world, person, wirings } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { network: { allowedDomains: ["api.stripe.com"] } });
    person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const approval = wirings.get(FAKE_COMPANY)!.approval!;
    const requestId = setupDecisionRequestId(digest, 2);
    const card = { cardId: "setup_proposal:payments", contentVersion: digest };
    const credential = await approval.issue({ companyId: FAKE_COMPANY, personId: "p-maint", stepUp: { at: new Date(world.clock.now - 60_000).toISOString(), method: "passkey" }, requestId, kind: "setup", project: "payments", revision: 2, artifactDigest: digest, outcome: "approve", card });
    const result = await approval.gate.decide({ companyId: FAKE_COMPANY, kind: "setup-proposal", subjectId: "payments", requestId, outcome: "approve", seen: { revision: 2, artifactDigest: digest }, credentials: [credential], card });
    expect(result).toEqual({ status: "refused", reason: "not_the_approver", detail: SETUP_NEEDS_ADMIN });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
  });
});

describe("hosted setup approval: the proof and the binding", () => {
  it("needs a fresh step-up: none, or one older than the window, is refused before anything is read", async () => {
    for (const ago of [null, 11 * 60_000]) {
      const { world, person, call } = await setupWorld();
      const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
      const owner = person("p-owner", FAKE_COMPANY, "owner", {}, ago);
      const refused = await call(post(`${RUN}/decide`, decideBody(digest)), owner);
      expect(refused.body, String(ago)).toEqual({ error: { code: "REAUTH_REQUIRED", message: SETUP_DECIDE_ON_A_PAGE } });
      expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    }
  });

  it("refuses a decision on what the person did not see (another digest or revision) and on a candidate whose check has not passed", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    for (const body of [decideBody("b".repeat(64)), decideBody(digest, "approve", 3)]) {
      const refused = await call(post(`${RUN}/decide`, body), owner);
      expect(refused.status, JSON.stringify(body)).toBe(409);
      expect(refused.body["error"]).toMatchObject({ code: "CHANGE_STALE" });
    }
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    const checking = await setupWorld();
    const seeded = await seedCandidate(checking.world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] }, "PREPARING");
    const theOwner = checking.person("p-owner", FAKE_COMPANY, "owner");
    expect((await checking.call(get(RUN), theOwner)).body["apply"]).toMatchObject({ check: { status: "checking" }, canApprove: false });
    expect(((await checking.call(get(RUN), theOwner)).body["apply"] as Record<string, unknown>)["approval"]).toBeUndefined();
    const notYet = await checking.call(post(`${RUN}/decide`, decideBody(seeded.digest)), theOwner);
    expect(notYet.status).toBe(409);
    expect(await latestOf(checking.world, FAKE_COMPANY)).toBe(1);
  });

  it("refuses an approval when the project moved on from the base revision the candidate was made from", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 3 } });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const refused = await call(post(`${RUN}/decide`, decideBody(digest)), owner);
    expect(refused.status).toBe(409);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(3);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
  });

  it("takes only a setup decision's own request id (setup-...), apart from task decisions' ids", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    expect((await call(post(`${RUN}/decide`, { ...decideBody(digest), requestId: "decision-request-0001" }), owner)).status).toBe(400);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
  });

  it("answers 'nothing waiting' when no candidate waits, and takes a strict body", async () => {
    const { person, call } = await setupWorld();
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    expect((await call(post(`${RUN}/decide`, decideBody("c".repeat(64))), owner)).body).toEqual({ error: { code: "CHANGE_STALE", message: SETUP_NOTHING_WAITING } });
    for (const body of [{}, { ...decideBody("c".repeat(64)), outcome: "request_changes" }, { ...decideBody("c".repeat(64)), risk: "low" }, { ...decideBody("c".repeat(64)), seen: { revision: 2, artifactDigest: "x" } }]) {
      expect((await call(post(`${RUN}/decide`, body), owner)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("hosted setup approval: two companies and two projects", () => {
  it("never reaches another company's candidate of the same project name: their owner decides only their own, ours stays waiting", async () => {
    const { world, person, call } = await setupWorld();
    const ours = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const theirs = await seedCandidate(world, OTHER, "payments", { setup: [command("yarn", ["install"])] });
    const theirOwner = person("p-their-owner", OTHER, "owner");
    // Our digest, from their company: their runtime reads their own candidate, so the digest is not the one waiting there.
    expect((await call(post(`${RUN}/decide`, decideBody(ours.digest)), theirOwner)).status).toBe(409);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
    const view = await call(get(RUN), theirOwner);
    expect((view.body["apply"] as Record<string, unknown>)["approval"]).toMatchObject({ artifactDigest: theirs.digest });
    expect(view.raw).not.toContain(ours.digest);
    expect((await call(post(`${RUN}/decide`, decideBody(theirs.digest)), theirOwner)).status).toBe(200);
    expect(await latestOf(world, OTHER)).toBe(2);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
  });

  it("keeps a maintainer of one project from deciding another project's candidate, and an approval of one project leaves the other's waiting", async () => {
    const { world, person, call } = await setupWorld();
    const payments = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const ledger = await seedCandidate(world, FAKE_COMPANY, "ledger", { setup: [command("npm", ["install"])] });
    const ledgerMaintainer = person("p-ledger", FAKE_COMPANY, "member", { ledger: "administrator", payments: "developer" });
    expect((await call(post(`${RUN}/decide`, decideBody(payments.digest)), ledgerMaintainer)).body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    // The payments digest on the ledger path is not ledger's candidate.
    expect((await call(post(`${LEDGER}/decide`, decideBody(payments.digest.replace(/.$/u, payments.digest.endsWith("0") ? "1" : "0"))), ledgerMaintainer)).status).toBe(409);
    expect((await call(post(`${LEDGER}/decide`, decideBody(ledger.digest)), ledgerMaintainer)).status).toBe(200);
    expect(await latestOf(world, FAKE_COMPANY, "ledger")).toBe(2);
    expect(await latestOf(world, FAKE_COMPANY, "payments")).toBe(1);
    expect(await applyRow(world, FAKE_COMPANY, "payments")).toMatchObject({ state: "checking" });
  });
});

describe("hosted setup approval: confirm and discard", () => {
  it("serves confirm only to people who manage the setup, audited first; with no finished run it refuses in the core's words and makes no candidate", async () => {
    const { world, person, call, audit } = await setupWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const requestId = randomUUID();
    const answer = await call(post(`${RUN}/confirm`, { requestId, expectedRevision: 1 }), admin);
    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toMatchObject({ code: "CONFIG_INVALID", message: "There is no setup from Rovara to use. Ask Rovara to set the project up first." });
    expect(audit.filter((event) => event.action === "setup_run.confirm_requested")).toEqual([expect.objectContaining({ actor: { type: "person", id: "p-admin" }, details: expect.objectContaining({ requestId, basis: "company-admin" }) as unknown })]);
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
    const developer = person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
    expect((await call(post(`${RUN}/confirm`, { requestId: randomUUID(), expectedRevision: 1 }), developer)).status).toBe(403);
  });

  it("discards a waiting candidate for a maintainer (audited), freeing the project; a project user cannot", async () => {
    const { world, person, call, audit } = await setupWorld();
    await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["install"])] });
    const developer = person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
    expect((await call(post(`${RUN}/discard`, { requestId: randomUUID() }), developer)).status).toBe(403);
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const discarded = await call(post(`${RUN}/discard`, { requestId: randomUUID() }), maintainer);
    expect(discarded.body).toEqual({ discarded: true });
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "discarded", decidedBy: "p-maint" });
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
    expect(audit.some((event) => event.action === "setup_run.discard_requested")).toBe(true);
  });

  it("serves none of confirm, discard or decide where the deployment has not wired the hosted approval, writing nothing", async () => {
    const { world, person, call } = await setupWorld({ approval: false });
    await seedCandidate(world, OTHER, "payments", { setup: [command("npm", ["install"])] });
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    for (const [tail, body] of [["confirm", { requestId: randomUUID(), expectedRevision: 1 }], ["discard", { requestId: randomUUID() }], ["decide", decideBody("d".repeat(64))]] as const) {
      expect((await call(post(`${RUN}/${tail}`, body), admin)).body, tail).toEqual({ error: { code: "NOT_FOUND", message: SETUP_APPROVAL_UNAVAILABLE } });
    }
    expect((await call(get(RUN), admin)).body["apply"]).toBeUndefined();
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
  });
});

describe("hosted approvers: a setup candidate's proof", () => {
  const NOW = Date.parse("2026-11-15T10:00:00.000Z");
  const DIGEST = "e".repeat(64);
  const STEP_UP = { at: new Date(NOW - 60_000).toISOString(), method: "passkey" };
  const A = FAKE_COMPANY as OrgId;
  const identity = createHostedIdentity({ membershipOf: async (personId) => (personId === "ada" ? { companyId: A, role: "member" as const } : undefined), displayNameOf: async () => "Ada" });
  const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    companyId: A, requestId: "setup-request-0001.x", kind: "setup", subject: { type: SETUP_PROPOSAL_SUBJECT, id: "payments" }, projectName: "payments", revision: 2, artifactDigest: DIGEST,
    risk: "low", outcome: "approve", card: { cardId: "setup_proposal:payments", contentVersion: DIGEST }, settlesClaims: true, ...overrides,
  });
  const token = (overrides: Record<string, unknown> = {}) => issueSetupApprovalProof(KEY, { companyId: A, personId: "ada", stepUp: STEP_UP, requestId: "setup-request-0001", kind: "setup", project: "payments", revision: 2, artifactDigest: DIGEST, outcome: "approve", card: { cardId: "setup_proposal:payments", contentVersion: DIGEST }, ...overrides } as never, NOW).token;
  const proof = (req: ApprovalRequest, value: string): ApprovalProof => ({ proofId: randomUUID(), method: APPROVAL_PROOF_METHOD, requestId: req.requestId, revision: req.revision, artifactDigest: req.artifactDigest, token: value });
  const point = () => createHostedApprovers({ store: createFakeWorld().store, identity, key: KEY, now: () => new Date(NOW) });

  it("accepts a live member's setup proof for exactly this project, revision, digest, card and answer", async () => {
    const verdict = await point().verify(request(), proof(request(), token()));
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ approved: true, approver: { personId: "ada", companyId: A } });
  });

  it("refuses a setup proof for another project, revision, digest or answer, a request without the project named, and a non-member", async () => {
    const cases: Array<[ApprovalRequest, string, string]> = [
      [request({ subject: { type: SETUP_PROPOSAL_SUBJECT, id: "ledger" }, projectName: "ledger", card: { cardId: "setup_proposal:ledger", contentVersion: DIGEST } }), token(), "other_subject"],
      [Object.fromEntries(Object.entries(request()).filter(([field]) => field !== "projectName")) as unknown as ApprovalRequest, token(), "no_rule_for_this_request"],
      [request({ projectName: "ledger" }), token(), "no_rule_for_this_request"],
      [request({ subject: { type: SETUP_PROPOSAL_SUBJECT, id: "-bad" }, projectName: "-bad" }), token(), "no_rule_for_this_request"],
      [request({ revision: 3 }), token(), "other_revision"],
      [request({ outcome: "reject" }), token(), "other_answer"],
      [request(), token({ personId: "bob" }), "not_a_member"],
      [request({ companyId: OTHER }), token(), "wrong_company"],
    ];
    for (const [req, value, reason] of cases) expect(await point().verify(req, proof(req, value)), reason).toEqual({ approved: false, reason });
  });

  it("never lets a task proof stand for a setup candidate, nor a setup proof for a task", async () => {
    const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
    // A task proof is refused on the setup subject (and a setup proof on a task): the proof's subject type is signed into it.
    const taskToken = issueApprovalProof(KEY, { companyId: A, personId: "ada", stepUp: STEP_UP, requestId: "setup-request-0001", kind: "setup", taskId: TASK, revision: 2, artifactDigest: DIGEST, outcome: "approve", card: { cardId: "setup_proposal:payments", contentVersion: DIGEST } }, NOW).token;
    expect(await point().verify(request(), proof(request(), taskToken))).toEqual({ approved: false, reason: "other_subject" });
    const taskRequest = request({ subject: { type: "task", id: TASK }, card: { cardId: `approve_plan:${TASK}`, contentVersion: DIGEST } });
    const setupForTask = token({ project: TASK, card: { cardId: `approve_plan:${TASK}`, contentVersion: DIGEST } });
    expect(await point().verify(taskRequest, proof(taskRequest, setupForTask))).toEqual({ approved: false, reason: "other_subject" });
  });

  it("refuses a task proof for a project whose name looks like a task id: only the proof's subject type tells them apart", async () => {
    const UUID_PROJECT = "3c2d1e0f-9a8b-4c7d-8e6f-5a4b3c2d1e0f";
    const card = { cardId: `setup_proposal:${UUID_PROJECT}`, contentVersion: DIGEST };
    const req = request({ subject: { type: SETUP_PROPOSAL_SUBJECT, id: UUID_PROJECT }, projectName: UUID_PROJECT, card });
    const taskProof = issueApprovalProof(KEY, { companyId: A, personId: "ada", stepUp: STEP_UP, requestId: "setup-request-0001", kind: "setup", taskId: UUID_PROJECT, revision: 2, artifactDigest: DIGEST, outcome: "approve", card }, NOW).token;
    expect(await point().verify(req, proof(req, taskProof))).toEqual({ approved: false, reason: "other_subject" });
    // The same act as a setup proof is accepted.
    expect(await point().verify(req, proof(req, token({ project: UUID_PROJECT, card })))).toMatchObject({ approved: true });
  });

  it("issues no setup proof for a malformed project name", () => {
    for (const project of ["", "-bad", "a/b", "x".repeat(101)]) expect(() => token({ project }), project).toThrow("a step-up approval cannot be issued for this input");
  });
});

describe("hosted setup run: the broken-setup card and a candidate Rovara drafted (L4-RD)", () => {
  const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
  /** The rows a broken setup leaves (the re-check, its one admin notice) and, when `repair` is given, the draft. */
  async function seedBroken(world: FakeWorld, companyId: string, name: string, repair?: Record<string, unknown>): Promise<void> {
    const at = new Date(world.clock.now).toISOString();
    const base = { orgId: companyId, project: name };
    const check = { workspaceId: randomUUID(), revision: 1, startedAt: at, startedBy: "x" };
    // The project's own setup state is the failed re-check's check (the break holds only while that mark stands).
    await world.store.update({ key: projectMetaKey(companyId, name), ops: [change.set("setupCheck", check)] });
    await world.store.put({ item: { ...recheckRowKey(companyId, name, "k1"), entityType: "SETUP_RECHECK", ...base, key: "k1", setupRevision: 1, commits: {}, classes: ["lockfile"], state: "broken", attempt: 2, check, startedAt: at, failedStep: STEP } });
    await world.store.put({ item: { ...repairNoticeKey(companyId, name), entityType: "SETUP_REPAIR_NOTICE", ...base, key: "k1", failedStep: STEP, classes: ["lockfile"], at } });
    if (repair === undefined) return;
    await world.store.put({ item: { ...repairRowKey(companyId, name, "k1"), entityType: "SETUP_REPAIR", ...base, key: "k1", setupRevision: 1, runRequestId: randomUUID(), confirmRequestId: randomUUID(), budgetCents: 400, claimedAt: at, ...repair } });
    await world.store.put({ item: { ...repairCurrentKey(companyId, name), entityType: "SETUP_REPAIR_CURRENT", ...base, key: "k1", startedAt: at } });
  }

  it("shows managers the card with the manual way out, and shows readers and other projects nothing", async () => {
    const { world, person, call } = await setupWorld();
    await seedBroken(world, FAKE_COMPANY, "payments");
    const admin = person("p-admin", FAKE_COMPANY, "member", { payments: "administrator" });
    const reader = person("p-reader", FAKE_COMPANY, "member", { payments: "developer" });
    const view = await call(get(RUN), admin);
    expect(view.body["repair"]).toMatchObject({ title: "Setup needs repair", state: "no_fix", actions: [{ id: "fix_setup", label: "Fix setup (uses your AI, up to $4)" }, { id: "edit_commands" }] });
    expect((await call(get(RUN), reader)).body["repair"]).toBeUndefined();
    expect((await call(get(LEDGER), person("p-ledger", FAKE_COMPANY, "member", { ledger: "administrator" }))).body["repair"]).toBeUndefined();
    // Another company's project of the same name has its own (here: no) card.
    expect((await call(get(RUN), person("p-other", OTHER, "owner"))).body["repair"]).toBeUndefined();
  });

  it("a candidate whose check ran as the system owner is marked drafted by Rovara, shown with the fix-ready card, and a maintainer still approves it by the risk rule", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["ci", "--prefer-offline"])] });
    const requestId = randomUUID();
    await world.store.update({ key: setupApplyKey(FAKE_COMPANY, "payments"), ops: [change.set("by", systemOwnerIdOf(FAKE_COMPANY, "payments")), change.set("requestId", requestId)] });
    await seedBroken(world, FAKE_COMPANY, "payments", { state: "ready", confirmRequestId: requestId, taskId: "t1" });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const view = await call(get(RUN), maintainer);
    expect(view.body["apply"]).toMatchObject({ candidateRevision: 2, draftedByRovara: true, risk: "low", canApprove: true });
    expect(view.body["repair"]).toMatchObject({ state: "fix_ready", candidateRevision: 2, actions: [{ id: "approve_setup", label: "Approve new setup" }, { id: "see_changes" }] });
    // A person's own candidate is not marked.
    const { world: w2, person: p2, call: c2 } = await setupWorld();
    await seedCandidate(w2, FAKE_COMPANY, "payments", { setup: [command("npm", ["ci", "--prefer-offline"])] });
    expect((await c2(get(RUN), p2("p-maint", FAKE_COMPANY, "member", { payments: "administrator" }))).body["apply"]).not.toHaveProperty("draftedByRovara");
    const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(decided.status, decided.raw).toBe(200);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
  });
});

describe("L4-EVP: prompt locations in a setup candidate", () => {
  const LOCATIONS = [{ repo: "demo", path: "deskbot/agent.py", kind: "function", symbol: "DeskAgent.build_contents" }];
  const storedLocations = async (world: FakeWorld, companyId: string, name: string, revision: number) =>
    (await world.store.get(projectRevisionKey(companyId, name, revision)) as { definition?: { promptLocations?: unknown } } | undefined)?.definition?.promptLocations;

  it("is MEDIUM: a project maintainer sees the locations whole, approves, and the project's revision then holds them", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { promptLocations: LOCATIONS });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const view = await call(get(RUN), maintainer);
    expect(view.body["apply"]).toMatchObject({ risk: "medium", changes: [{ area: "prompt_locations", risk: "medium" }], approver: "maintainer", canApprove: true, promptLocations: ["demo/deskbot/agent.py: function DeskAgent.build_contents"] });
    const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(decided.status, decided.raw).toBe(200);
    expect(decided.body).toMatchObject({ decision: "approved", risk: "medium" });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
    expect(await storedLocations(world, FAKE_COMPANY, "payments", 2)).toEqual(LOCATIONS);
  });
  it("a candidate with no locations shows no promptLocations field (the view as it was)", async () => {
    const { world, person, call } = await setupWorld();
    await seedCandidate(world, FAKE_COMPANY, "payments", { setup: [command("npm", ["ci", "--cache", ".c"])] });
    const view = await call(get(RUN), person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" }));
    expect(view.body["apply"]).not.toHaveProperty("promptLocations");
  });
  it("a developer grant and a member with no grant cannot approve it; a rejection removes it and the project keeps none", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { promptLocations: LOCATIONS });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), person("p-dev", FAKE_COMPANY, "member", { payments: "developer" }))).status).toBe(403);
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), person("p-none", FAKE_COMPANY, "member"))).status).toBe(404);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    const rejected = await call(post(`${RUN}/decide`, decideBody(digest, "reject")), person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" }));
    expect(rejected.status, rejected.raw).toBe(200);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    expect(await storedLocations(world, FAKE_COMPANY, "payments", 1)).toBeUndefined();
  });
  it("is bound to the digest the person saw: another digest (the locations changed under them) is refused", async () => {
    const { world, person, call } = await setupWorld();
    await seedCandidate(world, FAKE_COMPANY, "payments", { promptLocations: LOCATIONS });
    const other = setupApplyDigest([command("npm", ["ci"])], [command("npm", ["test"])]);
    expect((await call(post(`${RUN}/decide`, decideBody(other)), person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" }))).status).toBeGreaterThanOrEqual(400);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
  });
  it("two projects and two companies: approving one project's locations leaves the other project, and another company's same-named project, without any", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { promptLocations: LOCATIONS });
    await seedCandidate(world, OTHER, "payments", { promptLocations: [{ repo: "demo", path: "other/agent.py", kind: "file" }] });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator", ledger: "administrator" });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(200);
    expect(await storedLocations(world, FAKE_COMPANY, "payments", 2)).toEqual(LOCATIONS);
    expect(await storedLocations(world, FAKE_COMPANY, "ledger", 1)).toBeUndefined();
    expect(await latestOf(world, FAKE_COMPANY, "ledger")).toBe(1);
    expect(await latestOf(world, OTHER)).toBe(1);
    expect(await storedLocations(world, OTHER, "payments", 2)).toEqual([{ repo: "demo", path: "other/agent.py", kind: "file" }]);
    expect((await applyRow(world, OTHER))).toMatchObject({ state: "checking" });
  });
});
