import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { collectHostRun, proveActualRun } from "../support/e2e-actual-run-proof.js";
import { createLinuxHost, linuxRunInput, removeProbeDirs, runProbe, type ProbeRun } from "../support/linux-runtime.js";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();

// Real Docker and the real executor image, driven only through `createDockerApplicationHost`. It runs only in the CI
// `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE, with the container firewall from boot.sh
// applied); everywhere else it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("docker application host", () => {
  afterAll(removeProbeDirs, 120_000);

  async function runThroughHost(options: Parameters<typeof createOrdersExecutorPlan>[0]) {
    const fixture = createOrdersExecutorPlan(options);
    const { host, runRoot } = await createLinuxHost(fixture);
    const run = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
    const label = `label=rovara.run=${fixture.plan.runId}`;
    return { fixture, host, runRoot, run, leftovers: { containers: await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}"),
      networks: await docker("network", "ls", "--filter", label, "--format", "{{.Name}}") } };
  }

  it("runs the fixture end to end: the CSV positive passes, the readback proves cleanup, nothing is left behind", async () => {
    const r = await runThroughHost({ probe: "web-csv-positive-v1" });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    expect(r.run.lifecycle.process.exitCode).toBe(0);
    expect(r.run.lifecycle.cleanup).toBe("confirmed");
    const proof = proveActualRun(r.run.actualRun!, r.fixture.plan);
    expect(proof.captures.map((capture) => capture.terminal.kind)).toEqual(["completed"]);
    expect(proof.captures.map((capture) => capture.assertions.map((assertion) => assertion.outcome))).toEqual([["passed"]]);
    expect(r.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  /** The worker's own join after close. The executor reports its image's node path, which the worker image shares; here the test process borrows it. */
  async function collectLikeTheWorker(r: ProbeRun) {
    const actual = r.run.actualRun!;
    const inputs = await r.host.readCollectionInputs(new AbortController().signal);
    const original = process.execPath;
    process.execPath = actual.runnerToolchain.execPath;
    try { return collectHostRun(actual, inputs, r.fixture.plan); } finally { process.execPath = original; }
  }

  it("collects the CSV positive through the real collector as PASS", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status).toBe("PASS");
  }, 300_000);

  it("collects the extra-order defect through the real collector as FAILED, caused by the csv assertion", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
    expect(r.exitCode, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBe(1);
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status).toBe("FAILED");
    const [verdict] = collected.qualification!.result!.cases;
    expect(verdict!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "failed"]]);
    expect(verdict!.assertionReceipts[0]!.assertionDigest).toBe(r.fixture.compiled.expectedCases[0]!.assertionDigests[0]);
  }, 300_000);

  it("collects the API state positive as PASS and an API status mismatch as FAILED, on Rovara's HTTP engine", async () => {
    const pass = await runProbe("api-state-positive-v1", { defect: null });
    expect(pass.run.unavailableReason, JSON.stringify(pass.host.readDiagnostics(pass.fixture.plan.runId))).toBeNull();
    const passed = await collectLikeTheWorker(pass);
    expect(passed.unavailableReason, passed.unavailableReason ?? "").toBeNull();
    expect(passed.qualification?.status).toBe("PASS");
    const fail = await runProbe("api-status-mismatch-v1", { defect: null });
    expect(fail.exitCode, JSON.stringify(fail.host.readDiagnostics(fail.fixture.plan.runId))).toBe(1);
    const failed = await collectLikeTheWorker(fail);
    expect(failed.unavailableReason, failed.unavailableReason ?? "").toBeNull();
    expect(failed.qualification?.status).toBe("FAILED");
    expect(failed.qualification!.result!.cases[0]!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "failed"]]);
  }, 600_000);

  it("collects an API state that stays on another value until the poll times out as FAILED, caused by the state assertion (Ruling W)", async () => {
    // The fixture app keeps answering 200 with well-formed JSON of the approved shape and a different version: a definite mismatch, not an unavailable observation.
    // A state that never settles because the app answers non-2xx or malformed JSON stays UNKNOWN; that is covered without Docker (tests/unit/e2e-api-state-timeout.test.ts),
    // since the fixture app is byte-pinned to the installed qualification app and has no such defect.
    const r = await runProbe("api-state-positive-v1", { defect: "state-contract.json" });
    expect(r.exitCode, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBe(1);
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status).toBe("FAILED");
    expect(collected.qualification!.result!.cases[0]!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "failed"]]);
  }, 300_000);

  it("reports build-failed, with the build log, when a build command fails, and removes everything", async () => {
    const r = await runThroughHost({ probe: "web-csv-positive-v1", recipeBuild: [{ program: "npm", args: ["run", "does-not-exist"], cwd: ".", timeoutMs: 120_000, env: {} }] });
    expect(r.run.unavailableReason).toBe("build-failed");
    expect(r.run.actualRun).toBeNull();
    expect(r.host.readDiagnostics(r.fixture.plan.runId).buildLogTail).toMatch(/Missing script/);
    expect(r.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("cannot reach the instance metadata service from the build container", async () => {
    // The IMDS drop is one of the CI job's container firewall rules (the ones boot.sh installs on a runner); the build container runs on its own rvb bridge.
    const reach = "fetch('http://169.254.169.254/latest/meta-data/').then(()=>process.exit(0),()=>process.exit(7))";
    const r = await runThroughHost({ probe: "web-csv-positive-v1", recipeBuild: [{ program: "node", args: ["-e", reach], cwd: ".", timeoutMs: 120_000, env: {} }] });
    expect(r.run.unavailableReason).toBe("build-failed");
    expect(r.host.readDiagnostics(r.fixture.plan.runId).buildLogTail).toMatch(/exit code 7/);
    expect(r.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);
});
