import { createHash } from "node:crypto";
import { z } from "zod";
import { E2EModelReceiptSchema, E2EModelRouteDefinitionSchema, canonicalJson } from "@agentx/contracts";
import { E2E_AGENT_LEDGER_MAX_BYTES, E2E_AGENT_MODEL_EVIDENCE_SCHEMA_VERSION, type E2EAgentModelEvidence, type E2EAgentTranscriptDigest } from "../application-agent-result.js";
import type { ExecutorAgentEvidence } from "./executor-readback.js";

/**
 * What a group's model channel hands back when it closes (Task 4.4a): the receipts of every request it received, its own tally of the requests it could not serve as it should, the
 * redacted transcripts it kept (read here for their digests only), the run's value key and the route definition it served. The worker owns all of it; the Docker host reads it, in
 * this one place, into the evidence the collector reads.
 */
export const E2EModelChannelClosedSchema = z.object({
  receipts: z.array(E2EModelReceiptSchema).max(300),
  droppedRequests: z.number().int().min(0).max(1_000_000), unscopedRequests: z.number().int().min(0).max(1_000_000), overrun: z.boolean(), evidenceErrors: z.number().int().min(0).max(1_000_000),
  transcripts: z.array(z.object({ receiptId: z.string().min(1).max(120), prompt: z.string().nullable(), response: z.string().nullable(), omitted: z.enum(["budget", "unparseable"]).optional() })).max(300),
  valueKey: z.string().regex(/^[a-f0-9]{64}$/),
  definition: E2EModelRouteDefinitionSchema,
});
export type E2EModelChannelClosed = z.input<typeof E2EModelChannelClosedSchema>;

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sortKey = (receipt: { caseId: string; stepIndex: number; callIndex: number }) => `${receipt.caseId}\u0000${String(receipt.stepIndex).padStart(4, "0")}\u0000${String(receipt.callIndex).padStart(4, "0")}`;

/** The digest of a stored transcript body, as the receipt's own digest is made: SHA-256 of the canonical JSON the body holds. `undefined` when the body is not JSON. */
function bodyDigest(body: string): string | undefined {
  try { return sha(canonicalJson(JSON.parse(body))); } catch { return undefined; }
}

function digestOf(transcript: z.infer<typeof E2EModelChannelClosedSchema>["transcripts"][number]): E2EAgentTranscriptDigest {
  const omitted = transcript.omitted ?? null;
  if (transcript.prompt === null && transcript.response === null) return { receiptId: transcript.receiptId, promptSha256: null, responseSha256: null, omitted };
  const promptSha256 = transcript.prompt === null ? null : bodyDigest(transcript.prompt);
  const responseSha256 = transcript.response === null ? null : bodyDigest(transcript.response);
  if (promptSha256 === undefined || responseSha256 === undefined) return { receiptId: transcript.receiptId, promptSha256: null, responseSha256: null, omitted: "unparseable" };
  return { receiptId: transcript.receiptId, promptSha256, responseSha256, omitted };
}

/**
 * The evidence of a group's AI navigation steps for the collector, from what the channel returned when it closed (`closed`: anything; what is not a closed channel is a channel that
 * failed to close) and the ledgers the executor left. `valueKey` is the host's own key for the run (the one it wrote into the executor's plan), so a channel that returns another
 * is a fault. Nothing here reads a prompt or an answer beyond its digest, and a ledger over its bound is left out (the collector then has none and says so).
 *
 * A channel that failed does not make the group's evidence absent: it makes it say so (`evidenceErrors`), so the collector answers UNKNOWN with the code for it and never PASS.
 */
export function buildE2EAgentModelEvidence(input: { closed: unknown; valueKey: string; agent: ExecutorAgentEvidence | undefined }): E2EAgentModelEvidence {
  const ledgers = (input.agent?.ledgers ?? []).filter((item) => item.bytes.byteLength <= E2E_AGENT_LEDGER_MAX_BYTES)
    .map((item) => ({ caseDirectory: item.caseDirectory, bytesBase64: Buffer.from(item.bytes).toString("base64"), sha256: sha(item.bytes) }));
  const parsed = E2EModelChannelClosedSchema.safeParse(input.closed);
  if (!parsed.success || parsed.data.valueKey !== input.valueKey) {
    return { schemaVersion: E2E_AGENT_MODEL_EVIDENCE_SCHEMA_VERSION, route: null, valueKey: input.valueKey, receipts: [],
      channel: { droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 1 }, ledgers, transcriptDigests: [] };
  }
  const closed = parsed.data;
  const receipts = [...closed.receipts].sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  const transcripts = new Map(closed.transcripts.map((item) => [item.receiptId, item] as const));
  return { schemaVersion: E2E_AGENT_MODEL_EVIDENCE_SCHEMA_VERSION, route: closed.definition, valueKey: input.valueKey, receipts,
    channel: { droppedRequests: closed.droppedRequests, unscopedRequests: closed.unscopedRequests, overrun: closed.overrun, evidenceErrors: closed.evidenceErrors }, ledgers,
    transcriptDigests: receipts.flatMap((receipt) => { const transcript = transcripts.get(receipt.receiptId); return transcript === undefined ? [] : [digestOf(transcript)]; }) };
}
