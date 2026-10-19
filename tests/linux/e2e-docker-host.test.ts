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
// `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE, with the DOCKER-USER metadata drop rule
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

  it("never collects the extra-order defect as PASS", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
    expect(r.exitCode, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBe(1);
    const collected = await collectLikeTheWorker(r);
    // Known gap: the collector wants a failed `assertion` step in the upstream report, but the web adapter fails the case body with a plain
    // error, so a real assertion mismatch collects as UNKNOWN instead of FAILED (see the Task 1.4 fix report).
    expect(collected.qualification?.status ?? "UNKNOWN").not.toBe("PASS");
    expect(collected.unavailableReason ?? "").toMatch(/upstream report verdict disagree/);
  }, 300_000);

  it("reports build-failed, with the build log, when a build command fails, and removes everything", async () => {
    const r = await runThroughHost({ probe: "web-csv-positive-v1", recipeBuild: [{ program: "npm", args: ["run", "does-not-exist"], cwd: ".", timeoutMs: 120_000, env: {} }] });
    expect(r.run.unavailableReason).toBe("build-failed");
    expect(r.run.actualRun).toBeNull();
    expect(r.host.readDiagnostics(r.fixture.plan.runId).buildLogTail).toMatch(/Missing script/);
    expect(r.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("cannot reach the instance metadata service from the build container", async () => {
    // The host's own IMDS rule is the CI job's DOCKER-USER drop; the build container sits on the default bridge, so it is the one that matters.
    const reach = "fetch('http://169.254.169.254/latest/meta-data/').then(()=>process.exit(0),()=>process.exit(7))";
    const r = await runThroughHost({ probe: "web-csv-positive-v1", recipeBuild: [{ program: "node", args: ["-e", reach], cwd: ".", timeoutMs: 120_000, env: {} }] });
    expect(r.run.unavailableReason).toBe("build-failed");
    expect(r.host.readDiagnostics(r.fixture.plan.runId).buildLogTail).toMatch(/exit code 7/);
    expect(r.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);
});
