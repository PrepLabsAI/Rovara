import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationJournal, createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/index.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { createApplicationChecksFeatureMonitor, createWorkflowE2EApplicationRuntime, workflowE2EApplicationChecksAvailability, workflowE2EApplicationHostDeps, workflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli } from "../support/fake-docker-cli.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("worker application runtime configuration", () => {
  const image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-executor@sha256:" + "a".repeat(64);

  it("takes the executor image from EXECUTOR_IMAGE, the build image from the pin and a shared run root from the host profile", () => {
    expect(workflowE2EApplicationRuntimeConfig({ EXECUTOR_IMAGE: image }, "linux", "arm64"))
      .toEqual({ executorImage: image, buildImage: WEB_API_BUILD_IMAGE, runRoot: "/mnt/agentx-runtime/candidates/web-api-runs" });
  });

  it.each([{}, { EXECUTOR_IMAGE: "" }, { EXECUTOR_IMAGE: "  " }, { EXECUTOR_IMAGE: "--privileged" }, { EXECUTOR_IMAGE: "two words" }])("refuses to run without a usable executor image (%j)", (environment) => {
    expect(() => workflowE2EApplicationRuntimeConfig(environment, "linux", "arm64")).toThrow(/EXECUTOR_IMAGE/);
  });

  it("refuses a host with no shared runtime directory", () => {
    expect(() => workflowE2EApplicationRuntimeConfig({ EXECUTOR_IMAGE: image }, "darwin", "arm64")).toThrow(/shared runtime directory/);
  });

  it("builds one Docker application host per call over the supplied admission, group and staged source, touching docker only when it runs", async () => {
    const source = await realpath(await mkdtemp(join(tmpdir(), "runtime-source-")));
    roots.push(source);
    await writeFile(join(source, "package.json"), "{}");
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const docker = new FakeDockerCli();
    const runtime = createWorkflowE2EApplicationRuntime({ EXECUTOR_IMAGE: image }, { platform: "linux", arch: "arm64", docker });
    expect(runtime.runRoot).toBe("/mnt/agentx-runtime/candidates/web-api-runs");
    const first = runtime.createHost({ admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source });
    const second = runtime.createHost({ admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source });
    expect(first).not.toBe(second);
    expect(docker.calls).toEqual([]);
    expect(() => runtime.createHost({ admission: fixture.plan.admission, groupId: "not-a-group", candidateSourceDir: source })).toThrow(/not a runnable application group/);
  });

  it("takes only the admission, group and staged source from the caller, never the image, run root or docker", () => {
    const config = { executorImage: image, buildImage: WEB_API_BUILD_IMAGE, runRoot: "/mnt/agentx-runtime/candidates/web-api-runs" };
    const docker = new FakeDockerCli();
    const now = () => 1;
    const hostile = { admission: { marker: "admission" }, groupId: "group-1", candidateSourceDir: "/staged", executorImage: "evil:latest", buildImage: "evil:build",
      runRoot: "/tmp/elsewhere", docker: "not-docker", now: () => 2, assemble: "x", onRunOutput: "x", executorSeccompProfile: "/tmp/open.json" } as never;
    const deps = workflowE2EApplicationHostDeps(config, docker, now, hostile);
    expect(Object.keys(deps).sort()).toEqual(["admission", "buildImage", "candidateSourceDir", "docker", "executorImage", "groupId", "now", "runRoot"]);
    expect(deps).toMatchObject({ executorImage: image, buildImage: WEB_API_BUILD_IMAGE, runRoot: config.runRoot, docker, now, groupId: "group-1", candidateSourceDir: "/staged" });
  });
});

describe("whether this worker can run application rounds at all", () => {
  const image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-executor@sha256:" + "a".repeat(64);
  const docker = (code: number) => ({ run: vi.fn<(args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>>(async () => ({ code, stdout: "", stderr: "" })) });

  it("is ready only when EXECUTOR_IMAGE is set and the host holds that image", async () => {
    const cli = docker(0);
    await expect(workflowE2EApplicationChecksAvailability({ EXECUTOR_IMAGE: image }, { platform: "linux", arch: "arm64", docker: cli })).resolves.toEqual({ status: "ready" });
    expect(cli.run.mock.calls[0]?.[0]).toEqual(["image", "inspect", image]);
  });

  it("is unavailable, without touching docker, when EXECUTOR_IMAGE is not set to an image reference", async () => {
    const cli = docker(0);
    await expect(workflowE2EApplicationChecksAvailability({}, { platform: "linux", arch: "arm64", docker: cli })).resolves.toEqual({ status: "unavailable", reason: "executor-image-not-configured" });
    await expect(workflowE2EApplicationChecksAvailability({ EXECUTOR_IMAGE: "--privileged" }, { platform: "linux", arch: "arm64", docker: cli })).resolves.toMatchObject({ status: "unavailable" });
    expect(cli.run).not.toHaveBeenCalled();
  });

  it("is unavailable when the host does not hold the image, or docker cannot be asked", async () => {
    await expect(workflowE2EApplicationChecksAvailability({ EXECUTOR_IMAGE: image }, { platform: "linux", arch: "arm64", docker: docker(1) }))
      .resolves.toEqual({ status: "unavailable", reason: "executor-image-not-on-host" });
    const broken = { run: vi.fn(async () => { throw new Error("docker.sock: no such file"); }) };
    await expect(workflowE2EApplicationChecksAvailability({ EXECUTOR_IMAGE: image }, { platform: "linux", arch: "arm64", docker: broken }))
      .resolves.toEqual({ status: "unavailable", reason: "executor-image-not-on-host" });
  });

  it("is unavailable on a host with no shared runtime directory", async () => {
    await expect(workflowE2EApplicationChecksAvailability({ EXECUTOR_IMAGE: image }, { platform: "darwin", arch: "arm64", docker: docker(0) }))
      .resolves.toEqual({ status: "unavailable", reason: "no-shared-runtime-directory" });
  });
});

describe("the application CHECKS feature as /ping reports it (never waits on Docker)", () => {
  const image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-executor@sha256:" + "a".repeat(64);
  type Result = { code: number; stdout: string; stderr: string };
  const FEATURE = "task.workflowE2EApplicationChecks";
  const pingOf = async (monitor: ReturnType<typeof createApplicationChecksFeatureMonitor>) => {
    const root = await mkdtemp(join(tmpdir(), "agentx-monitor-ping-"));
    roots.push(root);
    const state = createWorkerServerState(new OperationJournal(root), { execute: () => Promise.resolve(), ...monitor.executor });
    const started = Date.now();
    const body = await (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as { invocationFeatures: string[]; invocationFeatureDiagnostics?: Record<string, unknown> };
    return { body, elapsedMs: Date.now() - started };
  };

  it("starts as unavailable and answers /ping at once while a slow Docker has not answered, then lists the feature once the first check succeeds", async () => {
    let release!: (result: Result) => void;
    const docker = { run: vi.fn(() => new Promise<Result>((resolve) => { release = resolve; })) };
    const monitor = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker, intervalMs: 60_000 });
    expect(monitor.current()).toEqual({ status: "unavailable", reason: "not-yet-checked" });
    monitor.start();
    const slow = await pingOf(monitor);
    expect(slow.elapsedMs).toBeLessThan(500);
    expect(slow.body.invocationFeatures).not.toContain(FEATURE);
    expect(slow.body.invocationFeatureDiagnostics).toMatchObject({ [FEATURE]: { status: "unavailable", reason: "not-yet-checked" } });
    release({ code: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(monitor.current()).toEqual({ status: "ready" }));
    expect((await pingOf(monitor)).body.invocationFeatures).toContain(FEATURE);
    monitor.stop();
  });

  it("refreshes in the background: a host that loses the image stops listing the feature, and one that gets it lists it again", async () => {
    vi.useFakeTimers();
    try {
      let code = 0;
      const docker = { run: vi.fn(async () => ({ code, stdout: "", stderr: "" })) };
      const monitor = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker, intervalMs: 30_000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.current()).toEqual({ status: "ready" });
      code = 1;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.current()).toEqual({ status: "unavailable", reason: "executor-image-not-on-host" });
      code = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.current()).toEqual({ status: "ready" });
      monitor.stop();
      const calls = docker.run.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(docker.run.mock.calls.length).toBe(calls);
    } finally { vi.useRealTimers(); }
  });

  it("lists the baseline feature (Task 3.7b) exactly when it lists application CHECKS: both need the executor image on the host, and both are withheld together with the reason", async () => {
    const BASELINE = "task.workflowE2EBaselineChecks";
    const V2 = "task.workflowE2EApplicationChecks.v2";
    const docker = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
    const monitor = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker, intervalMs: 60_000 });
    expect(monitor.executor.withholdableInvocationFeatures).toEqual([FEATURE, V2, BASELINE]);
    const before = await pingOf(monitor);
    expect(before.body.invocationFeatures).not.toContain(BASELINE);
    // Task 3.4: the string for version 2 admissions (web and API groups in one plan) is listed and withheld with the application CHECKS feature, so a worker that cannot run application rounds never claims it.
    expect(before.body.invocationFeatures).not.toContain(V2);
    expect(before.body.invocationFeatureDiagnostics).toMatchObject({ [V2]: { status: "unavailable", reason: "not-yet-checked" } });
    expect(before.body.invocationFeatureDiagnostics).toMatchObject({ [BASELINE]: { status: "unavailable", reason: "not-yet-checked" } });
    monitor.start();
    await vi.waitFor(() => expect(monitor.current()).toEqual({ status: "ready" }));
    const ready = await pingOf(monitor);
    expect(ready.body.invocationFeatures).toEqual(expect.arrayContaining([FEATURE, V2, BASELINE]));
    monitor.stop();
    const missing = { run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) };
    const without = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker: missing, intervalMs: 60_000 });
    without.start();
    await vi.waitFor(() => expect(without.current()).toMatchObject({ status: "unavailable" }));
    const lacking = await pingOf(without);
    expect(lacking.body.invocationFeatures).not.toContain(BASELINE);
    expect(lacking.body.invocationFeatures).not.toContain(V2);
    expect(lacking.body.invocationFeatureDiagnostics).toMatchObject({ [V2]: { status: "unavailable", reason: "executor-image-not-on-host" } });
    // Exporting the unchanged code needs the repository alone, so a host without the executor image still lists it (review 3.7b finding 5).
    expect(lacking.body.invocationFeatures).toContain("task.workflowE2EBaselineSource");
    expect(lacking.body.invocationFeatureDiagnostics).toMatchObject({ [BASELINE]: { status: "unavailable", reason: "executor-image-not-on-host" } });
    without.stop();
  });

  it("does not start a second check while one is still running", async () => {
    vi.useFakeTimers();
    try {
      const docker = { run: vi.fn(() => new Promise<Result>(() => undefined)) };
      const monitor = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker, intervalMs: 1_000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(docker.run).toHaveBeenCalledTimes(1);
      monitor.stop();
    } finally { vi.useRealTimers(); }
  });

  it("stays unavailable without calling Docker when EXECUTOR_IMAGE is not set (production today)", async () => {
    const docker = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
    const monitor = createApplicationChecksFeatureMonitor({ environment: {}, platform: "linux", arch: "arm64", docker, intervalMs: 60_000 });
    monitor.start();
    await vi.waitFor(() => expect(monitor.current()).toEqual({ status: "unavailable", reason: "executor-image-not-configured" }));
    expect(docker.run).not.toHaveBeenCalled();
    expect((await pingOf(monitor)).body.invocationFeatures).not.toContain(FEATURE);
    monitor.stop();
  });

  it("is wired in main.ts from the monitor's last value: started at boot, spread into the executor, and never asked of Docker per ping", async () => {
    const main = await readFile(new URL("../../packages/worker/src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("createApplicationChecksFeatureMonitor({ environment: process.env })");
    expect(main).toContain("applicationChecks.start()");
    expect(main).toContain("...applicationChecks.executor");
    expect(main).not.toContain("workflowE2EApplicationChecksAvailability");
    expect(main).not.toMatch(/withheldInvocationFeatures\s*\(/);
  });
});
