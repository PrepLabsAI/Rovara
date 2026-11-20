import { describe, expect, it } from "vitest";
import { findServiceContract, type AdapterRead, type ContractAdapter } from "../../packages/broker/src/core/test-env/service-contract.js";
import { generateServiceMock, serviceMockConfigSchema } from "../../packages/broker/src/core/test-env/service-contract-mock.js";

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
});
