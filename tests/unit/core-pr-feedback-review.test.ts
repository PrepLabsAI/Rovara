import { expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { feedbackWorld } from "../support/pr-feedback-world.js";
import { collectPrFeedback } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { createBuildSteps } from "../../packages/broker/src/core/build-step/index.js";

it("starts exact collecting REVIEW as a read-only critic with its operation and outbox together", async () => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const row = { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" as const };
  expect(await createBuildSteps().runRow(w.h.deps, row)).toBe("STARTED");
  const operations = await workspaceOperations(w.h.deps, task.workspaceId);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ workflowMode: "FEEDBACK_REVIEW", workflowFeedbackReview: { taskId: task.taskId, candidateDigest: task.workflow!.candidate!.digest },
    dispatch: { extraActions: ["feedback-bundles"] } });
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.state).toBe("RUNNING");
  expect(await createBuildSteps().runRow(w.h.deps, row)).toBe("STALE");
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toHaveLength(1);
});

it.each(["wrong-revision", "cross-stage", "closed"])("stale %s REVIEW never starts either reviewer", async kind => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const row = { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" as const };
  if (kind === "wrong-revision") row.workflowRevision--;
  if (kind === "cross-stage") await w.h.store.update({ key: { pk: task.pk, sk: task.sk }, ops: [change.set(["workflow", "stage"], "IMPLEMENT")] });
  if (kind === "closed") await w.h.store.update({ key: { pk: task.pk, sk: task.sk }, ops: [change.set("closedAt", new Date(w.clock.ms).toISOString())] });
  expect(await createBuildSteps().runRow(w.h.deps, row)).toBe("STALE");
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toHaveLength(0);
});

it("missing collected bytes produces an actionable failed card with no paid dispatch", async () => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  w.objects.clear();
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  const next = (await readTask(w.h.deps, task.taskId))!.workflow!;
  expect(next).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED" } } });
  expect(admit).not.toHaveBeenCalled();
});

it.each(["operation", "task", "revision", "proposal", "requirements", "candidate-binding", "finding-refs"])("a critic report with wrong %s settles as an actionable failure", async kind => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld("COMPLETE", report => {
    if (kind === "operation") report.operationId = "99999999-9999-4999-8999-999999999999";
    if (kind === "task") report.taskId = "99999999-9999-4999-8999-999999999999";
    if (kind === "revision") report.workflowRevision++;
    if (kind === "proposal") report.proposalDigest = "0".repeat(64);
    if (kind === "requirements") report.taskRequirementsDigest = "0".repeat(64);
    if (kind === "candidate-binding") report.candidateBindings[0]!.headSha = "0".repeat(40);
    if (kind === "finding-refs") report.findingRefs = [];
  });
  expect(w.task.workflow).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { status: "BLOCKED" } } });
});

it.each(["busy-workspace", "missing-stamp", "expired-queue"])("critic admission handles %s before paid work", async kind => {
  const { PR_FEEDBACK_REVIEW_DEADLINE_MS } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const { engineStampKey } = await import("../../packages/broker/src/core-host/engine-stamp.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "busy-workspace") await w.h.store.update({ key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }, ops: [change.set("status", "PREPARING"), change.set("activeOperationId", "99999999-9999-4999-8999-999999999999")] });
  if (kind === "missing-stamp") await w.h.store.delete({ key: engineStampKey(task.taskId) });
  if (kind === "expired-queue") w.h.clock.advance(PR_FEEDBACK_REVIEW_DEADLINE_MS / 1000);
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" })).toBe(kind === "busy-workspace" ? "WAITING" : "STALE");
  expect(admit).not.toHaveBeenCalled();
});

it.each(["result-task", "unregistered-artifact", "artifact-address", "artifact-operation", "digest", "invalid-utf8", "result-status", "too-large"])("critic settlement rejects %s provenance", async kind => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const { corruptReplacementByte } = await import("../support/pr-feedback-world.js");
  const { feedbackDigest } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await reviewedFeedbackWorld("COMPLETE", report => {
    if (kind !== "invalid-utf8") return;
    report.findings[0]!.rationale = "\uFFFD";
    report.proposalDigest = feedbackDigest(JSON.stringify({ taskRequirementsDigest: report.taskRequirementsDigest, candidateBindings: report.candidateBindings, findings: report.findings }));
  }, async (world, operation, result) => {
    const artifactName = String(result["artifactName"]);
    const key = { pk: operation.pk, sk: `ARTIFACT#${operation.id}#${artifactName}` };
    const objectKey = `workspaces/${operation.workspaceId}/operations/${operation.id}/${artifactName}`;
    if (kind === "result-task") result["taskId"] = "99999999-9999-4999-8999-999999999999";
    if (kind === "result-status") result["status"] = "BLOCKED";
    if (kind === "unregistered-artifact") await world.h.store.delete({ key });
    if (kind === "artifact-address") await world.h.store.update({ key, ops: [change.set("objectKey", "another-operation/report.json")] });
    if (kind === "artifact-operation") await world.h.store.update({ key, ops: [change.set("operationId", "99999999-9999-4999-8999-999999999999")] });
    if (kind === "digest") world.objects.set(objectKey, Buffer.from(`\n${Buffer.from(world.objects.get(objectKey)!).toString("utf8")}`));
    if (kind === "invalid-utf8") world.objects.set(objectKey, corruptReplacementByte(world.objects.get(objectKey)!));
    if (kind === "too-large") {
      const bytes = Buffer.from(" ".repeat(1_000_001) + Buffer.from(world.objects.get(objectKey)!).toString("utf8"));
      const digest = feedbackDigest(bytes), name = `workflow-feedback-review-${digest}.json`;
      const nextKey = `workspaces/${operation.workspaceId}/operations/${operation.id}/${name}`;
      const saved = (await world.h.store.get(key))!;
      await world.h.store.put({ item: { ...saved, sk: `ARTIFACT#${operation.id}#${name}`, operationId: operation.id, objectKey: nextKey } });
      const reader = world.h.deps.artifacts!.get.bind(world.h.deps.artifacts);
      world.h.deps.artifacts = { get: (path, max) => path === nextKey ? Promise.resolve(bytes) : reader(path, max) };
      result["outputDigest"] = digest; result["artifactName"] = name;
    }
  });
  expect(w.task.workflow!.feedbackReview).toMatchObject({ status: "PENDING", reviewRef: { status: "BLOCKED", provider: "broker-lifecycle" } });
});

it("unknown live spend ends a queued critic before any worker operation", async () => {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  w.h.deps.taskCapUsd = async () => 10;
  w.h.deps.taskSpendUsd = async () => undefined;
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" })).toBe("STALE");
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.feedbackReview).toMatchObject({ status: "PENDING", reviewRef: { status: "BLOCKED" } });
  expect((await workspaceOperations(w.h.deps, task.workspaceId)).every(op => op.status === "FAILED")).toBe(true);
});

it.each(["stopped", "stale-revision", "retired"])("a %s critic's otherwise valid late report cannot become a complete owner card", async kind => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const { recordPrFeedbackReview } = await import("../../packages/broker/src/core/pr-feedback/review.js");
  const { toDocument } = await import("../../packages/broker/src/core/task-flow/records.js");
  const w = await reviewedFeedbackWorld();
  const task = { ...w.task, workflow: { ...w.task.workflow!, revision: w.operation.workflowRevision!, state: "RUNNING" as const,
    feedbackReview: { status: "COLLECTING" as const, bundleRefs: w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] } } };
  if (kind === "stale-revision") task.workflow.revision++;
  if (kind === "retired") await w.h.store.delete({ key: { pk: `TASK_ENGINE#${task.taskId}`, sk: "STAMP" } });
  await w.h.store.put({ item: toDocument(task) });
  const artifact = (await w.h.store.query({ pk: w.operation.pk, sk: { op: "beginsWith", prefix: `ARTIFACT#${w.operation.id}#` } })).items[0]!;
  const artifactName = typeof artifact["name"] === "string" ? artifact["name"] : "";
  const digest = artifactName.match(/[a-f0-9]{64}/)![0];
  await expect(recordPrFeedbackReview(w.h.deps, task, { ...w.operation, ...(kind === "stopped" ? { stopRequestedAt: new Date(w.clock.ms).toISOString() } : {}) }, { status: "SUCCEEDED",
    outcome: { kind: "reviewed", result: { workflowFeedbackReviewResult: { ...w.operation.workflowFeedbackReview, outputDigest: digest, artifactName, status: "COMPLETE" } } } })).resolves.toBeUndefined();
  const next = (await readTask(w.h.deps, task.taskId))!.workflow!;
  if (kind === "stopped") expect(next.feedbackReview).toMatchObject({ status: "PENDING", reviewRef: { status: "BLOCKED" } });
  else expect(next).toEqual(task.workflow);
});
