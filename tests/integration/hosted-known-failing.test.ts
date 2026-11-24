import { describe, expect, it } from "vitest";
import { EvidencePackSchema, projectPk, projectRevisionKey, type AuditSink, type OrgId, type Principal } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createKnownFailing, type KnownFailingDeps } from "../../packages/broker/src/core/test-env/known-failing.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createHostedApprovers, issueKnownFailingApprovalProof, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { classifyStoredTestingResult } from "../../packages/broker/src/core/proof/verification-result.js";
import { createWorkflowSnapshot, createCandidateManifest, WorkflowSnapshotSchema, wholeTaskSpendUsd } from "@agentx/contracts";

const company = "org_corehost00000000000a" as OrgId, other = "org_corehost00000000000b" as OrgId;
const now = Date.parse("2026-11-19T12:00:00Z");
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const digest = candidate.digest;
const evidence = (name = "old test") => EvidencePackSchema.parse({ schemaVersion: 1, candidateDigest: digest, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, checks: [{ checkId: "unit", kind: "test", label: "Unit", before: "failed", after: "failed", class: "already_failing", durationMs: 1, tests: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, newTests: [], names: [{ name, status: "failed" }] } }], selection: { method: "full", selected: 1, total: 1 }, api: [], browser: [], notTested: [] });
const person = (id = "maintainer", c: string = company): Principal => ({ companyId: c, personId: id, displayName: id, provider: "hosted", roles: ["member"] });
const taskId = "00000000-0000-4000-8000-000000000001";
const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: new Date(now).toISOString() }), stage: "REVIEW", state: "READY", candidate, verification: { candidateDigest: digest, producer: "worker", environmentId: "env", recordedAt: new Date(now).toISOString(), results: [{ checkId: "unit", status: "FAILED" }] } });
async function setup() {
  const store = new MemoryDocumentStore();
  const events: string[] = [];
  let role = "administrator", auditAvailable = true, pack = evidence();
  const audit: AuditSink = { stage(event) { if (!auditAvailable) throw new Error("ledger unavailable"); events.push(event.action); return [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: event.eventId, action: event.action, details: event.details ?? {} } }]; }, async record() { throw new Error("must be transactional"); } };
  const deps: KnownFailingDeps = { store, now: () => now, audit, mayMaintain: async (p) => p.companyId === company && (role === "owner" || role === "admin" || role === "administrator"), evidenceOf: async () => pack };
  const service = createKnownFailing(deps);
  for (const c of [company, other]) {
    await store.put({ item: { ...projectRevisionKey(c, "sample", 1), definition: { repositories: [{ defaultBranch: "main" }] } } });
    await store.put({ item: { pk: projectPk(c, "sample"), sk: "TESTENV#BASELINE#LATEST", baseline: { recordedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), envRevision: 1, branch: "main", headSha: "c".repeat(40), tests: { total: 1, passed: 0, failed: 1, skipped: 0 }, failed: ["old test"], flaky: [] } } });
  }
  const key = approvalProofKeyOf("test-key".repeat(8));
  const approvers = createHostedApprovers({ store, key, now: () => new Date(now), identity: { getPrincipal: async (c: string, id: string) => person(id, c) } });
  const gate = createDecisionGate({ store, audit, approvers, subjects: [service.subject], now: () => new Date(now) });
  async function produce(c = company) { return service.observe({ companyId: c, project: "sample", taskId, evidence: pack, workflow }); }
  async function decide(item: NonNullable<Awaited<ReturnType<typeof produce>>>, webApp = true, actor = person()) {
    const requestId = "request_1234";
    const credential = issueKnownFailingApprovalProof(key, { companyId: company, personId: actor.personId, requestId, kind: "known_failing", subjectId: item.subjectId, revision: item.binding!.revision, artifactDigest: item.binding!.artifactDigest, outcome: "approve", card: { cardId: `fix_setup:${item.subjectId}`, contentVersion: item.contentVersion } }, now);
    return gate.decide({ companyId: company, kind: "known_failing", subjectId: item.subjectId, requestId, outcome: "approve", seen: item.binding!, credentials: [credential], card: { cardId: `fix_setup:${item.subjectId}`, contentVersion: item.contentVersion }, details: { webApp } });
  }
  return { service, store, events, produce, decide, setRole: (value: string) => { role = value; }, breakAudit: () => { auditAvailable = false; }, changeEvidence: () => { pack = evidence("new test"); } };
}

describe("hosted known-failing lifecycle", () => {
  it("produces broker evidence, one maintainer approves atomically, results consume it, undo is exact", async () => {
    const s = await setup(), item = (await s.produce())!;
    expect(item.eligibleTests).toEqual([{ name: "old test", checkId: "unit" }]);
    expect((await s.decide(item)).status).toBe("decided");
    const marks = await s.service.marks(company, "sample");
    expect(marks.marks).toHaveLength(1);
    const audit = await s.store.query({ pk: `AUDIT#${company}` });
    expect(audit.items.some((row) => row["action"] === "known_failing.marked")).toBe(true);
    expect(JSON.stringify(audit.items)).not.toContain("old test");
    const result = await classifyStoredTestingResult({ store: s.store, now: () => now }, { companyId: company, project: "sample", taskId, workflow, evidence: evidence(), facts: {}, budget: { enabled: false, dayBudgetHasRoom: true, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 0, capUsd: 1 } } });
    expect(result).toMatchObject({ decided: true, result: "partially_verified" });
    await s.service.undo(company, "sample", person(), true, marks.marks[0]!);
    await expect(s.service.undo(company, "sample", person(), true, marks.marks[0]!)).rejects.toThrow();
    expect((await s.service.marks(company, "sample")).marks).toHaveLength(0);
  });
  it.each(["member", "developer", "missing"])("refuses role %s", async (role) => { const s = await setup(), item = (await s.produce())!; s.setRole(role); expect((await s.decide(item)).status).toBe("refused"); expect((await s.service.marks(company, "sample")).marks).toHaveLength(0); });
  it.each(["owner", "admin", "administrator"])("permits one current %s", async (role) => { const s = await setup(), item = (await s.produce())!; s.setRole(role); expect((await s.decide(item)).status).toBe("decided"); });
  it("refuses other clients and changed evidence", async () => { const s = await setup(), item = (await s.produce())!; expect((await s.decide(item, false)).status).toBe("refused"); s.changeEvidence(); await expect(s.decide(item)).rejects.toThrow(); });
  it("fails the whole write when the audit cannot stage", async () => { const s = await setup(), item = (await s.produce())!; s.breakAudit(); await expect(s.decide(item)).rejects.toThrow(); expect((await s.service.marks(company, "sample")).marks).toHaveLength(0); });
  it("isolates same project/test names in two companies and removes marks only on usable passing nights", async () => {
    const s = await setup(), item = (await s.produce())!; await s.produce(other); await s.decide(item);
    expect((await s.service.marks(other, "sample")).marks).toHaveLength(0);
    expect(await s.service.items(other, person())).toEqual([]);
    await s.service.nightly(company, "sample", { recordedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), envRevision: 1, branch: "main", headSha: "c".repeat(40), tests: { total: 1, passed: 1, failed: 0, skipped: 0 }, failed: [], flaky: [] }, ["old test"]);
    expect((await s.service.marks(company, "sample")).marks).toHaveLength(0);
    expect(s.events).toContain("known_failing.nightly_removed");
  });
});
