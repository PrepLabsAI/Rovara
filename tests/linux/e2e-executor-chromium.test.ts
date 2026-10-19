import { afterAll, describe, expect, it } from "vitest";
import { blockedHosts, caseStatuses, csvRows, failedAssertionKinds } from "../support/e2e-executor-output.js";
import { removeProbeDirs, runProbe, type ProbeRun } from "../support/linux-runtime.js";

/** Everything a failing run left to explain it: why it was unavailable, and the redacted log tails. */
const why = (r: ProbeRun) => `${r.run.unavailableReason ?? ""}\n${JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))}`;
const outOf = (r: ProbeRun) => { if (r.outDir === null) throw new Error(`the run was unavailable: ${why(r)}`); return r.outDir; };

// Real Docker, the real executor image and a real Chromium on a per-run internal network. It runs only in the CI
// `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE); everywhere else it skips.
// Each run goes through the production Docker host (packages/verifier/src/host), the same code the worker uses.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("executor image on an internal network", () => {
  afterAll(removeProbeDirs, 120_000);

  it("web-csv-positive: real Chromium downloads the exact CSV", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null });
    expect(r.exitCode, why(r)).toBe(0);
    expect(caseStatuses(outOf(r), r.fixture)).toEqual({ "web-csv-positive-v1": "passed" });
    // The rows are the fixture's own: tests/fixtures/e2e-web-api-app/fixtures/orders.json for tenant-a, as the CSV probe oracle lists them.
    expect(csvRows(outOf(r))).toEqual([["id", "customer", "total", "state"], ["a1", "Ada", "12.5", "ready"], ["a2", "Grace", "23", "ready"]]);
    // Judged by the host's own credential predicate over every byte of the run's out directory.
    expect(r.credentialsLeaked).toBe(false);
  }, 300_000);

  it("web-csv-negative: the extra-order defect fails the csv assertion", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
    expect(r.exitCode, why(r)).toBe(1);
    expect(failedAssertionKinds(outOf(r), r.fixture)).toEqual(["csv"]);
  }, 300_000);

  it("web-egress-denial: an outside request cannot pass and is recorded as blocked", async () => {
    const r = await runProbe("web-egress-denial-v1", { defect: null, appEnv: { FIXTURE_EGRESS_PROBE_URL: "https://probe.example.com/ping" } });
    expect(caseStatuses(outOf(r), r.fixture)["web-egress-denial-v1"]).not.toBe("passed");
    expect(blockedHosts(outOf(r))).toContain("probe.example.com");
  }, 300_000);

  it("third-party assets are blocked and recorded, not fatal", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null, appEnv: { FIXTURE_EXTERNAL_FONT: "https://fonts.example.com/a.css" } });
    expect(r.exitCode, why(r)).toBe(0);
    expect(blockedHosts(outOf(r))).toContain("fonts.example.com");
  }, 300_000);

  it("api-state-positive passes and an unhealthy app is unavailable", async () => {
    const ok = await runProbe("api-state-positive-v1", { defect: null });
    expect(ok.exitCode, why(ok)).toBe(0);
    const unhealthy = await runProbe("api-state-positive-v1", { defect: null, appArgs: ["-e", "process.exit(3)"], healthTimeoutMs: 10_000 });
    expect(unhealthy.run.unavailableReason, why(unhealthy)).toBe("app-exited");
    expect(unhealthy.run.actualRun).toBeNull();
  }, 600_000);
});
