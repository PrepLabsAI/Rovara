// Helpers the broker and the developer task routes share (spec 025 ruling F9): one definition each.
import { createHash } from "node:crypto";

/** A stable hash of a JSON value: idempotency records compare a retried request's payload with it. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A single write's or a transaction's condition failed (DynamoDB). */
export function isConditional(error: unknown): boolean {
  return error instanceof Error && ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(error.name);
}
