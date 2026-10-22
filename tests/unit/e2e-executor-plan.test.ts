import { describe, expect, it } from "vitest";
import { E2EExecutorPlanSchema, e2eExecutorAdmissionDigest } from "@agentx/contracts";
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
  describe("modelChannel (Task 4.3a)", () => {
    const route = { routeId: "rovara-e2e-default", routeRevision: "r1-0123456789ab" };
    const channel = { protocol: "rovara-e2e-model-channel/v1", socketPath: "/run/rovara/model.sock", ...route };
    const routed = (modelRoute: typeof route | null) => {
      const admission = { ...plan.admission, modelRoute };
      return { ...plan, admission: { ...admission, admissionDigest: e2eExecutorAdmissionDigest(admission) }, admissionDigest: e2eExecutorAdmissionDigest(admission) };
    };

    it("is optional: the plan the host writes for a group with no agent step has none", () => {
      expect(E2EExecutorPlanSchema.parse(plan).modelChannel).toBeUndefined();
    });
    it("accepts a channel that names the route its admission pins", () => {
      expect(E2EExecutorPlanSchema.parse({ ...routed(route), modelChannel: channel }).modelChannel).toEqual(channel);
    });
    it("refuses a channel for another route or revision, for an admission that pins none, and any other socket path or protocol", () => {
      expect(() => E2EExecutorPlanSchema.parse({ ...routed(route), modelChannel: { ...channel, routeRevision: "r2-0123456789ab" } })).toThrow(/pins/);
      expect(() => E2EExecutorPlanSchema.parse({ ...routed(route), modelChannel: { ...channel, routeId: "other-route" } })).toThrow(/pins/);
      expect(() => E2EExecutorPlanSchema.parse({ ...routed(null), modelChannel: channel })).toThrow(/pins/);
      expect(() => E2EExecutorPlanSchema.parse({ ...routed(route), modelChannel: { ...channel, socketPath: "/tmp/model.sock" } })).toThrow();
      expect(() => E2EExecutorPlanSchema.parse({ ...routed(route), modelChannel: { ...channel, protocol: "rovara-e2e-model-channel/v2" } })).toThrow();
      expect(() => E2EExecutorPlanSchema.parse({ ...routed(route), modelChannel: { ...channel, valueKey: "x" } })).toThrow();
    });
  });
});
