import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, canonicalJson, webApiProbeRunId } from "../../packages/contracts/src/index.js";
import { createWebApiProbePlan, webApiBuildProbeCommand, webApiProbeDriver } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot } from "../../packages/verifier/src/host/web-api-qualification-app.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const appRoot = installedWebApiQualificationAppRoot();
const challenge = webApiChallenge(Date.parse("2026-10-19T12:00:00.000Z"));

describe("the production web/API probe plan", () => {
  it.each(WEB_API_REQUIRED_PROBES.filter((probe) => probe.kind !== "build"))("pins the scenario %s runs, so the registrar can tell a swapped scenario", (probe) => {
    const driver = webApiProbeDriver(probe.probeId);
    const plan = createWebApiProbePlan({ probe: driver.probe, appRoot, runId: webApiProbeRunId(challenge, probe.probeId) });
    expect(sha(canonicalJson(plan.scenario))).toBe(probe.scenarioDigest);
    expect(plan.compiled.bundle.scenarios.map(canonicalJson)).toEqual([canonicalJson(plan.scenario)]);
    // The bundle is deterministic too, so its digest is pinned and a run admitted under any other bundle cannot be this probe's.
    expect(plan.compiled.bundle.bundleDigest).toBe(probe.bundleDigest);
  });

  it("pins the build command of the IMDS probe, which comes from the installed probe asset", () => {
    const probe = WEB_API_REQUIRED_PROBES.find((item) => item.kind === "build")!;
    expect(sha(canonicalJson(webApiBuildProbeCommand()))).toBe(probe.buildCommandDigest);
    expect(webApiProbeDriver(probe.probeId).recipeBuild).toEqual([webApiBuildProbeCommand()]);
  });

  it("runs the probe under the run id it is given, in the binding the collector later checks", () => {
    const runId = webApiProbeRunId(challenge, "web-csv-positive-v1");
    const plan = createWebApiProbePlan({ probe: "web-csv-positive-v1", appRoot, runId });
    expect(plan.plan.runId).toBe(runId);
    expect(plan.plan.admission.round.groupBindings[0]!.runId).toBe(runId);
    expect(createWebApiProbePlan({ probe: "web-csv-positive-v1", appRoot }).plan.runId).not.toBe(runId);
  });

  it("drives the negative web probe with the seeded defect and the egress probes with the outside host", () => {
    expect(webApiProbeDriver("web-csv-negative-v1")).toMatchObject({ probe: "web-csv-positive-v1", defect: "extra-order.json" });
    expect(webApiProbeDriver("web-egress-denial-v1").appEnv).toEqual({ FIXTURE_EGRESS_PROBE_URL: "https://probe.example.com/ping" });
    expect(webApiProbeDriver("api-egress-denial-v1").appEnv).toEqual({ INVENTORY_ORIGIN: "https://probe.example.com" });
    expect(() => webApiProbeDriver("unknown-v1")).toThrow("no probe plan");
    expect(join(appRoot, "defects", "extra-order.json")).toContain("qualification-app");
  });
});
