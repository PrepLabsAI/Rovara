import { afterAll, describe, expect, it } from "vitest";
import { allOutputText, blockedHosts, caseStatuses, csvRows, failedAssertionKinds } from "../support/e2e-executor-output.js";
import { removeProbeDirs, runProbe } from "../support/linux-runtime.js";

// Real Docker, the real executor image and a real Chromium on a per-run internal network. It runs only in the CI
// `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE); everywhere else it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("executor image on an internal network", () => {
  afterAll(removeProbeDirs, 120_000);

  it("web-csv-positive: real Chromium downloads the exact CSV", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null });
    expect(r.exitCode, `${r.executorLogTail}\n${r.appLogTail}`).toBe(0);
    expect(caseStatuses(r.outDir, r.fixture)).toEqual({ "web-csv-positive-v1": "passed" });
    // The rows are the fixture's own: tests/fixtures/e2e-web-api-app/fixtures/orders.json for tenant-a, as the CSV probe oracle lists them.
    expect(csvRows(r.outDir)).toEqual([["id", "customer", "total", "state"], ["a1", "Ada", "12.5", "ready"], ["a2", "Grace", "23", "ready"]]);
    const everything = allOutputText(r.outDir);
    expect(everything).not.toContain(r.fixture.account.password);
    expect(everything).not.toContain(r.fixture.account.email);
  }, 300_000);

  it("web-csv-negative: the extra-order defect fails the csv assertion", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
    expect(r.exitCode, `${r.executorLogTail}\n${r.appLogTail}`).toBe(1);
    expect(failedAssertionKinds(r.outDir, r.fixture)).toEqual(["csv"]);
  }, 300_000);

  it("web-egress-denial: an outside request cannot pass and is recorded as blocked", async () => {
    const r = await runProbe("web-egress-denial-v1", { defect: null, appEnv: { FIXTURE_EGRESS_PROBE_URL: "https://probe.example.com/ping" } });
    expect(caseStatuses(r.outDir, r.fixture)["web-egress-denial-v1"]).not.toBe("passed");
    expect(blockedHosts(r.outDir)).toContain("probe.example.com");
  }, 300_000);

  it("third-party assets are blocked and recorded, not fatal", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null, appEnv: { FIXTURE_EXTERNAL_FONT: "https://fonts.example.com/a.css" } });
    expect(r.exitCode, `${r.executorLogTail}\n${r.appLogTail}`).toBe(0);
    expect(blockedHosts(r.outDir)).toContain("fonts.example.com");
  }, 300_000);

  it("api-state-positive passes and an unhealthy app is unavailable", async () => {
    const ok = await runProbe("api-state-positive-v1", { defect: null });
    expect(ok.exitCode, `${ok.executorLogTail}\n${ok.appLogTail}`).toBe(0);
    const unhealthy = await runProbe("api-state-positive-v1", { defect: null, appCommand: ["node", "-e", "process.exit(3)"], healthTimeoutMs: 10_000 });
    expect(unhealthy.exitCode, unhealthy.executorLogTail).toBe(2);
  }, 600_000);
});
