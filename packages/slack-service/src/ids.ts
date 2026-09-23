import { createHash } from "node:crypto";

// Name-based UUID (version 5 layout, SHA-256 digest) so a redelivered Slack event reproduces the same request IDs.
export function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function requestIdSequence(eventId: string): () => string {
  let index = 0;
  return () => deterministicUuid(`${eventId}:tool:${index++}`);
}
