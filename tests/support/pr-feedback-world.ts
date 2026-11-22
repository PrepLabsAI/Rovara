import { toDocument, type TaskRecord, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import type { PrFeedbackCollectionDeps } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { feedbackDigest } from "../../packages/broker/src/core/pr-feedback/artifacts.js";
import { vi, type Mock } from "vitest";
import { change, type CodeHost, type ReadBudget, type DocumentKey, type WorkflowFeedbackFindingsDecisionRequest, type ChangeRequestFeedback, type WorkflowFeedbackReviewReport } from "@agentx/contracts";
import { host, ORG, OWNER_ID } from "./service-host.js";
import { TASK_ID } from "./merge-world.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { linkedChangeRequestKey } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";

type ServiceWorld = Awaited<ReturnType<typeof host>>;
export interface FeedbackWorld extends ServiceWorld {
  task: TaskRecord;
  feedback: ChangeRequestFeedback;
  read: Mock<() => Promise<ChangeRequestFeedback>>;
  reads: Map<string, Mock<() => Promise<ChangeRequestFeedback>>>;
  put: Mock<(key: string, bytes: Uint8Array) => Promise<void>>;
  objects: Map<string, Uint8Array>;
  deps: PrFeedbackCollectionDeps;
  budget: ReadBudget;
  link: DocumentKey;
}
export interface ReviewedFeedbackWorld extends FeedbackWorld {
  operation: OperationRecord;
  report: WorkflowFeedbackReviewReport;
  request: WorkflowFeedbackFindingsDecisionRequest;
}

/** Invalid UTF-8 which decodes to the same replacement character as the valid fixture bytes. */
export function corruptReplacementByte(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes), marker = Buffer.from("\uFFFD"), offset = buffer.indexOf(marker);
  if (offset < 0) throw new Error("The byte-integrity fixture needs a replacement character.");
  return Buffer.concat([buffer.subarray(0, offset), Buffer.from([0xFF]), buffer.subarray(offset + marker.length)]);
}

export async function feedbackWorld(options: Parameters<typeof host>[0] = {}): Promise<FeedbackWorld> {
  const w = await host(options);
  const task = (await readTask(w.h.deps, TASK_ID))!;
  Object.assign(task, { ownerKey: OWNER_ID, workspaceId: "33333333-3333-4333-8333-333333333333", conversationId: "44444444-4444-4444-8444-444444444444", provider: "local-owner", title: "Fix retry", requestText: "Handle failures safely" });
  await w.h.store.put({ item: toDocument(task) });
  await w.h.store.put({ item: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META", entityType: "WORKSPACE", id: task.workspaceId, companyId: ORG, orgId: ORG,
    ownerKey: OWNER_ID, projectName: "web", projectRevision: 1, status: "READY", activeOperationId: null, fence: 1,
    workspaceProject: "web", workspaceCreatedAt: task.createdAt, createdAt: task.createdAt, updatedAt: task.createdAt } });
  await w.h.store.put({ item: { pk: `WORKSPACE#${task.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID } });
  const home = (await w.world.host.repository("web", 1, "app", ORG))!;
  await w.h.store.put({ item: { ...engineStampKey(TASK_ID), entityType: "TASK_ENGINE", orgId: ORG, taskId: TASK_ID,
    coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "on", stampedAt: new Date(w.clock.ms).toISOString() } } });
  const link = linkedChangeRequestKey("github", home.url, "1")!;
  await w.h.store.update({ key: link, ops: [change.set("candidateDigest", task.workflow!.candidate!.digest), change.set("workspaceId", task.workspaceId)] });
  const feedback: ChangeRequestFeedback = await home.codeHost.feedback({ repository: { url: home.url }, id: "1", url: "" }, { orgId: ORG });
  feedback.changeRequest.headTreeRevision = "b".repeat(40);
  feedback.comments = [{ id: "comment-1", kind: "discussion", url: "https://github.com/acme/app/pull/1#issuecomment-1", author: "reviewer",
    updatedAt: new Date(w.clock.ms).toISOString(), body: "Handle this failure." }];
  const read = vi.fn(async () => feedback);
  const reads = new Map([["app", read]]);
  for (const repositoryId of options.repositories ?? []) {
    if (repositoryId === "app") continue;
    const other = (await w.world.host.repository("web", 1, repositoryId, ORG))!;
    const key = linkedChangeRequestKey("github", other.url, "1")!;
    await w.h.store.update({ key, ops: [change.set("candidateDigest", task.workflow!.candidate!.digest), change.set("workspaceId", task.workspaceId)] });
    const value = await other.codeHost.feedback({ repository: { url: other.url }, id: "1", url: "" }, { orgId: ORG });
    value.changeRequest.headTreeRevision = "b".repeat(40);
    reads.set(repositoryId, vi.fn(async () => value));
  }
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); });
  const plan = "# Plan\nHandle failures safely.";
  const sha256 = feedbackDigest(plan);
  const planKey = `private/${task.ownerKey}/${task.workspaceId}/plan.md`;
  objects.set(planKey, Buffer.from(plan));
  task.workflow!.artifacts = [{ id: "55555555-5555-4555-8555-555555555555", type: "plan", producer: "test", version: 1, sha256, objectKey: planKey, createdAt: task.createdAt }];
  task.workflow!.decisions = [{ requestId: "66666666-6666-4666-8666-666666666666", workflowRevision: 1, decision: "APPROVE", actorId: OWNER_ID, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: sha256, at: task.createdAt }];
  await w.h.store.put({ item: toDocument(task) });
  w.h.deps.feedbackArtifacts = { put, get: async (key: string) => objects.get(key) };
  w.h.deps.artifacts = w.h.deps.feedbackArtifacts;
  w.registry.unregister("code-host", "github");
  w.registry.register("code-host", "github", Object.create(home.codeHost, { feedback: { value: read } }) as CodeHost);
  w.h.deps.codeHosts = w.registry;
  const storage = w.registry.require("object-storage");
  w.registry.unregister("object-storage", "test");
  w.registry.register("object-storage", "test", { ...storage, put, get: async (key: string) => objects.get(key) });
  const deps = { flow: w.h.deps, repository: async (project: string, revision: number, repositoryId: string, orgId: typeof ORG) => {
    const resolved = await w.world.host.repository(project, revision, repositoryId, orgId);
    return resolved === undefined ? undefined : { ...resolved, codeHost: Object.create(resolved.codeHost, { feedback: { value: reads.get(repositoryId) } }) as CodeHost };
  },
    blobs: { put, get: async (key: string) => objects.get(key) }, now: () => w.clock.ms };
  const budget = { signal: new AbortController().signal, beforeRequest: vi.fn() };
  return { ...w, task, feedback, read, reads, put, objects, deps, budget, link };
}

export async function reviewedFeedbackWorld(status: "COMPLETE" | "BLOCKED" = "COMPLETE", editReport?: (report: WorkflowFeedbackReviewReport) => void,
  beforeResult?: (world: FeedbackWorld, operation: OperationRecord, result: Record<string, unknown>) => Promise<void>,
  beforeCollection?: (world: FeedbackWorld) => void): Promise<ReviewedFeedbackWorld> {
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  const { workspaceOperations } = await import("../../packages/broker/src/core/task-flow/reads.js");
  const { recordOperationResult } = await import("../../packages/broker/src/core/task-flow/results.js");
  const { lifecycleReport } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const { feedbackRequirements } = await import("../../packages/broker/src/core/pr-feedback/inputs.js");
  const w = await feedbackWorld();
  beforeCollection?.(w);
  await collectPrFeedback(w.deps, w.task, w.budget);
  const collected = (await readTask(w.h.deps, TASK_ID))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: TASK_ID, workflowRevision: collected.workflow!.revision, kind: "REVIEW" });
  const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId))[0]!;
  const running = (await readTask(w.h.deps, TASK_ID))!;
  const report = lifecycleReport(running, operation, new Date(w.clock.ms).toISOString(), "The reviewer could not complete.");
  if (status === "COMPLETE") {
    report.status = "COMPLETE";
    delete report.blockReason;
    report.taskRequirementsDigest = feedbackDigest(await feedbackRequirements(w.h.deps, running));
    report.findings = [{ id: "finding-1", bundleDigest: report.bundleDigests[0]!, commentIds: ["comment-1"], priority: "SHOULD_FIX", assessment: "ACTIONABLE", recommended: true,
      evidence: [{ source: "candidate", reference: "src/retry.ts" }], rationale: "The failure needs a bounded retry.", confidence: { level: "HIGH", reason: "The candidate lacks a retry." }, proposedDisposition: "IMPLEMENT",
      fixProposal: { summary: "Handle the failure.", fileChanges: [{ repositoryId: "app", path: "src/retry.ts", operation: "MODIFY", change: "Add a bounded retry." }], tests: [] } }];
    report.findingRefs = report.findings.map(({ id, bundleDigest, commentIds, priority, assessment, recommended }) => ({ id, bundleDigest, commentIds, priority, assessment, recommended }));
    report.proposalDigest = feedbackDigest(JSON.stringify({ taskRequirementsDigest: report.taskRequirementsDigest, candidateBindings: report.candidateBindings, findings: report.findings }));
  }
  editReport?.(report);
  const content = JSON.stringify(report);
  const outputDigest = feedbackDigest(content);
  const artifactName = `workflow-feedback-review-${outputDigest}.json`;
  const objectKey = `workspaces/${operation.workspaceId}/operations/${operation.id}/${artifactName}`;
  w.objects.set(objectKey, Buffer.from(content));
  await w.h.store.put({ item: { pk: operation.pk, sk: `ARTIFACT#${operation.id}#${artifactName}`, operationId: operation.id, name: artifactName, objectKey } });
  const result = { taskId: TASK_ID, workflowRevision: running.workflow!.revision,
    candidateDigest: running.workflow!.candidate!.digest, outputDigest, artifactName, status: report.status };
  await beforeResult?.(w, operation, result);
  await recordOperationResult(w.h.deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: "SUCCEEDED",
    outcome: { kind: "reviewed", result: { workflowFeedbackReviewResult: result } } });
  const task = (await readTask(w.h.deps, TASK_ID))!;
  const request = { requestId: "77777777-7777-4777-8777-777777777777", expectedRevision: task.workflow!.revision,
    reviewDigest: task.workflow!.feedbackReview!.reviewRef!.sha256, proposalDigest: task.workflow!.feedbackReview!.reviewRef!.proposalDigest,
    bundleDigests: task.workflow!.feedbackReview!.bundleRefs.map(ref => ref.sha256), decision: "APPROVE" as "APPROVE" | "DISMISS" | "REQUEST_CHANGES", selectedFindingIds: ["finding-1"], ownerNote: undefined as string | undefined };
  return { ...w, task, operation, report, request };
}

export async function rewriteFeedbackReport(w: Awaited<ReturnType<typeof reviewedFeedbackWorld>>, edit: (report: typeof w.report) => void) {
  const { WorkflowFeedbackReviewReportSchema } = await import("@agentx/contracts");
  const { saveFeedbackReport } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  edit(w.report);
  w.report.findingRefs = w.report.findings.map(({ id, bundleDigest, commentIds, priority, assessment, recommended }) => ({ id, bundleDigest, commentIds, priority, assessment, recommended }));
  w.report.proposalDigest = feedbackDigest(JSON.stringify({ taskRequirementsDigest: w.report.taskRequirementsDigest, candidateBindings: w.report.candidateBindings, findings: w.report.findings }));
  w.report = WorkflowFeedbackReviewReportSchema.parse(w.report);
  const ref = await saveFeedbackReport(w.h.deps, w.task, w.report);
  const current = w.task.workflow!.feedbackReview!;
  if (current.status === "COLLECTING") throw new Error("The report fixture must already be settled.");
  const review = { ...current, reviewRef: ref };
  w.task.workflow!.feedbackReview = review;
  await w.h.store.put({ item: toDocument(w.task) });
  w.request.reviewDigest = ref.sha256;
  w.request.proposalDigest = ref.proposalDigest;
}
