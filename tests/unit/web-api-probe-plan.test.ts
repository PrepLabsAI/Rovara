import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_API_AGENT_PROBE_GOAL, WEB_API_AGENT_PROBE_IDS, WEB_API_AGENT_PROBE_LIMITS, WEB_API_AGENT_PROBE_ROUTE, WEB_API_REQUIRED_PROBES, canonicalJson, e2eModelRouteRevision, webApiProbeRunId } from "../../packages/contracts/src/index.js";
import { e2eAgentRoutePolicyLimits } from "../../packages/broker/src/e2e/model-route-registry.js";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { e2eApplicationGroupAgentSteps, e2eApplicationGroupUsesModel } from "../../packages/verifier/src/application-scenarios.js";
import { assertAgentProbeAssetMatchesPin, loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { webApiApplicationLaunchTarget } from "../../packages/verifier/src/web-api-launch-target.js";
import { createWebApiProbePlan, webApiAgentIsolationGuardArgs, webApiAgentProbeScript, webApiAppStartGuardArgs, webApiBuildProbeCommand, webApiProbeDriver } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot } from "../../packages/verifier/src/host/web-api-qualification-app.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const appRoot = installedWebApiQualificationAppRoot();
const challenge = webApiChallenge(Date.parse("2026-10-19T12:00:00.000Z"));

describe("the production web/API probe plan", () => {
  it.each(WEB_API_REQUIRED_PROBES.filter((probe) => probe.kind !== "build"))("pins the scenario %s runs, so the registrar can tell a swapped scenario", (probe) => {
    const driver = webApiProbeDriver(probe.probeId);
    const plan = createWebApiProbePlan({ probe: driver.probe, appRoot, runId: webApiProbeRunId(challenge, probe.probeId), ...(driver.mock === true ? { mock: true } : {}),
      ...(driver.agent === undefined ? {} : { modelRoute: { ...WEB_API_AGENT_PROBE_ROUTE }, routeLimits: { ...WEB_API_AGENT_PROBE_LIMITS } }),
      ...(driver.startArgs ? { recipeStart: { args: [...driver.startArgs] } } : {}) });
    expect(sha(canonicalJson(plan.scenario))).toBe(probe.scenarioDigest);
    expect(plan.compiled.bundle.scenarios.map(canonicalJson)).toEqual([canonicalJson(plan.scenario)]);
    // The bundle is deterministic too, so its digest is pinned and a run admitted under any other bundle cannot be this probe's.
    expect(plan.compiled.bundle.bundleDigest).toBe(probe.bundleDigest);
  });

  it.each(WEB_API_REQUIRED_PROBES.filter((probe) => probe.kind === "build"))("pins the build command of $probeId, which comes from the installed probe asset", (probe) => {
    const id = probe.probeId as "build-imds-denial-v1" | "build-lateral-denial-v1";
    expect(sha(canonicalJson(webApiBuildProbeCommand(id)))).toBe(probe.buildCommandDigest);
    expect(webApiProbeDriver(probe.probeId).recipeBuild).toEqual([webApiBuildProbeCommand(id)]);
    expect(webApiProbeDriver(probe.probeId).startArgs).toBeNull();
  });

  it("starts the app of the app host probe with the guard from its pinned asset, and every other probe with the recipe's own command", () => {
    expect(webApiProbeDriver("app-host-denial-v1")).toMatchObject({ probe: "api-state-positive-v1", recipeBuild: null, startArgs: webApiAppStartGuardArgs() });
    expect(webApiAppStartGuardArgs()[0]).toBe("--input-type=module");
    for (const probe of WEB_API_REQUIRED_PROBES.filter((item) => item.probeId !== "app-host-denial-v1" && item.probeId !== "web-agent-app-isolation-v1")) expect(webApiProbeDriver(probe.probeId).startArgs).toBeNull();
  });

  it.each(["web-csv-positive-v1", "api-state-positive-v1"] as const)("declares the launch target of %s exactly as the broker's admission builder does", (probe) => {
    const { plan } = createWebApiProbePlan({ probe, appRoot });
    const admission = plan.admission;
    const target = admission.executionPlan.effectiveTargets[0]!;
    const rebuilt = webApiApplicationLaunchTarget({ target: { targetId: target.targetId, kind: target.kind as "web" | "api", applicationId: target.applicationId, runtimeProfileId: target.runtimeProfileId },
      runtime: admission.runtimeBindings[0]!.value, capture: admission.policy.capture });
    expect(rebuilt).toEqual(admission.launchTargets[0]);
  });

  it("runs the probe under the run id it is given, in the binding the collector later checks", () => {
    const runId = webApiProbeRunId(challenge, "web-csv-positive-v1");
    const plan = createWebApiProbePlan({ probe: "web-csv-positive-v1", appRoot, runId });
    expect(plan.plan.runId).toBe(runId);
    expect(plan.plan.admission.round.groupBindings[0]!.runId).toBe(runId);
    expect(createWebApiProbePlan({ probe: "web-csv-positive-v1", appRoot }).plan.runId).not.toBe(runId);
  });

  it("asks the api egress probe for the sinkholed name and then the IP literal, and asserts only that the IP literal was reached", () => {
    const { scenario } = createWebApiProbePlan({ probe: "api-egress-denial-v1", appRoot });
    expect(scenario.steps).toMatchObject([{ kind: "request", path: "/api/inventory/status" }, { kind: "request", path: "/api/egress/raw" }]);
    expect(scenario.assertions).toMatchObject([{ kind: "http-status", path: "/api/egress/raw", equals: 200 }]);
  });

  it("drives the negative web probe with the seeded defect and the egress probes with the outside host", () => {
    expect(webApiProbeDriver("web-csv-negative-v1")).toMatchObject({ probe: "web-csv-positive-v1", defect: "extra-order.json" });
    expect(webApiProbeDriver("web-egress-denial-v1").appEnv).toEqual({ FIXTURE_EGRESS_PROBE_URL: "https://probe.example.com/ping" });
    // The host gives every declared origin (INVENTORY_ORIGIN) a container of the run, so the outside host is aimed at through the app's own egress-test variable.
    // It also aims the app at an IP literal, which no name resolution can reach, so the raw wall is judged apart from the sinkholed name.
    expect(webApiProbeDriver("api-egress-denial-v1").appEnv).toEqual({ FIXTURE_INVENTORY_ORIGIN: "https://probe.example.com", FIXTURE_RAW_EGRESS_URL: "http://1.1.1.1/" });
    expect(webApiProbeDriver("api-egress-denial-v1").mock).not.toBe(true);
    expect(() => webApiProbeDriver("unknown-v1")).toThrow("no probe plan");
    expect(join(appRoot, "defects", "extra-order.json")).toContain("qualification-app");
  });
});

describe("the plan of the agent qualification probes (Task 4.5)", () => {
  const agentPlan = (probeId: string) => {
    const driver = webApiProbeDriver(probeId);
    return createWebApiProbePlan({ probe: driver.probe, appRoot, runId: webApiProbeRunId(challenge, probeId), modelRoute: { ...WEB_API_AGENT_PROBE_ROUTE }, routeLimits: { ...WEB_API_AGENT_PROBE_LIMITS },
      ...(driver.startArgs ? { recipeStart: { args: [...driver.startArgs] } } : {}) });
  };

  it("pins the scripted route and the limits the broker derives from its budgets: a qualification that spends nothing and reaches no provider", () => {
    expect(WEB_API_AGENT_PROBE_ROUTE).toEqual({ routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) });
    expect(WEB_API_AGENT_PROBE_LIMITS).toEqual(e2eAgentRoutePolicyLimits(scriptedE2ERouteDefinition().budgets));
    expect(WEB_API_AGENT_PROBE_LIMITS.maxSpendUsd).toBeNull();
    expect(scriptedE2ERouteDefinition()).toMatchObject({ provider: "rovara-scripted", scope: "qualification", secretArn: null, inferenceProfileArn: null, openRouter: null });
  });

  it.each([...WEB_API_AGENT_PROBE_IDS])("%s runs one AI-navigated step under the scripted route in the policy, the admission, the binding and the round", (probeId) => {
    const { plan, compiled, scenario } = agentPlan(probeId);
    expect(scenario.steps).toEqual([{ kind: "navigate", path: "/" }, { kind: "agent", goal: WEB_API_AGENT_PROBE_GOAL, maxActions: 4 }]);
    expect(scenario.assertions).toMatchObject([{ kind: "csv", downloadName: "orders.csv" }]);
    expect(e2eApplicationGroupUsesModel(compiled)).toBe(true);
    expect(e2eApplicationGroupAgentSteps(compiled)).toEqual([{ caseId: compiled.expectedCases[0]!.caseId, stepIndex: 1 }]);
    expect(plan.admission.modelRoute).toEqual(WEB_API_AGENT_PROBE_ROUTE);
    expect(plan.admission.policy.modelRouteRevision).toBe(WEB_API_AGENT_PROBE_ROUTE.routeRevision);
    expect(plan.admission.policy.limits).toEqual(WEB_API_AGENT_PROBE_LIMITS);
    expect(plan.admission.round.groupBindings[0]!.modelRouteRevision).toBe(WEB_API_AGENT_PROBE_ROUTE.routeRevision);
    expect(plan.admission.runtimeBindings[0]!.value.capabilities.supportedSteps).toContain("agent");
    expect(plan.admission.runtimeBindings[0]!.value.capabilities).toMatchObject({ modelChannel: "rovara-e2e-model-channel/v1" });
  });

  it("is refused without the route: a plan with an AI-navigated step and no route cannot be made", () => {
    expect(() => createWebApiProbePlan({ probe: "web-agent-v1", appRoot })).toThrow();
    expect(() => agentPlan("web-agent-scripted-v1")).not.toThrow();
  });

  it("runs the three probes through one scenario, differing in the script and in how the app starts; no other probe gets a model", () => {
    const drivers = WEB_API_AGENT_PROBE_IDS.map((probeId) => [probeId, webApiProbeDriver(probeId)] as const);
    expect(new Set(drivers.map(([, driver]) => driver.probe))).toEqual(new Set(["web-agent-v1"]));
    expect(new Set(WEB_API_AGENT_PROBE_IDS.map((probeId) => canonicalJson(agentPlan(probeId).scenario))).size).toBe(1);
    expect(drivers.map(([probeId, driver]) => [probeId, driver.agent?.script.length, driver.startArgs === null])).toEqual([["web-agent-scripted-v1", 2, true], ["web-agent-wrong-action-v1", 1, true], ["web-agent-app-isolation-v1", 2, false]]);
    expect(webApiProbeDriver("web-agent-app-isolation-v1").startArgs).toEqual(webApiAgentIsolationGuardArgs());
    for (const probe of WEB_API_REQUIRED_PROBES.slice(0, 11)) expect(webApiProbeDriver(probe.probeId).agent, probe.probeId).toBeUndefined();
  });

  it("takes each script from the installed asset, so the pinned asset digest covers what the double does", () => {
    for (const probeId of WEB_API_AGENT_PROBE_IDS) {
      const oracle = loadWebApiQualificationProbeAssets().find((item) => item.probeId === probeId)!.probe.oracle as { script: unknown[]; goal: string; maxActions: number };
      expect(webApiAgentProbeScript(probeId)).toEqual(oracle.script);
      expect(oracle.goal).toBe(WEB_API_AGENT_PROBE_GOAL);
      expect(webApiProbeDriver(probeId).agent!.script).toEqual(oracle.script);
    }
    expect(webApiAgentProbeScript("web-agent-scripted-v1")).toEqual([{ kind: "tap", name: "^Download orders CSV$" }, { kind: "done" }]);
    expect(webApiAgentProbeScript("web-agent-wrong-action-v1")).toEqual([{ kind: "done" }]);
    expect(() => webApiAgentProbeScript("web-csv-positive-v1")).toThrow("has no script");
  });

  it("keeps the guard of the isolation probe apart from the host-denial guard, which stays as it was", () => {
    expect(webApiAgentIsolationGuardArgs()).not.toEqual(webApiAppStartGuardArgs());
    expect(webApiAgentIsolationGuardArgs()[0]).toBe("--input-type=module");
    expect(webApiAgentIsolationGuardArgs()[2]).toContain("/run/rovara/model.sock");
    expect(webApiAgentIsolationGuardArgs()[2]).toContain("model-proxy");
  });

  it("refuses an agent asset that does not say what the pin says: goal, actions, script length, downloads, expected reason, and an agent asset on a probe that is not pinned as one", () => {
    const pinOf = (probeId: string) => WEB_API_REQUIRED_PROBES.find((probe) => probe.probeId === probeId)!;
    const assetOf = (probeId: string) => loadWebApiQualificationProbeAssets().find((item) => item.probeId === probeId)!.probe;
    for (const probeId of WEB_API_AGENT_PROBE_IDS) expect(() => assertAgentProbeAssetMatchesPin(pinOf(probeId), assetOf(probeId)), probeId).not.toThrow();
    const edited = (probeId: string, change: Record<string, unknown>) => { const probe = structuredClone(assetOf(probeId)); return { ...probe, oracle: { ...probe.oracle, ...change } } as ReturnType<typeof assetOf>; };
    const refuses = (probeId: string, change: Record<string, unknown>) => expect(() => assertAgentProbeAssetMatchesPin(pinOf(probeId), edited(probeId, change)), JSON.stringify(change)).toThrow(/does not say what the qualification pins/);
    refuses("web-agent-scripted-v1", { goal: "Export something else" });
    refuses("web-agent-scripted-v1", { maxActions: 5 });
    refuses("web-agent-scripted-v1", { expectedModelCalls: 3 });
    refuses("web-agent-scripted-v1", { expectedDownloads: 0 });
    refuses("web-agent-scripted-v1", { script: [{ kind: "done" }] });
    refuses("web-agent-wrong-action-v1", { expectedDownloads: 1 });
    refuses("web-agent-wrong-action-v1", { script: [{ kind: "tap", name: "x" }, { kind: "done" }] });
    // An asset of one kind under another probe's pin is not that probe's.
    expect(() => assertAgentProbeAssetMatchesPin(pinOf("web-agent-scripted-v1"), assetOf("web-csv-positive-v1"))).toThrow(/is not an agent probe/);
    expect(() => assertAgentProbeAssetMatchesPin(pinOf("web-csv-positive-v1"), assetOf("web-agent-scripted-v1"))).toThrow(/does not pin as one/);
    expect(() => assertAgentProbeAssetMatchesPin(pinOf("web-csv-positive-v1"), assetOf("web-csv-positive-v1"))).not.toThrow();
    // The wrong-action asset names the code the pin names, and no other.
    expect(() => assertAgentProbeAssetMatchesPin(pinOf("web-agent-scripted-v1"), edited("web-agent-wrong-action-v1", {}))).toThrow(/does not say what the qualification pins/);
  });
});
