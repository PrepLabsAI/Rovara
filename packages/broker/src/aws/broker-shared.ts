// Helpers the broker and the developer task routes share (spec 025 ruling F9): one definition each.
import { createHash } from "node:crypto";
import { OPERATION_PROMPT_MAX_BYTES } from "@agentx/contracts";

/** A stable hash of a JSON value: idempotency records compare a retried request's payload with it. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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
