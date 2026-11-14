// Proof and evidence E8 (contracts): the fixture set a mock serves, the request hash it is found by, the unmatched-request words, what a mock reports back, and the SDK endpoint variable.
import { describe, expect, it } from "vitest";
import * as mocks from "../../packages/contracts/src/service-mocks.js";

const hash = (body: string, over: Partial<Parameters<typeof mocks.serviceMockRequestHash>[0]> = {}) => mocks.serviceMockRequestHash({ service: "sagemaker_runtime", target: "partner-scorer", method: "POST", contentType: "application/json", body, ...over });
const entry = (body = '{"partner":"p1"}', over: Record<string, unknown> = {}) => ({ requestHash: hash(body), request: { contentType: "application/json", body }, response: { status: 200, contentType: "application/json", body: '{"score":0.82}', latencyMs: 40 }, ...over });
const set = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, service: { name: "partner-scorer", kind: "sagemaker_runtime", target: "partner-scorer" }, revision: 1, recordedAt: "2026-11-02T00:00:00.000Z", syntheticOnly: true,
  requestSchema: { type: "object", properties: { partner: { type: "string" } }, required: ["partner"], additionalProperties: false },
  responseSchema: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 1 } }, required: ["score"] },
  entries: [entry()], faults: [{ name: "slow-timeout", kind: "timeout", delayMs: 30000 }, { name: "busy", kind: "throttle", status: 429, delayMs: 0 }],
  ...over,
});
const ok = (value: unknown) => mocks.ServiceMockFixtureSetSchema.safeParse(value).success;

describe("request hash", () => {
  it("is one request for a JSON body whatever its key order or spacing", () => {
    expect(hash('{"a":1,"b":{"c":2,"d":3}}')).toBe(hash('{ "b": {"d":3, "c":2}, "a": 1 }'));
    expect(hash('{"a":1}')).not.toBe(hash('{"a":2}'));
  });
  it("includes the service, target, method and content type, so the same bytes elsewhere find nothing", () => {
    const base = hash('{"a":1}');
    expect(hash('{"a":1}', { target: "other-endpoint" })).not.toBe(base);
    expect(hash('{"a":1}', { service: "http" })).not.toBe(base);
    expect(hash('{"a":1}', { method: "PUT" })).not.toBe(base);
    expect(hash('{"a":1}', { contentType: "text/plain" })).not.toBe(base);
    expect(hash('{"a":1}', { method: "post", contentType: "Application/JSON; charset=utf-8" })).toBe(base);
  });
  it("hashes a body that is not JSON as written, even under a JSON content type", () => {
    expect(hash("not json")).toBe(hash("not json"));
    expect(hash("not json")).not.toBe(hash("not  json"));
    expect(hash("a,b\n1,2", { contentType: "text/csv" })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("fixture set", () => {
  it("accepts a recorded set and round-trips it", () => {
    expect(mocks.ServiceMockFixtureSetSchema.parse(set())).toEqual(set());
  });
  it("is synthetic only and strict", () => {
    expect(ok(set({ syntheticOnly: false }))).toBe(false);
    expect(ok(set({ extra: 1 }))).toBe(false);
    expect(ok(set({ entries: [{ ...entry(), extra: 1 }] }))).toBe(false);
  });
  it("bounds entries (500), bodies (64 KiB, counted in bytes), faults (20) and latency (30 s)", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => entry(`{"n":${String(index)}}`));
    expect(ok(set({ entries: many(500) }))).toBe(true);
    expect(ok(set({ entries: many(501) }))).toBe(false);
    expect(ok(set({ entries: [entry('{"a":1}', { response: { status: 200, contentType: "application/json", body: "x".repeat(65_536), latencyMs: 0 } })] }))).toBe(true);
    expect(ok(set({ entries: [entry('{"a":1}', { response: { status: 200, contentType: "application/json", body: "x".repeat(65_537), latencyMs: 0 } })] }))).toBe(false);
    expect(ok(set({ entries: [entry('{"a":1}', { response: { status: 200, contentType: "application/json", body: "é".repeat(40_000), latencyMs: 0 } })] }))).toBe(false);
    expect(ok(set({ entries: [entry('{"a":1}', { response: { status: 200, contentType: "application/json", body: "{}", latencyMs: 30_001 } })] }))).toBe(false);
    expect(ok(set({ faults: Array.from({ length: 21 }, (_, index) => ({ name: `f${String(index)}`, kind: "http_5xx", status: 500, delayMs: 0 })) }))).toBe(false);
  });
  it("has one recording per request and fault names that are unique", () => {
    expect(ok(set({ entries: [entry(), entry()] }))).toBe(false);
    expect(ok(set({ faults: [{ name: "a", kind: "timeout", delayMs: 1 }, { name: "a", kind: "timeout", delayMs: 1 }] }))).toBe(false);
  });
  it("gives a timeout no status and every other fault one in the error range", () => {
    const fault = (over: Record<string, unknown>) => ok(set({ faults: [{ name: "f", delayMs: 0, ...over }] }));
    expect(fault({ kind: "timeout" })).toBe(true);
    expect(fault({ kind: "timeout", status: 500 })).toBe(false);
    expect(fault({ kind: "http_5xx" })).toBe(false);
    expect(fault({ kind: "http_5xx", status: 503 })).toBe(true);
    expect(fault({ kind: "throttle", status: 200 })).toBe(false);
  });
  it("bounds a schema's depth (32) and size (2,048 nodes)", () => {
    const deep = (levels: number): mocks.ServiceMockJsonSchema => (levels === 0 ? { type: "string" } : { type: "object", properties: { next: deep(levels - 1) } });
    expect(ok(set({ requestSchema: deep(30) }))).toBe(true);
    expect(ok(set({ requestSchema: deep(40) }))).toBe(false);
    const wide: mocks.ServiceMockJsonSchema = { type: "object", properties: Object.fromEntries(Array.from({ length: 2_100 }, (_, index) => [`p${String(index)}`, { type: "string" as const }])) };
    expect(ok(set({ responseSchema: wide }))).toBe(false);
    expect(ok(set({ requestSchema: null, responseSchema: null }))).toBe(true);
    expect(ok(set({ requestSchema: { type: "object", unknownKeyword: true } }))).toBe(false);
  });
  it("has a digest that is stable, order-independent and changes with any recording", () => {
    const digest = mocks.serviceMockFixtureSetDigest(mocks.ServiceMockFixtureSetSchema.parse(set()));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.serviceMockFixtureSetDigest(mocks.ServiceMockFixtureSetSchema.parse(set()))).toBe(digest);
    const changed = set({ entries: [entry('{"partner":"p1"}', { response: { status: 200, contentType: "application/json", body: '{"score":0.83}', latencyMs: 40 } })] });
    expect(mocks.serviceMockFixtureSetDigest(mocks.ServiceMockFixtureSetSchema.parse(changed))).not.toBe(digest);
  });
});

describe("unmatched requests", () => {
  it("fail with a 500 and fixed words by default, and schema_synth is the other choice", () => {
    expect(mocks.SERVICE_MOCK_UNMATCHED_STATUS).toBe(500);
    expect(mocks.SERVICE_MOCK_NO_RECORDING_MESSAGE).toBe("mock had no recording");
    expect(mocks.ServiceMockUnmatchedSchema.options).toEqual(["fail", "schema_synth"]);
  });
});

describe("what a mock reports", () => {
  const usage = (over: Record<string, unknown> = {}) => ({ service: "partner-scorer", matched: 12, unmatchedFailed: 0, synthesized: 3, faultsInjected: [{ name: "busy", count: 2 }], ...over });
  it("counts matched, failed, synthesized and injected requests, so the evidence is never silent about a mock", () => {
    expect(mocks.ServiceMockUsageSchema.safeParse(usage()).success).toBe(true);
    expect(mocks.ServiceMockUsageSchema.safeParse(usage({ synthesized: -1 })).success).toBe(false);
    expect(mocks.ServiceMockUsageSchema.safeParse(usage({ faultsInjected: [{ name: "busy", count: 0 }] })).success).toBe(false);
    expect(mocks.ServiceMockUsageSchema.safeParse(usage({ extra: 1 })).success).toBe(false);
  });
});

describe("SDK endpoint variable", () => {
  it("is AWS_ENDPOINT_URL_ and the service id uppercased with spaces as underscores", () => {
    expect(mocks.awsEndpointUrlVariable("SageMaker Runtime")).toBe("AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME");
    expect(mocks.awsEndpointUrlVariable("S3")).toBe("AWS_ENDPOINT_URL_S3");
    expect(mocks.awsEndpointUrlVariable("Bedrock Runtime")).toBe("AWS_ENDPOINT_URL_BEDROCK_RUNTIME");
  });
  it("refuses anything that could end the variable's name or add to it", () => {
    for (const id of ["", "a=b", "x\ny", "a-b", "../x", " ", "a".repeat(65)]) expect(() => mocks.awsEndpointUrlVariable(id), JSON.stringify(id)).toThrow(RangeError);
  });
});
