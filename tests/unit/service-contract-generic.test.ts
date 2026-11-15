import { describe, expect, it } from "vitest";
import { findServiceContract, isServiceContract, type AdapterRead, type ContractAdapter } from "../../packages/broker/src/core/test-env/service-contract.js";
import { generateServiceMock, serviceMockConfigSchema } from "../../packages/broker/src/core/test-env/service-contract-mock.js";
import { sageMakerAdapter } from "../../packages/broker/src/core/test-env/sagemaker-contract.js";
import { SageMakerMockConfigSchema } from "../../packages/broker/src/core/test-env/sagemaker-mock.js";

// A second, made-up service: its fixture is plain "key=value" lines (not JSON), it has no inference source, and it has its own error case.
// It exists to prove the generic interface (contract source -> answer shape -> labelled mock config) is not tied to SageMaker or to JSON.
const lineFixtureAdapter: ContractAdapter = {
  service: "fake-lines",
  kinds: ["fixture", "output_schema"],
  errorCases: [{ scenario: "unavailable", status: 503 }],
  errorRateKeys: ["unavailable"],
  read(file): AdapterRead {
    if (file.kind === "output_schema") return { status: "unsupported", reason: "invalid_json" };
    const value: Record<string, unknown> = {};
    for (const line of file.content.split("\n").filter((entry) => entry !== "")) {
      const at = line.indexOf("=");
      if (at < 1) return { status: "unsupported", reason: "invalid_json" };
      const raw = line.slice(at + 1);
      value[line.slice(0, at)] = raw === "true" ? true : raw === "false" ? false : raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    return { status: "ok", form: "example", value, pointer: "lines" };
  },
};
const lines = (content = "name=ada\ncount=3\nok=true") => ({ kind: "fixture" as const, path: "tests/answers.txt", content });

describe("generic service contract finder, second adapter", () => {
  it("finds a contract through an adapter that is not SageMaker and not JSON, with provenance", () => {
    const result = findServiceContract(lineFixtureAdapter, [{ kind: "output_schema", path: "schema.txt", content: "x" }, lines()]);
    expect(result).toMatchObject({ status: "found", contract: { source: { kind: "fixture", path: "tests/answers.txt", pointer: "lines" } }, inputs: [{ reason: "lower_priority" }, { reason: "selected" }] });
    if (result.status !== "found") return;
    expect(result.contract.shape).toMatchObject({ type: "object", fields: [
      { name: "name", required: true, shape: { type: "string", source: { pointer: "lines/name" } } },
      { name: "count", shape: { type: "number" } },
      { name: "ok", shape: { type: "boolean" } },
    ] });
    expect(JSON.stringify(result.contract)).not.toContain("ada");
    expect(isServiceContract(result.contract)).toBe(true);
  });
  it("refuses a source kind the adapter does not list, and a file the adapter cannot read, by fixed reason", () => {
    expect(findServiceContract(lineFixtureAdapter, [{ kind: "inference", path: "model.py", content: "return 1" }])).toEqual({
      status: "not_found", message: "No contract found", reason: "no_supported_input", inputs: [{ index: 0, reason: "invalid_input" }],
    });
    expect(findServiceContract(lineFixtureAdapter, [lines("not a pair"), lines("a=1")])).toMatchObject({ status: "found", inputs: [{ reason: "invalid_json" }, { reason: "selected" }] });
  });
  it("applies the shared limits and the shape rules to any adapter", () => {
    expect(findServiceContract(lineFixtureAdapter, [lines("x".repeat(65_537))])).toMatchObject({ status: "not_found", inputs: [{ reason: "too_large" }] });
    expect(findServiceContract(lineFixtureAdapter, Array.from({ length: 65 }, () => lines()))).toMatchObject({ status: "not_found", reason: "too_many_inputs" });
    expect(findServiceContract(lineFixtureAdapter, [{ ...lines(), content: null }])).toMatchObject({ status: "not_found", inputs: [{ reason: "unreadable" }] });
    const wide = findServiceContract(lineFixtureAdapter, [lines(Array.from({ length: 300 }, (_, i) => `k${i}=1`).join("\n"))]);
    expect(wide).toMatchObject({ status: "not_found", inputs: [{ reason: "unsupported_shape" }] });
  });
  it("treats an adapter that throws or returns something odd as unsupported, never as a guess", () => {
    const throwing: ContractAdapter = { ...lineFixtureAdapter, read: () => { throw new Error("secret detail"); } };
    const result = findServiceContract(throwing, [lines()]);
    expect(result).toMatchObject({ status: "not_found", inputs: [{ reason: "unsupported_shape" }] });
    expect(JSON.stringify(result)).not.toContain("secret");
    for (const odd of [null, { status: "ok" }, { status: "ok", form: "guess", value: {}, pointer: "" }, { status: "ok", form: "example", value: {}, pointer: 5 }, { status: "maybe" }]) {
      const adapter = { ...lineFixtureAdapter, read: () => odd } as unknown as ContractAdapter;
      expect(findServiceContract(adapter, [lines()])).toMatchObject({ status: "not_found", inputs: [{ reason: "unsupported_shape" }] });
    }
  });
  it("makes a labelled mock config with the adapter's own service name and error cases", () => {
    const found = findServiceContract(lineFixtureAdapter, [lines()]);
    if (found.status !== "found") throw new Error("control missing");
    const config = generateServiceMock(lineFixtureAdapter, found.contract, { latencyMs: 5 });
    expect(config).toMatchObject({ version: 1, service: "fake-lines", trust: "made_by_rovara", label: "Made by Rovara", latencyMs: 5, errors: [{ scenario: "unavailable", status: 503 }] });
    expect(config.outputs.map((entry) => entry.scenario)).toEqual(["typical", "edge", "low_score", "high_score", "empty"]);
    expect(config.outputs[0].body).toEqual({ name: "example", count: 0.5, ok: true });
    expect(config.outputs[1].body).toEqual({ name: "", count: 0, ok: false });
    const schema = serviceMockConfigSchema(lineFixtureAdapter);
    expect(schema.safeParse(config).success).toBe(true);
    for (const changed of [
      { ...config, service: "sagemaker" }, { ...config, label: "Real" }, { ...config, errors: [] },
      { ...config, errors: [{ scenario: "unavailable", status: 500 }] }, { ...config, errors: [...config.errors, { scenario: "timeout" }] },
    ]) expect(schema.safeParse(changed).success).toBe(false);
  });
  it("takes error rates keyed by the adapter's own keys, not SageMaker's", () => {
    const found = findServiceContract(lineFixtureAdapter, [lines()]);
    if (found.status !== "found") throw new Error("control missing");
    expect(generateServiceMock(lineFixtureAdapter, found.contract).errorRates).toEqual({ unavailable: 0 });
    expect(generateServiceMock(lineFixtureAdapter, found.contract, { errorRates: { unavailable: 1 } }).errorRates).toEqual({ unavailable: 1 });
    for (const errorRates of [{ modelError: 0, throttled: 0, timeout: 0 }, { unavailable: 0, extra: 0 }, { unavailable: 1.1 }, { unavailable: -1 }, {}]) {
      expect(() => generateServiceMock(lineFixtureAdapter, found.contract, { errorRates })).toThrow();
    }
    const sm = findServiceContract(sageMakerAdapter, [{ ...lines(), content: '{"a":1}' }]);
    if (sm.status !== "found") throw new Error("control missing");
    expect(() => generateServiceMock(sageMakerAdapter, sm.contract, { errorRates: { unavailable: 0 } })).toThrow();
    expect(() => generateServiceMock(sageMakerAdapter, sm.contract, { errorRates: { modelError: 0.6, throttled: 0.6, timeout: 0 } })).toThrow();
  });
  it("accepts an adapter whose error cases list their keys in another order, and refuses a contract source kind the adapter lacks", () => {
    const reordered = { ...lineFixtureAdapter, errorCases: [{ status: 503, scenario: "unavailable" }] } as ContractAdapter;
    const found = findServiceContract(reordered, [lines()]);
    if (found.status !== "found") throw new Error("control missing");
    expect(serviceMockConfigSchema(reordered).safeParse(generateServiceMock(reordered, found.contract)).success).toBe(true);
    const fromInference = { ...found.contract, source: { ...found.contract.source, kind: "inference" as const } };
    expect(() => generateServiceMock(lineFixtureAdapter, fromInference)).toThrow();
  });
  it("refuses an over-long pointer from an adapter instead of selecting it", () => {
    const long: ContractAdapter = { ...lineFixtureAdapter, read: () => ({ status: "ok", form: "example", value: 1, pointer: "p".repeat(65_537) }) };
    expect(findServiceContract(long, [lines()])).toMatchObject({ status: "not_found", inputs: [{ reason: "unsupported_shape" }] });
  });
  it("keeps each service's config to itself: neither schema accepts the other's document", () => {
    const found = findServiceContract(lineFixtureAdapter, [lines()]);
    if (found.status !== "found") throw new Error("control missing");
    const fake = generateServiceMock(lineFixtureAdapter, found.contract);
    const sm = generateServiceMock(sageMakerAdapter, found.contract);
    expect(SageMakerMockConfigSchema.safeParse(sm).success).toBe(true);
    expect(SageMakerMockConfigSchema.safeParse(fake).success).toBe(false);
    expect(serviceMockConfigSchema(lineFixtureAdapter).safeParse(sm).success).toBe(false);
  });
  it("refuses a forged contract before generation", () => {
    const found = findServiceContract(lineFixtureAdapter, [lines()]);
    if (found.status !== "found") throw new Error("control missing");
    expect(() => generateServiceMock(lineFixtureAdapter, { ...found.contract, extra: 1 } as typeof found.contract)).toThrow("Invalid service contract");
  });
});
