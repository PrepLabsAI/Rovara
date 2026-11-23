// Browser testing, Lane B: "this is not your live site" is claimed only on a runtime whose registered record shows the egress probes passed. Read from the runtime row, never inferred.
import { describe, expect, it } from "vitest";
import { SANDBOX_EGRESS_PROBE_IDS, WEB_API_REQUIRED_PROBE_IDS } from "@agentx/contracts";
import { readyProfilesFor, runtimeProvesSandbox, sandboxAvailableFor } from "../../packages/broker/src/core/setup-agent/browser-testing-sandbox.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { registerProject } from "../support/browser-testing-world.js";
import { NOW, PROFILE, shaCanonical, webApiRow } from "../support/e2e-application-plan-fixtures.js";

/** A web row whose probe manifest lists exactly these probes (the digest recomputed, so the row still parses whole). */
function rowWith(probeIds: readonly string[], overrides: Record<string, unknown> = {}) {
  const base = webApiRow("web");
  const { manifestDigest: _digest, ...content } = base.probeManifest;
  void _digest;
  const body = { ...content, positiveProbeIds: probeIds.slice(0, 2), negativeProbeIds: probeIds.slice(2) };
  return webApiRow("web", { probeManifest: { ...body, manifestDigest: shaCanonical(body) }, ...overrides });
}

describe("which probes make the sandbox claim true", () => {
  it("names six probes, every one of them a probe the install qualification requires", () => {
    expect([...SANDBOX_EGRESS_PROBE_IDS].sort()).toEqual(["api-egress-denial-v1", "app-host-denial-v1", "app-private-denial-v1", "build-imds-denial-v1", "build-lateral-denial-v1", "web-egress-denial-v1"]);
    for (const id of SANDBOX_EGRESS_PROBE_IDS) expect(WEB_API_REQUIRED_PROBE_IDS).toContain(id);
  });

  it("a runtime proves it only when its manifest lists ALL of them; missing any one is not available", () => {
    expect(runtimeProvesSandbox(rowWith([...SANDBOX_EGRESS_PROBE_IDS]))).toBe(true);
    expect(runtimeProvesSandbox(rowWith(["web-csv-positive-v1", "web-csv-negative-v1", ...SANDBOX_EGRESS_PROBE_IDS]))).toBe(true);
    for (const missing of SANDBOX_EGRESS_PROBE_IDS) expect(runtimeProvesSandbox(rowWith(SANDBOX_EGRESS_PROBE_IDS.filter((id) => id !== missing))), missing).toBe(false);
    expect(runtimeProvesSandbox(rowWith(["web-csv-positive-v1", "web-csv-negative-v1", "web-egress-denial-v1"]))).toBe(false);
  });
});

describe("whether the sandbox is available for a project", () => {
  async function company(rows: Array<{ kind: "web" | "api"; row: ReturnType<typeof webApiRow> }>, project: Record<string, unknown> | undefined = undefined) {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY, "payments", project);
    for (const { kind, row } of rows) await world.store.put({ item: { ...e2eRegisteredRuntimeKey("catalog", PROFILE, kind), ...row } as never });
    const input = { store: world.store, companyId: FAKE_COMPANY, project: "payments", runtimeCatalogId: "catalog", now: NOW };
    return { input, world };
  }

  it("is available on a READY runtime of the project's binding that passed every egress probe, and that runtime is a READY profile for the proposal", async () => {
    const { input } = await company([{ kind: "web", row: rowWith([...SANDBOX_EGRESS_PROBE_IDS]) }]);
    expect(await sandboxAvailableFor(input, 1)).toBe(true);
    expect(await readyProfilesFor(input, 1)).toEqual([{ kind: "web", profileId: PROFILE }]);
  });

  it("is NOT available when the runtime did not list the probes, when the row is expired or parked, when it is another binding's, or when there is none", async () => {
    expect(await sandboxAvailableFor((await company([{ kind: "web", row: rowWith(["web-csv-positive-v1", "web-csv-negative-v1", "web-egress-denial-v1"]) }])).input, 1)).toBe(false);
    expect(await sandboxAvailableFor((await company([{ kind: "web", row: rowWith([...SANDBOX_EGRESS_PROBE_IDS], { expiresAt: new Date(NOW - 1000).toISOString(), qualifiedAt: new Date(NOW - 60_000).toISOString() }) }])).input, 1)).toBe(false);
    expect(await sandboxAvailableFor((await company([{ kind: "web", row: rowWith([...SANDBOX_EGRESS_PROBE_IDS], { state: "PARKED" }) }])).input, 1)).toBe(false);
    expect(await sandboxAvailableFor((await company([])).input, 1)).toBe(false);
    const other = await company([{ kind: "web", row: rowWith([...SANDBOX_EGRESS_PROBE_IDS]) }]);
    expect(await sandboxAvailableFor({ ...other.input, runtimeCatalogId: "another-catalog" }, 1)).toBe(false);
    expect(await sandboxAvailableFor({ ...other.input, project: "ledger" }, 1)).toBe(false);
  });

  it("is not available for a project with no runtime binding (a fault is a fault; it is not 'off for this company')", async () => {
    const { input } = await company([{ kind: "web", row: rowWith([...SANDBOX_EGRESS_PROBE_IDS]) }], { registeredBy: "k" });
    expect(await sandboxAvailableFor(input, 1)).toBe(false);
    expect(await readyProfilesFor(input, 1)).toEqual([]);
  });
});
