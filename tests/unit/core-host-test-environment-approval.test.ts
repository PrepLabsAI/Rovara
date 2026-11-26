// L4-B3b (DEC 254zm item 4, live): approving a project's test environment on Code's AWS deployment through the hosted approvers point's own subject kind (`test-environment`) and proof, with
// the risk-based approvers (DEC 254z b) read LIVE. Parts: (1) the approvers point's proof for this subject and its separation from the task and setup subjects; (2) the route
// `POST /v1/app/projects/{project}/test-environment/approve` end to end over the real approvers, gate and subject (roles by risk, no step-up (DEC 254zzz73), binding, live role re-read, two companies,
// two projects); (3) Code's workers advertise the feature the task flow relies on.
import { MEMBERSHIP_READ_FAILED_WORDS, membershipReadFailed } from "../../packages/broker/src/core/membership-read.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TestEnvironmentBodySchema, type ApprovalProof, type ApprovalRequest, type AuditEvent, type OrgId, type OrgRole, type TestEnvironmentBody,
} from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { TEST_ENVIRONMENT_KIND, createTestEnvironmentSubject, proposeTestEnvironment, readApprovedTestEnvironment, recordTestEnvProveReport, testEnvironmentSubjectId } from "../../packages/broker/src/core/test-env/environment.js";
import type { TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, NOT_ON_THE_CORE_YET, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  APPROVAL_PROOF_METHOD, TEST_ENVIRONMENT_SUBJECT, createHostedApprovers, issueSetupApprovalProof, issueApprovalProof, issueTestEnvironmentApprovalProof, approvalProofKeyOf,
} from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createHostedTestEnvironmentApproval, testEnvironmentCardOf } from "../../packages/broker/src/core-host/test-environment-approval.js";
import { TEST_ENVIRONMENT_NOT_ALLOWED } from "../../packages/broker/src/core-host/hosted-test-environment-decision.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { projectStore } from "../support/test-env-world.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { TEST_ENV_PLAN_FEATURE } from "@agentx/contracts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OTHER = "org_corehost00000000000b" as OrgId;
const A = FAKE_COMPANY as OrgId;
const KEY = approvalProofKeyOf("callback-signing-key-for-tests-0123456789abcdef");
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const SHA = (c: string) => c.repeat(64);

const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/partner-service", executable, args, timeoutSeconds: 600 });
const sandbox = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "partner-service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: SHA("a"), schemaRef: SHA("b"), unmatched: "fail" } }],
  data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});
const highRisk = (): TestEnvironmentBody => sandbox({ services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/partner-scorer", roleArn: "arn:aws:iam::222222222222:role/rovara-invoke", region: "us-west-2" } }] });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- (1) the approvers point

describe("hosted approvers: a test environment's proof", () => {
  const DIGEST = SHA("e");
  const members: Record<string, { companyId: OrgId; role: OrgRole }> = { ada: { companyId: A, role: "member" }, cy: { companyId: OTHER, role: "member" } };
  const identity = createHostedIdentity({ membershipOf: async (personId) => members[personId], displayNameOf: async () => "Ada" });
  const card = (project = "payments", version = DIGEST) => ({ cardId: `test-environment:${project}`, contentVersion: version });
  const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    companyId: A, requestId: "req_0123456789.x", kind: "setting", subject: { type: TEST_ENVIRONMENT_SUBJECT, id: "payments" }, projectName: "payments", revision: 1, artifactDigest: DIGEST,
    risk: "medium", outcome: "approve", card: card(), settlesClaims: true, ...overrides,
  });
  const base = { companyId: A, personId: "ada", requestId: "req_0123456789", kind: "setting", revision: 1, artifactDigest: DIGEST, outcome: "approve" as const, card: card() };
  const token = (overrides: Record<string, unknown> = {}, at = NOW) => issueTestEnvironmentApprovalProof(KEY, { ...base, project: "payments", ...overrides }, at).token;
  const proof = (req: ApprovalRequest, value: string): ApprovalProof => ({ proofId: randomUUID(), method: APPROVAL_PROOF_METHOD, requestId: req.requestId, revision: req.revision, artifactDigest: req.artifactDigest, token: value });
  const point = (nowMs = NOW) => createHostedApprovers({ store: new MemoryDocumentStore(), identity, key: KEY, now: () => new Date(nowMs) });

  it("refuses every other project, revision, digest, answer, request, card, company, person, window and a replay (each by its own fixed reason)", async () => {
    const cases: Array<[string, ApprovalRequest, string, string]> = [
      ["other project", request({ subject: { type: TEST_ENVIRONMENT_SUBJECT, id: "ledger" }, projectName: "ledger", card: card("ledger") }), token(), "other_subject"],
      ["project not named", Object.fromEntries(Object.entries(request()).filter(([field]) => field !== "projectName")) as unknown as ApprovalRequest, token(), "no_rule_for_this_request"],
      ["request names another project", request({ projectName: "ledger" }), token(), "no_rule_for_this_request"],
      ["bad project name", request({ subject: { type: TEST_ENVIRONMENT_SUBJECT, id: "-bad" }, projectName: "-bad" }), token(), "no_rule_for_this_request"],
      ["other revision", request({ revision: 2 }), token(), "other_revision"],
      ["other digest", request({ artifactDigest: SHA("f"), card: card("payments", SHA("f")) }), token(), "other_content"],
      ["other answer", request({ outcome: "reject" }), token(), "other_answer"],
      ["other decision request", request({ requestId: "req_other_0001.x" }), token(), "other_request"],
      ["other kind", request({ kind: "plan" }), token(), "other_kind"],
      ["other card id", request({ card: { cardId: "test-environment:ledger", contentVersion: DIGEST } }), token(), "other_card"],
      ["other card version", request({ card: card("payments", SHA("f")) }), token(), "other_card"],
      ["no card named", ({ ...request(), card: undefined } as unknown as ApprovalRequest), token(), "card_not_named"],
      ["other company", request({ companyId: OTHER }), token(), "wrong_company"],
      ["a person of another company", request(), token({ personId: "cy" }), "not_a_member"],
      ["not a member", request(), token({ personId: "bob" }), "not_a_member"],
    ];
    for (const [name, req, value, reason] of cases) expect(await point().verify(req, proof(req, value)), name).toEqual({ approved: false, reason });
    // Expired proof.
    expect(await point(NOW + 121_000).verify(request(), proof(request(), token()))).toEqual({ approved: false, reason: "proof_expired" });
    // Replay: one proof settles once.
    const approvers = point();
    const once = token();
    expect(await approvers.verify(request(), proof(request(), once))).toMatchObject({ approved: true });
    expect(await approvers.verify(request(), proof(request(), once))).toEqual({ approved: false, reason: "proof_already_used" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- (2) the route, end to end

interface Person { companyId: OrgId; role: OrgRole; grants: Record<string, "developer" | "administrator"> }
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };

const post = (path: string, body: unknown) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const PATH = (project: string) => `/v1/app/projects/${project}/test-environment/approve`;

async function world(options: { approval?: boolean } = {}) {
  const fake = createFakeWorld();
  const store = fake.store as MemoryDocumentStore;
  const clock = fake.clock;
  const now = () => new Date(clock.now);
  const app: CoreHostApp = createCoreHostApp({
    modules: fake.modules, context: () => fake.context(), nowMs: () => clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now, log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
  const people = new Map<string, Person>();
  /** Reads of a person's company membership that still answer (to take a role away in the middle of a decision). Undefined: all. */
  const memberReadsLeft: { value: number | undefined } = { value: undefined };
  const grantReadsLeft: { value: number | undefined } = { value: undefined };
  const membershipOf = async (personId: string) => {
    if (memberReadsLeft.value !== undefined && memberReadsLeft.value-- <= 0) return undefined;
    const found = people.get(personId);
    return found === undefined ? undefined : { companyId: found.companyId, role: found.role };
  };
  const projectGrantRole = async (personId: string, project: string) => {
    if (grantReadsLeft.value !== undefined && grantReadsLeft.value-- <= 0) return undefined;
    return people.get(personId)?.grants[project];
  };
  const person = (personId: string, companyId: OrgId, role: OrgRole, grants: Person["grants"] = {}): DeployedCaller => {
    people.set(personId, { companyId, role, grants });
    return {
      principal: { companyId, personId, displayName: personId, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud",
    };
  };
  const identity = createHostedIdentity({ membershipOf, displayNameOf: async (id) => id });
  const approvers = createHostedApprovers({ store, identity, key: KEY, now });
  const audit: AuditEvent[] = [];
  const sink = { stage: (event: AuditEvent) => { audit.push(event); return []; }, record: async (event: AuditEvent) => { audit.push(event); } };
  const depsOf = (): TestEnvDeps => ({ store, now: () => clock.now, env: { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" }, audit: sink });
  const approvalOf = (companyId: OrgId) => createHostedTestEnvironmentApproval({ companyId, deps: depsOf(), store, approvers, audit: sink, identity, people: { membershipOf, projectGrantRole }, proofKey: KEY, now });
  // The deployment's own reading rule (core-engine-root.ts `canReadProject: projectGrant`): a grant on the project, whatever the company role.
  const canReadFails = { value: false };
  const canRead = async (personId: string, project: string) => { if (canReadFails.value) throw membershipReadFailed(); return people.get(personId)?.grants[project] !== undefined; };
  const approvals = new Map<string, ReturnType<typeof approvalOf>>([[A, approvalOf(A)], [OTHER, approvalOf(OTHER)]]);
  const wiring = (runtime: { companyId: string }): CoreDevWiring => ({
    origin: () => "https://api.example", canReadProject: canRead,
    ...(options.approval === false ? {} : { testEnvironmentApproval: approvals.get(runtime.companyId)! }),
  });
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller): Promise<CompanyMembership | undefined> => { const found = people.get(caller.principal.personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; },
    wiring,
  });
  const call = async (project: string, caller: DeployedCaller, body: unknown) => {
    const answer = await routes.route(post(PATH(project), body), caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } }, raw: answer.body };
  };
  /** A proposal that passed its Prove run, waiting for approval. */
  const seed = async (companyId: OrgId, project: string, body: TestEnvironmentBody = sandbox()) => {
    await projectStore(companyId, project, { store });
    const deps = depsOf();
    const proposed = await proposeTestEnvironment(deps, { orgId: companyId, project, proposedBy: "owner", body });
    await recordTestEnvProveReport(deps, { orgId: companyId, project, report: {
      schemaVersion: 1, proposalDigest: proposed.digest,
      steps: [{ step: "setup", status: "passed", durationMs: 5 }, { step: "boot", status: "passed", durationMs: 7 }, { step: "smoke", status: "passed", durationMs: 9 }],
      services: body.services.map((service) => ({ name: service.name, modeUsed: "mocked" })), finishedAt: "2026-11-03T10:00:00.000Z",
    } });
    return { digest: proposed.digest, revision: 1 };
  };
  const approved = (companyId: OrgId, project: string) => readApprovedTestEnvironment(depsOf(), companyId, project);
  const bodyFor = (seen: { digest: string; revision: number }, over: Record<string, unknown> = {}) => ({ requestId: `req_${randomUUID().slice(0, 12)}`, revision: seen.revision, artifactDigest: seen.digest, ...over });
  return { fake, store, clock, person, call, routes, audit, memberReadsLeft, grantReadsLeft, canReadFails, seed, approved, bodyFor, approvers, approvals, depsOf, sink, identity, people };
}

describe("approving a test environment on the deployed API: who, by risk (DEC 254z b)", () => {

  it("a project developer and a member with no grant decide nothing (the grant-less member cannot even read the project)", async () => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    expect(await w.call("payments", w.person("dev", A, "member", { payments: "developer" }), w.bodyFor(seen))).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(await w.call("payments", w.person("nobody", A, "member"), w.bodyFor(seen))).toMatchObject({ status: 404 });
    expect(await w.approved(A, "payments")).toBeUndefined();
  });
});

describe("approving a test environment on the deployed API: no step-up, binding and the live role", () => {

  it("binds what the person saw: another digest, another revision, a malformed id, an extra field or a non-object is refused and approves nothing", async () => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    const owner = w.person("ann", A, "owner");
    expect((await w.call("payments", owner, w.bodyFor({ ...seen, digest: SHA("c") }))).status).toBe(409);
    expect((await w.call("payments", owner, w.bodyFor({ ...seen, revision: 2 }))).status).toBe(409);
    for (const bad of [{ requestId: "x" }, { revision: 0 }, { artifactDigest: "nope" }, { extra: 1 }, { outcome: "reject" }]) {
      expect((await w.call("payments", owner, w.bodyFor(seen, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.call("payments", owner, [])).status).toBe(400);
    expect(await w.approved(A, "payments")).toBeUndefined();
    expect((await w.call("payments", owner, w.bodyFor(seen))).status).toBe(200);
    // The proposal no longer waits once it is the newest revision: a second approval finds nothing to approve, and no second revision is made.
    expect((await w.call("payments", owner, w.bodyFor(seen))).status).toBe(404);
    expect((await w.approved(A, "payments"))?.revision).toBe(1);
  });

  it("a grant read that FAILS at the route's own reading check is the retryable 503, never the 404 of a missing project; nothing is approved", async () => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    const dev = w.person("dev", A, "member", { payments: "developer" });
    w.canReadFails.value = true;
    const reply = await w.call("payments", dev, w.bodyFor(seen));
    expect(reply, reply.raw).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: MEMBERSHIP_READ_FAILED_WORDS } } });
    expect(await w.approved(A, "payments")).toBeUndefined();
    w.canReadFails.value = false;
    expect((await w.call("payments", dev, w.bodyFor(seen))).status, "control: the read answering 'a grant' reaches the decision, which refuses a developer").toBe(403);
  });

  it("re-reads the company role inside the decision: an admin demoted after the route's own check approves nothing", async () => {
    for (const left of [1, 2]) {
      const w = await world();
      const seen = await w.seed(A, "payments", highRisk());
      const admin = w.person("ann", A, "admin");
      // Reads that still answer: the decision's own first read, then the approvers point's identity read; the next one (inside the gate's subject rule) finds nobody.
      w.memberReadsLeft.value = left;
      const reply = await w.call("payments", admin, w.bodyFor(seen));
      expect(reply.status, `reads left ${left}: ${reply.raw}`).toBeGreaterThanOrEqual(400);
      w.memberReadsLeft.value = undefined;
      expect(await w.approved(A, "payments")).toBeUndefined();
    }
  });

  it("re-reads the project grant inside the decision: a maintainer whose grant is removed after the route's check approves nothing", async () => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    const maintainer = w.person("mia", A, "member", { payments: "administrator" });
    w.grantReadsLeft.value = 1;
    const reply = await w.call("payments", maintainer, w.bodyFor(seen));
    expect(reply).toMatchObject({ status: 403, body: { error: { message: TEST_ENVIRONMENT_NOT_ALLOWED } } });
    w.grantReadsLeft.value = undefined;
    expect(await w.approved(A, "payments")).toBeUndefined();
    // With the grant in place it is approved.
    expect((await w.call("payments", maintainer, w.bodyFor(seen))).status).toBe(200);
  });

  it("a proposal that changes between the person's look and the act (a newer one replaces it) is stale, never approved on the old digest", async () => {
    const w = await world();
    const first = await w.seed(A, "payments");
    const owner = w.person("ann", A, "owner");
    const second = await w.seed(A, "payments", sandbox({ roundBudgetMin: 45 }));
    expect(second.digest).not.toBe(first.digest);
    expect((await w.call("payments", owner, w.bodyFor(first))).status).toBe(409);
    expect((await w.call("payments", owner, w.bodyFor(second))).status).toBe(200);
  });

  it("not wired on this install: a fixed 'not on the core yet', nothing is read", async () => {
    const w = await world({ approval: false });
    const seen = await w.seed(A, "payments");
    const reply = await w.call("payments", w.person("ann", A, "owner"), w.bodyFor(seen));
    expect(reply).toMatchObject({ status: 404, body: { error: { message: NOT_ON_THE_CORE_YET } } });
  });
});

describe("approving a test environment on the deployed API: the gate refuses another subject's proof", () => {
  it("a task proof or a setup proof presented for the test environment's own decision is refused and approves nothing", async () => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    w.person("ann", A, "owner");
    const gate = createDecisionGate({
      store: w.store, approvers: w.approvers, audit: w.sink, now: () => new Date(w.clock.now), identity: w.identity,
      subjects: [createTestEnvironmentSubject(w.depsOf(), { companyId: A })],
    });
    const card = testEnvironmentCardOf("payments", seen.digest);
    const common = { companyId: A, personId: "ann", kind: "setting", revision: seen.revision, artifactDigest: seen.digest, outcome: "approve" as const, card };
    const attempt = (requestId: string, credential: { method: string; token: string }) => gate.decide({
      companyId: A, kind: TEST_ENVIRONMENT_KIND, subjectId: testEnvironmentSubjectId("payments", seen.digest), requestId, outcome: "approve",
      seen: { revision: seen.revision, artifactDigest: seen.digest }, credentials: [credential], details: {}, card,
    });
    const taskProof = issueApprovalProof(KEY, { ...common, requestId: "req_task_00001", taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6" }, w.clock.now);
    const setupProof = issueSetupApprovalProof(KEY, { ...common, requestId: "req_setup_0001", project: "payments" }, w.clock.now);
    expect(await attempt("req_task_00001", taskProof)).toMatchObject({ status: "refused" });
    expect(await attempt("req_setup_0001", setupProof)).toMatchObject({ status: "refused" });
    expect(await w.approved(A, "payments")).toBeUndefined();
    const own = issueTestEnvironmentApprovalProof(KEY, { ...common, requestId: "req_envproof_01", project: "payments" }, w.clock.now);
    expect(await attempt("req_envproof_01", own)).toMatchObject({ status: "decided" });
    expect((await w.approved(A, "payments"))?.revision).toBe(1);
  });
});

describe("the test environment subject's own approver rule (read inside the decision)", () => {
  const attemptWith = async (rule: Parameters<typeof createTestEnvironmentSubject>[1]["approval"], approvers: Array<{ companyId: string; personId: string }>) => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    const subject = createTestEnvironmentSubject(w.depsOf(), { companyId: A, ...(rule === undefined ? {} : { approval: rule }) });
    const loaded = await subject.load(A, testEnvironmentSubjectId("payments", seen.digest));
    const principals = approvers.map((a) => ({ ...a, displayName: a.personId, roles: [], provider: HOSTED_IDENTITY_PROVIDER })) as never;
    const attempt = { companyId: A, kind: TEST_ENVIRONMENT_KIND, subjectId: testEnvironmentSubjectId("payments", seen.digest), requestId: "req_0123456789", outcome: "approve" as const, seen: { revision: 1, artifactDigest: seen.digest }, credentials: [] };
    return subject.apply(loaded!, attempt, principals, new Date(NOW).toISOString());
  };
  const WORDS = "fixed words of the rule";
  it("a rule that throws, or answers anything but true, refuses (fixed words); only true passes", async () => {
    const ann = [{ companyId: A, personId: "ann" }];
    await expect(attemptWith({ mayDecide: async () => { throw new Error("read failed"); }, refusal: WORDS }, ann)).rejects.toMatchObject({ message: WORDS });
    await expect(attemptWith({ mayDecide: async () => 1 as never, refusal: WORDS }, ann)).rejects.toMatchObject({ message: WORDS });
    await expect(attemptWith({ mayDecide: async () => false, refusal: WORDS }, ann)).rejects.toMatchObject({ message: WORDS });
    await expect(attemptWith({ mayDecide: async () => true, refusal: WORDS }, ann)).resolves.toBeDefined();
  });
});

describe("the hosted rule is for approvers of THIS company only", () => {
  it("an approver of another company is refused by the rule even when that company's records would allow them", async () => {
    const w = await world();
    const seen = await w.seed(A, "payments");
    w.person("zed", OTHER, "owner");
    let called = false;
    const spyPeople = { membershipOf: async (id: string) => { called = true; const f = w.people.get(id); return f === undefined ? undefined : { companyId: f.companyId, role: f.role }; }, projectGrantRole: async () => "administrator" as const };
    const approval = createHostedTestEnvironmentApproval({ companyId: A, deps: w.depsOf(), store: w.store, approvers: w.approvers, audit: w.sink, identity: w.identity, people: spyPeople, proofKey: KEY, now: () => new Date(w.clock.now) });
    const result = await approval.approve({ personId: "zed", project: "payments", approval: { requestId: "req_0123456789", revision: seen.revision, artifactDigest: seen.digest } });
    expect(called).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(await w.approved(A, "payments")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- (3) the workers

describe("Code's workers and the test environment's task flow", () => {
  it("a Code worker lists the feature a task with a pinned test environment needs (task.testEnvironment.v1) on /ping; the name task.testEnv.v1 is not a feature", async () => {
    expect(TEST_ENV_PLAN_FEATURE).toBe("task.testEnvironment.v1");
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(TEST_ENV_PLAN_FEATURE);
    const root = await mkdtemp(join(tmpdir(), "agentx-features-"));
    const state = createWorkerServerState(new OperationJournal(root), { execute: async () => undefined });
    const ping = await (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as { invocationFeatures: string[] };
    expect(ping.invocationFeatures).toContain("task.testEnvironment.v1");
    expect(ping.invocationFeatures).not.toContain("task.testEnv.v1");
  });
});
