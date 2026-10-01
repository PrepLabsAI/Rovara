import { describe, expect, it } from "vitest";
import {
  SwebenchChannelRequestSchema,
  SwebenchRunResultSchema,
  SwebenchRunnerConfigSchema,
  parseSwebenchCommand,
} from "@agentx/contracts";

describe("the eval swebench command (spec 043 FR-001)", () => {
  it("reads a dataset, one instance and an optional model", () => {
    expect(parseSwebenchCommand("<@U123ABC> eval swebench verified django__django-11099")).toEqual({
      kind: "run", dataset: "verified", instanceId: "django__django-11099",
    });
    expect(parseSwebenchCommand("eval swebench Lite astropy__astropy-12907 model Fast.")).toEqual({
      kind: "run", dataset: "lite", instanceId: "astropy__astropy-12907", modelSelector: "Fast",
    });
    expect(parseSwebenchCommand("eval swebench full sympy__sympy-20590 model us.anthropic.claude-opus")).toMatchObject({
      modelSelector: "us.anthropic.claude-opus",
    });
  });

  it("leaves every other message to the orchestrator", () => {
    expect(parseSwebenchCommand("please evaluate this")).toBeUndefined();
    expect(parseSwebenchCommand("eval the swebench results")).toBeUndefined();
    expect(parseSwebenchCommand("models")).toBeUndefined();
  });

  it.each([
    ["eval swebench", /which dataset/],
    ["eval swebench enterprise django__django-11099", /Unknown dataset “enterprise”/],
    ["eval swebench pro django__django-11099", /not a SWE-Bench Pro instance ID/],
    ["eval swebench verified", /which instance/],
    ["eval swebench verified not-an-instance", /not a SWE-bench instance ID/],
    ["eval swebench verified django__django-11099 django__django-11100", /exactly one instance/],
    ["eval swebench verified django__django-11099 model", /which model/],
  ])("explains what is wrong with %j", (text, message) => {
    const command = parseSwebenchCommand(text);
    expect(command?.kind).toBe("invalid");
    expect(command?.kind === "invalid" ? command.message : "").toMatch(message);
    expect(command?.kind === "invalid" ? command.message : "").toContain("eval swebench <verified|lite|full|pro|pro-hard>");
  });
});

describe("SWE-bench contracts", () => {
  it("bounds a channel's cost ceiling (FR-002)", () => {
    expect(SwebenchChannelRequestSchema.parse({})).toEqual({});
    expect(SwebenchChannelRequestSchema.parse({ maxCostUsd: 25 })).toEqual({ maxCostUsd: 25 });
    expect(() => SwebenchChannelRequestSchema.parse({ maxCostUsd: 0.5 })).toThrow();
    expect(() => SwebenchChannelRequestSchema.parse({ maxCostUsd: 101 })).toThrow();
  });

  it("accepts a graded result without test counts only as an empty patch's", () => {
    const usage = {
      schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "m", cacheRetention: "short",
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cacheReadRatio: 0, costUsd: 0.01,
    };
    expect(SwebenchRunResultSchema.parse({
      outcome: "GRADED", resolved: false, stopReason: "finished", patchBytes: 0, agentSeconds: 5,
      imageDigest: "swebench/x@sha256:abc", usage, artifactsPrefix: "evals/x/",
    })).toMatchObject({ outcome: "GRADED", patchBytes: 0 });
    expect(() => SwebenchRunResultSchema.parse({ outcome: "FAILED", error: "" })).toThrow();
  });

  it("admits only an evals/<run>/ artifact prefix and an HTTPS control plane", () => {
    const config = {
      runId: "3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11", dataset: "verified", instanceId: "django__django-11099",
      model: { provider: "amazon-bedrock", modelId: "m" }, maxCostUsd: 10, controlPlaneUrl: "https://api.example.com",
      capability: "c", artifactBucket: "agentx-artifacts", artifactsPrefix: "evals/3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11/",
    };
    expect(SwebenchRunnerConfigSchema.parse(config)).toEqual(config);
    expect(() => SwebenchRunnerConfigSchema.parse({ ...config, artifactsPrefix: "workspaces/x/" })).toThrow();
    expect(() => SwebenchRunnerConfigSchema.parse({ ...config, controlPlaneUrl: "http://api.example.com" })).toThrow();
  });
});
