import { describe, expect, it } from "vitest";
import {
  TaskUsageTelemetrySchema,
  createTaskUsageTelemetry,
  effectiveCacheRetention,
} from "../../packages/contracts/src/usage.js";
import * as worker from "../../packages/worker/src/usage.js";

const stats = { tokens: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1, total: 21 }, cost: 0.25 };

describe("shared usage contract", () => {
  it("labels an OpenRouter total the provider billed (Pi 1.5 totalFromProvider) as billed, and only for OpenRouter", () => {
    const billed = createTaskUsageTelemetry({ ...stats, costFromProvider: true }, { provider: "openrouter", modelId: "model" }, "SUCCEEDED");
    expect(TaskUsageTelemetrySchema.parse(billed)).toMatchObject({ costUsd: 0.25, costSource: "billed" });
    expect(createTaskUsageTelemetry({ ...stats, costFromProvider: false }, { provider: "openrouter", modelId: "model" }, "SUCCEEDED")).toMatchObject({ costSource: "estimated" });
    // No cost is never billed; a direct provider's total is its list price whatever the flag says.
    expect(createTaskUsageTelemetry({ ...stats, cost: 0, costFromProvider: true }, { provider: "openrouter", modelId: "model" }, "SUCCEEDED")).toMatchObject({ costUsd: null, costSource: "unknown" });
    expect(createTaskUsageTelemetry({ ...stats, costFromProvider: true }, { provider: "anthropic", modelId: "model" }, "SUCCEEDED")).toMatchObject({ costSource: "list-price" });
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
