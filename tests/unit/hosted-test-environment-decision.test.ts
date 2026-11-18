// DEC 254zm item 4: approving a project's test environment on AWS through the approval gate and the test environment's own subject, with risk-based approvers (DEC 254z b) read live,
// and the proof seam that L4-D's hosted approvers extension provides (a fake here that hands the bench's local proof, so the gate and the subject run for real).
import { describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, type OrgId, type OrgRole, type TestEnvironmentBody } from "@agentx/contracts";
import { LOCAL_SESSION_METHOD } from "../../packages/broker/src/ports/policy-defaults.js";
import { readApprovedTestEnvironment } from "../../packages/broker/src/core/test-env/environment.js";
import { createHostedTestEnvironmentDecision, mayApproveTestEnvironment, type TestEnvironmentProofIssuer } from "../../packages/broker/src/core-host/hosted-test-environment-decision.js";
import type { DeployedPeople } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { BENCH_ORG, BENCH_SESSION, bench } from "../support/test-env-bench.js";

const sha = (c: string) => c.repeat(64);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/partner-service", executable, args, timeoutSeconds: 600 });
const sandbox = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "partner-service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }],
  data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});
const highRisk = () => sandbox({ services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/partner-scorer", roleArn: "arn:aws:iam::222222222222:role/rovara-invoke", region: "us-west-2" } }] });

const OTHER_COMPANY = `org_${"z9".repeat(10)}`;
const STEP_UP = { at: "2026-11-03T10:00:00.000Z", method: "email-code" };

function people(company: { role?: OrgRole; companyId?: OrgId } | undefined, grant?: "developer" | "administrator"): DeployedPeople & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    membershipOf: async (personId) => { calls.push(`member:${personId}`); return company === undefined || company.role === undefined ? undefined : { companyId: company.companyId ?? BENCH_ORG, role: company.role }; },
    projectGrantRole: async (personId, project) => { calls.push(`grant:${personId}:${project}`); return grant; },
  };
}

async function setup(body: TestEnvironmentBody, who: DeployedPeople, options: { proofs?: TestEnvironmentProofIssuer | null } = {}) {
  const b = await bench();
  const proposal = await b.propose(body);
  await b.prove(proposal.digest, body, { steps: [{ step: "setup", status: "passed", durationMs: 5 }, { step: "boot", status: "passed", durationMs: 7 }, { step: "smoke", status: "passed", durationMs: 9 }] });
  const issued: unknown[] = [];
  const proofs: TestEnvironmentProofIssuer = { issue: (input) => { issued.push(input); return { method: LOCAL_SESSION_METHOD, token: BENCH_SESSION }; } };
  const gate = vi.fn(() => b.gate);
  const decider = createHostedTestEnvironmentDecision({ companyId: BENCH_ORG, deps: b.deps, gate, people: who, ...(options.proofs === null ? {} : { proofs: options.proofs ?? proofs }) });
  const approval = { requestId: "req_0123456789", revision: 1, artifactDigest: proposal.digest };
  return { b, proposal, issued, gate, decider, approval };
}

describe("who may approve a test environment on AWS (DEC 254z b)", () => {
  it.each([
    ["owner", undefined, "medium", true], ["admin", undefined, "medium", true], ["member", "administrator", "medium", true], ["member", "administrator", "low", true],
    ["member", "developer", "medium", false], ["member", undefined, "medium", false],
    ["owner", undefined, "high", true], ["admin", undefined, "high", true], ["member", "administrator", "high", false], ["member", "developer", "high", false],
    [undefined, "administrator", "medium", false], [undefined, undefined, "low", false],
  ] as const)("company %s, project %s, risk %s: %s", (companyRole, projectRole, risk, allowed) => {
    expect(mayApproveTestEnvironment({ companyRole, projectRole, risk })).toBe(allowed);
  });
});

describe("approving a project's test environment on AWS", () => {
  it("a project maintainer approves a medium-risk proposal with a fresh step-up: the proof is for exactly this act, the gate decides, the revision is stored", async () => {
    const s = await setup(sandbox(), people({ role: "member" }, "administrator"));
    expect(s.proposal.risk).toBe("medium");
    const result = await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval });
    expect(result).toEqual({ ok: true, message: "Approved. Tasks that start from now on use it." });
    expect(s.issued).toEqual([{ companyId: BENCH_ORG, personId: "p1", stepUp: STEP_UP, requestId: "req_0123456789", kind: "setting", project: s.b.project, revision: 1, artifactDigest: s.proposal.digest, outcome: "approve", card: { cardId: `test-environment:${s.b.project}`, contentVersion: s.proposal.digest } }]);
    expect((await readApprovedTestEnvironment(s.b.deps, BENCH_ORG, s.b.project))?.revision).toBe(1);
  });

  it("a high-risk proposal: a project maintainer is refused before any proof; a company admin approves", async () => {
    const maintainer = await setup(highRisk(), people({ role: "member" }, "administrator"));
    expect(maintainer.proposal.risk).toBe("high");
    expect(await maintainer.decider.approve({ personId: "p1", stepUp: STEP_UP, project: maintainer.b.project, approval: maintainer.approval })).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(maintainer.issued).toEqual([]);
    expect(maintainer.gate).not.toHaveBeenCalled();
    const admin = await setup(highRisk(), people({ role: "admin" }));
    expect(await admin.decider.approve({ personId: "p2", stepUp: STEP_UP, project: admin.b.project, approval: admin.approval })).toMatchObject({ ok: true });
  });

  it("a project developer, and anyone with no grant, decide nothing", async () => {
    for (const grant of ["developer", undefined] as const) {
      const s = await setup(sandbox(), people({ role: "member" }, grant));
      expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false, reason: "not_allowed" });
      expect(s.issued).toEqual([]);
      expect(await readApprovedTestEnvironment(s.b.deps, BENCH_ORG, s.b.project)).toBeUndefined();
    }
  });

  it("two companies: a person whose live membership is another company's (even as its owner) reads nothing of this company's proposal and decides nothing", async () => {
    const who = people({ role: "owner", companyId: OTHER_COMPANY }, "administrator");
    const s = await setup(sandbox(), who);
    const result = await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(who.calls).toEqual(["member:p1"]);
    expect(s.issued).toEqual([]);
    expect(s.gate).not.toHaveBeenCalled();
  });

  it("no step-up, a membership read that fails, or a revoked member: nothing is issued", async () => {
    const s = await setup(sandbox(), people({ role: "admin" }));
    expect(await s.decider.approve({ personId: "p1", stepUp: undefined, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false, reason: "not_allowed" });
    const failing: DeployedPeople = { membershipOf: async () => { throw new Error("read failed"); }, projectGrantRole: async () => "administrator" };
    const f = await setup(sandbox(), failing);
    expect(await f.decider.approve({ personId: "p1", stepUp: STEP_UP, project: f.b.project, approval: f.approval })).toMatchObject({ ok: false, reason: "not_found" });
    // A malformed person id or an unknown role is nobody (the deployed decisions' own membership reader).
    expect(await s.decider.approve({ personId: "p#1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false, reason: "not_found" });
    const oddRole = await setup(sandbox(), people({ role: "superuser" as OrgRole }, "administrator"));
    expect(await oddRole.decider.approve({ personId: "p1", stepUp: STEP_UP, project: oddRole.b.project, approval: oddRole.approval })).toMatchObject({ ok: false, reason: "not_found" });
    const revoked = await setup(sandbox(), people(undefined, "administrator"));
    expect(await revoked.decider.approve({ personId: "p1", stepUp: STEP_UP, project: revoked.b.project, approval: revoked.approval })).toMatchObject({ ok: false, reason: "not_found" });
    expect([...s.issued, ...f.issued, ...revoked.issued, ...oddRole.issued]).toEqual([]);
  });

  it("binds the proposal the person saw: another digest, another revision, an unproved proposal or another project is refused before any proof", async () => {
    const s = await setup(sandbox(), people({ role: "admin" }));
    expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: { ...s.approval, artifactDigest: sha("c") } })).toMatchObject({ ok: false, reason: "stale" });
    expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: { ...s.approval, revision: 2 } })).toMatchObject({ ok: false, reason: "stale" });
    expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: "other-project", approval: s.approval })).toMatchObject({ ok: false, reason: "not_found" });
    for (const bad of [{ ...s.approval, requestId: "x" }, { ...s.approval, revision: 0 }, { ...s.approval, artifactDigest: "not-a-digest" }]) {
      expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: bad })).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(s.issued).toEqual([]);
    const unproved = await bench();
    const proposed = await unproved.propose(sandbox());
    const issued: unknown[] = [];
    const decider = createHostedTestEnvironmentDecision({ companyId: BENCH_ORG, deps: unproved.deps, gate: () => unproved.gate, people: people({ role: "admin" }), proofs: { issue: (input) => { issued.push(input); return { method: LOCAL_SESSION_METHOD, token: BENCH_SESSION }; } } });
    expect(await decider.approve({ personId: "p1", stepUp: STEP_UP, project: unproved.project, approval: { requestId: "req_0123456789", revision: 1, artifactDigest: proposed.digest } })).toMatchObject({ ok: false, reason: "stale" });
    expect(issued).toEqual([]);
  });

  it("not wired (no proof issuer: the hosted approvers point cannot prove this act yet) answers not_wired and reads nothing", async () => {
    const who = people({ role: "admin" });
    const s = await setup(sandbox(), who, { proofs: null });
    expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toEqual({ ok: false, reason: "not_wired", message: "Approving a test environment is not on this install yet." });
    expect(who.calls).toEqual([]);
    expect(s.gate).not.toHaveBeenCalled();
  });

  it("the test environment switched off answers off", async () => {
    const s = await setup(sandbox(), people({ role: "admin" }));
    const decider = createHostedTestEnvironmentDecision({ companyId: BENCH_ORG, deps: { ...s.b.deps, env: { ROVARA_TEST_ENVIRONMENT: "0" } }, gate: () => s.b.gate, people: people({ role: "admin" }), proofs: { issue: () => ({ method: LOCAL_SESSION_METHOD, token: BENCH_SESSION }) } });
    expect(await decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false, reason: "off" });
  });

  it("a proof the gate's approvers point refuses approves nothing, and a repeat of an approved request is stale", async () => {
    const s = await setup(sandbox(), people({ role: "admin" }));
    const refusing = createHostedTestEnvironmentDecision({ companyId: BENCH_ORG, deps: s.b.deps, gate: () => s.b.gate, people: people({ role: "admin" }), proofs: { issue: () => ({ method: LOCAL_SESSION_METHOD, token: "not-the-session" }) } });
    expect(await refusing.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false, reason: "refused" });
    expect(await readApprovedTestEnvironment(s.b.deps, BENCH_ORG, s.b.project)).toBeUndefined();
    const throwing = createHostedTestEnvironmentDecision({ companyId: BENCH_ORG, deps: s.b.deps, gate: () => s.b.gate, people: people({ role: "admin" }), proofs: { issue: () => { throw new Error("cannot bind"); } } });
    expect(await throwing.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false, reason: "refused" });
    expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: true });
    expect(await s.decider.approve({ personId: "p1", stepUp: STEP_UP, project: s.b.project, approval: s.approval })).toMatchObject({ ok: false });
  });
});
