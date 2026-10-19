import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2EExecutorPlanSchema } from "@agentx/contracts";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createDockerApplicationHost, createProcessDockerCli, sweepStaleRovaraRuns } from "../../packages/verifier/src/host/docker-application-host.js";
import { createOrdersExecutorPlan, type OrdersExecutorFixture } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }

const sentinel = { protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" } };
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(options: { fake: FakeDockerCli; deadlineMs?: number; recipeBuild?: Parameters<typeof createOrdersExecutorPlan>[0]["recipeBuild"]; runRoot?: string; role?: "owner" | "viewer" }) {
  const fixture: OrdersExecutorFixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.recipeBuild ? { recipeBuild: options.recipeBuild } : {}), ...(options.role ? { role: options.role } : {}) });
  const source = await temp("candidate-source-"); await writeFile(join(source, "package.json"), "{}");
  const runRoot = options.runRoot ?? await temp("run-root-");
  const assemble = vi.fn<(input: unknown) => never>(() => sentinel as never);
  const host = createDockerApplicationHost({ docker: options.fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, now: () => Date.now(),
    admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source, appPollMs: 10, deadlineGraceMs: 60, assemble });
  const { compiled, plan } = fixture;
  const binding = plan.admission.round.groupBindings[0]!;
  const ref = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
  const app = compiled.applicationBindings.get(ref.applicationId)!; const runtime = compiled.runtimeBindings.get(ref.runtimeProfileId)!;
  const input = { binding, suite: { bundle: compiled.bundle, files: compiled.shards[0]!.files, expectedCases: compiled.expectedCases },
    profile: { profileId: runtime.profileId, kind: "web", runtimeManifestDigest: runtime.manifestDigest,
      applications: [{ applicationId: ref.applicationId, appBuildManifestDigest: app.build.manifestDigest,
        appRecipe: app.approval.applications.find((item) => item.applicationId === ref.applicationId)!.recipe }],
      networkPolicyDigest: runtime.capabilities.networkPolicyDigest, seedDigest: "a".repeat(64), limits: runtime.binding,
      capture: compiled.runtimeAdmissionContext.selectionInput.policy.capture }, modelPermit: null };
  return { fixture, host, assemble, input, runId: plan.runId, groupId: plan.groupId, runRoot, fake: options.fake };
}
const runWith = (s: Setup, signal: AbortSignal = new AbortController().signal) =>
  runIsolatedE2EApplication({ input: s.input as never, compiled: s.fixture.compiled, ports: s.host, signal });
const okOutput = (s: Setup) => (outDir: string) => writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: s.runId, groupId: s.groupId });
const buildStep = [{ program: "npm", args: ["run", "build"], cwd: ".", timeoutMs: 45_000, env: {} }, { program: "npm", args: ["run", "does-not-exist"], cwd: ".", timeoutMs: 60_000, env: {} }];

describe("docker application host", () => {
  it("never gives app or executor the docker socket, credentials or a published port", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.unavailableReason).toBeNull();
    for (const args of [fake.argsFor("app"), fake.argsFor("executor")]) {
      expect(args).toEqual(expect.arrayContaining(["--network", `rovara-e2e-${s.runId}`, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--label", `rovara.run=${s.runId}`]));
      expect(args.join(" ")).not.toMatch(/docker\.sock|AWS_|AGENTX_|PI_|GIT_|TOKEN|SECRET|(^| )-p /);
    }
    expect(fake.argsFor("app")).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,size=256m", "--network-alias", "app", "APP_PORT=4317", "--memory", "1g", "--pids-limit", "512"]));
    expect(fake.argsFor("executor")).toEqual(expect.arrayContaining(["--init", "--read-only", "--shm-size", "1g"]));
    expect(fake.call("network create")).toContain("--internal");
    expect(fake.mountsFor("executor").find((mount) => mount.endsWith(":/run/rovara/plan.json:ro"))).toBeDefined();
    expect(fake.mountsFor("executor").find((mount) => mount.endsWith(":/out"))).toBeDefined();
    expect(fake.mountsFor("app").some((mount) => mount.endsWith(":/app:ro"))).toBe(true);
    expect(fake.mountsFor("app").some((mount) => mount.endsWith(":/app/.owned:ro"))).toBe(true);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("gives the build container the source read-only, no credentials and registry egress only, and runs each command with its own timeout", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep }); fake.onExecutor = okOutput(s);
    await runWith(s);
    const builds = fake.calls.filter((args) => args[0] === "run" && args[args.indexOf("--name") + 1]!.startsWith("rovara-build-"));
    expect(builds).toHaveLength(3);
    for (const args of builds) {
      expect(args).toEqual(expect.arrayContaining(["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "2g", "--pids-limit", "1024"]));
      expect(args).not.toContain("--network");
      expect(args.join(" ")).not.toMatch(/docker\.sock|AWS_|AGENTX_|PI_|GIT_|TOKEN|SECRET|(^| )-p /);
      expect(args.some((value) => value.endsWith(":/src:ro"))).toBe(true);
      expect(args.some((value) => value.endsWith(":/out") && args[args.indexOf(value) - 1] === "-v")).toBe(true);
    }
    expect(builds[1]!.slice(-3)).toEqual(["npm", "run", "build"]);
    expect(fake.buildTimeouts().slice(1)).toEqual([45_000, 60_000]);
    // The app runs the built tree, and the network was created before anything used it.
    expect(fake.calls.findIndex((args) => args[0] === "network" && args[1] === "create")).toBeLessThan(fake.calls.indexOf(builds[0]!));
  });

  it("seeds synthetic credentials for the plan's account profiles and keeps them out of every diagnostic", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    let planText = ""; let seedText = "";
    fake.onExecutor = (outDir, args) => {
      okOutput(s)(outDir);
      const mount = (from: string[], suffix: string) => from.find((value, index) => from[index - 1] === "-v" && value.endsWith(suffix))!.slice(0, -suffix.length);
      planText = readFileSync(mount(args, ":/run/rovara/plan.json:ro"), "utf8");
      seedText = readFileSync(join(mount(fake.argsFor("app"), ":/app/.owned:ro"), "seed.json"), "utf8");
      const account = (JSON.parse(planText) as { accounts: { email: string; password: string }[] }).accounts[0]!;
      // The executor echoes the credentials the way a careless log line would.
      fake.executorStdout = `login ${account.email} with ${account.password}\n`;
    };
    await runWith(s);
    const plan = E2EExecutorPlanSchema.parse(JSON.parse(planText));
    expect(plan.accounts).toHaveLength(1);
    const account = plan.accounts[0]!;
    expect(account.profileId).toBe("orders-owner");
    expect(account.email).toMatch(/^rovara-orders-owner-[0-9a-f]{6}@example\.test$/);
    expect(account.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const seed = JSON.parse(seedText) as { accounts: Record<string, string>[] };
    expect(seed.accounts).toEqual([{ email: account.email, passwordDigest: createHash("sha256").update(account.password).digest("hex"),
      subjectId: expect.stringMatching(/^subject-/) as unknown, tenantId: "tenant-a", role: "owner", displayName: "Rovara orders-owner" }]);
    expect(seedText).not.toContain(account.password);
    const diagnostics = s.host.readDiagnostics(s.runId);
    expect(diagnostics.executorLogTail).toContain("<account:orders-owner>");
    expect(JSON.stringify(diagnostics)).not.toContain(account.password);
    expect(JSON.stringify(diagnostics)).not.toContain(account.email);
    expect(Buffer.byteLength(diagnostics.appLogTail)).toBeLessThanOrEqual(65_536);
  });

  it("removes every labeled resource even when the build fails", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep });
    fake.failOn("build", 1); fake.buildOutput = "npm error Missing script: does-not-exist\n";
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("build-failed");
    expect(result.actualRun).toBeNull();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(fake.networks()).toEqual([]);
    expect(s.host.readDiagnostics(s.runId).buildLogTail).toContain("Missing script: does-not-exist");
    expect(() => fake.argsFor("app")).toThrow();
    expect(s.assemble).not.toHaveBeenCalled();
    expect(await readdir(s.runRoot)).toEqual([]);
  });

  it("kills the run at the deadline and never reports a result", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, deadlineMs: 400 });
    fake.hangOn("executor");
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("deadline-exceeded");
    expect(result.actualRun).toBeNull();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(s.assemble).not.toHaveBeenCalled();
  });

  it("is cancelled by the caller's signal and still cleans up", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.hangOn("executor");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("operator cancelled")), 100);
    const result = await runWith(s, controller.signal);
    expect(result.actualRun).toBeNull();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("isolates concurrent runs", async () => {
    const fake = new FakeDockerCli();
    const a = await setup({ fake }); const b = await setup({ fake });
    fake.onExecutor = (outDir, args) => {
      const runId = args[args.indexOf("--name") + 1]!.replace("rovara-executor-", "");
      const owner = runId === a.runId ? a : b;
      writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: owner.runId, groupId: owner.groupId });
    };
    const results = await Promise.all([runWith(a), runWith(b)]);
    expect(results.map((item) => item.unavailableReason)).toEqual([null, null]);
    expect(fake.calls.filter((args) => args[0] === "network" && args[1] === "create").map((args) => args.at(-1))).toEqual(
      expect.arrayContaining([`rovara-e2e-${a.runId}`, `rovara-e2e-${b.runId}`]));
    const executors = fake.calls.filter((args) => args[0] === "run" && args[args.indexOf("--name") + 1]!.startsWith("rovara-executor-"));
    expect(executors).toHaveLength(2);
    for (const args of executors) {
      const own = args[args.indexOf("--name") + 1]!.replace("rovara-executor-", "");
      const other = own === a.runId ? b.runId : a.runId;
      expect(args.filter((value, index) => args[index - 1] === "-v").some((mount) => mount.includes(other))).toBe(false);
      expect(args[args.indexOf("--network") + 1]).toBe(`rovara-e2e-${own}`);
    }
    expect(fake.liveResources(`rovara.run=${a.runId}`).concat(fake.liveResources(`rovara.run=${b.runId}`))).toEqual([]);
  });

  it("sweeps stale runs older than one hour", async () => {
    const fake = new FakeDockerCli(); const now = Date.now();
    fake.seedStale({ runId: "old", ageMs: 3_700_000, now }); fake.seedStale({ runId: "fresh", ageMs: 60_000, now });
    const runRoot = await temp("sweep-root-"); await mkdir(join(runRoot, "old")); await mkdir(join(runRoot, "fresh"));
    expect(await sweepStaleRovaraRuns(fake, 3_600_000, { now: () => now, runRoot })).toBe(1);
    expect(fake.liveResources("rovara.run=old")).toEqual([]);
    expect(fake.liveResources("rovara.run=fresh")).toHaveLength(2);
    expect(await readdir(runRoot)).toEqual(["fresh"]);
  });

  it("sweeps stale runs at the start of an allocation", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.onExecutor = okOutput(s);
    fake.seedStale({ runId: "ancient", ageMs: 7_200_000, now: Date.now() });
    await runWith(s);
    expect(fake.liveResources("rovara.run=ancient")).toEqual([]);
  });

  it("returns app-exited with the app log tail when the app crashes mid-run", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    fake.exitDuringExecutor("app", 137, "boom\n");
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("app-exited");
    expect(result.actualRun).toBeNull();
    expect(s.host.readDiagnostics(s.runId).appLogTail).toContain("boom");
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  describe("executor results", () => {
    it("hands a completed run (exit 0 or 1 with a matching result file) to the readback once cleanup is confirmed", async () => {
      for (const exitCode of [0, 1] as const) {
        const fake = new FakeDockerCli(); const s = await setup({ fake });
        fake.exitCodeOfExecutor(exitCode);
        fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode, reason: null, runId: s.runId, groupId: s.groupId });
        const result = await runWith(s);
        expect(result.unavailableReason).toBeNull();
        expect(result.actualRun).toBe(sentinel);
        expect(result.lifecycle.process.exitCode).toBe(exitCode);
        const call = s.assemble.mock.calls[0]![0] as { snapshot: { result: { exitCode: number } }; cleanup: { network: string; containers: string[] } };
        expect(call.snapshot.result.exitCode).toBe(exitCode);
        expect(call.cleanup.network).toBe(`rovara-e2e-${s.runId}`);
        expect(call.cleanup.containers).toEqual(expect.arrayContaining([`rovara-app-${s.runId}`]));
      }
    });

    it("never reads or returns the out directory when the executor exits 2, whatever it says", async () => {
      for (const reason of ["output-scan-failed", "credential-leak", "internal-error"]) {
        const fake = new FakeDockerCli(); const s = await setup({ fake });
        fake.exitCodeOfExecutor(2);
        fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason, runId: s.runId, groupId: s.groupId });
        const result = await runWith(s);
        expect(result.unavailableReason).toBe("executor-failed");
        expect(result.actualRun).toBeNull();
        expect(s.assemble).not.toHaveBeenCalled();
      }
    });

    it("maps an executor that found the app unhealthy to app-unhealthy and a missing result with exit 2 to executor-failed", async () => {
      const unhealthy = new FakeDockerCli(); const a = await setup({ fake: unhealthy });
      unhealthy.exitCodeOfExecutor(2);
      unhealthy.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason: "app-unhealthy", runId: a.runId, groupId: a.groupId });
      expect((await runWith(a)).unavailableReason).toBe("app-unhealthy");
      const crashed = new FakeDockerCli(); const b = await setup({ fake: crashed });
      crashed.exitCodeOfExecutor(2);
      expect((await runWith(b)).unavailableReason).toBe("executor-failed");
      expect(b.assemble).not.toHaveBeenCalled();
    });

    it("treats a missing result file, or one that disagrees with the container exit code, as unavailable", async () => {
      const missing = new FakeDockerCli(); const a = await setup({ fake: missing });
      expect((await runWith(a)).unavailableReason).toBe("executor-result-mismatch");
      const liar = new FakeDockerCli(); const b = await setup({ fake: liar });
      liar.exitCodeOfExecutor(0);
      liar.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 1, reason: null, runId: b.runId, groupId: b.groupId });
      const result = await runWith(b);
      expect(result.unavailableReason).toBe("executor-result-mismatch");
      expect(result.actualRun).toBeNull();
      const opposite = new FakeDockerCli(); const c = await setup({ fake: opposite });
      opposite.exitCodeOfExecutor(2);
      opposite.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: c.runId, groupId: c.groupId });
      expect((await runWith(c)).unavailableReason).toBe("executor-result-mismatch");
      for (const s of [a, b, c]) expect(s.assemble).not.toHaveBeenCalled();
    });

    it("refuses a result file written for another run", async () => {
      const fake = new FakeDockerCli(); const s = await setup({ fake });
      fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: "00000000-0000-4000-8000-000000000000", groupId: s.groupId });
      const real = await import("../../packages/verifier/src/host/executor-readback.js");
      // The default readback rejects a foreign run; the host surfaces that as an unavailable readback, never a result.
      const host = createDockerApplicationHost({ docker: fake, executorImage: "e", buildImage: "b", runRoot: s.runRoot, now: () => Date.now(),
        admission: s.fixture.plan.admission, groupId: s.groupId, candidateSourceDir: await temp("src-"), appPollMs: 10, deadlineGraceMs: 60, assemble: real.assembleExecutorActualRun });
      const result = await runIsolatedE2EApplication({ input: s.input as never, compiled: s.fixture.compiled, ports: host, signal: new AbortController().signal });
      expect(result.actualRun).toBeNull();
      expect(result.unavailableReason).toMatch(/not a completed run of this group/);
    });
  });
});

describe("process docker cli", () => {
  async function shim(script: string) { const dir = await temp("docker-shim-"); const path = join(dir, "docker"); await writeFile(path, `#!/bin/sh\n${script}\n`); await chmod(path, 0o755); return createProcessDockerCli(path); }
  const signal = () => new AbortController().signal;

  it("returns the exit code and both streams", async () => {
    const cli = await shim('echo "args: $*"; echo oops >&2; exit 3');
    expect(await cli.run(["ps", "-a"], { signal: signal(), timeoutMs: 5_000 })).toEqual({ code: 3, stdout: "args: ps -a\n", stderr: "oops\n" });
  });

  it("kills the docker process on timeout (124) and on abort (130)", async () => {
    const cli = await shim("sleep 30");
    const started = Date.now();
    expect((await cli.run(["run"], { signal: signal(), timeoutMs: 100 })).code).toBe(124);
    const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
    expect((await cli.run(["run"], { signal: controller.signal, timeoutMs: 20_000 })).code).toBe(130);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a missing docker binary as 127 instead of throwing", async () => {
    const result = await createProcessDockerCli("/nonexistent/docker").run(["ps"], { signal: signal(), timeoutMs: 1_000 });
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/could not run/);
  });
});
