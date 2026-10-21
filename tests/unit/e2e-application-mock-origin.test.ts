/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- the test edits retained frames whose shape the schemas under test judge */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/index.js";
import { E2EApplicationCollectionOracleSchema, E2EApplicationCollectionSchema, UNMOCKED_EXTERNAL_CALL_REASON, qualifyE2EApplicationCollection,
  type E2EApplicationCollection } from "../../packages/verifier/src/application-result-adapter.js";
import { fixtureEvidence } from "../support/web-api-qualification.js";

// The collector's verdict on two real runs of the qualification app, recorded on a Docker host: one whose inventory origin is served by the approved mock, and one whose
// inventory origin has no mock, so the app's call landed in the sinkhole. Both are judged here by the same pure code the broker runs.
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const load = (probeId: string) => {
  const evidence = fixtureEvidence(probeId);
  if (evidence.kind !== "collected") throw new Error("fixture is not a collected run");
  return { oracle: E2EApplicationCollectionOracleSchema.parse(evidence.oracle), collection: E2EApplicationCollectionSchema.parse(evidence.collection) };
};

type Wire = { ref: { artifactId: string; sha256: string; byteLength: number; mediaType: string }; bytesBase64: string };
const frameOf = (wire: Wire) => JSON.parse(Buffer.from(wire.bytesBase64, "base64").toString("utf8")) as Record<string, any>;
function encode(value: unknown, artifactId: string): Wire {
  const bytes = Buffer.from(canonicalJson(value));
  return { ref: { artifactId, sha256: sha(bytes), byteLength: bytes.byteLength, mediaType: "application/json" }, bytesBase64: bytes.toString("base64") };
}
/** Replaces the receipt of a collection and every place that names it. */
function withReceipt(collection: E2EApplicationCollection, change: (receipt: Record<string, any>) => void, evidenceChange: (evidence: Wire[]) => Wire[] = (list) => list): E2EApplicationCollection {
  const copy = structuredClone(collection);
  const readback = copy.supervisorReadback as unknown as { receipt: Wire; evidence: Wire[] };
  const receipt = frameOf(readback.receipt);
  change(receipt);
  const next = encode(receipt, readback.receipt.ref.artifactId);
  readback.evidence = evidenceChange(readback.evidence).sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId));
  const refs = copy.supervisorReceiptRefs.map((ref) => (ref.artifactId === next.ref.artifactId ? next.ref : ref));
  readback.receipt = next;
  return { ...copy, supervisorReceiptRefs: refs };
}
/** Rewrites the request and response frames of the first mock consumption, and everything that digests them, so only the content differs. */
function withMockFrames(collection: E2EApplicationCollection, edits: { request?: (frame: Record<string, any>) => Record<string, any>; response?: (frame: Record<string, any>) => Record<string, any> }): E2EApplicationCollection {
  const readback = collection.supervisorReadback as unknown as { receipt: Wire; evidence: Wire[] };
  const byId = (artifactId: string) => readback.evidence.find((wire) => wire.ref.artifactId === artifactId)!;
  const entry = frameOf(readback.receipt).mockConsumptions[0];
  const consumption = frameOf(byId(entry.ref.artifactId));
  const row = consumption.rows[0];
  const request = encode((edits.request ?? ((frame) => frame))(frameOf(byId(row.requestRef.artifactId))), row.requestRef.artifactId);
  const response = encode((edits.response ?? ((frame) => frame))(frameOf(byId(row.responseRef.artifactId))), row.responseRef.artifactId);
  Object.assign(row, { requestRef: request.ref, requestSha256: request.ref.sha256, responseRef: response.ref, responseSha256: response.ref.sha256 });
  const next = encode(consumption, entry.ref.artifactId);
  const replaced = new Map([request, response, next].map((wire) => [wire.ref.artifactId, wire]));
  const updated = withReceipt(collection, (receipt) => { receipt.mockConsumptions[0].ref = next.ref; }, (list) => list.map((wire) => replaced.get(wire.ref.artifactId) ?? wire));
  return { ...updated, mockConsumptions: [{ ...updated.mockConsumptions[0]!, requestRef: request.ref, requestSha256: request.ref.sha256, responseRef: response.ref, responseSha256: response.ref.sha256 }] };
}

describe("the verdict on a run whose inventory origin is served by the approved mock", () => {
  const { oracle, collection } = load("web-mock-origin-v1");

  it("passes, serves the success variant once, and names the mocked origin on the case and on the result", () => {
    const verdict = qualifyE2EApplicationCollection(oracle, collection);
    expect(verdict.status, verdict.reason).toBe("PASS");
    expect(verdict.mockSummary).toEqual({ consumptions: { success: 1, refusal: 0, invalidData: 0 }, unmockedCalls: { sinkhole: 0, mocked: 0 }, mockedOrigins: ["inventory-v1"] });
    expect(verdict.result?.mockedOrigins).toEqual(["inventory-v1"]);
    expect(verdict.result?.cases.map((item) => [item.status, item.mockedOrigins])).toEqual([["passed", ["inventory-v1"]]]);
    expect(verdict.result?.cases[0]?.coverage.observedMockedComponentIds).toEqual(oracle.mockOrigins!.map((item) => item.componentId));
  });

  it("knows which mock component is the host-served inventory origin, and expects it of the case", () => {
    expect(oracle.mockOrigins).toEqual([{ componentId: expect.stringMatching(/^api-schema-[a-f0-9]{12}$/), originRef: "inventory-v1" }]);
    expect(oracle.expectedMocksByCase.map((item) => item.specs.map((spec) => spec.componentId))).toEqual([[oracle.mockOrigins![0]!.componentId]]);
  });

  it("is not a pass when the mock was never called: a declared dependency nobody exercised proves nothing", () => {
    const noCall = withReceipt(collection, (receipt) => { receipt.mockConsumptions = []; }, (list) => list.filter((wire) => !/mock-(request|response|consumption)/.test(wire.ref.artifactId)));
    const stripped = { ...noCall, mockConsumptions: [] };
    const verdict = qualifyE2EApplicationCollection(oracle, stripped);
    expect(verdict.status).toBe("UNKNOWN");
  });

  it.each([
    ["a request for a variant the response does not answer", { request: (frame: Record<string, any>) => ({ ...frame, input: { orderId: "a2" } }) }],
    ["a request for an input value no variant has", { request: (frame: Record<string, any>) => ({ ...frame, input: { orderId: "zz" } }) }],
    ["a request with another input field", { request: (frame: Record<string, any>) => ({ ...frame, input: { order: "a1" } }) }],
    ["a request with an extra input field", { request: (frame: Record<string, any>) => ({ ...frame, input: { orderId: "a1", extra: "x" } }) }],
    ["a request for another path", { request: (frame: Record<string, any>) => ({ ...frame, path: "/v1/other" }) }],
    ["a request with another method", { request: (frame: Record<string, any>) => ({ ...frame, method: "POST" }) }],
    ["a request for another component", { request: (frame: Record<string, any>) => ({ ...frame, componentId: "api-schema-000000000000" }) }],
    ["a request that does not say the application made it", { request: (frame: Record<string, any>) => Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "origin")) }],
    ["a response with another status", { response: (frame: Record<string, any>) => ({ ...frame, status: 404 }) }],
    ["a response with another body", { response: (frame: Record<string, any>) => ({ ...frame, body: { status: "out" } }) }],
    ["a response to another request", { response: (frame: Record<string, any>) => ({ ...frame, requestId: "foreign" }) }],
  ])("is not a pass with %s, even though the frames are digest-consistent", (_label, edits) => {
    const verdict = qualifyE2EApplicationCollection(oracle, withMockFrames(collection, edits));
    expect(verdict.status, verdict.reason).toBe("UNKNOWN");
    // The frames themselves are well formed, so the collector reached the case and found its mock evidence not to be what the approved fixture would give.
    expect(verdict.result?.cases[0]).toMatchObject({ status: "unavailable", reason: "application-evidence-floor-unmet" });
  });

  it("is not a pass when a call no mock matched is recorded for the case, and says why", () => {
    const readback = collection.supervisorReadback as unknown as { receipt: Wire; evidence: Wire[] };
    const receipt = frameOf(readback.receipt);
    const capture = receipt.caseCaptures[0];
    const call = { requestId: "inventory-v1-req-injected", origin: "inventory-v1", kind: "unmatched", method: "GET", path: "/internal/admin", observedAt: receipt.context.observedAt };
    const frame = encode({ schemaVersion: "e2e-application-unmocked-calls/v1", context: receipt.context, caseId: capture.caseId, shardId: capture.shardId,
      upstreamRunId: receipt.launches[0].upstreamRunId, calls: [call] }, "rovara-unmocked-calls-injected");
    const injected = withReceipt(collection, (next) => { next.unmockedCalls = [{ caseId: capture.caseId, shardId: capture.shardId, ref: frame.ref }]; }, (list) => [...list, frame]);
    const verdict = qualifyE2EApplicationCollection(oracle, { ...injected, unmockedCalls: [{ caseId: capture.caseId, shardId: capture.shardId, calls: [call] }] } as E2EApplicationCollection);
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.reason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    expect(verdict.result?.cases[0]).toMatchObject({ status: "unavailable", reason: UNMOCKED_EXTERNAL_CALL_REASON });
    expect(verdict.result?.reason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    expect(verdict.mockSummary?.unmockedCalls).toEqual({ sinkhole: 0, mocked: 1 });
    // The same frame without the collection's own copy of it is not accepted: the two must agree.
    expect(qualifyE2EApplicationCollection(oracle, injected).status).toBe("UNKNOWN");
    expect(qualifyE2EApplicationCollection(oracle, injected).reason).toMatch(/unmocked call rows differ/);
  });

  it("is not a pass when the collection's consumption rows differ from the retained frames", () => {
    const changed = structuredClone(collection);
    changed.mockConsumptions[0]!.responseSha256 = "0".repeat(64);
    expect(qualifyE2EApplicationCollection(oracle, changed).status).toBe("UNKNOWN");
  });
});

describe("the verdict on a run whose inventory origin has no approved mock", () => {
  const { oracle, collection } = load("web-unmocked-call-v1");

  it("is UNKNOWN for unmocked-external-call, never a pass, although every assertion of the case held", () => {
    const verdict = qualifyE2EApplicationCollection(oracle, collection);
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.reason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    const only = verdict.result!.cases[0]!;
    expect(only).toMatchObject({ status: "unavailable", reason: UNMOCKED_EXTERNAL_CALL_REASON });
    // The app hid the failed call behind the answer the page expects, so the approved assertion itself was met: the call is the only fact against a pass.
    expect(only.assertionReceipts.map((receipt) => receipt.status)).toEqual(["passed"]);
    expect(verdict.result).toMatchObject({ status: "unavailable", reason: UNMOCKED_EXTERNAL_CALL_REASON });
    expect(verdict.mockSummary).toEqual({ consumptions: { success: 0, refusal: 0, invalidData: 0 }, unmockedCalls: { sinkhole: 1, mocked: 0 }, mockedOrigins: [] });
  });

  it("has no mock to name: the origin is not listed as mocked", () => {
    expect(oracle.mockOrigins).toBeUndefined();
    expect(qualifyE2EApplicationCollection(oracle, collection).result?.mockedOrigins).toBeUndefined();
  });

  it("records the call as made to the sinkhole, with the path the app asked for", () => {
    expect(collection.unmockedCalls).toHaveLength(1);
    expect(collection.unmockedCalls![0]!.calls).toMatchObject([{ origin: "unbound", kind: "unmatched", method: "GET", path: "/v1/stock" }]);
  });
});
