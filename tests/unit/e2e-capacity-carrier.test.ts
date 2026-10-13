import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import { aggregateE2EVerification, E2EExecutionPlanSchema, E2ERoundSchema, E2ERunBindingSchema, E2EQualifiedResultSchema } from "../../packages/contracts/src/e2e.js";
import { buildE2ESharedView } from "../../packages/contracts/src/e2e-view.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const d = (char: string) => char.repeat(64);
function fixture(caseCount: number) {
  const targets = ["web-1", "web-2"].map((targetId, index) => ({ targetId, applicationId: `app-${index}`, runtimeProfileId: "browser-v1", accountProfileId: "account-v1", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 800 } }));
  const assertionDigests = Array.from({ length: 20 }, (_, index) => hash({ assertionIndex: index, literal: true }));
  const cases = Array.from({ length: caseCount }, (_, index) => {
    const target = targets[index % 2]!;
    const core = { criterionId: `criterion-${index}`, scenarioId: `scenario-${Math.floor(index / 2)}`, targetId: target.targetId, requestedTargetId: target.targetId, agentId: "template-v1", repeat: 0 as const, executionDescriptorDigest: d("1"), accountContextId: `context-${index}`, accountContextDigest: d("2"), accountProfileId: target.accountProfileId, assertionDigest: hash(assertionDigests), assertionDigests, required: true, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [] as string[] };
    const item = { ...core, caseId: e2eCaseIdFromIdentity(core) };
    return { ...item, upstreamTestId: e2eUpstreamTestIdFromIdentity(item) };
  });
  const content = { schemaVersion: 1 as const, candidateDigest: d("c"), planDigest: d("d"), criteria: cases.map((item, index) => ({ criterionId: item.criterionId, requirementId: `req-${index}`, scenarioId: item.scenarioId, requestedTargetId: item.requestedTargetId, required: true, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [] as string[], expectedCaseIds: [item.caseId] })), effectiveTargets: targets, groups: targets.map((target, index) => ({ groupId: `group-${index}`, targetIds: [target.targetId], runtimeProfileId: "browser-v1", mode: "mock-only" as const, mockManifestDigest: d(index === 0 ? "5" : "6"), expectedCases: cases.filter((item) => item.targetId === target.targetId) })), mocks: [], unavailableCriteria: [] };
  const plan = E2EExecutionPlanSchema.parse({ ...content, digest: hash(content) });
  const admittedAt = "2026-10-12T12:00:00.000Z";
  const deadlineAt = "2026-10-12T12:05:00.000Z";
  const common = { schemaVersion: 1, roundId: "a0000000-0000-4000-8000-000000000010", taskId: "task-current", operationId: "operation-current", operationFence: 3, workflowRevision: 7, executionPlanDigest: plan.digest, authorizationRevision: "auth-current", candidateDigest: plan.candidateDigest, planDigest: plan.planDigest, policyDigest: d("7"), bundleDigest: d("8"), modelRouteRevision: null, admittedAt, deadlineAt };
  const bindings = plan.groups.map((group, index) => E2ERunBindingSchema.parse({ ...common, runId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, groupId: group.groupId, executionMode: "mock-only", appBuildDigest: d(index === 0 ? "1" : "9"), environmentDigest: d(index === 0 ? "2" : "a"), runtimeManifestDigest: d(index === 0 ? "3" : "b"), mockManifestDigest: group.mockManifestDigest, expectedCases: group.expectedCases }));
  const results = bindings.map((binding) => E2EQualifiedResultSchema.parse({ schemaVersion: 1, binding, producer: "synthetic-private-capacity-fixture", startedAt: "2026-10-12T12:00:01.000Z", finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed", qualification: "trusted", executionMode: "mock-only", reason: "complete", cases: binding.expectedCases.map((item) => ({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, status: "passed", reason: "assertions-passed", attemptCount: 1, assertionDigest: item.assertionDigest, assertionReceipts: item.assertionDigests.map((assertionDigest, assertionIndex) => ({ assertionIndex, assertionDigest, status: "passed", reason: "assertions-passed" })), artifacts: [], coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], observedMockedComponentIds: ["api"], unexercisedBehaviors: [] } })), rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed" }));
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId: common.roundId, taskId: common.taskId, operationId: common.operationId, operationFence: common.operationFence, workflowRevision: common.workflowRevision, executionPlanDigest: plan.digest, admittedAt, deadlineAt, limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null }, groupBindings: bindings });
  return { plan, round, results, setup: { status: "runtime-ready" as const, selectedTargetIds: targets.map((target) => target.targetId), executionPlanDigest: plan.digest, blockingInputIds: [], mockSubstitutableInputIds: [] } };
}
function status(results: unknown[], f: ReturnType<typeof fixture>) {
  return aggregateE2EVerification(f.plan, results as never[], f.round).results.find((item) => item.checkId === "project-e2e")?.status;
}

describe("bounded multi-group E2E carriers", () => {
  it("retains a valid own-data plan when the top-level carrier has accessors or unknown fields", () => {
    const f = fixture(32);
    const cases: Array<{ name: string; mutate: (input: Record<string, unknown>, hooks: { count: number }) => void }> = [
      { name: "results accessor with complete round", mutate: (input, hooks) => Object.defineProperty(input, "results", { enumerable: true, get: () => { hooks.count += 1; return f.results; } }) },
      { name: "results accessor with partial round", mutate: (input, hooks) => { input.currentRound = null; Object.defineProperty(input, "results", { enumerable: true, get: () => { hooks.count += 1; return [f.results[0]]; } }); } },
      { name: "results accessor with empty round", mutate: (input, hooks) => { input.currentRound = null; Object.defineProperty(input, "results", { enumerable: true, get: () => { hooks.count += 1; return []; } }); } },
      { name: "control accessor", mutate: (input, hooks) => Object.defineProperty(input, "control", { enumerable: true, get: () => { hooks.count += 1; return { policyPresent: true, workflowPhase: "e2e", ownerActionProposals: ["retry-run"] }; } }) },
      { name: "unknown accessor", mutate: (input, hooks) => Object.defineProperty(input, "unexpected", { enumerable: true, get: () => { hooks.count += 1; return "ignored"; } }) },
    ];
    const observations: Array<{ name: string; digest: string | null; expectedGroups: number; requiredCriteria: number; unavailableCriteria: number; receivedGroups: number; executedCases: number; qualifiedCriteria: number; policyPresence: string; workflowPhase: string | null; actions: string[]; hookCount: number }> = [];
    for (const { name, mutate } of cases) {
      const input: Record<string, unknown> = { plan: f.plan, currentRound: f.round, results: f.results, setup: f.setup, actor: "owner" };
      const hooks = { count: 0 };
      mutate(input, hooks);
      const view = buildE2ESharedView(input as never);
      observations.push({ name, digest: view.e2e.executionPlanDigest, expectedGroups: view.e2e.expectedGroups, requiredCriteria: view.e2e.requiredCriteria, unavailableCriteria: view.e2e.unavailableCriteria, receivedGroups: view.e2e.receivedGroups, executedCases: view.e2e.executedCases, qualifiedCriteria: view.e2e.qualifiedCriteria, policyPresence: view.e2e.policyPresence, workflowPhase: view.e2e.workflowPhase, actions: view.actions, hookCount: hooks.count });
    }
    expect(observations).toEqual(cases.map(({ name }) => ({ name, digest: f.plan.digest, expectedGroups: 2, requiredCriteria: 32, unavailableCriteria: 32, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, policyPresence: "absent", workflowPhase: null, actions: [], hookCount: 0 })));
    expect(observations.every(({ digest }) => digest !== null)).toBe(true);
  });

  it("does not introspect a proxied top carrier or invoke an accessor plan during fallback", () => {
    const f = fixture(2);
    let hooks = 0;
    const proxied = new Proxy({ plan: f.plan }, {
      getPrototypeOf() { hooks += 1; throw new Error("proxy prototype hook"); },
      ownKeys() { hooks += 1; throw new Error("proxy ownKeys hook"); },
      get() { hooks += 1; throw new Error("proxy get hook"); },
    });
    const proxyView = buildE2ESharedView(proxied as never);
    expect(proxyView.e2e).toMatchObject({ status: "UNKNOWN", executionPlanDigest: null, expectedGroups: 0, requiredCriteria: 0 });

    const withPlanGetter: Record<string, unknown> = { currentRound: f.round, results: f.results, setup: f.setup, actor: "viewer" };
    Object.defineProperty(withPlanGetter, "plan", { enumerable: true, get: () => { hooks += 1; return f.plan; } });
    const getterView = buildE2ESharedView(withPlanGetter as never);
    expect(getterView.e2e).toMatchObject({ status: "UNKNOWN", executionPlanDigest: null, expectedGroups: 0 });

    const cyclicPlan = { ...f.plan } as Record<string, unknown>;
    cyclicPlan["self"] = cyclicPlan;
    const malformedView = buildE2ESharedView({ plan: cyclicPlan, currentRound: f.round, results: f.results, setup: f.setup, actor: "viewer", control: {} } as never);
    expect(malformedView.e2e).toMatchObject({ status: "UNKNOWN", executionPlanDigest: null, expectedGroups: 0, requiredCriteria: 0 });
    expect(hooks).toBe(0);
  });

  it.each([32, 48, 64])("qualifies every accepted result for %i cases without widening per-record bounds", (caseCount) => {
    const f = fixture(caseCount);
    const forward = status(f.results, f);
    const reverse = status([...f.results].reverse(), f);
    const view = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: f.results, setup: f.setup, actor: "viewer" });
    expect(forward).toBe("PASS");
    expect(reverse).toBe("PASS");
    expect(view.e2e).toMatchObject({ status: "PASS", requiredCriteria: caseCount, qualifiedCriteria: caseCount, expectedGroups: 2, receivedGroups: 2, executedCases: caseCount, executionPlanDigest: f.plan.digest });
  });

  it("keeps incomplete, duplicate, conflicting, and excess result inventories conservative", () => {
    const f = fixture(32);
    expect(status([f.results[0]!], f)).toBe("UNKNOWN");
    expect(status([...f.results, f.results[0]!], f)).toBe("UNKNOWN");
    expect(status([...f.results, ...f.results, f.results[0]!], f)).toBe("UNKNOWN");
    const duplicated = [...f.results, f.results[0]!];
    const view = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: duplicated, setup: f.setup, actor: "viewer" });
    expect(view.e2e).toMatchObject({ status: "PASS", requiredCriteria: 32, qualifiedCriteria: 32, expectedGroups: 2, receivedGroups: 2, executionPlanDigest: f.plan.digest });
    const conflictingResult = { ...f.results[0]!, reason: "conflicting duplicate" };
    const conflict = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: [...f.results, conflictingResult], setup: f.setup, actor: "viewer" });
    expect(conflict.e2e).toMatchObject({ status: "UNKNOWN", requiredCriteria: 32, qualifiedCriteria: 16, expectedGroups: 2, receivedGroups: 1, executionPlanDigest: f.plan.digest });
    const excess = Array.from({ length: 257 }, () => f.results[0]!);
    const overView = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: excess, setup: f.setup, actor: "viewer" });
    expect(overView.e2e).toMatchObject({ status: "UNKNOWN", requiredCriteria: 32, qualifiedCriteria: 0, expectedGroups: 2, receivedGroups: 0, executionPlanDigest: f.plan.digest });
  });

  it("retains a valid plan when one result record exceeds its independent cap", () => {
    const f = fixture(32);
    const oversized = { ...f.results[0]!, unrecognized: "x".repeat(262_145) };
    const view = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: [oversized, f.results[1]], setup: f.setup, actor: "viewer" });
    expect(view.e2e).toMatchObject({ status: "UNKNOWN", requiredCriteria: 32, qualifiedCriteria: 0, expectedGroups: 2, executionPlanDigest: f.plan.digest });
    const cyclic = { ...f.results[0]! } as Record<string, unknown>;
    cyclic["self"] = cyclic;
    const cyclicView = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: [cyclic, f.results[1]], setup: f.setup, actor: "viewer" });
    expect(cyclicView.e2e).toMatchObject({ status: "UNKNOWN", requiredCriteria: 32, qualifiedCriteria: 0, expectedGroups: 2, executionPlanDigest: f.plan.digest });
    const extraFieldView = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results: [{ ...f.results[0]!, extra: true }, f.results[1]], setup: f.setup, actor: "viewer" });
    expect(extraFieldView.e2e).toMatchObject({ status: "UNKNOWN", requiredCriteria: 32, qualifiedCriteria: 0, expectedGroups: 2, executionPlanDigest: f.plan.digest });
  });

  it("rejects sparse, accessor, proxy, and over-count result arrays without invoking hooks", () => {
    const f = fixture(2);
    let getterCalls = 0;
    const accessor = [f.results[0], f.results[1]];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => { getterCalls += 1; return f.results[0]; } });
    const sparse = new Array<unknown>(2);
    sparse[0] = f.results[0];
    const proxied = new Proxy([f.results[0]], { get() { getterCalls += 1; throw new Error("must not invoke proxy"); } });
    for (const results of [accessor, sparse, proxied]) {
      const view = buildE2ESharedView({ plan: f.plan, currentRound: f.round, results, setup: f.setup, actor: "viewer" });
      expect(view.e2e).toMatchObject({ status: "UNKNOWN", requiredCriteria: 2, expectedGroups: 2, executionPlanDigest: f.plan.digest });
    }
    let inputGetterCalls = 0;
    const inputWithGetter = { currentRound: f.round, results: f.results, setup: f.setup, actor: "viewer" } as Record<string, unknown>;
    Object.defineProperty(inputWithGetter, "plan", { enumerable: true, get: () => { inputGetterCalls += 1; return f.plan; } });
    const getterView = buildE2ESharedView(inputWithGetter as never);
    expect(getterView.e2e.status).toBe("UNKNOWN");
    expect(getterCalls).toBe(0);
    expect(inputGetterCalls).toBe(0);
  });
});
