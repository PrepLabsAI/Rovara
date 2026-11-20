// The project's test environment on the ports: propose, record a Prove run, approve as a new revision through the approval gate, and the production deny list.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, TestEnvironmentBodySchema, projectMetaKey, testEnvDigest, type Approvers, type TestEnvironmentBody } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { TEST_ENVIRONMENT_KIND, TEST_ENV_PROPOSAL_TTL_MS, createTestEnvironmentSubject, proposeTestEnvironment, readApprovedTestEnvironment, recordTestEnvProveReport, testEnvRevisionKey, testEnvironmentSubjectId } from "../../packages/broker/src/core/test-env/environment.js";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvProposalKey } from "../../packages/broker/src/core/test-env/environment.js";

const ORG = IMPLICIT_COMPANY_ID;
const OWNER = localOwnerPrincipal();
const PROJECT = "partner-service";
const SESSION = ["local", "session", "secret", "for", "tests"].join("-");
const sha = (letter: string) => letter.repeat(64);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const sandbox = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "partner-service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: ["poetry.lock"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }],
  data: { seeds: [], generator: "faker_seeded", seed: 7 },
  accounts: [],
  prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: ["arn:aws:sagemaker:us-east-1:111122223333:"] },
  capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
const proved = (digest: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, proposalDigest: digest, steps: [{ step: "setup", status: "passed", durationMs: 5 }, { step: "boot", status: "passed", durationMs: 7 }, { step: "smoke", status: "passed", durationMs: 9 }],
  services: [{ name: "partner-scorer", modeUsed: "mocked" }], finishedAt: "2026-10-30T10:00:00.000Z", ...over,
});

function harness(startMs = Date.UTC(2026, 9, 30, 10, 0, 0), options: { forbidSelfApproval?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  /** What the Approvers seam was asked, so a test can read the risk the core put on the request. */
  const asked: Array<{ risk: string | undefined; kind: string; revision: number; requestedBy: unknown }> = [];
  const clock = { now: startMs };
  void store.put({ item: { ...projectMetaKey(ORG, PROJECT), status: "active" } });
  const deps: TestEnvDeps = { store, now: () => clock.now };
  const inner = createLocalOwnerApprovers({ owner: OWNER, now: () => new Date(clock.now), verifySession: (token) => token === SESSION });
  const approvers: Approvers = {
    requirement: async (request) => ({ ...(await inner.requirement(request)), ...(options.forbidSelfApproval === true ? { selfApprovalAllowed: false } : {}) }),
    verify: (request, proof) => { asked.push({ risk: request.risk, kind: request.kind, revision: request.revision, requestedBy: request.requestedBy }); return inner.verify(request, proof); },
  };
  const subject = createTestEnvironmentSubject(deps, { companyId: ORG });
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [subject], now: () => new Date(clock.now) });
  const propose = (body: unknown = sandbox(), proposer?: { provider: string; personId: string; displayName: string }) => proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "owner", body, ...(proposer === undefined ? {} : { proposer, client: "mcp" }) });
  const proposeAndProve = async (body: TestEnvironmentBody, over: Record<string, unknown> = {}) => {
    const proposal = await propose(body);
    await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: proved(proposal.digest, over) });
    return proposal;
  };
  const attempt = (digest: string, over: Partial<DecisionAttempt> = {}): DecisionAttempt => ({
    companyId: ORG, kind: TEST_ENVIRONMENT_KIND, subjectId: testEnvironmentSubjectId(PROJECT, digest), requestId: randomUUID(), outcome: "approve", seen: { revision: 1, artifactDigest: digest },
    credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }], ...over,
  });
  return { store, clock, deps, gate, propose, proposeAndProve, attempt, asked };
}

describe("the first approval", () => {

  it("is replayable: the same request answers again and writes nothing new", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    const request = h.attempt(digest);
    await h.gate.decide(request);
    expect(await h.gate.decide(request)).toMatchObject({ status: "replayed" });
    const rows = await h.store.query({ pk: testEnvRevisionKey(ORG, PROJECT, 1).pk, sk: { op: "beginsWith", prefix: "TESTENV#REV#" } });
    expect(rows.items).toHaveLength(1);
  });

});

describe("what an approval refuses", () => {
  it("a body that does not parse, naming the field and never the value", async () => {
    const h = harness();
    const error = await h.propose({ ...sandbox(), roundBudgetMin: 5 }).catch((caught: unknown) => (caught instanceof Error ? caught.message : ""));
    expect(error).toContain("roundBudgetMin");
    expect(error).not.toContain("5");
  });

  it("a digest nobody proposed, an expired proposal, and one that was never proved", async () => {
    const h = harness();
    expect(await h.gate.decide(h.attempt(sha("9")))).toMatchObject({ status: "refused", reason: "not_found" });
    const proposal = await h.propose();
    expect(await h.gate.decide(h.attempt(proposal.digest))).toMatchObject({ status: "refused", reason: "invalid", detail: expect.stringContaining("prove this environment") });
    h.clock.now += TEST_ENV_PROPOSAL_TTL_MS + 1000;
    expect(await h.gate.decide(h.attempt(proposal.digest))).toMatchObject({ status: "refused", reason: "not_found" });
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("a Prove report for a proposal that does not exist, or that is not a report", async () => {
    const h = harness();
    await expect(recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: proved(sha("e")) })).rejects.toThrow(/no such proposal/);
    await expect(recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: { nonsense: true } })).rejects.toThrow(/could not be read/);
  });

  it("a revision the person was not looking at", async () => {
    const h = harness();
    const first = await h.proposeAndProve(sandbox());
    await h.gate.decide(h.attempt(first.digest));
    const second = await h.proposeAndProve(sandbox({ data: { seeds: [], generator: "faker_seeded", seed: 9 } }));
    expect(await h.gate.decide(h.attempt(second.digest, { seen: { revision: 1, artifactDigest: second.digest } }))).toMatchObject({ status: "refused", reason: "stale" });
    expect(await h.gate.decide(h.attempt(second.digest, { seen: { revision: 2, artifactDigest: second.digest } }))).toMatchObject({ status: "decided", result: { revision: 2 } });
  });

  it("a reject or a request for changes: a test environment is approved or left alone", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    expect(await h.gate.decide(h.attempt(digest, { outcome: "reject", reason: "no" }))).toMatchObject({ status: "refused" });
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("a forged or missing proof approves nothing", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    expect(await h.gate.decide(h.attempt(digest, { credentials: [{ method: LOCAL_SESSION_METHOD, token: "not-the-session" }] }))).toMatchObject({ status: "refused" });
    expect(await h.gate.decide(h.attempt(digest, { credentials: [] }))).toMatchObject({ status: "refused" });
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("a subject id of another company or one that is not a proposal reads as absent", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    expect(await h.gate.decide(h.attempt(digest, { subjectId: `${PROJECT}@not-a-digest` }))).toMatchObject({ status: "refused", reason: "not_found" });
    expect(await h.gate.decide(h.attempt(digest, { subjectId: "other@" + digest }))).toMatchObject({ status: "refused", reason: "not_found" });
  });
});

describe("production is refused again at approval", () => {
  it("a proposal stored before the deny list grew is refused when approved: the approved revision's own deny list still counts", async () => {
    const h = harness();
    const first = await h.proposeAndProve(sandbox());
    await h.gate.decide(h.attempt(first.digest));
    // A proposal that was stored without going through propose (an older build, another path): it points at a host the APPROVED revision's list names, and lists nothing itself.
    const sneaky = { ...sandbox(), tier: "shared", shared: { baseUrl: "https://api.prod.example.com", leaseScope: "env", dataNamespace: "task_prefix" }, prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } };
    const parsed = TestEnvironmentBodySchema.parse(sneaky);
    const digest = testEnvDigest(parsed);
    await h.store.put({ item: documentOf({ ...testEnvProposalKey(ORG, PROJECT, digest), entityType: "TEST_ENV_PROPOSAL", orgId: ORG, project: PROJECT, digest, proposedBy: "owner", proposedAt: new Date(h.clock.now).toISOString(), environment: parsed }) });
    await recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: proved(digest) });
    const refused = await h.gate.decide(h.attempt(digest, { seen: { revision: 2, artifactDigest: digest } }));
    expect(refused).toMatchObject({ status: "refused", reason: "invalid", detail: expect.stringContaining("production") });
    expect((await readApprovedTestEnvironment(h.deps, ORG, PROJECT))?.revision).toBe(1);
  });
});

describe("the person who proposed is the requester of the approval", () => {
  const owner = { provider: OWNER.provider, personId: OWNER.personId, displayName: OWNER.displayName };
  it("an approvers adapter that forbids self-approval refuses the person who proposed, with the gate's own reason, and the environment stays unapproved", async () => {
    const h = harness(undefined, { forbidSelfApproval: true });
    const proposal = await h.propose(sandbox(), owner);
    await recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: proved(proposal.digest) });
    expect(await h.gate.decide(h.attempt(proposal.digest))).toMatchObject({ status: "refused", reason: "self_approval_not_allowed" });
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });

});

