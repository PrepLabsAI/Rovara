/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the test edits retained frames whose shape the schemas under test judge */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/index.js";
import { E2EApplicationCollectionOracleSchema, E2EApplicationCollectionSchema, UNDECLARED_MOCK_CONSUMPTION_REASON, UNMOCKED_EXTERNAL_CALL_REASON,
  qualifyE2EApplicationCollection, requiredHostedMockSpecs, type E2EApplicationCollection } from "../../packages/verifier/src/application-result-adapter.js";
import { buildScenarioRows } from "../../packages/broker/src/e2e/application-display.js";
import { fixtureEvidence } from "../support/web-api-qualification.js";

// MOCKUNUSED. The recorded run of the qualification app whose inventory origin is served by the approved, host-served mock is the base: its one case consumed the mock once. Here the
// same case is edited into a deny-only case that never reaches the dependency (zero mock rows, zero unmocked calls), with every frame digest-consistent, and the same pure code the
// broker runs judges it. The oracle is never edited except where a test says so.
type Wire = { ref: { artifactId: string; sha256: string; byteLength: number; mediaType: string }; bytesBase64: string };
const frameOf = (wire: Wire) => JSON.parse(Buffer.from(wire.bytesBase64, "base64").toString("utf8")) as Record<string, any>;
function encode(value: unknown, artifactId: string): Wire {
  const bytes = Buffer.from(canonicalJson(value));
  return { ref: { artifactId, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType: "application/json" }, bytesBase64: bytes.toString("base64") };
}
const evidence = fixtureEvidence("web-mock-origin-v1");
if (evidence.kind !== "collected") throw new Error("fixture is not a collected run");
const oracle = E2EApplicationCollectionOracleSchema.parse(evidence.oracle);
const collection = E2EApplicationCollectionSchema.parse(evidence.collection);
const hostedComponentId = oracle.mockOrigins![0]!.componentId;

/**
 * The collection with its case capture's coverage rewritten (and the receipt, the receipt refs and the capture copy that name it), optionally without the mock consumption: the capture
 * is a retained frame, so it is re-encoded and re-referenced rather than patched in place.
 */
function withCoverage(change: (coverage: Record<string, any>) => void, dropConsumption: boolean): E2EApplicationCollection {
  const copy: any = structuredClone(collection);
  const readback = copy.supervisorReadback as { receipt: Wire; evidence: Wire[] };
  const receipt = frameOf(readback.receipt);
  const captureRef = receipt.caseCaptures[0].ref;
  const capture = frameOf(readback.evidence.find((wire) => wire.ref.artifactId === captureRef.artifactId)!);
  change(capture.coverage);
  const nextCapture = encode(capture, captureRef.artifactId);
  receipt.caseCaptures[0].ref = nextCapture.ref;
  if (dropConsumption) receipt.mockConsumptions = [];
  const nextReceipt = encode(receipt, readback.receipt.ref.artifactId);
  readback.evidence = readback.evidence.filter((wire) => !dropConsumption || !/mock-(request|response|consumption)/.test(wire.ref.artifactId))
    .map((wire) => (wire.ref.artifactId === nextCapture.ref.artifactId ? nextCapture : wire)).sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId));
  readback.receipt = nextReceipt;
  copy.supervisorReceiptRefs = copy.supervisorReceiptRefs.map((ref: any) => (ref.artifactId === nextReceipt.ref.artifactId ? nextReceipt.ref : ref.artifactId === nextCapture.ref.artifactId ? nextCapture.ref : ref));
  copy.applicationCaptures = [{ ...copy.applicationCaptures[0], coverage: { ...copy.applicationCaptures[0].coverage, ...capture.coverage } }];
  if (dropConsumption) copy.mockConsumptions = [];
  return E2EApplicationCollectionSchema.parse(copy);
}
const denyOnly = () => withCoverage((coverage) => { coverage.observedMockedComponentIds = []; }, true);

describe("a deny-only case on a target that has a host-served mock", () => {
  it("is the case the recorded run is not: no mock row, no unmocked call, the hosted mock permitted for the target", () => {
    expect(collection.mockConsumptions).toHaveLength(1);
    expect(denyOnly().mockConsumptions).toEqual([]);
    expect(denyOnly().unmockedCalls ?? []).toEqual([]);
    expect(oracle.expectedMocksByCase[0]!.specs.map((spec) => spec.componentId)).toEqual([hostedComponentId]);
    expect(oracle.applicationIdsByCase[0]!.scenario.steps.some((step) => step.kind === "request")).toBe(false);
  });

  it("passes, and coverage says honestly that the mock was declared and never observed", () => {
    const verdict = qualifyE2EApplicationCollection(oracle, denyOnly());
    expect(verdict.status, verdict.reason).toBe("PASS");
    const only = verdict.result!.cases[0]!;
    expect(only).toMatchObject({ status: "passed", reason: "structural-application-observations-complete" });
    expect(only.coverage.mockedComponentIds).toEqual([hostedComponentId]);
    expect(only.coverage.observedMockedComponentIds).toEqual([]);
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 0, refusal: 0, invalidData: 0 });
  });

  it("still judges a call the application does make: an unmocked call is UNKNOWN, never a pass", () => {
    const base: any = denyOnly();
    const readback = base.supervisorReadback as { receipt: Wire; evidence: Wire[] };
    const receipt = frameOf(readback.receipt);
    const capture = receipt.caseCaptures[0];
    const call = { requestId: "inventory-v1-req-injected", origin: "inventory-v1", kind: "unmatched", method: "GET", path: "/internal/admin", observedAt: receipt.context.observedAt };
    const frame = encode({ schemaVersion: "e2e-application-unmocked-calls/v1", context: receipt.context, caseId: capture.caseId, shardId: capture.shardId,
      upstreamRunId: receipt.launches[0].upstreamRunId, calls: [call] }, "rovara-unmocked-calls-injected");
    receipt.unmockedCalls = [{ caseId: capture.caseId, shardId: capture.shardId, ref: frame.ref }];
    const nextReceipt = encode(receipt, readback.receipt.ref.artifactId);
    readback.evidence = [...readback.evidence, frame].sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId));
    readback.receipt = nextReceipt;
    base.supervisorReceiptRefs = base.supervisorReceiptRefs.map((ref: any) => (ref.artifactId === nextReceipt.ref.artifactId ? nextReceipt.ref : ref));
    base.unmockedCalls = [{ caseId: capture.caseId, shardId: capture.shardId, calls: [call] }];
    const verdict = qualifyE2EApplicationCollection(oracle, base as E2EApplicationCollection);
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.result?.cases[0]).toMatchObject({ status: "unavailable", reason: UNMOCKED_EXTERNAL_CALL_REASON });
  });

  it("stays UNKNOWN when the capture claims a mock was observed that no consumption row witnesses", () => {
    const claimed = withCoverage(() => undefined, true);
    expect(qualifyE2EApplicationCollection(oracle, claimed).status).toBe("UNKNOWN");
  });

  it("is judged exactly as before when the application did call the mock (the recorded run still passes)", () => {
    const verdict = qualifyE2EApplicationCollection(oracle, collection);
    expect(verdict.status, verdict.reason).toBe("PASS");
    expect(verdict.result!.cases[0]!.coverage.observedMockedComponentIds).toEqual([hostedComponentId]);
  });
});

describe("which hosted mocks a scenario requires", () => {
  const spec = oracle.expectedMocksByCase[0]!.specs[0]!;
  const fixture = spec.apiFixture!;
  const scenarioOf = (steps: readonly Record<string, unknown>[]) => ({ ...oracle.applicationIdsByCase[0]!.scenario, steps }) as unknown as Parameters<typeof requiredHostedMockSpecs>[0];
  const request = (method: string, path: string) => ({ kind: "request", requestId: "r1", method, path, body: { orderId: "a1" } });

  it("requires the mock a request step of the scenario names (method and path)", () => {
    expect(requiredHostedMockSpecs(scenarioOf([request(fixture.method, fixture.path)]), [spec])).toEqual([spec]);
  });

  it("only permits a mock that no request step names, whatever the other steps do", () => {
    expect(requiredHostedMockSpecs(scenarioOf([request("GET", "/api/orders.csv")]), [spec])).toEqual([]);
    expect(requiredHostedMockSpecs(scenarioOf([request("POST", fixture.path)]), [spec])).toEqual([]);
    expect(requiredHostedMockSpecs(scenarioOf([{ kind: "navigate", path: "/" }, { kind: "click", testId: "check-inventory" }]), [spec])).toEqual([]);
  });

  it("keeps a hosted mock with no API fixture to compare required, as before", () => {
    const opaque = { ...spec, kind: "state", apiFixture: undefined } as unknown as typeof spec;
    expect(requiredHostedMockSpecs(scenarioOf([]), [opaque])).toEqual([opaque]);
  });
});

describe("a case that consumed a group mock it did not declare (a hybrid group)", () => {
  // The host serves a group's mock to every target of a hybrid group, so a case on a target the plan gave no mock still reaches it. The collector sees a consumption row for a component
  // the case's own expectation does not list; the row here names a component that is not the case's, which is the same fact seen from the case.
  const foreign = "api-schema-ffffffffffff";
  function withForeignConsumption(): E2EApplicationCollection {
    const copy: any = structuredClone(collection);
    const readback = copy.supervisorReadback as { receipt: Wire; evidence: Wire[] };
    const receipt = frameOf(readback.receipt);
    const entry = receipt.mockConsumptions[0];
    const consumption = frameOf(readback.evidence.find((wire) => wire.ref.artifactId === entry.ref.artifactId)!);
    consumption.rows[0].componentId = foreign;
    const nextConsumption = encode(consumption, entry.ref.artifactId);
    entry.ref = nextConsumption.ref;
    const captureRef = receipt.caseCaptures[0].ref;
    const capture = frameOf(readback.evidence.find((wire) => wire.ref.artifactId === captureRef.artifactId)!);
    capture.coverage.observedMockedComponentIds = [foreign];
    const nextCapture = encode(capture, captureRef.artifactId);
    receipt.caseCaptures[0].ref = nextCapture.ref;
    const nextReceipt = encode(receipt, readback.receipt.ref.artifactId);
    readback.evidence = readback.evidence.map((wire) => (wire.ref.artifactId === nextConsumption.ref.artifactId ? nextConsumption : wire.ref.artifactId === nextCapture.ref.artifactId ? nextCapture : wire));
    readback.receipt = nextReceipt;
    copy.supervisorReceiptRefs = copy.supervisorReceiptRefs.map((ref: any) => [nextReceipt, nextConsumption, nextCapture].find((wire) => wire.ref.artifactId === ref.artifactId)?.ref ?? ref);
    copy.mockConsumptions = [{ ...copy.mockConsumptions[0], componentId: foreign }];
    copy.applicationCaptures = [{ ...copy.applicationCaptures[0], coverage: { ...copy.applicationCaptures[0].coverage, observedMockedComponentIds: [foreign] } }];
    return E2EApplicationCollectionSchema.parse(copy);
  }

  it("is UNKNOWN with the specific reason, not 'the evidence was not enough'", () => {
    const verdict = qualifyE2EApplicationCollection(oracle, withForeignConsumption());
    expect(verdict.status, verdict.reason).toBe("UNKNOWN");
    expect(verdict.result!.cases[0]).toMatchObject({ status: "unavailable", reason: UNDECLARED_MOCK_CONSUMPTION_REASON });
    expect(UNDECLARED_MOCK_CONSUMPTION_REASON).toBe("undeclared-mock-consumption");
  });

  it("is never a pass, although every assertion held", () => {
    const only = qualifyE2EApplicationCollection(oracle, withForeignConsumption()).result!.cases[0]!;
    expect(only.assertionReceipts.map((receipt) => receipt.status)).toEqual(["passed"]);
    expect(only.status).not.toBe("passed");
  });
});

describe("what the owner reads for that reason", () => {
  it("is a fixed sentence about the stand-in service, not 'the evidence was not enough'", () => {
    const item = { caseId: "viewer-case", scenarioId: "viewer-access", targetId: "web-1", accountProfileId: "orders-viewer" };
    const { scenarios } = buildScenarioRows({ authoritative: true, attach: "failed-or-incomplete", targetKinds: new Map([["web-1", "web"]]),
      groups: [{ verdict: "UNKNOWN", reason: "", cases: [item], scenarios: new Map([["viewer-access", { assertions: [{ kind: "visible", testId: "export-csv", equals: false }] }]]),
        result: { cases: [{ caseId: item.caseId, status: "unavailable", reason: UNDECLARED_MOCK_CONSUMPTION_REASON, assertionReceipts: [{ assertionIndex: 0, status: "passed" }] }] },
        observed: new Map(), screenshots: new Map() }] });
    expect(scenarios[0]).toMatchObject({ status: "UNKNOWN", reason: "called a stand-in service the plan did not set for this check's target" });
  });
});
