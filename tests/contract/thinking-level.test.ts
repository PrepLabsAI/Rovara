import { describe, expect, it } from "vitest";
import {
  ModelRefSchema, ModelSelectionSchema, ProjectModelsSchema, SwebenchRunnerConfigSchema, SwebenchRunSchema,
  SwebenchStartRequestSchema, TaskUsageTelemetrySchema, ThinkingLevelSchema, WorkerInvocationSchema, createTaskUsageTelemetry,
} from "@agentx/contracts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

describe("thinking level contracts (spec 053)", () => {
  it("ThinkingLevelSchema accepts exactly the six levels", () => {
    expect(ThinkingLevelSchema.options).toEqual(LEVELS);
    for (const level of LEVELS) expect(ThinkingLevelSchema.parse(level)).toBe(level);
    for (const bad of ["", "max", "HIGH", "none", 3]) expect(ThinkingLevelSchema.safeParse(bad).success).toBe(false);
  });

  it("ModelRefSchema accepts an optional level and refuses a bad one", () => {
    expect(ModelRefSchema.parse({ ...sonnet, thinkingLevel: "high" }).thinkingLevel).toBe("high");
    expect(ModelRefSchema.parse(sonnet).thinkingLevel).toBeUndefined();
    expect(ModelRefSchema.safeParse({ ...sonnet, thinkingLevel: "max" }).success).toBe(false);
  });

  it("ProjectModelsSchema keeps uniqueness and default-in-approved with levels present", () => {
    const other = { provider: "openrouter", modelId: "x/y", thinkingLevel: "low" };
    expect(ProjectModelsSchema.safeParse({ default: { ...sonnet, thinkingLevel: "high" }, approved: [{ ...sonnet, thinkingLevel: "high" }, other] }).success).toBe(true);
    expect(ProjectModelsSchema.safeParse({ default: sonnet, approved: [{ ...sonnet, thinkingLevel: "low" }, { ...sonnet, thinkingLevel: "high" }] }).success).toBe(false);
    expect(ProjectModelsSchema.safeParse({ default: sonnet, approved: [other] }).success).toBe(false);
  });

  it("ModelSelectionSchema takes an identifier with or without a level and refuses unknown keys", () => {
    expect(ModelSelectionSchema.parse(sonnet)).toEqual(sonnet);
    expect(ModelSelectionSchema.parse({ ...sonnet, thinkingLevel: "xhigh" }).thinkingLevel).toBe("xhigh");
    expect(ModelSelectionSchema.safeParse({ ...sonnet, label: "x" }).success).toBe(false);
    expect(ModelSelectionSchema.safeParse({ ...sonnet, thinkingLevel: "max" }).success).toBe(false);
  });

  it("the invocation model accepts a level", () => {
    const base = {
      protocolVersion: 1, operationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(40), kind: "task",
    };
    const payload = { conversationId: crypto.randomUUID(), prompt: "hi" };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, model: { ...sonnet, thinkingLevel: "medium" } } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, model: sonnet } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...payload, model: { ...sonnet, thinkingLevel: "max" } } }).success).toBe(false);
  });

  it("the eval model fields accept a level", () => {
    const withLevel = { ...sonnet, thinkingLevel: "high" };
    expect(SwebenchStartRequestSchema.shape.model.safeParse(withLevel).success).toBe(true);
    expect(SwebenchRunSchema.shape.model.safeParse(withLevel).success).toBe(true);
    expect(SwebenchRunnerConfigSchema.shape.model.safeParse(withLevel).success).toBe(true);
    expect(SwebenchRunSchema.shape.model.safeParse({ ...sonnet, thinkingLevel: "max" }).success).toBe(false);
    expect(SwebenchRunnerConfigSchema.shape.model.safeParse(sonnet).success).toBe(true);
  });

  it("usage telemetry records an optional level", () => {
    const stats = { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0.01 };
    const withLevel = createTaskUsageTelemetry(stats, { ...sonnet, thinkingLevel: "high" }, "SUCCEEDED");
    expect(withLevel.thinkingLevel).toBe("high");
    expect(TaskUsageTelemetrySchema.safeParse(withLevel).success).toBe(true);
    const without = createTaskUsageTelemetry(stats, sonnet, "SUCCEEDED");
    expect("thinkingLevel" in without).toBe(false);
    expect(TaskUsageTelemetrySchema.safeParse(without).success).toBe(true);
  });
});
