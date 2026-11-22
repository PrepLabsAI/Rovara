import type * as InvocationModule from "../../packages/broker/src/core/work-breakdown/invocation.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { change, taskGraphDigest, type WorkflowDependencyInvocation } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";

const invocations = vi.hoisted(() => ({ first: vi.fn(), resume: vi.fn() }));
vi.mock("../../packages/broker/src/core/work-breakdown/invocation.js", async importOriginal => ({
  ...await importOriginal<typeof InvocationModule>(),
  firstGraphInvocation: invocations.first, resumeGraphInvocation: invocations.resume,
}));

for (const mode of ["first", "resumed", "absent", "absent-restart", "no-application-selection"] as const) it(`selects the ${mode} ordered-work invocation before coding`, async () => {
  const h = createHarness(); await h.registerProject();
  const start = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Code", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, start.task.taskId))!;
  const bytes = Buffer.from("# Owner approved plan\n"); const digest = createHash("sha256").update(bytes).digest("hex");
  const at = new Date(h.clock.now).toISOString();
  const artifact = { id: "plan", type: "plan" as const, version: 1, sha256: digest, objectKey: "plan.md", producer: "planner", createdAt: at };
  const graph = { schemaVersion: 1 as const, taskId: task.taskId, version: 1, items: [{ id: newRequestId(), title: "Build", description: "Build", repository: "demo", dependsOn: [] }] };
  const approval = { artifactId: artifact.id, artifactDigest: digest, graphDigest: taskGraphDigest(graph), runId: newRequestId(), workflowRevision: 2, actorId: task.ownerKey };
  const invocation: WorkflowDependencyInvocation = { graph, approval, peopleRevision: 0, sequenceStart: 0 };
  const first = mode === "first" || mode === "no-application-selection";
  const workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "IMPLEMENT" as const, state: "READY" as const, artifacts: [artifact],
    decisions: [{ requestId: newRequestId(), workflowRevision: 2, decision: "APPROVE" as const, artifactDigest: digest, actorId: task.ownerKey, actorRole: "TASK_OWNER" as const, reason: "approved", at },
      ...(mode === "absent-restart" ? [{ requestId: newRequestId(), workflowRevision: task.workflow!.revision, decision: "REQUEST_CHANGES" as const, artifactDigest: digest, actorId: task.ownerKey, actorRole: "TASK_OWNER" as const, source: "SEND_BACK" as const, reason: "Code it again", at }] : [])],
    workflowDependenciesApproval: approval, ...(first ? {} : { workflowDependenciesOperationId: newRequestId() }),
    ...(mode === "no-application-selection" ? { e2e: { required: true as const, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [] } } : {}) };
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
  const location = await workspaceKeys(h.deps, task.workspaceId);
  await h.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  h.deps.artifacts = { get: async () => bytes };
  invocations.first.mockReset().mockResolvedValue({ invocation });
  invocations.resume.mockReset().mockResolvedValue(mode.startsWith("absent") ? undefined : invocation);
  if (mode === "no-application-selection") vi.spyOn(h.deps.projects, "revision").mockRejectedValue(new Error("baseline catalog unavailable"));
  expect(await startImplementation(h.deps, { taskId: task.taskId, workflowRevision: workflow.revision })).toBe("STARTED");
  expect(invocations.first).toHaveBeenCalledTimes(first ? 1 : 0);
  expect(invocations.resume).toHaveBeenCalledTimes(first ? 0 : 1);
  const operation = (await workspaceOperations(h.deps, task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  if (mode.startsWith("absent")) expect(operation.workflowDependencies).toBeUndefined();
  else expect(operation.workflowDependencies).toEqual(invocation);
});
