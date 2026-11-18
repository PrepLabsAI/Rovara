import { expect, it } from "vitest";
import { change, projectMetaKey, type JsonValue } from "@agentx/contracts";
import { setupBrokenTaskWords, driftTaskKey, recheckRowKey } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { closeSetupCheck, startProjectSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";

it("resumes the exact setup pause when a current human check passes", async () => {
  const h = createHarness();
  const project = { ...definition, name: "payments" };
  await h.registerProject(project);
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, "payments"), entityType: "PROJECT_META" } });
  const task = (await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "change", workflow: true, workflowPath: "QUICK" })).task;
  const brokenStep = "setup: npm ci failed";
  await h.store.update({ key: projectMetaKey(h.deps.companyId, "payments"), ops: [change.set("setupCheck", { workspaceId: "failed-check", revision: 1, startedAt: "2026-11-16T10:00:00.000Z", startedBy: "system" })] });
  await h.store.put({ item: { ...driftTaskKey(h.deps.companyId, "payments", task.taskId), entityType: "SETUP_DRIFT_TASK", orgId: h.deps.companyId, project: "payments", taskId: task.taskId, recheckKey: "broken", state: "pending", at: "2026-11-16T10:00:00.000Z" } });
  await h.store.put({ item: toDocument({ ...recheckRowKey(h.deps.companyId, "payments", "broken"), entityType: "SETUP_RECHECK", orgId: h.deps.companyId, project: "payments", key: "broken", setupRevision: 1, commits: {}, classes: ["lockfile"], state: "broken", attempt: 2, check: { workspaceId: "failed-check", revision: 1, startedAt: "2026-11-16T10:00:00.000Z", startedBy: "system" }, startedAt: "2026-11-16T10:00:00.000Z", failedStep: brokenStep }) });
  const record = (await readTask(h.deps, task.taskId))!;
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", { ...record.workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: setupBrokenTaskWords(brokenStep) } as unknown as JsonValue)] });

  const check = await startProjectSetupCheck(h.deps, { project: "payments", requestId: newRequestId(), startedBy: "owner" });
  await h.store.update({ key: workspaceKey(h.deps.companyId, check.workspaceId), ops: [change.set("status", "READY")] });
  await closeSetupCheck(h.deps, check.workspaceId);

  expect((await readTask(h.deps, task.taskId))?.workflow?.state).toBe("READY");
  expect((await h.store.get(driftTaskKey(h.deps.companyId, "payments", task.taskId)))?.["resumedSetupRevision"]).toBe(1);
});
