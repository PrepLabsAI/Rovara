import { describe, expect, it } from "vitest";
import {
  TaskUsageTelemetrySchema,
  createTaskUsageTelemetry,
  effectiveCacheRetention,
} from "../../packages/contracts/src/usage.js";
import * as worker from "../../packages/worker/src/usage.js";

const stats = { tokens: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1, total: 21 }, cost: 0.25 };

describe("shared usage contract", () => {
  it("labels OpenRouter catalog estimates and unknown cost without calling it free", () => {
    const unknown = createTaskUsageTelemetry({ ...stats, cost: 0 }, { provider: "openrouter", modelId: "model" }, "SUCCEEDED");
    expect(TaskUsageTelemetrySchema.parse(unknown)).toMatchObject({ costUsd: null, costSource: "unknown" });
    expect(createTaskUsageTelemetry(stats, { provider: "openrouter", modelId: "model" }, "SUCCEEDED")).toMatchObject({ costUsd: 0.25, costSource: "estimated" });
  });
  it("builds the feature 011 shape from session totals", () => {
    const usage = createTaskUsageTelemetry(stats, { provider: "amazon-bedrock", modelId: "model", cacheRetention: "long" }, "SUCCEEDED");
    expect(usage).toEqual({
      schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "model", cacheRetention: "long",
      tokens: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1, total: 21 }, cacheReadRatio: 8 / 19, costUsd: 0.25,
    });
    expect(TaskUsageTelemetrySchema.parse(usage)).toEqual(usage);
  });

  it("gives the worker the same functions through its unchanged import path", () => {
    expect(worker.createTaskUsageTelemetry(stats, { provider: "p", modelId: "m" }, "FAILED"))
      .toEqual(createTaskUsageTelemetry(stats, { provider: "p", modelId: "m" }, "FAILED"));
    expect(worker.effectiveCacheRetention("long")).toBe(effectiveCacheRetention("long"));
  });

  it("refuses negative or fractional token counts and an unknown field", () => {
    expect(() => createTaskUsageTelemetry({ ...stats, tokens: { ...stats.tokens, input: -1 } }, { provider: "p", modelId: "m" }, "SUCCEEDED"))
      .toThrow("input tokens must be a non-negative safe integer");
    const usage = createTaskUsageTelemetry(stats, { provider: "p", modelId: "m" }, "SUCCEEDED");
    expect(TaskUsageTelemetrySchema.safeParse({ ...usage, extra: 1 }).success).toBe(false);
  });
});
