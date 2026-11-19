// Helpers the broker and the developer task routes share (spec 025 ruling F9): one definition each.
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, OPERATION_PROMPT_MAX_BYTES } from "@agentx/contracts";
import type { TransactItems } from "./developer-task-actions.js";

export * from "../developer/plan-instructions.js";

/** A stable hash of a JSON value: idempotency records compare a retried request's payload with it. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * What an owner hears when a project's catalog pointer cannot be repaired from its revision history (an administrator
 * must register the project again). Written for Slack and the task page; the project and the reason go to the broker log.
 */
export const PROJECT_RECORD_NEEDS_ADMIN = "This project's settings record needs an administrator to register it again.";

/** A single write's or a transaction's condition failed (DynamoDB). */
export function isConditional(error: unknown): boolean {
  return error instanceof Error && ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(error.name);
}

/**
 * Spec 025 C19: an AWS error worth trying again: throttling, or any 5xx. A cancelled transaction is
 * not one of them: its conditions decide what happens next.
 */
const TEMPORARY_AWS_ERRORS = new Set([
  "ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "TooManyRequestsException",
  "InternalServerError", "InternalFailure", "ServiceUnavailable", "ServiceUnavailableException", "TransactionConflictException", "TimeoutError",
]);

export function isTemporaryAwsError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return TEMPORARY_AWS_ERRORS.has(error.name) || (typeof status === "number" && status >= 500);
}

/** Issue #48: the words a caller gets for a temporary AWS error, which it can try again. */
export const AWS_TEMPORARY_MESSAGE = "AgentX could not reach AWS just now; try again in a moment";
/**
 * Issue #48: the words a caller gets for any other error that is not an AgentXError. Its own words
 * can name AWS resources or internals, so only its name is logged (as 25e does for admin changes).
 */
export const UNEXPECTED_REQUEST_MESSAGE = "AgentX could not handle this request; check it and try again, or ask an admin to check the broker logs";

/**
 * 25c live-check note 1 (owner answer, 2026-09-30): a shared task's channel turns and AI-tool turns
 * each resume their own session, so each remembers the files as they were at its last turn. Every
 * turn on a shared task after its first (when no one else has touched the workspace yet) ends with
 * this line, when it fits. It is added after the request hash is taken.
 */
export const SHARED_WORKSPACE_REREAD = "Other people also change this workspace between your turns. Read a file again before you change it.";

/** Refuses an ordinary write-capable turn on a gated task (gap 10a); user-facing, so it avoids internal terms. */
export const GATED_TASK_TURN_REFUSAL = "This task is waiting on its own approval steps. Use its approval buttons or the task's decision tool instead of sending more instructions.";
/** Refuses a pull request anyone asks for on a gated task (ruling A): AgentX opens its draft itself. User-facing. */
export const GATED_TASK_PULL_REQUEST_REFUSAL = "AgentX opens the draft pull request for this task itself once checks and reviews pass";
/** Refuses a pull request change through AgentX on a gated task (ruling A); humans change and merge it on GitHub. */
export const GATED_TASK_PULL_REQUEST_ACTION_REFUSAL = "AgentX does not change this task's pull request on request. Change or merge it on GitHub.";

/** Starts every workflow phase prompt: the worker is one step, and AgentX owns approvals, checks, reviews and publishing. */
export const WORKFLOW_PREAMBLE = "You are one step inside AgentX's gated task workflow. AgentX itself asks the task owner for every approval, runs the project's checks, runs the independent code and security reviews, and opens the draft pull request. Never plan, describe or perform git push, creating remote branches, opening or updating pull requests (for example gh pr create), merging, or deploying. Never treat any step as already approved: the owner approves each document in Slack.";
/**
 * The prompt the worker runs: the request's own, and on a shared task the re-read line after it.
 * The line is only a hint, so it is left out when it would take the prompt past a request's limit
 * (UTF-8 bytes, stricter than the worker's own character count). The caller logs that omission.
 */
export function workerPrompt(prompt: string, shared: boolean): string {
  if (!shared) return prompt;
  const withLine = `${prompt}\n\n${SHARED_WORKSPACE_REREAD}`;
  return Buffer.byteLength(withLine, "utf8") <= OPERATION_PROMPT_MAX_BYTES ? withLine : prompt;
}

/**
 * Gap 6: the intent to start the next workflow step with no one asking, written in the same transaction as the
 * result that made it due. The broker runs it right after that commit; the recovery sweep runs any row left behind.
 */
export interface WorkflowDispatchRecord {
  pk: "WORKFLOW_DISPATCH";
  sk: string; // `${taskId}#${revision}`
  entityType: "WORKFLOW_DISPATCH";
  taskId: string;
  workflowRevision: number;
  /** UPDATE: an approved fix's checks and reviews passed, and it is pushed to the pull requests already open. AUTOFIX: the workflow blocked in VERIFY or REVIEW, and the automatic-fix policy looks at it once (never blocks or gives up anything itself). */
  kind: "CHECKS" | "REVIEW" | "PUBLISH" | "UPDATE" | "REPLAN" | "AUTOFIX" | "GROUNDING";
  /** For REPLAN, the digest of `planPrompt`: there is no candidate yet. */
  candidateDigest: string;
  /** REPLAN: what the planner is told on the automatic second run of a plan (the findings, or what was unreadable). */
  planPrompt?: string;
  /** A single internal resume operation warms EC2 before a required E2E round is immutably admitted. */
  readinessOperationId?: string;
  createdAt: string;
  /** Failed runs so far; the row is retried with backoff and gives up (blocking the task) at the cap. */
  attempts: number;
  /** When the sweep may run the row next. */
  nextAttemptAt: string;
  /** The due-time index keys (WORKFLOW_DISPATCH_DUE_INDEX): a constant, and `${nextAttemptAt}#${sk}`. */
  dispatchDuePk: "WORKFLOW_DISPATCH";
  dispatchDueSk: string;
  /** TTL backstop (epoch seconds), in case a row is somehow never resolved. */
  indexExpiresAt: number;
  /** AUTOFIX only (DISPATCHEXHAUST): how the block this row is for came about when no finished run wrote it. Rows from before carry none. */
  autofixCause?: string;
  /** AUTOFIX only (DISPATCHEXHAUST): the look must not happen before this time, the delay of the one automatic retry of an infrastructure fault. */
  autofixNotBefore?: string;
}

/** Internal purpose binding for the one pre-admission compute warmup of a required feature E2E dispatch. */
export interface WorkflowE2EReadinessMarker {
  purpose: "workflow-e2e-readiness";
  taskId: string;
  workflowRevision: number;
  candidateDigest: string;
  dispatchSk: string;
}

export const WORKFLOW_DISPATCH_PK = "WORKFLOW_DISPATCH";
const WORKFLOW_DISPATCH_RETENTION_SECONDS = 7 * 86_400;

export function workflowDispatchItem(tableName: string, taskId: string, workflowRevision: number, kind: WorkflowDispatchRecord["kind"], candidateDigest: string, now: string, planPrompt?: string): TransactItems[number] {
  const sk = `${taskId}#${workflowRevision}`;
  const item: WorkflowDispatchRecord = {
    pk: WORKFLOW_DISPATCH_PK, sk, entityType: "WORKFLOW_DISPATCH",
    taskId, workflowRevision, kind, candidateDigest, ...(planPrompt === undefined ? {} : { planPrompt }), createdAt: now,
    attempts: 0, nextAttemptAt: now, dispatchDuePk: WORKFLOW_DISPATCH_PK, dispatchDueSk: `${now}#${sk}`,
    [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(now) / 1000) + WORKFLOW_DISPATCH_RETENTION_SECONDS,
  };
  return { Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } };
}
