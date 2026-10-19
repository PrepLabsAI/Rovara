import { describe, expect, it } from "vitest";
import { E2EExecutorPlanSchema } from "@agentx/contracts";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";

const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
const plan = fixture.plan;

describe("executor plan", () => {
  it("accepts the plan the host writes for a real compiled group", () => {
    expect(E2EExecutorPlanSchema.parse(plan).app.origin).toBe("http://app:4317");
  });
  it("rejects a plan whose app origin is not http://app:4317", () => {
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, app: { ...plan.app, origin: "http://example.com" } })).toThrow();
  });
  it("bounds the health wait", () => {
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, app: { ...plan.app, health: { ...plan.app.health, timeoutMs: 120_001 } } })).toThrow();
  });
  it("rejects an admission digest that does not bind its admission", () => {
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, admissionDigest: "0".repeat(64) })).toThrow(/digest/);
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, admission: { ...plan.admission, taskId: "other-task" } })).toThrow(/digest/);
  });
  it("rejects a group or run that is not in the admission", () => {
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, runId: "00000000-0000-4000-8000-000000000000" })).toThrow(/run/);
  });
  it("rejects duplicate account profiles, short passwords and unknown keys", () => {
    const account = plan.accounts[0]!;
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, accounts: [account, account] })).toThrow(/unique/);
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, accounts: [{ ...account, password: "short" }] })).toThrow();
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, extra: true })).toThrow();
  });
});
