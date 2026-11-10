// Live steer: what happens at the broker when a step stopped because the owner's live message asked for a change outside the approved plan (this lane; the hosted product's `agent-sessions/live-steer-reapproval.ts`).
// The worker ended the step with the fixed words `WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE` followed by the ids of the owner's messages it had been given (server-made ids, never text). The step's own result blocks the
// workflow with a fixed reason (the owner decides: Understand and Plan retry with the message and the new plan is approved; coding retries the approved plan without the change, or the plan is revised with it); this
// marks each of those messages `needs re-approval` on its row and says so on the session's timeline. It never throws (the block is already committed) and no log line, event or row holds a message's text.
import { WORKFLOW_BLOCK_REASONS, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, liveSteerCodingBlockReason, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import { markSteerNeedsReapproval, type SteerDeps } from "./steer.js";

/** The most messages one stop marks (the worker names at most five). */
const MARK_MAX = 5;

/** The ids of the owner's messages a stopped step's error names, oldest first, without repeats. Empty when the error is not a re-approval stop. */
export function reapprovalMessageIds(error: string | undefined): string[] {
  if (error === undefined || !error.includes(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE)) return [];
  return [...new Set(error.match(/msg_[0-9a-z]{20}/gu) ?? [])].slice(0, MARK_MAX);
}

/** Whether a stopped step's error is a re-approval stop. */
export const isReapprovalStop = (error: string | undefined): boolean => error?.includes(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE) === true;

/**
 * The block reason coding stops with when the owner's live message asked for a change outside the approved plan: the one that offers Revise the plan only when the plan can take the change in AND the owner's
 * message ids are known (they are what the press plans with); otherwise the round-2 words.
 */
export function liveSteerCodingStop(workflow: Parameters<typeof liveSteerCodingBlockReason>[0], error: string | undefined): string {
  return reapprovalMessageIds(error).length === 0 ? WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding : liveSteerCodingBlockReason(workflow);
}

/** Where the stop keeps the owner's message ids for the press: one item per task, written in the transaction that blocks coding, so a card that offers Revise always has its record. */
export const liveSteerChangeKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "LIVE_STEER_CHANGE" });

/** The record item, to go in the same transaction as the block (`next` is the blocked workflow being stored); nothing for any other block. Ids only, never text. */
export function liveSteerChangeItems(taskId: string, next: Pick<WorkflowSnapshot, "stage" | "state" | "blockReason" | "revision">, error: string | undefined, at: string): TransactItem[] {
  const messageIds = reapprovalMessageIds(error);
  if (next.stage !== "IMPLEMENT" || next.state !== "BLOCKED" || next.blockReason !== WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise || messageIds.length === 0) return [];
  return [{ kind: "put", item: { ...liveSteerChangeKey(taskId), entityType: "LIVE_STEER_CHANGE", taskId, workflowRevision: next.revision, messageIds, at } }];
}

/** Marks the messages a stopped step's error names. Answers how many it marked. */
export async function settleLiveSteerReapproval(deps: SteerDeps, task: { orgId?: string | undefined; companyId?: string | undefined; sessionId?: string | undefined }, error: string | undefined): Promise<number> {
  const ids = reapprovalMessageIds(error);
  const orgId = task.orgId ?? task.companyId;
  if (ids.length === 0 || orgId === undefined || task.sessionId === undefined) return 0;
  let marked = 0;
  for (const messageId of ids) if (await markSteerNeedsReapproval(deps, orgId, task.sessionId, messageId)) marked += 1;
  return marked;
}
