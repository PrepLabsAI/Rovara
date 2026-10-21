import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, e2eApiSchemaComponentId, type E2EApiMockFixture, type E2EMockSpec } from "../../packages/contracts/src/index.js";
import { mockOriginHost, mockOriginUrl, planApplicationOrigins } from "../../packages/verifier/src/application-mocks.js";
import { MOCK_UNMOCKED_RESPONSE_DIGEST, mockRequestDigest, mockResponseDigest, type MockLedgerLine } from "../../packages/verifier/src/executor/mock-server.js";
import { bindMockLedgers, parseMockLedger } from "../../packages/verifier/src/host/mock-ledger.js";
import { buildMockProofs } from "../../packages/verifier/src/host/mock-proofs.js";

const fixture: E2EApiMockFixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "getStock", method: "GET", path: "/v1/stock", inputField: "orderId", variants: [
  { id: "success", inputValue: "a1", status: 200, body: { status: "in-stock" } },
  { id: "refusal", inputValue: "a2", status: 404, body: { error: "unknown order" } },
  { id: "invalid-data", inputValue: "b1", status: 200, body: { status: 7 } },
] };
const componentId = e2eApiSchemaComponentId("inventory/openapi.json");
const spec = (overrides: Partial<E2EMockSpec> = {}): E2EMockSpec => ({ componentId, requestedTargetId: "web-1", effectiveTargetId: "web-1", kind: "api", contractDigest: "a".repeat(64),
  fixtureVersion: "openapi-json-fixture-v1", sourceRefs: [{ path: "inventory/openapi.json", sha256: "b".repeat(64) }], reason: "phase-unavailable", apiFixture: fixture, ...overrides });
const bindings = [{ originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }, { originRef: "inventory-v1", envName: "INVENTORY_ORIGIN", contractPath: "inventory/openapi.json" }];

describe("placing approved mocks on a service's declared origins", () => {
  it("serves an approved mock as the origin whose contract it stands for and gives every other declared origin to the sinkhole", () => {
    const plan = planApplicationOrigins({ originBindings: bindings, mocks: [spec()] });
    expect(plan.mocked).toEqual([{ originRef: "inventory-v1", envName: "INVENTORY_ORIGIN", componentId, fixture }]);
    expect(plan.unbound).toEqual([{ originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }]);
    expect(plan.unplaced).toEqual([]);
  });

  it("leaves every origin to the sinkhole when no mock is approved", () => {
    const plan = planApplicationOrigins({ originBindings: bindings, mocks: [] });
    expect(plan.mocked).toEqual([]);
    expect(plan.unbound.map((item) => item.originRef)).toEqual(["inventory-v1", "orders-api"]);
  });

  it("serves one origin once when two targets approve the same fixture, and refuses two different fixtures for one origin", () => {
    expect(planApplicationOrigins({ originBindings: bindings, mocks: [spec(), spec({ requestedTargetId: "web-2", effectiveTargetId: "web-2" })] }).mocked).toHaveLength(1);
    const other: E2EApiMockFixture = { ...fixture, variants: [{ ...fixture.variants[0]!, body: { status: "low" } }, fixture.variants[1]!, fixture.variants[2]!] };
    expect(() => planApplicationOrigins({ originBindings: bindings, mocks: [spec(), spec({ requestedTargetId: "web-2", effectiveTargetId: "web-2", apiFixture: other })] })).toThrow(/two different approved fixtures/);
  });

  it("reports a mock that no origin claims instead of guessing an origin for it", () => {
    const stranger = spec({ componentId: e2eApiSchemaComponentId("other/openapi.json") });
    expect(planApplicationOrigins({ originBindings: bindings, mocks: [stranger] }).unplaced).toEqual([stranger]);
    expect(planApplicationOrigins({ originBindings: [{ originRef: "inventory-v1", envName: "INVENTORY_ORIGIN" }], mocks: [spec()] }).unplaced).toHaveLength(1);
  });

  it.each([["unbound"], ["has space"], ["../up"], ["a".repeat(60)], ["_leading"]])("refuses an origin name a container cannot carry: %s", (originRef) => {
    expect(() => planApplicationOrigins({ originBindings: [{ originRef, envName: "INVENTORY_ORIGIN", contractPath: "inventory/openapi.json" }], mocks: [spec()] })).toThrow(/cannot be served/);
  });

  it("refuses a claimed mock that is not a source-backed API fixture", () => {
    const { apiFixture: _fixture, ...withoutFixture } = spec();
    void _fixture;
    expect(() => planApplicationOrigins({ originBindings: bindings, mocks: [withoutFixture as E2EMockSpec] })).toThrow(/not a source-backed API fixture/);
    expect(() => planApplicationOrigins({ originBindings: bindings, mocks: [spec({ kind: "database" })] })).toThrow(/not a source-backed API fixture/);
  });

  it("serves at most eight mocked origins in one run, one container each", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ originRef: `origin-${index}`, envName: `ORIGIN_${index}_URL`, contractPath: `svc-${index}/openapi.json` }));
    const mocks = many.map((item) => spec({ componentId: e2eApiSchemaComponentId(item.contractPath) }));
    expect(planApplicationOrigins({ originBindings: many.slice(0, 8), mocks: mocks.slice(0, 8) }).mocked).toHaveLength(8);
    expect(() => planApplicationOrigins({ originBindings: many, mocks })).toThrow(/at most 8 mocked origins/);
  });

  it("names an origin's host only ever as one of the run's own containers", () => {
    expect(mockOriginHost("inventory-v1")).toBe("mock-inventory-v1");
    expect(mockOriginUrl("unbound")).toBe("http://mock-unbound:8080");
  });
});

describe("the frames a run's mock ledgers become", () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const at = (ms: number) => new Date(Date.parse("2026-10-20T12:00:00.000Z") + ms).toISOString();
  const consumption = (variantId: "success" | "refusal", ms: number, id: string): MockLedgerLine => {
    const variant = fixture.variants.find((item) => item.id === variantId)!;
    return { requestId: id, method: "GET", path: "/v1/stock", inputValue: variant.inputValue, variantId, status: variant.status,
      requestSha256: mockRequestDigest({ method: "GET", path: "/v1/stock", inputValue: variant.inputValue }), responseSha256: mockResponseDigest({ status: variant.status, body: variant.body }), observedAt: at(ms) };
  };
  const unmatched = (ms: number, id: string): MockLedgerLine => ({ requestId: id, method: "GET", path: "/internal/admin", inputValue: null, variantId: null, status: 599,
    requestSha256: mockRequestDigest({ method: "GET", path: "/internal/admin", inputValue: null }), responseSha256: MOCK_UNMOCKED_RESPONSE_DIGEST, observedAt: at(ms) });
  const ledger = (origin: string, id: string | null, lines: MockLedgerLine[], withFixture = true) =>
    parseMockLedger({ origin, componentId: id, fixture: withFixture ? fixture : null, bytes: Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
  const proof = (value: unknown, mediaType: string, artifactId: string) => {
    const bytes = Buffer.from(typeof value === "string" ? value : canonicalJson(value));
    return { ref: { artifactId, sha256: sha(bytes), byteLength: bytes.byteLength, mediaType }, bytes };
  };
  const windows = [{ caseId: "case-a", startMs: Date.parse(at(0)), endMs: Date.parse(at(100)) }, { caseId: "case-b", startMs: Date.parse(at(200)), endMs: Date.parse(at(300)) }];
  const build = () => {
    const bound = bindMockLedgers({ ledgers: [ledger("inventory-v1", componentId, [consumption("success", 10, "req-1"), consumption("refusal", 20, "req-2"), unmatched(250, "req-3")]),
      ledger("unbound", null, [unmatched(30, "req-4")], false)], windows, caseIds: ["case-a", "case-b"] });
    return buildMockProofs({ runId: "11111111-1111-4111-8111-111111111111", mockManifestDigest: "c".repeat(64), lifecycleId: "rovara-executor-x", context: { marker: "context" }, producer: { marker: "producer" },
      cases: [{ caseId: "case-b", shardId: "shard", upstreamRunId: "u" }, { caseId: "case-a", shardId: "shard", upstreamRunId: "u" }], bound, proof });
  };
  const parse = (frame: { bytes: Uint8Array }) => JSON.parse(Buffer.from(frame.bytes).toString("utf8")) as Record<string, unknown> & { rows?: Record<string, unknown>[]; calls?: Record<string, unknown>[] };

  it("makes a request frame, a response frame and a row of hashes of those exact bytes for every consumption, marked as the application's own call", () => {
    const proofs = build();
    const consumptionFrame = proofs.frames.find((frame) => frame.ref.artifactId.includes("mock-consumption") && parse(frame).caseId === "case-a")!;
    const rows = parse(consumptionFrame).rows!;
    expect(rows).toHaveLength(2);
    const byId = new Map(proofs.frames.map((frame) => [frame.ref.artifactId, frame]));
    for (const row of rows) {
      const request = byId.get((row.requestRef as { artifactId: string }).artifactId)!; const response = byId.get((row.responseRef as { artifactId: string }).artifactId)!;
      expect(row.requestSha256).toBe(sha(request.bytes));
      expect(row.responseSha256).toBe(sha(response.bytes));
      expect(parse(request)).toMatchObject({ requestId: row.requestId, componentId, caseId: "case-a", method: "GET", path: "/v1/stock", origin: "application" });
      expect(parse(response)).toMatchObject({ requestId: row.requestId, responseId: row.responseId });
      expect(row).toMatchObject({ caseId: "case-a", componentId, runId: "11111111-1111-4111-8111-111111111111", mockManifestDigest: "c".repeat(64), lifecycleId: "rovara-executor-x", producer: { marker: "producer" } });
    }
    expect(rows.map((row) => parse(byId.get((row.requestRef as { artifactId: string }).artifactId)!).input)).toEqual([{ orderId: "a1" }, { orderId: "a2" }]);
    expect(rows.map((row) => parse(byId.get((row.responseRef as { artifactId: string }).artifactId)!).status)).toEqual([200, 404]);
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
  });

  it("lists the case's calls no mock matched in a frame of their own, and a call outside every window in every case's frame", () => {
    const proofs = build();
    const frames = proofs.frames.filter((frame) => frame.ref.artifactId.includes("unmocked-calls")).map(parse);
    expect(frames.map((frame) => [frame.caseId, frame.calls!.map((call) => [call.origin, call.kind])])).toEqual([
      ["case-a", [["unbound", "unmatched"]]], ["case-b", [["inventory-v1", "unmatched"]]]]);
    expect(proofs.unmockedEntries.map((entry) => entry.caseId)).toEqual(["case-a", "case-b"]);
  });

  it("orders the receipt entries by case id and reports the components each case really consumed", () => {
    const proofs = build();
    expect(proofs.consumptionEntries.map((entry) => entry.caseId)).toEqual(["case-a"]);
    expect(proofs.observedComponentsByCase.get("case-a")).toEqual([componentId]);
    expect(proofs.observedComponentsByCase.get("case-b")).toEqual([]);
  });

  it("gives every frame a distinct artifact id", () => {
    const ids = build().frames.map((frame) => frame.ref.artifactId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
