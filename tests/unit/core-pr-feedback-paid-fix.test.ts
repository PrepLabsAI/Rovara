import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { expect, it, vi } from "vitest";
import { change, WorkflowFeedbackApprovalBindingSchema, type CodeHost } from "@agentx/contracts";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { decidePrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { feedbackFixContext, requireSafeFeedbackSelection, validateFeedbackApproval } from "../../packages/broker/src/core/pr-feedback/fix-context.js";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";

it("the selected fix and later review exclude every unselected finding and comment", async () => {
  const { rewriteFeedbackReport } = await import("../support/pr-feedback-world.js");
  const { feedbackForReview } = await import("../../packages/broker/src/core/pr-feedback/fix-context.js");
  const w = await reviewedFeedbackWorld("COMPLETE", undefined, undefined, input => {
    for (const id of ["comment-2", "comment-3"]) input.feedback.comments.push({ ...input.feedback.comments[0]!, id, url: `${input.feedback.changeRequest.ref.url}#${id}`, body: "UNSELECTED_COMMENT_2" + "x".repeat(40_000) });
  });
  await rewriteFeedbackReport(w, report => { report.findings.push({ ...report.findings[0]!, id: "finding-2", commentIds: ["comment-2", "comment-3"],
    fixProposal: { ...report.findings[0]!.fixProposal!, summary: "UNSELECTED_FINDING_2" } }); });
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  expect(operation.workflowFeedbackApproval!.selectedFindingIds).toEqual(["finding-1"]);
  expect(operation.dispatch.payload["prompt"]).not.toContain("UNSELECTED_FINDING_2");
  expect(operation.dispatch.payload["prompt"]).not.toContain("UNSELECTED_COMMENT_2");
  const context = await feedbackForReview(w.h.deps, task);
  expect(JSON.stringify(context)).toContain("Add a bounded retry.");
  expect(JSON.stringify(context)).not.toContain("UNSELECTED_FINDING_2");
});

it("an empty selected fix is refused even before an approval binding is constructed", async () => {
  const w = await reviewedFeedbackWorld();
  expect(() => requireSafeFeedbackSelection(w.task, [])).toThrow();
});

it("an oversized report is refused even when the storage adapter ignores its read bound", async () => {
  const { feedbackDigest, feedbackReportPrefix } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const { readFeedbackReportArtifact } = await import("../../packages/broker/src/core/pr-feedback/validate.js");
  const w = await reviewedFeedbackWorld();
  const bytes = Buffer.from(" ".repeat(1_000_001) + JSON.stringify(w.report));
  const sha256 = feedbackDigest(bytes);
  const ref = { ...w.task.workflow!.feedbackReview!.reviewRef!, sha256, objectKey: `${feedbackReportPrefix(w.task)}${sha256}.json` };
  w.h.deps.artifacts = { get: async () => bytes };
  await expect(readFeedbackReportArtifact(w.h.deps, w.task, ref)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it.each(["not-approved", "long-note", "changed-head", "changed-comments", "wrong-mode", "changed-selection", "missing-host-port"])("paid execution rechecks %s after the owner decision", async kind => {
  const w = await reviewedFeedbackWorld();
  if (kind === "changed-selection") {
    const { rewriteFeedbackReport } = await import("../support/pr-feedback-world.js");
    await rewriteFeedbackReport(w, report => { report.findings.push({ ...report.findings[0]!, id: "finding-2" }); });
  }
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  let task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "wrong-mode" || kind === "changed-selection") {
    await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision });
    task = (await readTask(w.h.deps, task.taskId))!;
    const operation = (await workspaceOperations(w.h.deps, task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
    if (kind === "wrong-mode") operation.workflowMode = "CHECKS";
    else {
      task.workflow!.feedbackDecisions!.at(-1)!.selectedFindingIds = ["finding-2"];
      await w.h.store.put({ item: toDocument(task) });
    }
    await expect(validateFeedbackApproval(w.h.deps, operation, operation.workflowFeedbackApproval!)).rejects.toMatchObject({ code: "STALE_FENCE" });
    return;
  }
  if (kind === "not-approved") task.workflow!.feedbackReview!.status = "PENDING";
  if (kind === "long-note") task.workflow!.feedbackDecisions!.at(-1)!.ownerNote = "x".repeat(501);
  if (kind === "changed-head") w.feedback.changeRequest.headRevision = "f".repeat(40);
  if (kind === "changed-comments") task.workflow!.feedbackDecisions!.at(-1)!.selectedCommentIds = ["other-comment"];
  if (kind === "missing-host-port") delete w.h.deps.codeHosts;
  const result = feedbackFixContext(w.h.deps, task, task.workflow!.revision + 1);
  if (kind === "changed-head") await expect(result).rejects.toBeDefined();
  else await expect(result).rejects.toMatchObject({ code: kind === "changed-comments" ? "CALLBACK_FORBIDDEN" : kind === "missing-host-port" ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID" });
});

it("ordinary coding still starts and delivers without a feedback approval", async () => {
  const w = await reviewedFeedbackWorld();
  w.task.workflow = { ...w.task.workflow!, stage: "IMPLEMENT", state: "READY", fixSource: undefined,
    feedbackReview: undefined, feedbackReviewHistory: undefined, feedbackDecisions: undefined };
  await w.h.store.put({ item: toDocument(w.task) });
  expect(await startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.task.workflow.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  expect(operation.workflowFeedbackApproval).toBeUndefined();
  expect(operation.dispatch.payload["workflowFeedbackApproval"]).toBeUndefined();
  expect(operation.dispatch.payload["prompt"]).not.toContain("Add a bounded retry.");
  const start = vi.spyOn(w.h.machines, "start");
  await runDispatchOnce(w.h.deps);
  expect(start).toHaveBeenCalledOnce();
});

it("an approved fix carries only the owner's selected proposal and uses the original task payer", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  expect(await startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  const binding = WorkflowFeedbackApprovalBindingSchema.parse(operation.workflowFeedbackApproval);
  expect(binding.selectedFindingIds).toEqual(["finding-1"]);
  expect(binding.selectedCommentIds).toEqual(["comment-1"]);
  expect(operation.dispatch.payload["prompt"]).toContain("Add a bounded retry.");
  expect(operation.dispatch.payload["workflowFix"]).toMatchObject({ source: "feedback", startFrom: w.task.workflow!.pullRequests![0]!.headSha });
  expect((await readTask(w.h.deps, w.task.taskId))!.charge).toEqual(w.task.charge);
  await expect(validateFeedbackApproval(w.h.deps, operation, binding)).resolves.toBeUndefined();
  const current = (await readTask(w.h.deps, w.task.taskId))!;
  await w.h.store.update({ key: current, ops: [change.set(["workflow", "revision"], current.workflow!.revision + 1)] });
  await expect(validateFeedbackApproval(w.h.deps, operation, binding)).rejects.toBeDefined();
});

it("approval revocation before delivery starts no machine or model", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  await startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision });
  w.h.deps.access.ownerActing = async () => undefined;
  const start = vi.spyOn(w.h.machines, "start");
  await runDispatchOnce(w.h.deps);
  expect(start).not.toHaveBeenCalled();
  const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  expect(operation.status).toBe("FAILED");
});

it("a co-owner's selected fix preserves the task owner binding and records the actual decider", async () => {
  const w = await reviewedFeedbackWorld();
  const actorId = "c".repeat(64);
  w.h.deps.access.ownerActing = async () => ({ actorId, authority: { actorId, ownerIds: [actorId] } });
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision });
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  expect(operation.workflowFeedbackApproval!.ownerId).toBe(task.ownerKey);
  expect(task.workflow!.feedbackDecisions!.at(-1)!.actorId).toBe(actorId);
  await expect(validateFeedbackApproval(w.h.deps, operation, operation.workflowFeedbackApproval!)).resolves.toBeUndefined();
});

it("missing selected evidence cannot silently fall back to the original plan", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  w.objects.delete(approved.workflow!.feedbackReview!.reviewRef!.objectKey);
  await expect(startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision })).rejects.toBeDefined();
  expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter(op => op.workflowMode === "IMPLEMENT")).toHaveLength(0);
});

it.each(["missing-receipt", "changed-actor"])("delivery refuses %s with a specific authority refusal", async kind => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  if (kind === "missing-receipt") await w.h.store.delete({ key: { pk: `DEVTASK#${task.taskId}`, sk: `REQUEST#${w.request.requestId}` } });
  if (kind === "changed-actor") {
    const actorId = "c".repeat(64);
    w.h.deps.access.ownerActing = async () => ({ actorId, authority: { actorId, ownerIds: [actorId] } });
  }
  await expect(startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  expect((await workspaceOperations(w.h.deps, task.workspaceId)).filter(op => op.workflowMode === "IMPLEMENT")).toHaveLength(0);
});

it.each(["foreign-company", "foreign-key", "missing-ref", "digest", "invalid-utf8", "metadata"])("approval report reads refuse %s evidence", async kind => {
  const { readFeedbackReportArtifact } = await import("../../packages/broker/src/core/pr-feedback/validate.js");
  const w = await reviewedFeedbackWorld();
  if (kind === "invalid-utf8") {
    const { rewriteFeedbackReport } = await import("../support/pr-feedback-world.js");
    await rewriteFeedbackReport(w, report => { report.findings[0]!.rationale = "\uFFFD"; });
  }
  let ref = w.task.workflow!.feedbackReview!.reviewRef;
  if (kind === "foreign-company") w.task.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
  if (kind === "missing-ref") ref = undefined;
  if (kind === "foreign-key") {
    const bytes = w.objects.get(ref!.objectKey)!;
    ref = { ...ref!, objectKey: `private/other/workspace/${ref!.sha256}.json` };
    w.objects.set(ref.objectKey, bytes);
  }
  if (kind === "digest") w.objects.set(ref!.objectKey, Buffer.from(`\n${Buffer.from(w.objects.get(ref!.objectKey)!).toString("utf8")}`));
  if (kind === "metadata") ref = { ...ref!, provider: "another-provider" };
  if (kind === "invalid-utf8") {
    const { corruptReplacementByte } = await import("../support/pr-feedback-world.js");
    w.objects.set(ref!.objectKey, corruptReplacementByte(w.objects.get(ref!.objectKey)!));
  }
  await expect(readFeedbackReportArtifact(w.h.deps, w.task, ref)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("ordinary review context has no feedback override before an owner approval", async () => {
  const { feedbackForReview } = await import("../../packages/broker/src/core/pr-feedback/fix-context.js");
  const w = await reviewedFeedbackWorld();
  await expect(feedbackForReview(w.h.deps, w.task)).resolves.toBeUndefined();
});

it("the selected context packs fifty valid findings without truncation", async () => {
  const { reviewFeedbackContext } = await import("../../packages/broker/src/core/pr-feedback/fix-context.js");
  const w = await reviewedFeedbackWorld();
  const findings = Array.from({ length: 50 }, (_, i) => ({ ...w.report.findings[0]!, id: `finding-${i}` }));
  const context = reviewFeedbackContext(findings, undefined);
  expect(context).toHaveLength(2);
  expect(context.reduce((count, item) => count + item.fileChanges.length, 0)).toBe(50);
  for (const finding of findings) expect(context.some(item => item.summary.includes(`${finding.id}:`))).toBe(true);
});

it("selected context over the worker's twenty-entry envelope is refused", async () => {
  const { reviewFeedbackContext } = await import("../../packages/broker/src/core/pr-feedback/fix-context.js");
  const w = await reviewedFeedbackWorld();
  const finding = w.report.findings[0]!;
  const findings = Array.from({ length: 21 }, (_, i) => ({ ...finding, id: `finding-${i}`, fixProposal: { ...finding.fixProposal!,
    fileChanges: Array.from({ length: 32 }, (_, j) => ({ ...finding.fixProposal!.fileChanges[0]!, path: `src/file-${i}-${j}.ts` })) } }));
  expect(() => reviewFeedbackContext(findings, undefined)).toThrow();
});

it("a reviewed selected fix updates the pinned PR and reconciles an uncertain but landed push exactly once", async () => {
  const { createCandidateManifest } = await import("@agentx/contracts");
  const { startPublication } = await import("../../packages/broker/src/core/build-step/publish.js");
  const { recordOperationResult } = await import("../../packages/broker/src/core/task-flow/results.js");
  const { pullRequestRecordKey } = await import("../../packages/broker/src/core/build-step/records.js");
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const before = task.workflow!;
  const candidate = createCandidateManifest(before.candidate!.repositories.map(r => ({ ...r, commitSha: "f".repeat(40), treeSha: "c".repeat(40) })));
  const workflow = { ...before, revision: before.revision + 1, stage: "PULL_REQUEST", state: "READY", programStepId: "pull_request", candidate,
    reviewBase: [{ repositoryId: "app", baseCommitSha: "e".repeat(40) }],
    verification: { ...before.verification!, candidateDigest: candidate.digest }, reviews: before.reviews!.map(r => ({ ...r, candidateDigest: candidate.digest })) };
  await w.h.store.update({ key: task, ops: [change.set("workflow", toDocument(workflow))] });
  const host = w.registry.require("code-host", "github");
  const ref = { repository: { url: "https://github.com/acme/app" }, id: "1", url: before.pullRequests![0]!.url };
  const remote = await host.getChangeRequest(ref, { orgId: w.h.deps.companyId });
  const key = pullRequestRecordKey({ pk: `WORKSPACE#${task.workspaceId}` }, "app", 1);
  await w.h.store.put({ item: { ...key, entityType: "PULL_REQUEST", workspaceId: task.workspaceId, repository: "app", repositoryUrl: ref.repository.url, number: 1,
    url: ref.url, state: "open", headBranch: remote.sourceBranch, baseBranch: remote.targetBranch, expectedHeadCommit: remote.headRevision,
    title: "Fix retries", body: "Original description", createdByOperationId: w.operation.id, updatedAt: task.createdAt } });
  expect(await startPublication(w.h.deps, { taskId: task.taskId, workflowRevision: workflow.revision })).toBe("STARTED");
  const push = (await workspaceOperations(w.h.deps, task.workspaceId)).find(op => op.kind === "maintain")!;
  expect(push.maintenance).toMatchObject({ pullRequestNumber: 1, headBranch: remote.sourceBranch, expectedHeadCommit: remote.headRevision });
  expect((await workspaceOperations(w.h.deps, task.workspaceId)).filter(op => op.kind === "publish")).toHaveLength(0);
  w.registry.unregister("code-host", "github");
  w.registry.register("code-host", "github", Object.create(host, {
    getChangeRequest: { value: async () => ({ ...remote, headRevision: "f".repeat(40) }) },
    tree: { value: async () => "c".repeat(40) }, commitParents: { value: async () => [remote.headRevision] },
  }) as CodeHost);
  const ended = { workspaceId: push.workspaceId, operationId: push.id, fence: push.fence, status: "FAILED" as const, error: "connection lost after push" };
  await recordOperationResult(w.h.deps, ended);
  const next = (await readTask(w.h.deps, task.taskId))!;
  expect(next.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ number: 1, headSha: "f".repeat(40) }] });
  expect(next.workflow!.feedbackReview).toBeUndefined();
  expect(next.workflow!.feedbackReviewHistory).toHaveLength(1);
  await recordOperationResult(w.h.deps, ended);
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.revision).toBe(next.workflow!.revision);
});

it("the documented feedback-approval callback authorizes only its exact worker binding", async () => {
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  await startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision });
  const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
  expect(operation.dispatch.extraActions).toContain("feedback-approval");
  expect(operation.dispatch.requires).toContain("task.workflowFeedbackApproval");
  const { createCallbackHandler, CAPABILITY_HEADER } = await import("../../packages/broker/src/services/callbacks.js");
  const { CallbackCapabilities } = await import("../../packages/broker/src/callbacks.js");
  const handler = createCallbackHandler({ flow: w.h.deps, blobs: w.registry.require("object-storage"), grants: w.h.deps.repositoryGrants as never });
  const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: operation.workspaceId,
    operationId: operation.id, fence: operation.fence, actions: ["feedback-approval"], expiresInSeconds: 100 });
  const request = { method: "POST", path: `/v1/internal/workspaces/${operation.workspaceId}/operations/${operation.id}/feedback-approval`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify(operation.workflowFeedbackApproval) };
  const response = await handler(request);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body) as unknown).toEqual({ authorized: true });
  w.h.deps.taskCapUsd = async () => 1;
  w.h.deps.taskSpendUsd = async () => undefined;
  expect((await handler(request)).statusCode).not.toBe(200);
});


it("ordinary review proceeds without feedback context when an archived report has expired", async () => {
  const { feedbackForReview } = await import("../../packages/broker/src/core/pr-feedback/fix-context.js");
  const w = await reviewedFeedbackWorld();
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const ref = task.workflow!.feedbackReview!.reviewRef!;
  task.workflow = { ...task.workflow!, feedbackReview: undefined, feedbackReviewHistory: [ref] };
  w.objects.delete(ref.objectKey);
  await expect(feedbackForReview(w.h.deps, task)).resolves.toBeUndefined();
});
