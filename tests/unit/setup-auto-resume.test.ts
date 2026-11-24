import { describe, expect, it } from "vitest";
import { change, projectMetaKey, type JsonValue } from "@agentx/contracts";
import { resumeSetupPausedTasks } from "../../packages/broker/src/core/setup-agent/auto-resume.js";
import { setupBrokenTaskWords, driftTaskKey, recheckRowKey, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { dispatchRowKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";

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

  it("DEC 254zzz447: with no pauses there is nothing to resume: a task that went on under the break (link released, not blocked) and a project with no links are left exactly as they are", async () => {
    const h = createHarness();
    const task = await setupPaused(h);
    // The task went on under the warning instead of pausing: its link was let through and its workflow is not blocked.
    const { blockReason: _reason, ...unblocked } = (await readTask(h.deps, task.taskId))!.workflow!;
    void _reason;
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", { ...unblocked, stage: "IMPLEMENT", state: "RUNNING" } as unknown as JsonValue)] });
    await h.store.update({ key: driftTaskKey(h.deps.companyId, "payments", task.taskId), ops: [change.set("state", "released")] });
    await h.registerProject({ ...definition, name: "payments", revision: 2 });
    const before = (await readTask(h.deps, task.taskId))!.workflow!;
    expect(await resumeSetupPausedTasks(h.deps, "payments", approved(2))).toBe(0);
    expect(await resumeSetupPausedTasks(h.deps, "payments", { kind: "check_passed", revision: 2, workspaceId: "nothing" })).toBe(0);
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(before);
    // A pending link whose task is not paused is skipped too, and a project with no links at all answers 0.
    await h.store.update({ key: driftTaskKey(h.deps.companyId, "payments", task.taskId), ops: [change.set("state", "pending")] });
    expect(await resumeSetupPausedTasks(h.deps, "payments", approved(2))).toBe(0);
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(before);
    await h.registerProject({ ...definition, name: "quiet" });
    await h.registerProject({ ...definition, name: "quiet", revision: 2 });
    expect(await resumeSetupPausedTasks(h.deps, "quiet", approved(2))).toBe(0);
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

});
