import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, canonicalJson, webApiProbeRunId } from "../../packages/contracts/src/index.js";
import { webApiApplicationLaunchTarget } from "../../packages/verifier/src/web-api-launch-target.js";
import { createWebApiProbePlan, webApiAppStartGuardArgs, webApiBuildProbeCommand, webApiProbeDriver } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot } from "../../packages/verifier/src/host/web-api-qualification-app.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const appRoot = installedWebApiQualificationAppRoot();
const challenge = webApiChallenge(Date.parse("2026-10-19T12:00:00.000Z"));

describe("the production web/API probe plan", () => {
  it.each(WEB_API_REQUIRED_PROBES.filter((probe) => probe.kind !== "build"))("pins the scenario %s runs, so the registrar can tell a swapped scenario", (probe) => {
    const driver = webApiProbeDriver(probe.probeId);
    const plan = createWebApiProbePlan({ probe: driver.probe, appRoot, runId: webApiProbeRunId(challenge, probe.probeId), ...(driver.mock === true ? { mock: true } : {}),
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
    for (const probe of WEB_API_REQUIRED_PROBES.filter((item) => item.probeId !== "app-host-denial-v1")) expect(webApiProbeDriver(probe.probeId).startArgs).toBeNull();
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
