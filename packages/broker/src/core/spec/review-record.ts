// The broker's record of a code review's walk of the spec, and the export the requirement-to-evidence table reads. The worker's report is read again here (schema, bounds), is kept only when it is about
// the commit the broker recorded for the spec, and is written with the review's own result.
import { SpecReviewResultSchema, queryAll, specRequirementRows, type DocumentStore, type StoredDocument, type TransactItem, type SpecReviewResult } from "@agentx/contracts";
import type { SpecStore } from "./hooks.js";

export const SPEC_REVIEW_SK_PREFIX = "SPEC#REVIEW#";

export interface SpecReviewRecordEnvironment {
  store: SpecStore;
  now(): string;
}

export type StoredSpecReview = SpecReviewResult & { pk: string; sk: string; entityType: "SPEC_REVIEW"; taskId: string; operationId: string; recordedAt: string };

/** The item to write with a review operation's result, or none: not a review, no walk reported, a walk that is not valid, or one about another commit than the spec's recorded one. */
export async function specReviewRecordItems(
  env: SpecReviewRecordEnvironment, taskId: string, operation: { id: string; kind: string; workflowMode?: string | undefined }, outcome: { status: string; result: unknown },
): Promise<TransactItem[]> {
  if (operation.kind !== "task" || operation.workflowMode !== "REVIEW" || outcome.status !== "SUCCEEDED") return [];
  const reported = outcome.result !== null && typeof outcome.result === "object" ? (outcome.result as { specReview?: unknown }).specReview : undefined;
  if (reported === undefined) return [];
  const parsed = SpecReviewResultSchema.safeParse(reported);
  if (!parsed.success) return [];
  const { state } = await env.store.load(taskId);
  if (state?.specPullRequest === undefined || state.specPullRequest.commit !== parsed.data.specCommit) return [];
  const item: StoredSpecReview = { pk: `DEVTASK#${taskId}`, sk: `${SPEC_REVIEW_SK_PREFIX}${operation.id}`, entityType: "SPEC_REVIEW", taskId, operationId: operation.id, recordedAt: env.now(), ...parsed.data };
  return [{ kind: "put", item: JSON.parse(JSON.stringify(item)) as StoredDocument }];
}

/** The requirement rows of every spec walk recorded for the task, oldest first: `(specPath, specCommit, id)` with the verdict, reason and evidence. */
export async function specRequirementRowsOfTask(
  store: Pick<DocumentStore, "query">, taskId: string,
): Promise<Array<ReturnType<typeof specRequirementRows>[number] & { operationId: string; recordedAt: string }>> {
  const rows: Array<ReturnType<typeof specRequirementRows>[number] & { operationId: string; recordedAt: string }> = [];
  for (const record of await queryAll(store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: SPEC_REVIEW_SK_PREFIX } })) {
    // The walk's own fields only: the stored item carries its key and bookkeeping beside them, which the strict schema would refuse.
    const { specPath, specCommit, verdicts, unanswered, truncated, operationId, recordedAt } = record as Record<string, unknown>;
    const parsed = SpecReviewResultSchema.safeParse({ specPath, specCommit, verdicts, unanswered, truncated });
    if (!parsed.success || typeof operationId !== "string" || typeof recordedAt !== "string") continue;
    for (const row of specRequirementRows(parsed.data)) rows.push({ ...row, operationId, recordedAt });
  }
  return rows.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}
