import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowSnapshot, WORKFLOW_BLOCK_REASONS, projectPk, projectRevisionKey, type AuditSink, type NightlyBaseline, type JsonObject, type OrgId, type Principal } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { alreadyFailingForResults } from "../../packages/broker/src/core/proof/verification-result.js";
import { createKnownFailing } from "../../packages/broker/src/core/test-env/known-failing.js";
const company = "org_corehost00000000000a" as OrgId, project = "sample", now = Date.parse("2026-11-19T12:00:00Z"), at = new Date(now).toISOString();
const principal: Principal = { companyId: company, personId: "maintainer", displayName: "Maintainer", provider: "test", roles: ["member"] };
const baseline: NightlyBaseline = { recordedAt: at, finishedAt: at, envRevision: 1, branch: "main", headSha: "a".repeat(40), tests: { total: 2, passed: 2, failed: 0, skipped: 0 }, failed: [], flaky: [] };
const blockedWorkflow = { ...createWorkflowSnapshot({ taskId: "00000000-0000-4000-8000-000000000001", ownerId: "a".repeat(64), now: at }), stage: "VERIFY" as const, state: "BLOCKED" as const, blockReason: WORKFLOW_BLOCK_REASONS.checkRunnerFailed };
async function fixture() {
  const store = new MemoryDocumentStore();
  let unavailable = false;
  const audit: AuditSink = { stage(event) { if (unavailable) throw new Error("ledger unavailable"); return [{ kind: "put", item: { pk: `AUDIT#${company}`, sk: event.eventId, action: event.action } }]; }, async record() { throw new Error("must use transaction"); } };
  const service = createKnownFailing({ store, now: () => now, audit, mayMaintain: async () => true, evidenceOf: async () => undefined, workflowOf: async () => blockedWorkflow });
  await store.put({ item: { ...projectRevisionKey(company, project, 1), definition: { repositories: [{ defaultBranch: "main" }] } } });
  const marks = ["passed test", "absent test"].map((name) => ({ name, checkId: "unit", markedBy: "maintainer", markedAt: at, epoch: 1, version: randomUUID() }));
  await store.put({ item: { pk: projectPk(company, project), sk: "KNOWN_FAILING", version: 1, marks } });
  return { service, store, unavailable: () => { unavailable = true; } };
}
describe("known-failing nightly boundaries", () => {
  it("creates health cards from fixed broker causes, dismissal is one website act, replay stays closed", async () => {
    const s = await fixture(), health = { class: "environment" as const, cause: "setup_failed", ranFrom: "fresh" as const };
    await s.store.put({ item: { pk: projectPk(company, project), sk: "TESTENV#BASELINE#LATEST", baseline: JSON.parse(JSON.stringify(baseline)) as JsonObject, health } });
    await s.service.health(company, project, baseline, health);
    const cards = await s.service.items(company, principal);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "fix_setup", knownFailingTests: 0, taskCount: 0 });
    const card = cards[0]!, loaded = (await s.service.subject.load(company, card.subjectId))!;
    const applied = await s.service.subject.apply(loaded, { companyId: company, subjectId: card.subjectId, kind: "known_failing", requestId: randomUUID(), outcome: "reject", seen: card.binding!, credentials: [], details: { webApp: true } }, [principal], at);
    expect((await s.store.transact([{ kind: "update", key: loaded.key, condition: loaded.guard, ops: applied.ops }])).applied).toBe(true);
    await s.service.health(company, project, baseline, health);
    expect(await s.service.items(company, principal)).toEqual([]);
    expect(await s.service.subject.load(company, card.subjectId)).toBeUndefined();
  });
  it("only removes matching passing names, with its audit in the same transaction", async () => {
    const s = await fixture();
    await s.service.nightly(company, project, baseline);
    expect((await s.service.marks(company, project)).marks).toHaveLength(2);
    await s.service.nightly(company, project, { ...baseline, branch: "other" }, ["passed test"]);
    expect((await s.service.marks(company, project)).marks).toHaveLength(2);
    await s.service.nightly(company, project, baseline, ["passed test"]);
    expect((await s.service.marks(company, project)).marks.map((mark) => mark.name)).toEqual(["absent test"]);
    expect((await s.store.query({ pk: `AUDIT#${company}` })).items).toHaveLength(1);
  });
});


it("produces a bounded environment card for a blocked task even when no test report could be kept", async () => {
  const s = await fixture();
  await s.service.observeBlocked({ companyId: company, project, taskId: blockedWorkflow.taskId, workflow: blockedWorkflow });
  expect(await s.service.items(company, principal)).toMatchObject([{ kind: "fix_setup", cause: "check-runner-failed", taskCount: 1, eligibleTests: [] }]);
});


it("excuses nothing when the task branch evidence cannot be read completely", async () => {
  const s = await fixture();
  const query = s.store.query.bind(s.store);
  vi.spyOn(s.store, "query").mockImplementation(async (input) => {
    if (input.pk.startsWith("DEVTASK#")) throw new Error("branch evidence unavailable");
    return query(input);
  });
  expect(await alreadyFailingForResults({ store: s.store, now: () => now }, { companyId: company, project, taskId: blockedWorkflow.taskId })).toEqual([]);
});
