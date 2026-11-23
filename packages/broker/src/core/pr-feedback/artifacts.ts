// Immutable feedback evidence. Only task/workspace-owned keys are accepted.
import { createHash } from "node:crypto";
import { ObjectConflictError, WorkflowFeedbackBundleRefSchema, WorkflowFeedbackBundleSchema, type ObjectStorage, type WorkflowFeedbackBundle, type WorkflowFeedbackBundleRef } from "@agentx/contracts";
import type { TaskRecord } from "../task-flow/records.js";

export const feedbackDigest = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
export const FEEDBACK_ARTIFACT_MAX_BYTES = 1_000_000;
export const FEEDBACK_INPUTS_MAX_BYTES = 8_000_000;
export const feedbackPrefix = (task: TaskRecord): string => `private/${task.ownerKey}/${task.workspaceId}/feedback-bundles/${task.taskId}/`;

export function prepareFeedbackBundle(task: TaskRecord, input: WorkflowFeedbackBundle) {
  const bundle = WorkflowFeedbackBundleSchema.parse(input);
  const text = JSON.stringify(bundle);
  const bytes = new TextEncoder().encode(text);
  if (bundle.taskId !== task.taskId || bytes.byteLength > FEEDBACK_ARTIFACT_MAX_BYTES) throw new Error("feedback artifact is outside its task or byte bound");
  const sha256 = feedbackDigest(text);
  return { bundle, bytes, sha256 };
}

export async function saveFeedbackBundle(blobs: Pick<ObjectStorage, "put" | "get">, task: TaskRecord, input: WorkflowFeedbackBundle): Promise<WorkflowFeedbackBundleRef> {
  const { bundle, bytes, sha256 } = prepareFeedbackBundle(task, input);
  const objectKey = `${feedbackPrefix(task)}${sha256}.json`;
  await writeFeedbackBytes(blobs, objectKey, bytes, sha256);
  const { sourceDeliveryIds: _deliveries, comments, ...metadata } = bundle;
  void _deliveries;
  return WorkflowFeedbackBundleRefSchema.parse({ ...metadata, objectKey, sha256, comments: comments.map(({ body: _body, ...ref }) => { void _body; return ref; }) });
}

export async function writeFeedbackBytes(blobs: Pick<ObjectStorage, "put" | "get">, objectKey: string, bytes: Uint8Array, sha256: string): Promise<void> {
  try {
    await blobs.put(objectKey, bytes, { contentType: "application/json", metadata: { sha256 }, retention: "evidence-std" });
  } catch (error) {
    // A repeat is safe only when the immutable bytes already at the key are exactly ours.
    if (!(error instanceof ObjectConflictError)) throw error;
    const existing = await blobs.get(objectKey, FEEDBACK_ARTIFACT_MAX_BYTES);
    if (existing === undefined || feedbackDigest(existing) !== sha256) throw error;
  }
}

export async function readFeedbackBundles(blobs: Pick<ObjectStorage, "get">, task: TaskRecord): Promise<{ ref: WorkflowFeedbackBundleRef; bundle: WorkflowFeedbackBundle; bytes: Uint8Array }[]> {
  const inputs = [];
  let total = 0;
  for (const ref of task.workflow?.feedbackReview?.bundleRefs ?? []) {
    if (ref.taskId !== task.taskId || ref.objectKey !== `${feedbackPrefix(task)}${ref.sha256}.json`) throw new Error("feedback bundle ownership mismatch");
    const bytes = await blobs.get(ref.objectKey, FEEDBACK_ARTIFACT_MAX_BYTES);
    if (bytes === undefined || bytes.byteLength > FEEDBACK_ARTIFACT_MAX_BYTES || feedbackDigest(bytes) !== ref.sha256) throw new Error("feedback bundle integrity mismatch");
    total += bytes.byteLength;
    if (total > FEEDBACK_INPUTS_MAX_BYTES) throw new Error("feedback bundle set exceeds its byte bound");
    const bundle = WorkflowFeedbackBundleSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    const { sourceDeliveryIds: _ids, comments, ...metadata } = bundle;
    void _ids;
    const projected = WorkflowFeedbackBundleRefSchema.parse({ ...metadata, objectKey: ref.objectKey, sha256: ref.sha256,
      comments: comments.map(({ body: _body, ...comment }) => { void _body; return comment; }) });
    if (JSON.stringify(projected) !== JSON.stringify(WorkflowFeedbackBundleRefSchema.parse(ref))) throw new Error("feedback bundle metadata mismatch");
    inputs.push({ ref, bundle, bytes });
  }
  if (inputs.length === 0) throw new Error("feedback bundle set is missing");
  return inputs;
}

export const feedbackReportPrefix = (task: TaskRecord): string => `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/`;
