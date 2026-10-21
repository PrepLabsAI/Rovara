import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { UNMOCKED_EXTERNAL_CALL_REASON } from "../../packages/verifier/src/application-result-adapter.js";
import { collectHostRun } from "../support/e2e-actual-run-proof.js";
import { EXECUTOR_IMAGE, removeProbeDirs, runProbe, type ProbeRun } from "../support/linux-runtime.js";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();

// External-origin mocks on a real Docker host: the production host starts the approved mock and the sinkhole from the executor image on the run's internal network, the app talks to them
// by name, and the real collector turns what they recorded into the verdict. Runs only where Docker and the executor image are provided (the CI `linux-runtime` job); elsewhere it skips.
describe.runIf(process.env.ROVARA_DOCKER === "1")("external-origin mocks and unmocked-call detection on a real Docker host", () => {
  afterAll(removeProbeDirs, 120_000);

  /** The worker's own join after close. The executor reports the Linux Node of its image; on a Linux runner only the path differs, on another host the platform does too. */
  async function collectLikeTheWorker(r: ProbeRun) {
    const actual = r.run.actualRun!;
    const inputs = await r.host.readCollectionInputs(new AbortController().signal);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const original = process.execPath;
    process.execPath = actual.runnerToolchain.execPath;
    if (process.platform !== "linux") Object.defineProperty(process, "platform", { ...platform, value: actual.runnerToolchain.platform });
    try { return collectHostRun(actual, inputs, r.fixture.plan); } finally { process.execPath = original; Object.defineProperty(process, "platform", platform); }
  }
  const leftovers = async (r: ProbeRun) => {
    const label = `label=rovara.run=${r.fixture.plan.runId}`;
    return { containers: await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}"), networks: await docker("network", "ls", "--filter", label, "--format", "{{.Name}}") };
  };

  it("serves the inventory origin from its approved mock: the owner's CSV shows in-stock for a1 and unavailable for a2, and the run passes", async () => {
    const r = await runProbe("web-inventory-csv-v1", { defect: null, mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    const verdict = collected.qualification!;
    expect(verdict.status, verdict.reason).toBe("PASS");
    // One order the mock answered with its success variant and one it refused: both calls are the app's own, both verified against the approved fixture.
    expect(verdict.mockSummary).toEqual({ consumptions: { success: 1, refusal: 1, invalidData: 0 }, unmockedCalls: { sinkhole: 0, mocked: 0 }, mockedOrigins: ["inventory-v1"] });
    expect(verdict.result?.mockedOrigins).toEqual(["inventory-v1"]);
    expect(verdict.result?.cases.map((item) => item.mockedOrigins)).toEqual([["inventory-v1"]]);
    expect(await leftovers(r)).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("shows the page's stock status once, from the success variant", async () => {
    const r = await runProbe("web-inventory-status-v1", { defect: null, mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const verdict = (await collectLikeTheWorker(r)).qualification!;
    expect(verdict.status, verdict.reason).toBe("PASS");
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 1, refusal: 0, invalidData: 0 });
  }, 300_000);

  it("is UNKNOWN for unmocked-external-call when the app asks the mock for a path it does not serve (the dependency-route defect calls /internal/admin)", async () => {
    const r = await runProbe("web-inventory-status-v1", { defect: "dependency-route.json", mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    const verdict = collected.qualification!;
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.result?.cases[0]).toMatchObject({ status: "unavailable", reason: UNMOCKED_EXTERNAL_CALL_REASON });
    // The mock answered 599 and recorded it; it is never a failure of the feature and never a pass.
    expect(verdict.mockSummary?.unmockedCalls).toEqual({ sinkhole: 0, mocked: 1 });
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 0, refusal: 0, invalidData: 0 });
  }, 300_000);

  it("is UNKNOWN for unmocked-external-call when the origin has no approved mock, although the app hid the failed call and every assertion held", async () => {
    const r = await runProbe("web-inventory-status-v1", { defect: "swallow-dependency.json" });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    const verdict = collected.qualification!;
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.reason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    expect(verdict.result?.cases[0]?.assertionReceipts.map((receipt) => receipt.status)).toEqual(["passed"]);
    expect(verdict.mockSummary?.unmockedCalls).toEqual({ sinkhole: 1, mocked: 0 });
    expect(verdict.result?.mockedOrigins).toBeUndefined();
  }, 300_000);

  it("never makes a case a pass because a declared origin was not called: the run without the call is not a pass either", async () => {
    // The default qualification app calls its inventory origin only when the page asks; this scenario never asks, so an approved mock goes unused.
    const r = await runProbe("web-csv-positive-v1", { defect: null, mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const verdict = (await collectLikeTheWorker(r)).qualification!;
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.result?.cases[0]).toMatchObject({ status: "unavailable", reason: "application-evidence-floor-unmet" });
  }, 300_000);

  it("runs the mock mode of the executor image under the host's own flags and answers by variant, recording every request", async () => {
    // The image's second mode, started exactly as the host starts it, on a throwaway internal network, and asked from another container by its network alias.
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-mock-mode-")));
    const name = `rovara-mock-mode-${Date.now()}`;
    const network = `${name}-net`;
    try {
      await mkdir(join(root, "mock"), { recursive: true }); await mkdir(join(root, "out"), { recursive: true, mode: 0o777 });
      const { chmod, readFile } = await import("node:fs/promises");
      await chmod(join(root, "out"), 0o777);
      await writeFile(join(root, "mock", "fixture.json"), await readFile(join(import.meta.dirname, "../fixtures/e2e-web-api-app/e2e/mocks/inventory-v1.json")));
      await docker("network", "create", "--internal", network);
      await docker("run", "-d", "--name", name, "--pull=never", "--network", network, "--network-alias", "mock-inventory-v1", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--init",
        "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64", "--cpus", "0.5", "--user", "node", "-v", `${join(root, "mock")}:/mock:ro`, "-v", `${join(root, "out")}:/out/mock`,
        "-e", "ROVARA_MOCK_FIXTURE=/mock/fixture.json", EXECUTOR_IMAGE, "node", "/opt/agentx/packages/verifier/dist/executor/entry.js", "--mock", "/mock/fixture.json", "--origin", "inventory-v1");
      const ask = "const ask = async (q) => { const r = await fetch('http://mock-inventory-v1:8080' + q); return r.status + ' ' + await r.text(); };"
        + "(async () => { for (let i = 0; i < 60; i += 1) { try { await ask('/v1/stock?orderId=a1'); break; } catch { await new Promise((done) => setTimeout(done, 500)); } }"
        + "console.log(await ask('/v1/stock?orderId=a2')); console.log(await ask('/v1/stock?orderId=b1')); console.log(await ask('/v1/stock')); console.log(await ask('/health')); })();";
      const answers = (await docker("run", "--rm", "--pull=never", "--network", network, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", EXECUTOR_IMAGE, "-e", ask)).split("\n");
      expect(answers).toEqual(['404 {"error":"unknown order"}', '200 {"status":7}', '599 {"error":"rovara-unmocked"}', '599 {"error":"rovara-unmocked"}']);
      const lines = (await readFile(join(root, "out", "inventory-v1.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { variantId: string | null; status: number });
      expect(lines.map((line) => [line.variantId, line.status])).toEqual([["success", 200], ["refusal", 404], ["invalid-data", 200], [null, 599], [null, 599]]);
      // A hardened mock: no capability, no write outside its ledger directory.
      expect(await docker("inspect", "-f", "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}", name)).toBe("true [ALL] node");
    } finally {
      await docker("rm", "-f", name).catch(() => undefined);
      await docker("network", "rm", network).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);
});
