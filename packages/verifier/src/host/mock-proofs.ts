import type { E2EApplicationEvidenceRef } from "@agentx/contracts";
import type { BoundCase } from "./mock-ledger.js";

/** The bytes of one retained frame, made by the readback; the same shape the supervisor receipt's closure carries. */
export type MockProofFrame = Readonly<{ ref: E2EApplicationEvidenceRef; bytes: Uint8Array }>;
export type MockProofCase = Readonly<{ caseId: string; shardId: string; upstreamRunId: string }>;
export type MockProofs = Readonly<{
  /** Every request, response, consumption and unmocked-call frame, to be retained next to the case captures. */
  frames: readonly MockProofFrame[];
  /** The supervisor receipt entries, ordered by case id as the receipt requires. */
  consumptionEntries: readonly { caseId: string; shardId: string; ref: E2EApplicationEvidenceRef }[];
  unmockedEntries: readonly { caseId: string; shardId: string; ref: E2EApplicationEvidenceRef }[];
  /** The components each case really consumed (what its capture's `observedMockedComponentIds` must say). */
  observedComponentsByCase: ReadonlyMap<string, readonly string[]>;
}>;

/**
 * Turns what the mocks recorded for each case into the frames the collector verifies. A consumption becomes a request frame (the fixture's method and path with the one input field the
 * app sent) and a response frame (the variant it was answered with), both marked as the application's own call; the row binds their digests. A call no approved mock matched becomes
 * a row of the case's unmocked-call frame. Nothing here decides a verdict: the collector re-derives every claim from these bytes against the approved fixture.
 */
export function buildMockProofs(input: Readonly<{
  runId: string; mockManifestDigest: string; lifecycleId: string; context: unknown; producer: unknown;
  cases: readonly MockProofCase[]; bound: ReadonlyMap<string, BoundCase>;
  proof(value: unknown, mediaType: string, artifactId: string): MockProofFrame;
}>): MockProofs {
  const frames: MockProofFrame[] = [];
  const consumptionEntries: { caseId: string; shardId: string; ref: E2EApplicationEvidenceRef }[] = [];
  const unmockedEntries: { caseId: string; shardId: string; ref: E2EApplicationEvidenceRef }[] = [];
  const observedComponentsByCase = new Map<string, readonly string[]>();
  const ordered = [...input.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));
  ordered.forEach((item, caseIndex) => {
    const bound = input.bound.get(item.caseId);
    observedComponentsByCase.set(item.caseId, Object.freeze([...new Set((bound?.consumptions ?? []).map((row) => row.componentId))].sort()));
    if (!bound) return;
    const rows = bound.consumptions.map((row, index) => {
      const requestId = `${row.origin}-${row.line.requestId}`.slice(0, 256);
      const responseId = `${requestId}-response`.slice(0, 256);
      const request = input.proof({ requestId, componentId: row.componentId, caseId: item.caseId, method: row.line.method, path: row.line.path,
        input: { [row.inputField]: row.line.inputValue }, origin: "application" }, "application/json", `rovara-mock-request-${input.runId}-${caseIndex}-${index}`);
      const response = input.proof({ responseId, requestId, status: row.variant.status, body: row.variant.body }, "application/json", `rovara-mock-response-${input.runId}-${caseIndex}-${index}`);
      frames.push(request, response);
      return { caseId: item.caseId, componentId: row.componentId, runId: input.runId, mockManifestDigest: input.mockManifestDigest, lifecycleId: input.lifecycleId,
        producer: input.producer, requestId, responseId, requestSha256: request.ref.sha256, responseSha256: response.ref.sha256, observedAt: row.line.observedAt,
        requestRef: request.ref, responseRef: response.ref };
    });
    if (rows.length > 0) {
      const frame = input.proof({ schemaVersion: "e2e-application-mock-consumption/v1", context: input.context, caseId: item.caseId, shardId: item.shardId,
        upstreamRunId: item.upstreamRunId, rows }, "application/json", `rovara-mock-consumption-${input.runId}-${caseIndex}`);
      frames.push(frame);
      consumptionEntries.push({ caseId: item.caseId, shardId: item.shardId, ref: frame.ref });
    }
    if (bound.unmocked.length > 0) {
      const frame = input.proof({ schemaVersion: "e2e-application-unmocked-calls/v1", context: input.context, caseId: item.caseId, shardId: item.shardId, upstreamRunId: item.upstreamRunId,
        calls: bound.unmocked.map((call) => ({ requestId: `${call.origin}-${call.requestId}`.slice(0, 256), origin: call.origin, kind: call.kind, method: call.method, path: call.path,
          observedAt: call.observedAt })) }, "application/json", `rovara-unmocked-calls-${input.runId}-${caseIndex}`);
      frames.push(frame);
      unmockedEntries.push({ caseId: item.caseId, shardId: item.shardId, ref: frame.ref });
    }
  });
  return Object.freeze({ frames: Object.freeze(frames), consumptionEntries: Object.freeze(consumptionEntries), unmockedEntries: Object.freeze(unmockedEntries), observedComponentsByCase });
}
