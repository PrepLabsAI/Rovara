import { expect, it } from "vitest";
import { TaskUsageTelemetrySchema } from "../../packages/contracts/src/usage.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";
it("strict usage readers accept optional bounded receipts before producers send them", () => {
  const report = { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: "claude-x", cacheRetention: "short", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheReadRatio: 0, costUsd: null };
  expect(TaskUsageTelemetrySchema.safeParse(report).success).toBe(true);
  expect(TaskUsageTelemetrySchema.safeParse({ ...report, chargeReceipts: [chargeReceipt()] }).success).toBe(true);
  for (const chargeReceipts of [[], [{}], Array(65).fill(chargeReceipt())]) expect(TaskUsageTelemetrySchema.safeParse({ ...report, chargeReceipts }).success).toBe(false);
});

it("strict readers accept optional missing-call counts and reject malformed counts", () => {
  const report = { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: "claude-x", cacheRetention: "short", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheReadRatio: 0, costUsd: null };
  for (const usageMissingCalls of [0, 1, 7]) expect(TaskUsageTelemetrySchema.safeParse({ ...report, usageMissingCalls }).success).toBe(true);
  for (const usageMissingCalls of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) expect(TaskUsageTelemetrySchema.safeParse({ ...report, usageMissingCalls }).success).toBe(false);
});
