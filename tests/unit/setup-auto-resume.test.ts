import { describe, expect, it } from "vitest";
import { change, IMPLICIT_COMPANY_ID, projectMetaKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { resumeSetupPausedTasks } from "../../packages/broker/src/core/setup-agent/auto-resume.js";
import { setupBrokenTaskWords, driftTaskKey, recheckRowKey, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { dispatchRowKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { startProjectSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";

const COMPANY_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const FAILED_STEP = "setup: npm ci failed";
const approved = (revision: number) => ({ kind: "approved" as const, revision });

async function setupPaused(h: Awaited<ReturnType<typeof createHarness>>, projectName = "payments") {
  await h.registerProject({ ...definition, name: projectName });
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, projectName), entityType: "PROJECT_META" } });
  const task = (await h.flow.start(h.owner, { requestId: newRequestId(), project: projectName, instructions: "Change a thing", workflow: true, workflowPath: "QUICK" })).task;
  const record = (await readTask(h.deps, task.taskId))!;
  await h.store.update({ key: projectMetaKey(h.deps.companyId, projectName), ops: [change.set("setupCheck", { workspaceId: "failed-check", revision: 1, startedAt: "2026-11-16T10:00:00.000Z", startedBy: "system" })] });
  const link = { entityType: "SETUP_DRIFT_TASK", orgId: h.deps.companyId, project: projectName, taskId: task.taskId, recheckKey: "failed-recheck", state: "pending", at: "2026-11-16T10:00:00.000Z" };
  const row: RecheckRow = { entityType: "SETUP_RECHECK", orgId: h.deps.companyId, project: projectName, key: "failed-recheck", setupRevision: 1, commits: {}, classes: ["lockfile"], state: "broken", attempt: 2, check: { workspaceId: "failed-check", revision: 1, startedAt: "2026-11-16T10:00:00.000Z", startedBy: "system" }, startedAt: "2026-11-16T10:00:00.000Z", failedStep: FAILED_STEP };
  await h.store.put({ item: { ...driftTaskKey(h.deps.companyId, projectName, task.taskId), ...link } });
  await h.store.put({ item: toDocument({ ...recheckRowKey(h.deps.companyId, projectName, row.key), ...row }) });
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", { ...record.workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: setupBrokenTaskWords(FAILED_STEP) } as unknown as JsonValue)] });
  return task;
}

describe("setup auto resume", () => {
  it("resumes a setup-paused task once when its setup revision is approved, with the fixed timeline line", async () => {
    const h = createHarness();
    const task = await setupPaused(h);
    await h.registerProject({ ...definition, name: "payments", revision: 2 });
    await resumeSetupPausedTasks(h.deps, "payments", approved(2));
    const resumed = (await readTask(h.deps, task.taskId))!;
    expect(resumed.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY" });
    expect(resumed.workflow).not.toHaveProperty("blockReason");
    expect(resumed.workflow!.revision).toBeGreaterThan(task.workflow!.revision);
    expect((await h.store.get(driftTaskKey(h.deps.companyId, "payments", task.taskId)))?.["resumedSetupRevision"]).toBe(2);
    expect((await h.store.get(dispatchRowKey(h.deps.companyId, task.taskId, resumed.workflow!.revision)))?.["firstEvent"]).toBe("Setup fixed, continuing");
    await resumeSetupPausedTasks(h.deps, "payments", approved(2));
    expect((await readTask(h.deps, task.taskId))?.workflow?.revision).toBe(resumed.workflow!.revision);
  });

  it("uses the revision marker when the same task is paused again with the same reason", async () => {
    const h = createHarness();
    const task = await setupPaused(h);
    await h.registerProject({ ...definition, name: "payments", revision: 2 });
    await resumeSetupPausedTasks(h.deps, "payments", approved(2));
    const resumed = (await readTask(h.deps, task.taskId))!;
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", { ...resumed.workflow, revision: resumed.workflow!.revision + 100, state: "BLOCKED", blockReason: setupBrokenTaskWords(FAILED_STEP) } as unknown as JsonValue)] });
    await resumeSetupPausedTasks(h.deps, "payments", approved(2));
    expect((await readTask(h.deps, task.taskId))?.workflow?.revision).toBe(resumed.workflow!.revision + 100);
    expect((await h.store.get(dispatchRowKey(h.deps.companyId, task.taskId, resumed.workflow!.revision)))?.["firstEvent"]).toBe("Setup fixed, continuing");
  });

  it("commits exactly one resume when two approvals race", async () => {
    const h = createHarness();
    const task = await setupPaused(h);
    await h.registerProject({ ...definition, name: "payments", revision: 2 });
    const results = await Promise.all([resumeSetupPausedTasks(h.deps, "payments", approved(2)), resumeSetupPausedTasks(h.deps, "payments", approved(2))]);
    const resumed = (await readTask(h.deps, task.taskId))!;
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(resumed.workflow!.revision).toBe(task.workflow!.revision + 1);
    expect((await h.store.get(driftTaskKey(h.deps.companyId, "payments", task.taskId)))?.["resumedSetupRevision"]).toBe(2);
    expect((await h.store.get(dispatchRowKey(h.deps.companyId, task.taskId, resumed.workflow!.revision)))?.["firstEvent"]).toBe("Setup fixed, continuing");
  });

  it("does not resume a stopped task or a task paused for another reason", async () => {
    const h = createHarness();
    const stopped = await setupPaused(h);
    await h.store.update({ key: taskKey(stopped.taskId), ops: [change.set("closedAt", "2026-11-16T11:00:00.000Z")] });
    const stopRequested = await setupPaused(h, "stop-requested");
    await h.store.update({ key: taskKey(stopRequested.taskId), ops: [change.set("stopRequest", { requestedAt: "2026-11-16T11:00:00.000Z" })] });
    const other = await setupPaused(h, "billing");
    await h.registerProject({ ...definition, name: "payments", revision: 2 });
    await h.registerProject({ ...definition, name: "billing", revision: 2 });
    const otherRecord = (await readTask(h.deps, other.taskId))!;
    await h.store.update({ key: taskKey(other.taskId), ops: [change.set("workflow", { ...otherRecord.workflow, blockReason: "another pause" } as unknown as JsonValue)] });
    await resumeSetupPausedTasks(h.deps, "payments", approved(2));
    await resumeSetupPausedTasks(h.deps, "billing", approved(2));
    expect((await readTask(h.deps, stopped.taskId))?.workflow?.state).toBe("BLOCKED");
    expect((await readTask(h.deps, stopRequested.taskId))?.workflow?.state).toBe("BLOCKED");
    expect((await readTask(h.deps, other.taskId))?.workflow?.blockReason).toBe("another pause");
    expect((await h.store.get(driftTaskKey(h.deps.companyId, "payments", stopped.taskId)))?.["resumedSetupRevision"]).toBeUndefined();
    expect((await h.store.get(driftTaskKey(h.deps.companyId, "stop-requested", stopRequested.taskId)))?.["resumedSetupRevision"]).toBeUndefined();
  });

  it("keeps same-named tasks in another company and project out of the resume", async () => {
    const sharedStore = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
    const a = createHarness({ companyId: IMPLICIT_COMPANY_ID, backend: () => ({ store: sharedStore, queues: new MemoryQueueService() }) });
    const b = createHarness({ companyId: COMPANY_B, backend: () => ({ store: sharedStore, queues: new MemoryQueueService() }) });
    const taskA = await setupPaused(a);
    const taskB = await setupPaused(b);
    const taskOtherProject = await setupPaused(a, "other-project");
    await a.registerProject({ ...definition, name: "payments", revision: 2 });
    await b.registerProject({ ...definition, name: "payments", revision: 2 });
    await b.registerProject({ ...definition, name: "other-project", revision: 2 });
    await resumeSetupPausedTasks(b.deps, "payments", approved(2));
    expect((await readTask(a.deps, taskA.taskId))?.workflow?.state).toBe("BLOCKED");
    expect((await readTask(b.deps, taskB.taskId))?.workflow?.state).toBe("READY");
    expect((await readTask(a.deps, taskOtherProject.taskId))?.workflow?.state).toBe("BLOCKED");
    await resumeSetupPausedTasks(a.deps, "payments", approved(2));
    expect((await readTask(a.deps, taskA.taskId))?.workflow?.state).toBe("READY");
    expect((await readTask(b.deps, taskB.taskId))?.workflow?.state).toBe("READY");
    expect((await readTask(a.deps, taskOtherProject.taskId))?.workflow?.state).toBe("BLOCKED");
    expect((await b.store.get(driftTaskKey(COMPANY_B, "payments", taskB.taskId)))?.["resumedSetupRevision"]).toBe(2);
  });

  it("resumes on a person's passing setup check only after that check is current and ready", async () => {
    const h = createHarness();
    const task = await setupPaused(h);
    const started = await startProjectSetupCheck(h.deps, { project: "payments", requestId: newRequestId(), startedBy: "owner" });
    await h.store.update({ key: workspaceKey(h.deps.companyId, started.workspaceId), ops: [change.set("status", "READY")] });
    await resumeSetupPausedTasks(h.deps, "payments", { kind: "check_passed", revision: 1, workspaceId: started.workspaceId });
    expect((await readTask(h.deps, task.taskId))?.workflow?.state).toBe("READY");
    expect((await h.store.get(driftTaskKey(h.deps.companyId, "payments", task.taskId)))?.["resumedSetupRevision"]).toBe(1);
  });
});
