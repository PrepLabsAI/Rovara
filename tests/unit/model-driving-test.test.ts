import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DRIVING_TEST_BUDGET, WEB_API_REQUIRED_PROBES, canonicalJson, e2eModelRouteRevision, type E2EModelReceipt } from "@agentx/contracts";
import { deriveE2EAgentRouteForModel } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { DRIVING_TEST_LIMITS, DRIVING_TEST_SCENARIO_ID, createWebApiProbePlan, webApiDrivingTestPlan, webApiProbeDriver } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot } from "../../packages/verifier/src/host/web-api-qualification-app.js";
import { loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { lastFailureOf, reasonCodeOf, runModelDrivingTest, type NavigationOutcome } from "../../packages/verifier/src/host/model-driving-test.js";

// M1.4 Task 4.10C, tests 30 and 31: the driving test's sequence with the model calls faked, and the qualification pins that must not move.

const RUN = "5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11";
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let counter = 0;
function receipt(over: Partial<E2EModelReceipt> = {}): E2EModelReceipt {
  counter += 1;
  return { receiptId: `r-${counter}`, runId: RUN, caseId: "model-check", stepIndex: 0, callIndex: 0, routeId: "rovara-e2e-default", routeRevision: "r1-aaaaaaaaaaaa", provider: "amazon-bedrock", modelId: MODEL,
    startedAt: new Date(Date.parse("2026-10-23T10:00:00Z") + counter * 1000).toISOString(), inputTokens: 1000, outputTokens: 40, latencyMs: 200, servedModelId: null, servedUpstream: null,
    promptSha256: "a".repeat(64), responseSha256: "b".repeat(64), outcome: "ok", ...over };
}
const rejected = (callIndex = 0) => receipt({ callIndex, outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "request-rejected", signal: "ValidationException" } });
const limited = () => receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" } });
const passedNavigation = (): NavigationOutcome => ({ caseVerdict: "passed", caseCode: null, receipts: [receipt({ caseId: "case", stepIndex: 1, callIndex: 0 }), receipt({ caseId: "case", stepIndex: 1, callIndex: 1 })], reported: { modelCalls: 2, downloads: 1, csvPassed: true } });

function fakes(firstCalls: E2EModelReceipt[], navigation: NavigationOutcome | Error = passedNavigation()) {
  const queue = [...firstCalls];
  const firstCall = vi.fn<(shape: "standard" | "minimal", callIndex: number) => Promise<E2EModelReceipt>>(async () => { const next = queue.shift(); if (next === undefined) throw new Error("a call the test did not expect"); return next; });
  const navigate = vi.fn<(shape: "standard" | "minimal") => Promise<NavigationOutcome>>(async () => { if (navigation instanceof Error) throw navigation; return navigation; });
  return { firstCall, navigate };
}

describe("the driving test's sequence (test 30)", () => {
  it("pass: the first call is ok, the navigation passes, and the shape is standard", async () => {
    const deps = fakes([receipt()]);
    const result = await runModelDrivingTest(deps);
    expect(result).toMatchObject({ payloadShape: "standard", outcome: "passed", failure: null, caseVerdict: "passed", reported: { modelCalls: 2, downloads: 1, csvPassed: true } });
    expect(result.receipts).toHaveLength(3);
    expect(deps.firstCall).toHaveBeenCalledTimes(1);
    expect(deps.navigate).toHaveBeenCalledWith("standard");
  });

  it("request-rejected: exactly one retry in the minimal shape, then the navigation in that shape", async () => {
    const deps = fakes([rejected(), receipt({ callIndex: 1 })]);
    const result = await runModelDrivingTest(deps);
    expect(result).toMatchObject({ payloadShape: "minimal", outcome: "passed" });
    expect(deps.firstCall.mock.calls).toEqual([["standard", 0], ["minimal", 1]]);
    expect(deps.navigate).toHaveBeenCalledWith("minimal");
  });

  it("a retry that is rejected too ends the test with that failure: never a second retry, never a navigation", async () => {
    const deps = fakes([rejected(), rejected(1), receipt({ callIndex: 2 })]);
    const result = await runModelDrivingTest(deps);
    expect(result).toMatchObject({ payloadShape: "minimal", outcome: "failed", failure: { class: "request-rejected" }, caseVerdict: "none" });
    expect(deps.firstCall).toHaveBeenCalledTimes(2);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("limit: no retry, no navigation, and the failure says limit", async () => {
    const deps = fakes([limited()]);
    const result = await runModelDrivingTest(deps);
    expect(result).toMatchObject({ outcome: "failed", failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" }, caseVerdict: "none", payloadShape: "standard" });
    expect(deps.firstCall).toHaveBeenCalledTimes(1);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it.each(["key-rejected", "model-not-found", "unreachable", "provider-outage", "unknown", "secret-unreadable", "not-in-catalog"] as const)("%s is not retried either", async (failureClass) => {
    const deps = fakes([receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: failureClass, signal: null } })]);
    expect(await runModelDrivingTest(deps)).toMatchObject({ outcome: "failed", failure: { class: failureClass } });
    expect(deps.firstCall).toHaveBeenCalledTimes(1);
  });

  it("a failed first call with no class is a failure with no class, and is not retried", async () => {
    const deps = fakes([receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0 })]);
    expect(await runModelDrivingTest(deps)).toMatchObject({ outcome: "failed", failure: null });
    expect(deps.firstCall).toHaveBeenCalledTimes(1);
  });

  it("wrong action: no download is an UNKNOWN case, so the test fails and no gating row could follow", async () => {
    const navigation: NavigationOutcome = { caseVerdict: "unknown", caseCode: "agent-no-download", receipts: [receipt({ caseId: "case", stepIndex: 1 })], reported: { modelCalls: 1, downloads: 0, csvPassed: false } };
    const result = await runModelDrivingTest(fakes([receipt()], navigation));
    expect(result).toMatchObject({ outcome: "failed", caseVerdict: "unknown", caseCode: "agent-no-download", failure: null });
  });

  it("budget: a navigation whose receipts hold a budget refusal is never a pass, whatever the verdict says", async () => {
    const navigation: NavigationOutcome = { ...passedNavigation(), receipts: [receipt({ caseId: "case", stepIndex: 1 }), receipt({ caseId: "case", stepIndex: 1, callIndex: 1, outcome: "budget", responseSha256: null, inputTokens: 0, outputTokens: 0 })] };
    expect(await runModelDrivingTest(fakes([receipt()], navigation))).toMatchObject({ outcome: "failed" });
  });

  it("a navigation that fails the case gives the failure of its last failed call when it has one", async () => {
    const navigation: NavigationOutcome = { caseVerdict: "unknown", caseCode: "model-limit-reached", receipts: [receipt({ caseId: "case", stepIndex: 1 }), { ...limited(), caseId: "case", stepIndex: 1, callIndex: 1 }], reported: null };
    const result = await runModelDrivingTest(fakes([receipt()], navigation));
    expect(result.failure).toEqual({ class: "limit-or-rate-limited", signal: "ThrottlingException" });
  });

  it("lastFailureOf picks by time, and a code is only a fixed token", () => {
    const early = { ...limited(), startedAt: "2026-10-23T10:00:00.000Z" };
    const late = { ...receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "provider-outage", signal: "timeout" } }), startedAt: "2026-10-23T10:00:05.000Z" };
    expect(lastFailureOf([late, early])).toEqual({ class: "provider-outage", signal: "timeout" });
    expect(reasonCodeOf("agent-no-download: the model said https://x")).toBe("agent-no-download");
    expect(reasonCodeOf("Some Sentence With Spaces")).toBe("unspecified");
    expect(reasonCodeOf(undefined)).toBe("unspecified");
  });
});

describe("the driving test's plan and the qualification pins (test 31)", () => {
  const appRoot = installedWebApiQualificationAppRoot();
  const definition = (() => {
    const derived = deriveE2EAgentRouteForModel({ provider: "amazon-bedrock", region: "us-east-1" }, MODEL, "standard", 1);
    if (derived.status !== "available") throw new Error("expected a route");
    return derived.definition;
  })();

  it("pins the REAL route, one case of the fixture's own goal, 3 actions, and the whole test's limits", () => {
    const plan = webApiDrivingTestPlan(definition, { appRoot, runId: RUN });
    const policy = plan.plan.admission.policy;
    expect(policy.modelRouteRevision).toBe(e2eModelRouteRevision(definition));
    expect(plan.plan.admission.round.groupBindings[0]!.modelRouteRevision).toBe(e2eModelRouteRevision(definition));
    expect(plan.plan.admission.modelRoute).toEqual({ routeId: definition.routeId, routeRevision: e2eModelRouteRevision(definition) });
    expect(plan.plan.runId).toBe(RUN);
    expect(plan.scenario.scenarioId).toBe(DRIVING_TEST_SCENARIO_ID);
    const agent = plan.scenario.steps.find((step) => step.kind === "agent") as { goal: string; maxActions: number };
    expect(agent).toMatchObject({ goal: "Export the orders as a CSV file", maxActions: DRIVING_TEST_BUDGET.maxActions });
    expect(plan.scenario.assertions).toHaveLength(1);
    expect(plan.scenario.assertions[0]).toMatchObject({ kind: "csv", downloadName: "orders.csv" });
    expect(policy.limits).toMatchObject({ maxModelRequests: 6, maxInputTokens: 36_000, maxOutputTokens: 3_072 });
    expect(DRIVING_TEST_LIMITS.maxModelRequests).toBe(DRIVING_TEST_BUDGET.maxCalls);
    expect(plan.compiled.expectedCases).toHaveLength(1);
  });

  it("is a plan of its own: its scenario and bundle are not any probe's", () => {
    const plan = webApiDrivingTestPlan(definition, { appRoot, runId: RUN });
    const pinned = WEB_API_REQUIRED_PROBES.flatMap((probe) => [probe.scenarioDigest, probe.bundleDigest]);
    expect(pinned).not.toContain(sha(canonicalJson(plan.scenario)));
    expect(pinned).not.toContain(plan.compiled.bundle.bundleDigest);
  });

  it("leaves the pins of the agent probes as they were: asset f383a9b1, scenario efa380e5, bundle 33716f10, all computed here", () => {
    const probe = WEB_API_REQUIRED_PROBES.find((item) => item.probeId === "web-agent-app-isolation-v1")!;
    expect(probe.assetDigest.startsWith("f383a9b1")).toBe(true);
    expect(probe.scenarioDigest!.startsWith("efa380e5")).toBe(true);
    expect(probe.bundleDigest!.startsWith("33716f10")).toBe(true);
    for (const item of WEB_API_REQUIRED_PROBES.filter((entry) => entry.agent !== undefined)) {
      const driver = webApiProbeDriver(item.probeId);
      const plan = createWebApiProbePlan({ probe: driver.probe, appRoot, runId: RUN, modelRoute: { routeId: "rovara-scripted/v1", routeRevision: "r1-51628bfc25fa" },
        ...(driver.startArgs ? { recipeStart: { args: [...driver.startArgs] } } : {}) });
      expect(sha(canonicalJson(plan.scenario)), item.probeId).toBe(item.scenarioDigest);
      expect(plan.compiled.bundle.bundleDigest, item.probeId).toBe(item.bundleDigest);
    }
    // Loading the installed assets checks each against its pinned digest and its agent facts.
    expect(() => loadWebApiQualificationProbeAssets()).not.toThrow();
  });
});
