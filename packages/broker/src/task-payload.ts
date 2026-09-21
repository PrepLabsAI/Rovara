import { createHash } from "node:crypto";
import { OperationRequestSchema, type OperationRequest } from "@agentx/contracts";

/**
 * One idempotency hash for task acceptance, shared by the in-memory and AWS brokers.
 *
 * The serialized shape is the one the AWS broker already persists: `conversationId`,
 * then `prompt`, then `candidate` only when the request carries one. Changing the key
 * order or sorting the JSON would invalidate every stored payloadHash, so both stay
 * exactly as written. Schema parsing normalizes field order, so a caller that sends the
 * same content with reordered keys hashes identically while different content does not.
 */
export function taskPayloadHash(input: OperationRequest): string {
  const request = OperationRequestSchema.parse(input);
  const payload = {
    conversationId: request.conversationId,
    prompt: request.prompt,
    ...(request.candidate === undefined ? {} : { candidate: request.candidate }),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
