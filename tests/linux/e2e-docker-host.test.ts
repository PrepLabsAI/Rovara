import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { proveActualRun } from "../support/e2e-actual-run-proof.js";
import { createLinuxHost, linuxRunInput, removeProbeDirs } from "../support/linux-runtime.js";

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
