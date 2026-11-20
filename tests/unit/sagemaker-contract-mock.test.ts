import { describe, expect, it } from "vitest";
import { findSageMakerContract, isSageMakerContract, SAGEMAKER_CONTRACT_LIMITS } from "../../packages/broker/src/core/test-env/sagemaker-contract.js";
import { generateSageMakerMock, SageMakerMockConfigSchema } from "../../packages/broker/src/core/test-env/sagemaker-mock.js";

const fixture = (content = '{"score":0.7,"labels":["yes"]}') => ({ kind: "fixture" as const, path: "tests/responses/model.json", content });
const inference = (content = 'def output_fn(prediction, accept):\n    return {"score": 0.2}\n') => ({ kind: "inference" as const, path: "model/inference.py", content });
const schema = (content = '{"type":"object","properties":{"score":{"type":"number","minimum":0,"maximum":1}},"required":["score"]}') => ({ kind: "output_schema" as const, path: "model/output.json", content });

describe("SageMaker contract discovery", () => {
  it("falls through malformed fixtures to literal inference, then schema", () => {
    const result = findSageMakerContract([fixture("bad"), inference("def predict_fn(data, model):\n    return {'value': True, 'nothing': None}\n"), schema()]);
    expect(result).toMatchObject({ status: "found", contract: { source: { kind: "inference" } }, inputs: [{ reason: "invalid_json" }, { reason: "selected" }, { reason: "lower_priority" }] });
    expect(findSageMakerContract([inference("def output_fn(x, accept):\n    return json.dumps(x)\n"), schema()])).toMatchObject({ status: "found", contract: { source: { kind: "output_schema" } } });
  });
  it.each([
    ["import", "from serde import output_fn\n"],
  ])("refuses unsupported output_fn form: %s", (_, output) => {
    const content = 'def predict_fn(data, model):\n    return {"score": 1}\n\n' + output;
    expect(findSageMakerContract([inference(content)])).toEqual({
      status: "not_found", message: "No contract found", reason: "no_supported_input",
      inputs: [{ index: 0, reason: "unsupported_inference" }],
    });
  });
  it.each([
    "def output_fn(x, accept):\n    if x:\n        return {'score': 1}\n    return {'score': 0}\n",
    '"""\ndef output_fn(x, accept):\n    return {"score": 1}\n"""\n',
  ])("never executes or guesses dynamic code", (content) => {
    expect(findSageMakerContract([inference(content)])).toMatchObject({ status: "not_found" });
  });
  it("reports missing content and bounds without retaining raw input", () => {
    expect(findSageMakerContract([{ kind: "fixture", path: "missing.json", content: null }])).toMatchObject({ status: "not_found", inputs: [{ reason: "unreadable" }] });
    expect(findSageMakerContract([fixture("x".repeat(SAGEMAKER_CONTRACT_LIMITS.characters + 1))])).toMatchObject({ status: "not_found", inputs: [{ reason: "too_large" }] });
    expect(findSageMakerContract(Array.from({ length: SAGEMAKER_CONTRACT_LIMITS.files + 1 }, () => fixture()))).toMatchObject({ status: "not_found", reason: "too_many_inputs" });
    expect(findSageMakerContract([fixture('['.repeat(20) + '1' + ']'.repeat(20))])).toMatchObject({ status: "not_found" });
    expect(findSageMakerContract([fixture(JSON.stringify(Array.from({ length: 300 }, () => 1)))])).toMatchObject({ status: "not_found" });
    expect(findSageMakerContract([{ ...fixture(), path: "x".repeat(2049) }])).toMatchObject({ status: "not_found", inputs: [{ reason: "too_large" }] });
  });
});

describe("SageMaker made-by-Rovara config", () => {
  it.each([
    [{ minimum: 2.1 }, [3, 3, 3, 3]],
  ])("accepts nonempty integer bounds %j through generation", (bounds, bodies) => {
    const result = findSageMakerContract([schema(JSON.stringify({ type: "integer", ...bounds }))]);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(isSageMakerContract(result.contract)).toBe(true);
    const config = generateSageMakerMock(result.contract);
    expect(config.outputs.slice(0, 4).map((entry) => entry.body)).toEqual(bodies);
    expect(SageMakerMockConfigSchema.safeParse(config).success).toBe(true);
  });
});
