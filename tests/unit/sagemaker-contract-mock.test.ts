import { describe, expect, it } from "vitest";
import { findSageMakerContract, isSageMakerContract, SAGEMAKER_CONTRACT_LIMITS } from "../../packages/broker/src/core/test-env/sagemaker-contract.js";
import { generateSageMakerMock, SageMakerMockConfigSchema } from "../../packages/broker/src/core/test-env/sagemaker-mock.js";

const fixture = (content = '{"score":0.7,"labels":["yes"]}') => ({ kind: "fixture" as const, path: "tests/responses/model.json", content });
const inference = (content = 'def output_fn(prediction, accept):\n    return {"score": 0.2}\n') => ({ kind: "inference" as const, path: "model/inference.py", content });
const schema = (content = '{"type":"object","properties":{"score":{"type":"number","minimum":0,"maximum":1}},"required":["score"]}') => ({ kind: "output_schema" as const, path: "model/output.json", content });
function contract() {
  const result = findSageMakerContract([schema()]);
  if (result.status !== "found") throw new Error("control contract missing");
  return result.contract;
}

describe("SageMaker contract discovery", () => {
  it("prefers fixtures, records per-field provenance and reports every unused input", () => {
    const result = findSageMakerContract([schema(), inference(), fixture()]);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.contract.source.kind).toBe("fixture");
    expect(result.contract.shape).toMatchObject({ type: "object", fields: [
      { name: "score", shape: { type: "number", source: { kind: "fixture", path: fixture().path, pointer: "/score" } } },
      { name: "labels", shape: { type: "array", items: { type: "string", source: { pointer: "/labels/0" } } } },
    ] });
    expect(result.inputs.map((entry) => entry.reason)).toEqual(["lower_priority", "lower_priority", "selected"]);
    expect(JSON.stringify(result.contract)).not.toContain('"yes"');
  });
  it("falls through malformed fixtures to literal inference, then schema", () => {
    const result = findSageMakerContract([fixture("bad"), inference("def predict_fn(data, model):\n    return {'value': True, 'nothing': None}\n"), schema()]);
    expect(result).toMatchObject({ status: "found", contract: { source: { kind: "inference" } }, inputs: [{ reason: "invalid_json" }, { reason: "selected" }, { reason: "lower_priority" }] });
    expect(findSageMakerContract([inference("def output_fn(x, accept):\n    return json.dumps(x)\n"), schema()])).toMatchObject({ status: "found", contract: { source: { kind: "output_schema" } } });
  });
  it("does not infer predict_fn's intermediate value when output_fn is dynamic", () => {
    expect(findSageMakerContract([inference('def predict_fn(x, model):\n    return {"score": 1}\n\ndef output_fn(x, accept):\n    return transform(x)\n')])).toMatchObject({ status: "not_found", message: "No contract found" });
  });
  it.each([
    ["import", "from serde import output_fn\n"],
    ["assignment", "output_fn = make_output()\n"],
    ["lambda", "output_fn = lambda p, a: json.dumps(p)\n"],
    ["async", "async def output_fn(p, a):\n    return to_csv(p)\n"],
    ["conditional", "if enabled:\n    def output_fn(p, a):\n        return to_csv(p)\n"],
    ["nested", "def setup():\n    def output_fn(p, a):\n        return to_csv(p)\n"],
    ["reassigned supported definition", "def output_fn(p, a):\n    return 1\noutput_fn = make_output()\n"],
    ["unsupported redefinition", "def output_fn(p, a):\n    return 1\ndef output_fn(p, a) -> str:\n    return to_csv(p)\n"],
  ])("refuses unsupported output_fn form: %s", (_, output) => {
    const content = 'def predict_fn(data, model):\n    return {"score": 1}\n\n' + output;
    expect(findSageMakerContract([inference(content)])).toEqual({
      status: "not_found", message: "No contract found", reason: "no_supported_input",
      inputs: [{ index: 0, reason: "unsupported_inference" }],
    });
  });
  it.each([
    ["unknown kind", { ...fixture(), kind: "fixtures" }],
    ["missing kind", { path: "response.json", content: "1" }],
    ["numeric content", { ...fixture(), content: 5 }],
    ["missing content", { kind: "fixture", path: "response.json" }],
    ["missing path", { kind: "fixture", content: "1" }],
    ["numeric path", { ...fixture(), path: 5 }],
    ["null file", null],
  ])("reports invalid runtime input: %s", (_, file) => {
    const invalid = file as unknown as Parameters<typeof findSageMakerContract>[0][number];
    expect(findSageMakerContract([invalid])).toEqual({
      status: "not_found", message: "No contract found", reason: "no_supported_input",
      inputs: [{ index: 0, reason: "invalid_input" }],
    });
    expect(findSageMakerContract([fixture(), invalid])).toMatchObject({
      status: "found", inputs: [{ index: 0, reason: "selected" }, { index: 1, reason: "invalid_input" }],
    });
    expect(findSageMakerContract([invalid, fixture()])).toMatchObject({
      status: "found", inputs: [{ index: 0, reason: "invalid_input" }, { index: 1, reason: "selected" }],
    });
  });
  it.each([
    "def output_fn(x, accept):\n    if x:\n        return {'score': 1}\n    return {'score': 0}\n",
    "def output_fn(x, accept):\n    return {'score': run_model()}\n",
    "# def output_fn(x, accept):\n#     return {'score': 1}\n",
    '"""\ndef output_fn(x, accept):\n    return {"score": 1}\n"""\n',
    '@replace_output\ndef output_fn(x, accept):\n    return {"score": 1}\n',
  ])("never executes or guesses dynamic code", (content) => {
    expect(findSageMakerContract([inference(content)])).toMatchObject({ status: "not_found" });
  });
  it.each(["[]", '[1,"x"]', '{"x":1e999}', '{"x":[]}'])("refuses ambiguous or nonfinite fixtures: %s", (content) => {
    expect(findSageMakerContract([fixture(content)])).toMatchObject({ status: "not_found" });
  });
  it.each([
    '{"type":"number","minimum":2,"maximum":1}',
    '{"type":"number","multipleOf":2}',
    '{"$ref":"https://invalid.example/schema"}',
    '{"type":"array"}',
    '{"type":"object","properties":{"x":{"type":"string"}},"required":["missing"]}',
  ])("does not silently ignore schema constraints: %s", (content) => {
    expect(findSageMakerContract([schema(content)])).toMatchObject({ status: "not_found", inputs: [{ reason: "unsupported_shape" }] });
  });
  it("reports missing content and bounds without retaining raw input", () => {
    expect(findSageMakerContract([{ kind: "fixture", path: "missing.json", content: null }])).toMatchObject({ status: "not_found", inputs: [{ reason: "unreadable" }] });
    expect(findSageMakerContract([fixture("x".repeat(SAGEMAKER_CONTRACT_LIMITS.characters + 1))])).toMatchObject({ status: "not_found", inputs: [{ reason: "too_large" }] });
    expect(findSageMakerContract(Array.from({ length: SAGEMAKER_CONTRACT_LIMITS.files + 1 }, () => fixture()))).toMatchObject({ status: "not_found", reason: "too_many_inputs" });
    expect(findSageMakerContract([fixture('['.repeat(20) + '1' + ']'.repeat(20))])).toMatchObject({ status: "not_found" });
    expect(findSageMakerContract([fixture(JSON.stringify(Array.from({ length: 300 }, () => 1)))])).toMatchObject({ status: "not_found" });
    expect(findSageMakerContract([{ ...fixture(), path: "x".repeat(2049) }])).toMatchObject({ status: "not_found", inputs: [{ reason: "too_large" }] });
  });
  it("works at the exact file, character, depth and node limits", () => {
    const files = Array.from({ length: SAGEMAKER_CONTRACT_LIMITS.files }, () => fixture("bad"));
    files[files.length - 1] = fixture("0" + " ".repeat(SAGEMAKER_CONTRACT_LIMITS.characters - 1));
    expect(findSageMakerContract(files)).toMatchObject({ status: "found" });
    expect(findSageMakerContract([fixture('['.repeat(12) + '1' + ']'.repeat(12))])).toMatchObject({ status: "found" });
    expect(findSageMakerContract([fixture(JSON.stringify(Array.from({ length: 255 }, () => 1)))])).toMatchObject({ status: "found" });
  });
  it("handles JSON property names as data, including prototype spellings and pointer escapes", () => {
    const result = findSageMakerContract([fixture('{"__proto__":{"polluted":true},"constructor":"x","a/b~c":1}')]);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    const config = generateSageMakerMock(result.contract);
    const body = config.outputs[0].body as Record<string, unknown>;
    expect(Object.hasOwn(body, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(result.contract.shape).toMatchObject({ fields: [{}, {}, { shape: { source: { pointer: "/a~1b~0c" } } }] });
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });
  it("preserves which schema properties are required", () => {
    const result = findSageMakerContract([schema('{"type":"object","properties":{"required":{"type":"string"},"optional":{"type":"boolean"}},"required":["required"]}')]);
    expect(result).toMatchObject({ status: "found", contract: { shape: { fields: [{ name: "required", required: true }, { name: "optional", required: false }] } } });
  });
  it("rejects forged or unbounded normalized contracts before generation", () => {
    const good = contract();
    expect(isSageMakerContract(good)).toBe(true);
    for (const bad of [
      { ...good, extra: "unrecognized" },
      { ...good, source: { ...good.source, kind: "guess" } },
      { ...good, shape: { type: "string", source: good.source, extra: true } },
      { ...good, shape: { type: "number", source: good.source, minimum: Infinity } },
      { ...good, shape: { type: "mystery", source: good.source } },
      { ...good, shape: { type: "object", source: good.source, fields: [{ name: "x", required: true, shape: good.shape }, { name: "x", required: true, shape: good.shape }] } },
    ]) {
      expect(isSageMakerContract(bad)).toBe(false);
      expect(() => generateSageMakerMock(bad as typeof good)).toThrow();
    }
  });
});

describe("SageMaker made-by-Rovara config", () => {
  it("produces deterministic, validated scenarios and reuses the trust words", () => {
    const input = contract();
    const before = JSON.stringify(input);
    const config = generateSageMakerMock(input);
    expect(SageMakerMockConfigSchema.safeParse(config).success).toBe(true);
    expect(config).toEqual(generateSageMakerMock(input));
    expect(config).toMatchObject({ version: 1, trust: "made_by_rovara", label: "Made by Rovara", latencyMs: 0, errorRates: { modelError: 0, throttled: 0, timeout: 0 } });
    expect(config.outputs.map((entry) => entry.scenario)).toEqual(["typical", "edge", "low_score", "high_score", "empty"]);
    expect(config.outputs[2].body).toEqual({ score: 0 });
    expect(config.outputs[3].body).toEqual({ score: 1 });
    expect(config.outputs[4]).toMatchObject({ body: null, conformsToContract: false });
    expect(config.errors).toEqual([{ scenario: "model_error", status: 424 }, { scenario: "throttled", status: 429 }, { scenario: "timeout" }]);
    expect(JSON.stringify(input)).toBe(before);
    expect(config.outputs[0].body).not.toBe(config.outputs[1].body);
  });
  it("generates nested arrays, integer bounds, booleans, strings and null", () => {
    const result = findSageMakerContract([schema('{"type":"array","items":{"type":"object","properties":{"n":{"type":"integer","minimum":2.1,"maximum":4.9},"s":{"type":"string"},"b":{"type":"boolean"},"z":{"type":"null"}}}}')]);
    if (result.status !== "found") throw new Error("schema missing");
    const config = generateSageMakerMock(result.contract);
    expect(config.outputs[2].body).toEqual([{ n: 3, s: "example", b: true, z: null }]);
    expect(config.outputs[3].body).toEqual([{ n: 4, s: "example", b: true, z: null }]);
    expect(config.outputs[1].body).toEqual([]);
  });
  it("keeps huge finite numeric bounds finite and rejects empty integer domains", () => {
    const result = findSageMakerContract([schema('{"type":"number","minimum":-1e308,"maximum":1e308}')]);
    if (result.status !== "found") throw new Error("schema missing");
    expect(generateSageMakerMock(result.contract).outputs[0].body).toBe(0);
    expect(findSageMakerContract([schema('{"type":"integer","minimum":0.1,"maximum":0.9}')])).toMatchObject({ status: "not_found" });
  });
  it.each([
    [{ minimum: 2.1 }, [3, 3, 3, 3]],
    [{ maximum: -0.5 }, [-1, -1, -1, -1]],
    [{ minimum: 2.1, maximum: 3.1 }, [3, 3, 3, 3]],
    [{ minimum: -1.1, maximum: -0.5 }, [-1, -1, -1, -1]],
  ])("accepts nonempty integer bounds %j through generation", (bounds, bodies) => {
    const result = findSageMakerContract([schema(JSON.stringify({ type: "integer", ...bounds }))]);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(isSageMakerContract(result.contract)).toBe(true);
    const config = generateSageMakerMock(result.contract);
    expect(config.outputs.slice(0, 4).map((entry) => entry.body)).toEqual(bodies);
    expect(SageMakerMockConfigSchema.safeParse(config).success).toBe(true);
  });
  it.each([{ minimum: 2.1, maximum: 2.9 }, { minimum: -0.9, maximum: -0.5 }])("refuses empty integer bounds %j", (bounds) => {
    expect(findSageMakerContract([schema(JSON.stringify({ type: "integer", ...bounds }))])).toMatchObject({
      status: "not_found", inputs: [{ reason: "unsupported_shape" }],
    });
  });
  it.each([
    { latencyMs: -1 }, { latencyMs: Infinity }, { latencyMs: 60_001 },
    { errorRates: { modelError: -0.1, throttled: 0, timeout: 0 } },
    { errorRates: { modelError: 0.5, throttled: 0.5, timeout: 0.1 } },
    { errorRates: { modelError: NaN, throttled: 0, timeout: 0 } },
  ])("refuses invalid controls", (options) => {
    expect(() => generateSageMakerMock(contract(), options)).toThrow();
  });
  it("accepts controls at their limits and rejects forged labels, statuses, scenarios and bodies", () => {
    const config = generateSageMakerMock(contract(), { latencyMs: 60_000, errorRates: { modelError: 0.5, throttled: 0.5, timeout: 0 } });
    expect(SageMakerMockConfigSchema.safeParse(config).success).toBe(true);
    for (const changed of [
      { ...config, trust: "real" }, { ...config, label: "Real" }, { ...config, version: 2 },
      { ...config, errors: [{ scenario: "model_error", status: 500 }] },
      { ...config, errors: [{ scenario: "model_error", status: 500 }, config.errors[1], config.errors[2]] },
      { ...config, errors: [config.errors[0], { scenario: "throttled", status: 500 }, config.errors[2]] },
      { ...config, errors: [config.errors[0], config.errors[1], { scenario: "timeout", status: 200 }] },
      { ...config, outputs: config.outputs.slice(1) },
      { ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: { score: 10 } } : entry) },
      { ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: { score: -1 } } : entry) },
      { ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: {} } : entry) },
      { ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: { score: 0.5, extra: 1 } } : entry) },
      { ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: { score: Infinity } } : entry) },
      { ...config, unexpected: true },
      { ...config, latencyMs: 0.5 },
      { ...config, errorRates: { modelError: 2, throttled: 0, timeout: 0 } },
      { ...config, outputs: config.outputs.map((entry, i) => i === 4 ? { ...entry, conformsToContract: true } : entry) },
      { ...config, contract: { ...config.contract, shape: { type: "mystery" } } },
    ]) expect(SageMakerMockConfigSchema.safeParse(changed).success).toBe(false);
  });
  it("validates every output type, required fields and optional omissions", () => {
    for (const [type, bad] of [["string", 1], ["boolean", "true"], ["null", 0], ["integer", 0.5], ["number", "1"]] as const) {
      const result = findSageMakerContract([schema(JSON.stringify({ type }))]);
      if (result.status !== "found") throw new Error("control missing");
      const config = generateSageMakerMock(result.contract);
      expect(SageMakerMockConfigSchema.safeParse(config).success).toBe(true);
      expect(SageMakerMockConfigSchema.safeParse({ ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: bad } : entry) }).success).toBe(false);
    }
    for (const content of ['{"type":"array","items":{"type":"number"}}', '{"type":"object","properties":{"score":{"type":"number"}},"required":["score"]}']) {
      const result = findSageMakerContract([schema(content)]);
      if (result.status !== "found") throw new Error("control missing");
      const config = generateSageMakerMock(result.contract);
      for (const bad of [null, "wrong", { extra: 1 }, ["wrong"], Array.from({ length: 257 }, () => 1)]) {
        expect(SageMakerMockConfigSchema.safeParse({ ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: bad } : entry) }).success).toBe(false);
      }
    }
    const result = findSageMakerContract([schema('{"type":"object","properties":{"score":{"type":"number"}}}')]);
    if (result.status !== "found") throw new Error("control missing");
    const config = generateSageMakerMock(result.contract);
    expect(SageMakerMockConfigSchema.safeParse({ ...config, outputs: config.outputs.map((entry, i) => i === 0 ? { ...entry, body: {} } : entry) }).success).toBe(true);
  });
});
