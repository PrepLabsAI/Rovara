// The lighter flow's record is written without moving the revision. A writer that holds a whole older workflow must neither wipe the record nor be refused for it: it sets only the keys it changed.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, change, createWorkflowSnapshot, submitWorkflowArtifact, when, type JsonValue, type WorkflowFlow, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createWorkflowDocumentSubject, workflowTaskKey } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { workflowUpdateItem } from "../../packages/broker/src/core/merge/store.js";
import { flowIs, workflowWriteOps } from "../../packages/broker/src/core/task-flow/flow-guard.js";
import { recordTier, tierFromDiff } from "../../packages/broker/src/core/decisions/change-tier.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const PLAN = "b".repeat(64);
const AT = "2026-11-13T12:00:00.000Z";
const KEY = workflowTaskKey(TASK);

function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-09T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: PLAN, producer: "agentx-planner", objectKey: `tasks/${TASK}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" },
  });
}
const flowWith = (head: string): WorkflowFlow => recordTier(undefined, tierFromDiff({ files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }], complete: true }, { headSha: head.repeat(40), at: AT })).flow;
async function storeWith(workflow: WorkflowSnapshot): Promise<MemoryDocumentStore> {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...KEY, orgId: IMPLICIT_COMPANY_ID, project: "web", workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  return store;
}
const storedFlow = async (store: MemoryDocumentStore): Promise<unknown> => ((await store.get(KEY))!["workflow"] as { flow?: unknown }).flow;

describe("workflowWriteOps", () => {
  it("writes nothing for a workflow that did not change, and one key for one change", () => {
    const current = waiting();
    expect(workflowWriteOps(current, current).ops).toEqual([]);
    expect(workflowWriteOps(current, { ...current, updatedAt: "2026-11-09T11:00:00.000Z" }).ops).toEqual([change.set(["workflow", "updatedAt"], "2026-11-09T11:00:00.000Z")]);
  });
  it("removes a key the writer dropped, and leaves `flow` alone when the writer did not change it", () => {
    const current = { ...waiting(), flow: flowWith("a") };
    const { blockReason: _gone, ...without } = { ...current, blockReason: "x" };
    void _gone;
    expect(workflowWriteOps({ ...current, blockReason: "x" }, without as WorkflowSnapshot).ops).toEqual([change.remove(["workflow", "blockReason"])]);
    expect(workflowWriteOps(current, { ...current, updatedAt: "2026-11-09T11:00:00.000Z" }).ops.map((op) => (op as { path: string[] }).path.join("."))).toEqual(["workflow.updatedAt"]);
  });
  it("sets `flow` under a fence on the record read only when the writer owns it and changed it", () => {
    const current = { ...waiting(), flow: flowWith("a") };
    const next = { ...current, flow: flowWith("b") };
    expect(workflowWriteOps(current, next).ops).toEqual([]);
    const owned = workflowWriteOps(current, next, { ownsFlow: true });
    expect(owned.ops).toHaveLength(1);
    expect(owned.guard).toEqual([flowIs(current.flow)]);
  });
  it("writes the whole workflow when the writer has not read one", () => {
    const next = waiting();
    expect(workflowWriteOps(undefined, next).ops).toHaveLength(1);
  });
});

describe("a whole-workflow writer that read the task before the record was written", () => {
  it("workflowUpdateItem: the stored record is carried forward and the write is not refused for it", async () => {
    const stale = waiting();
    const store = await storeWith(stale);
    // A tier write lands after the stale writer read the task (no revision move).
    const recorded = flowWith("c");
    await store.update({ key: KEY, ops: [change.set(["workflow", "flow"], JSON.parse(JSON.stringify(recorded)) as never)], condition: when.and(when.eq(["workflow", "revision"], stale.revision), flowIs(undefined)) });
    const next = { ...stale, revision: stale.revision + 1, updatedAt: "2026-11-09T11:00:00.000Z" };
    const written = await store.transact([workflowUpdateItem(TASK, next, stale.revision, stale)]);
    expect(written.applied).toBe(true);
    expect(((await store.get(KEY))!["workflow"] as { revision: number }).revision).toBe(stale.revision + 1);
    expect(await storeFlow(store)).toEqual(JSON.parse(JSON.stringify(recorded)));
  });
  it("workflowUpdateItem: a writer that changes `flow` from a stale read is refused", async () => {
    const stale = waiting();
    const store = await storeWith(stale);
    await store.update({ key: KEY, ops: [change.set(["workflow", "flow"], JSON.parse(JSON.stringify(flowWith("c"))) as never)], condition: when.eq(["workflow", "revision"], stale.revision) });
    const next = { ...stale, flow: flowWith("d") };
    expect((await store.transact([workflowUpdateItem(TASK, next, stale.revision, stale)])).applied).toBe(false);
    expect(await storeFlow(store)).toEqual(JSON.parse(JSON.stringify(flowWith("c"))));
  });
  it("the plan decision (workflow-subject): the approval is written and the stored record is kept", async () => {
    const store = await storeWith(waiting());
    const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low" });
    const loaded = (await subject.load(IMPLICIT_COMPANY_ID, TASK))!;
    // The record is written after the subject loaded the task.
    const recorded = flowWith("e");
    await store.update({ key: KEY, ops: [change.set(["workflow", "flow"], JSON.parse(JSON.stringify(recorded)) as never)], condition: when.eq(["workflow", "revision"], waiting().revision) });
    const attempt = { companyId: IMPLICIT_COMPANY_ID, kind: subject.kind, subjectId: TASK, requestId: "11111111-1111-4111-8111-111111111111", outcome: "approve" as const, seen: { revision: waiting().revision, artifactDigest: PLAN }, credentials: [], details: {} };
    const applied = await subject.apply(loaded, attempt, [localOwnerPrincipal({ companyId: IMPLICIT_COMPANY_ID })], "2026-11-09T10:05:00.000Z");
    const result = await store.update({ key: KEY, ops: applied.ops, condition: loaded.guard });
    expect(result.applied).toBe(true);
    expect(((await store.get(KEY))!["workflow"] as { decisions: unknown[] }).decisions.length).toBeGreaterThan(0);
    expect(await storeFlow(store)).toEqual(JSON.parse(JSON.stringify(recorded)));
  });
});

const storeFlow = storedFlow;
