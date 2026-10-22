import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2EExecutorPlanSchema } from "@agentx/contracts";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createDockerApplicationHost, createProcessDockerCli, dockerOwnedCleanupReceipt, dockerOwnedResourceInventory, e2eRunNetworks, sweepStaleRovaraRuns } from "../../packages/verifier/src/host/docker-application-host.js";
import { executorContainerArgs } from "../../packages/verifier/src/host/executor-container.js";
import { installedExecutorSeccompProfilePath } from "../../packages/verifier/src/host/executor-seccomp.js";
import { createOrdersExecutorPlan, type OrdersExecutorFixture } from "../support/e2e-orders-executor-fixture.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { createInferredExecutorPlan } from "../support/e2e-inferred-fixture.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";
import { MOCK_UNMOCKED_RESPONSE_DIGEST, mockRequestDigest, mockResponseDigest } from "../../packages/verifier/src/executor/mock-server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }

const collectionSentinel = { marker: "collection-inputs" };
const sentinel = { protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" } };
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(options: { fake: FakeDockerCli; imagePullRetryMs?: number; deadlineMs?: number; recipeBuild?: Parameters<typeof createOrdersExecutorPlan>[0]["recipeBuild"];
  recipeStart?: Parameters<typeof createOrdersExecutorPlan>[0]["recipeStart"]; runRoot?: string; role?: "owner" | "viewer"; probe?: Parameters<typeof createOrdersExecutorPlan>[0]["probe"]; mock?: boolean; mockReadyMs?: number;
  onRunOutput?: NonNullable<Parameters<typeof createDockerApplicationHost>[0]["onRunOutput"]>; fixture?: OrdersExecutorFixture; ownedFiles?: Record<string, string>;
  modelChannel?: NonNullable<Parameters<typeof createDockerApplicationHost>[0]["modelChannel"]> }) {
  const fixture: OrdersExecutorFixture = options.fixture ?? createOrdersExecutorPlan({ probe: options.probe ?? "web-csv-positive-v1", ...(options.mock ? { mock: true } : {}), ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.recipeBuild ? { recipeBuild: options.recipeBuild } : {}), ...(options.recipeStart ? { recipeStart: options.recipeStart } : {}), ...(options.role ? { role: options.role } : {}) });
  const source = await temp("candidate-source-"); await writeFile(join(source, "package.json"), "{}");
  const runRoot = options.runRoot ?? await temp("run-root-");
  const assemble = vi.fn<(input: unknown) => never>(() => sentinel as never);
  const assembleCollectionInputs = vi.fn<(input: unknown) => never>(() => collectionSentinel as never);
  const host = createDockerApplicationHost({ docker: options.fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, now: () => Date.now(),
    admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source, appPollMs: 10, deadlineGraceMs: 60, ...(options.mockReadyMs ? { mockReadyMs: options.mockReadyMs } : {}), assemble, assembleCollectionInputs, ...(options.imagePullRetryMs ? { imagePullRetryMs: options.imagePullRetryMs } : {}),
    ...(options.onRunOutput ? { onRunOutput: options.onRunOutput } : {}), ...(options.ownedFiles ? { ownedFiles: options.ownedFiles } : {}), ...(options.modelChannel ? { modelChannel: options.modelChannel } : {}) });
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
  return { fixture, host, assemble, assembleCollectionInputs, input, runId: plan.runId, groupId: plan.groupId, runRoot, fake: options.fake };
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
    expect(fake.argsFor("app")).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m", "--network-alias", "app", "APP_PORT=4317",
      "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "512", "--cpus", "1", "--pull=never"]));
    expect(fake.argsFor("executor")).toEqual(expect.arrayContaining(["--init", "--read-only", "--shm-size", "1g", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m",
      "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "1024", "--cpus", "2", "--pull=never"]));
    // Ambient proxy and Node settings are blanked on every container, after anything the recipe could set.
    for (const args of [fake.argsFor("app"), fake.argsFor("executor")]) {
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_OPTIONS"]) {
        expect(args.some((value, index) => args[index - 1] === "-e" && value === `${name}=`), name).toBe(true);
      }
    }
    const creates = fake.calls.filter((args) => args[0] === "network" && args[1] === "create");
    expect(creates.filter((args) => args.includes("--internal")).map((args) => args.at(-1))).toEqual([`rovara-e2e-${s.runId}`]);
    expect(fake.mountsFor("executor").find((mount) => mount.endsWith(":/run/rovara/plan.json:ro"))).toBeDefined();
    expect(fake.mountsFor("executor").find((mount) => mount.endsWith(":/out"))).toBeDefined();
    expect(fake.mountsFor("app").some((mount) => mount.endsWith(":/app:ro"))).toBe(true);
    expect(fake.mountsFor("app").some((mount) => mount.endsWith(":/app/.owned:ro"))).toBe(true);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("runs the executor, and only the executor, under the pinned seccomp profile, with no capability added and nothing unconfined", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep }); fake.onExecutor = okOutput(s);
    await runWith(s);
    const securityOptions = (args: string[]) => args.filter((value, index) => args[index - 1] === "--security-opt");
    expect(securityOptions(fake.argsFor("executor"))).toEqual(["no-new-privileges", `seccomp=${installedExecutorSeccompProfilePath()}`]);
    expect(fake.argsFor("executor")).toContain("--cap-drop=ALL");
    // The executor's sandbox and limit flags are the shared definition the image smoke test runs with, in order and unchanged.
    const shared = executorContainerArgs(installedExecutorSeccompProfilePath());
    const executorArgs = fake.argsFor("executor");
    expect(executorArgs.slice(executorArgs.indexOf(shared[0]!), executorArgs.indexOf(shared[0]!) + shared.length)).toEqual(shared);
    // No other container of the run (app, source copy, build commands, cleanup) leaves Docker's default profile.
    const others = fake.calls.filter((args) => args[0] === "run" && !args[args.indexOf("--name") + 1]?.startsWith("rovara-executor-"));
    expect(others.length).toBeGreaterThan(2);
    for (const args of others) expect(args.join(" ")).not.toMatch(/seccomp/);
    for (const args of fake.calls) expect(args.join(" ")).not.toMatch(/--privileged|--cap-add|seccomp=unconfined|apparmor=unconfined|--userns|--pid=host|--ipc=host/);
  });

  it("says why an executor that exited 2 did, from its own log and its exit code, since docker run prints nothing of it", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    fake.exitCodeOfExecutor(2);
    fake.onExecutor = (outDir) => {
      writeExecutorOutput(outDir, { exitCode: 2, reason: "chromium-unsandboxed", runId: s.runId, groupId: s.groupId });
      writeFileSync(join(outDir, "executor.log"), "2026-10-19T00:00:00.000Z unavailable: chromium-unsandboxed: renderer-has-no-extra-seccomp-filter\n");
    };
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("executor-failed");
    const tail = s.host.readDiagnostics(s.runId).executorLogTail;
    expect(tail).toContain("chromium-unsandboxed: renderer-has-no-extra-seccomp-filter");
    expect(tail).toContain("docker run exited with code 2");
  });

  it("says why docker run itself failed to start the executor: its stderr and exit code", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    fake.exitCodeOfExecutor(126); fake.executorStdout = "docker: Error response from daemon: invalid seccomp profile";
    await runWith(s);
    const tail = s.host.readDiagnostics(s.runId).executorLogTail;
    expect(tail).toContain("invalid seccomp profile");
    expect(tail).toContain("docker run exited with code 126");
  });

  it("keeps a finished run's executor diagnostics free of credentials and bounded", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    fake.exitCodeOfExecutor(2);
    let password = "";
    fake.onExecutor = (outDir) => {
      // The run's own synthetic credential, which only the plan mount holds.
      password = (JSON.parse(readFileSync(join(dirname(outDir), "plan.json"), "utf8")) as { accounts: { password: string }[] }).accounts[0]!.password;
      writeExecutorOutput(outDir, { exitCode: 2, reason: "internal-error", runId: s.runId, groupId: s.groupId });
      writeFileSync(join(outDir, "executor.log"), `${"x".repeat(200_000)}\npassword ${password}\n`);
    };
    await runWith(s);
    const tail = s.host.readDiagnostics(s.runId).executorLogTail;
    expect(password.length).toBeGreaterThan(16);
    expect(tail).not.toContain(password);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64 * 1024);
    expect(tail).toContain("<account:");
  });

  it.each([124, 130])("reads nothing from the out directory when docker run was killed (exit %i): the container may still be running", async (code) => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    fake.exitCodeOfExecutor(code);
    fake.onExecutor = (outDir) => { writeExecutorOutput(outDir, { exitCode: 2, reason: "internal-error", runId: s.runId, groupId: s.groupId }); writeFileSync(join(outDir, "executor.log"), "LOG-THAT-MUST-NOT-BE-READ\n"); };
    await runWith(s);
    expect(s.host.readDiagnostics(s.runId).executorLogTail).not.toContain("LOG-THAT-MUST-NOT-BE-READ");
  });

  it("never follows a symbolic link, and never waits on a FIFO, left in place of executor.log", async () => {
    for (const kind of ["symlink", "fifo"] as const) {
      const fake = new FakeDockerCli(); const s = await setup({ fake });
      const secret = join(await temp("worker-file-"), "worker-secret.txt"); writeFileSync(secret, "WORKER-FILE-CONTENT\n");
      fake.exitCodeOfExecutor(2);
      fake.onExecutor = (outDir) => {
        writeExecutorOutput(outDir, { exitCode: 2, reason: "internal-error", runId: s.runId, groupId: s.groupId });
        if (kind === "symlink") symlinkSync(secret, join(outDir, "executor.log")); else execFileSync("mkfifo", [join(outDir, "executor.log")]);
      };
      const started = Date.now();
      await runWith(s);
      const tail = s.host.readDiagnostics(s.runId).executorLogTail;
      expect(Date.now() - started, kind).toBeLessThan(10_000);
      expect(tail, kind).not.toContain("WORKER-FILE-CONTENT");
      expect(tail, kind).toContain("docker run exited with code 2");
    }
  });

  it("redacts a credential that straddles the start of the kept window, before cutting", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    fake.exitCodeOfExecutor(2);
    let password = "";
    fake.onExecutor = (outDir) => {
      password = (JSON.parse(readFileSync(join(dirname(outDir), "plan.json"), "utf8")) as { accounts: { password: string }[] }).accounts[0]!.password;
      writeExecutorOutput(outDir, { exitCode: 2, reason: "internal-error", runId: s.runId, groupId: s.groupId });
      // The kept window is the last 32 KiB: put the credential so that its second half is the first thing inside it.
      const tail = `${"y".repeat(32 * 1024 - Math.floor(password.length / 2))}`;
      writeFileSync(join(outDir, "executor.log"), `${"x".repeat(5_000)}${password}${tail}`);
    };
    await runWith(s);
    const text = s.host.readDiagnostics(s.runId).executorLogTail;
    expect(text).toContain("yyyy");
    expect(text).not.toContain(password);
    expect(text).not.toContain(password.slice(-10));
    expect(text).not.toContain(password.slice(0, 10));
  });

  it("refuses to be built over a seccomp profile whose digest differs from the pin", async () => {
    const fake = new FakeDockerCli(); const dir = await temp("seccomp-");
    const profile = join(dir, "profile.json"); await writeFile(profile, "{}");
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    expect(() => createDockerApplicationHost({ docker: fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot: dir, now: () => Date.now(),
      admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: dir, executorSeccompProfile: profile })).toThrow(/executor-seccomp-profile-digest-mismatch/);
    expect(fake.calls).toEqual([]);
  });

  it("gives the build container the source read-only, no credentials and registry egress only, and runs each command with its own timeout", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep }); fake.onExecutor = okOutput(s);
    await runWith(s);
    const builds = fake.calls.filter((args) => args[0] === "run" && args[args.indexOf("--name") + 1]!.startsWith("rovara-build-"));
    expect(builds).toHaveLength(3);
    for (const args of builds) {
      expect(args).toEqual(expect.arrayContaining(["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "1024", "--cpus", "2"]));
      expect(args).toContain("NODE_OPTIONS=");
      expect(args).toContain("--pull=never");
      // Never the default bridge: the source copy has no network, every build command has the run's own build bridge.
      const index = Number(args[args.indexOf("--name") + 1]!.split("-").at(-1));
      expect(args[args.indexOf("--network") + 1]).toBe(index === 0 ? "none" : `rovara-e2e-build-${s.runId}`);
      expect(args.join(" ")).not.toMatch(/docker\.sock|AWS_|AGENTX_|PI_|GIT_|TOKEN|SECRET|(^| )-p /);
      expect(args.some((value) => value.endsWith(":/src:ro"))).toBe(true);
      expect(args.some((value) => value.endsWith(":/out") && args[args.indexOf(value) - 1] === "-v")).toBe(true);
    }
    expect(builds[1]!.slice(-3)).toEqual(["npm", "run", "build"]);
    expect(fake.buildTimeouts().slice(1)).toEqual([45_000, 60_000]);
    // The app runs the built tree, and the network was created before anything used it.
    expect(fake.calls.findIndex((args) => args[0] === "network" && args[1] === "create")).toBeLessThan(fake.calls.indexOf(builds[0]!));
  });

  it("puts builds and the app on bridges with fixed names the host firewall keys on, labels both networks and removes both", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep }); fake.onExecutor = okOutput(s);
    const signal = new AbortController().signal;
    const lease = await s.host.allocate(s.input as never, signal);
    const networks = e2eRunNetworks(s.runId);
    // 8 hex of the run id's digest after a three-letter kind: valid Linux interface names (at most 15 characters), told apart by prefix.
    expect(networks.buildBridge).toMatch(/^rvb[0-9a-f]{8}$/);
    expect(networks.internalBridge).toMatch(/^rvi[0-9a-f]{8}$/);
    expect(networks.buildBridge.slice(3)).toBe(networks.internalBridge.slice(3));
    expect(e2eRunNetworks("another-run").buildBridge).not.toBe(networks.buildBridge);
    const creates = fake.calls.filter((args) => args[0] === "network" && args[1] === "create");
    expect(creates).toHaveLength(2);
    const build = creates.find((args) => args.at(-1) === networks.build)!;
    const internal = creates.find((args) => args.at(-1) === networks.internal)!;
    expect(build).not.toContain("--internal");
    expect(internal).toContain("--internal");
    expect(build).toEqual(expect.arrayContaining(["-o", `com.docker.network.bridge.name=${networks.buildBridge}`, "--label", `rovara.run=${s.runId}`]));
    expect(internal).toEqual(expect.arrayContaining(["-o", `com.docker.network.bridge.name=${networks.internalBridge}`, "--label", `rovara.run=${s.runId}`]));
    // Both carry the creation time the stale-run sweep ages them by.
    for (const args of creates) expect(args.some((value) => /^rovara\.created=\d+$/.test(value))).toBe(true);
    await lease.execute(signal);
    // App and executor share the internal network and nothing else; builds never see it.
    for (const args of [fake.argsFor("app"), fake.argsFor("executor")]) expect(args.filter((value, index) => args[index - 1] === "--network")).toEqual([networks.internal]);
    await expect(lease.close(signal)).resolves.toEqual({ confirmed: true });
    expect(fake.networks()).toEqual([]);
    expect(fake.calls.filter((args) => args[0] === "network" && args[1] === "rm").map((args) => args[2]).sort()).toEqual([networks.build, networks.internal].sort());
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

  // The three tests below are about what happens when a deadline arrives or a caller cancels while the executor runs. Their deadlines are measured on a
  // fake clock (timers and Date only; file and process I/O stay real), and every moment is chosen by the test: it advances the clock or aborts only
  // once the executor is running, so machine load can neither expire a deadline early nor let one pass unnoticed.
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  afterEach(() => { vi.useRealTimers(); });

  it("kills the run at the deadline and never reports a result", async () => {
    fakeTimers();
    const fake = new FakeDockerCli(); const s = await setup({ fake, deadlineMs: 400 });
    fake.hangOn("executor");
    const running = runWith(s);
    await fake.executorStarted;
    // Docker's own timeout for the executor is the time left plus the grace: the deadline reaches Docker, not just the host's timers.
    expect(fake.executorTimeoutMs).toBe(400 + 60);
    await vi.advanceTimersByTimeAsync(400);
    const result = await running;
    expect(result.unavailableReason).toBe("deadline-exceeded");
    expect(result.actualRun).toBeNull();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(s.assemble).not.toHaveBeenCalled();
  });

  it("is cancelled by the caller's signal and still cleans up", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.hangOn("executor");
    const controller = new AbortController();
    const running = runWith(s, controller.signal);
    await fake.executorStarted;
    controller.abort(new Error("operator cancelled"));
    const result = await running;
    expect(result.actualRun).toBeNull();
    // The lifecycle refuses to read back after a cancellation; the host's own reason is the cancellation, never a result.
    expect(result.unavailableReason).toBe("application proof readback was cancelled before dispatch");
    await expect(s.host.readActualRun(new AbortController().signal)).rejects.toThrow("cancelled");
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("treats a run stopped while the output hook ran as stopped, whatever the hook saw", async () => {
    const controller = new AbortController();
    const fake = new FakeDockerCli(); const hook = vi.fn(async () => { controller.abort(new Error("operator cancelled")); });
    const s = await setup({ fake, onRunOutput: hook });
    fake.onExecutor = okOutput(s);
    const result = await runWith(s, controller.signal);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.actualRun).toBeNull();
    expect(s.assemble).not.toHaveBeenCalled();
    await expect(s.host.readActualRun(new AbortController().signal)).rejects.toThrow("cancelled");
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("waits for an execution still in flight at the deadline before removing anything, and never returns its late result", async () => {
    fakeTimers();
    const fake = new FakeDockerCli(); const hook = vi.fn(async () => undefined);
    const s = await setup({ fake, deadlineMs: 300, onRunOutput: hook });
    // The executor does not stop when the signal fires: it finishes, cleanly and in full, only when the test lets it, after the deadline.
    let letExecutorFinish!: () => void;
    fake.executorIgnoresAbortUntil = new Promise<void>((resolve) => { letExecutorFinish = resolve; });
    fake.onExecutor = okOutput(s);
    const running = runWith(s);
    await fake.executorStarted;
    await vi.advanceTimersByTimeAsync(300);
    // Give the host every chance to remove things too early: many turns of the event loop (real I/O completes in them) while the executor is still running.
    for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.events.some((event) => event.startsWith("rm "))).toBe(false);
    letExecutorFinish();
    const result = await running;
    expect(result.unavailableReason).toBe("deadline-exceeded");
    expect(result.actualRun).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(s.assemble).not.toHaveBeenCalled();
    expect(fake.events.indexOf("executor finished")).toBeGreaterThanOrEqual(0);
    expect(fake.events.indexOf("executor finished")).toBeLessThan(fake.events.findIndex((event) => event.startsWith("rm ")));
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

  it("refuses recipe env names that look like credentials, for the build and the app alike", async () => {
    for (const options of [{ recipeBuild: [{ program: "npm", args: ["run", "build"], cwd: ".", timeoutMs: 45_000, env: { MY_Token_NAME: "x" } }] }, { recipeStart: { env: { app_SECRET_name: "x" } } }]) {
      const fake = new FakeDockerCli(); const s = await setup({ fake, ...options });
      const result = await runWith(s);
      expect(result.unavailableReason).toBe("build-failed");
      expect(s.host.readDiagnostics(s.runId).buildLogTail).toMatch(/looks like a credential/);
      expect(fake.calls.filter((args) => args[0] === "run")).toEqual([]);
      expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    }
  });

  it("never lets a build command run past the plan deadline, and reports that as the deadline", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, deadlineMs: 5_000, recipeBuild: [{ program: "npm", args: ["run", "build"], cwd: ".", timeoutMs: 300_000, env: {} }] });
    fake.failOn("build", 124);
    const result = await runWith(s);
    expect(fake.buildTimeouts().slice(1).every((timeout) => timeout <= 5_000)).toBe(true);
    expect(fake.buildTimeouts()).toHaveLength(2);
    expect(result.unavailableReason).toBe("deadline-exceeded");
    expect(result.actualRun).toBeNull();
    // A command that merely times out inside the deadline is still a failed build.
    const inside = new FakeDockerCli(); const t = await setup({ fake: inside, deadlineMs: 600_000, recipeBuild: [{ program: "npm", args: ["run", "build"], cwd: ".", timeoutMs: 45_000, env: {} }] });
    inside.failOn("build", 124);
    expect((await runWith(t)).unavailableReason).toBe("build-failed");
  });

  it("pulls a missing image itself, within the plan deadline, and never leaves it to docker run", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, deadlineMs: 5_000 }); fake.onExecutor = okOutput(s);
    fake.missingImages.add("node:build-test");
    const result = await runWith(s);
    expect(result.unavailableReason).toBeNull();
    const pullIndex = fake.calls.findIndex((args) => args[0] === "pull");
    expect(fake.calls[pullIndex]).toEqual(["pull", "node:build-test"]);
    expect(fake.timeouts[pullIndex]).toBeLessThanOrEqual(5_000);
    expect(pullIndex).toBeLessThan(fake.calls.findIndex((args) => args[0] === "run" && args.includes("-d")));
    for (const kind of ["app", "executor"] as const) expect(fake.argsFor(kind)).toContain("--pull=never");
  });

  it("carries on when another process pulled the same image while this pull was failing", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, imagePullRetryMs: 1 }); fake.onExecutor = okOutput(s);
    // Parallel runs on one host race to pull the same image; the loser's pull fails although the image is then there.
    fake.missingImages.add("node:build-test"); fake.pullFailures = 1; fake.imageArrivesDuringFailedPull = true;
    expect((await runWith(s)).unavailableReason).toBeNull();
    expect(fake.calls.filter((args) => args[0] === "pull")).toHaveLength(1);
  });

  it("retries a pull that fails for a transient reason, and says why when it never succeeds", async () => {
    const transient = new FakeDockerCli(); const t = await setup({ fake: transient, imagePullRetryMs: 1 }); transient.onExecutor = okOutput(t);
    transient.missingImages.add("node:build-test"); transient.pullFailures = 2;
    expect((await runWith(t)).unavailableReason).toBeNull();
    expect(transient.calls.filter((args) => args[0] === "pull")).toHaveLength(3);
    const hopeless = new FakeDockerCli(); const h = await setup({ fake: hopeless, imagePullRetryMs: 1 });
    hopeless.missingImages.add("node:build-test"); hopeless.pullFailures = 99; hopeless.pullStderr = "toomanyrequests: rate limit exceeded";
    const result = await runWith(h);
    expect(result.unavailableReason).toContain("executor-failed");
    expect(hopeless.calls.filter((args) => args[0] === "pull")).toHaveLength(3);
    // The diagnostic names the image and docker's own words, so a CI failure explains itself.
    expect(h.host.readDiagnostics(h.runId).buildLogTail).toMatch(/node:build-test is not available on the host: toomanyrequests: rate limit exceeded/);
  });

  it("reports an app container that cannot start as app-exited", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.appStartFails = true;
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("app-exited");
    expect(s.host.readDiagnostics(s.runId).appLogTail).toContain("cannot start the app container");
    expect(() => fake.argsFor("executor")).toThrow();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("cleans up an allocation that fails after it created its workspace", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.networkCreateFails = true;
    const result = await runWith(s);
    expect(result.actualRun).toBeNull();
    expect(fake.calls.some((args) => args[0] === "run")).toBe(false);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(await readdir(s.runRoot)).toEqual([]);
  });

  it("closes once and says the same thing again", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    const signal = new AbortController().signal;
    const lease = await s.host.allocate(s.input as never, signal);
    // Both names, in sorted order whichever way the run id's first character sorts against "build-".
    expect(fake.networks().sort()).toEqual([`rovara-e2e-${s.runId}`, `rovara-e2e-build-${s.runId}`].sort());
    await expect(lease.close(signal)).resolves.toEqual({ confirmed: true });
    const removals = () => fake.calls.filter((args) => args[0] === "rm" || (args[0] === "network" && args[1] === "rm")).length;
    const before = removals();
    await expect(lease.close(signal)).resolves.toEqual({ confirmed: true });
    expect(removals()).toBe(before);
    await expect(lease.execute(signal)).rejects.toThrow(/only before it is closed/);
    await expect(s.host.allocate(s.input as never, signal)).rejects.toThrow(/already allocated/);
  });

  it("does not confirm cleanup it could not finish, and removes the workspace's stubborn files through a labeled root container", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    const locked = join(s.runRoot, s.runId, "out", "locked");
    // A directory this user cannot empty, like the files a container user leaves behind; the fake root container does not actually clear it.
    fake.onExecutor = (outDir) => { writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: s.runId, groupId: s.groupId });
      mkdirSync(join(outDir, "locked")); writeFileSync(join(outDir, "locked", "file"), "x"); chmodSync(join(outDir, "locked"), 0o555); };
    try {
      const result = await runWith(s);
      expect(result.lifecycle.cleanup).not.toBe("confirmed");
      expect(result.actualRun).toBeNull();
      expect(result.unavailableReason).toMatch(/cleanup/);
      const root = fake.calls.find((args) => args[0] === "run" && args.includes("--entrypoint") && args[args.indexOf("--entrypoint") + 1] === "rm")!;
      expect(root).toEqual(expect.arrayContaining(["--label", `rovara.run=${s.runId}`, "--pull=never", "--network", "none", "--user", "0:0"]));
      await expect(s.host.readActualRun(new AbortController().signal)).rejects.toThrow("owned cleanup is not confirmed");
    } finally { await chmod(locked, 0o755).catch(() => undefined); }
  });

  it("sweeps stale runs older than one hour", async () => {
    const fake = new FakeDockerCli(); const now = Date.now();
    fake.seedStale({ runId: "old", ageMs: 3_700_000, now }); fake.seedStale({ runId: "fresh", ageMs: 60_000, now });
    const runRoot = await temp("sweep-root-"); await mkdir(join(runRoot, "old")); await mkdir(join(runRoot, "fresh"));
    expect(await sweepStaleRovaraRuns(fake, 3_600_000, { now: () => now, runRoot })).toBe(1);
    expect(fake.liveResources("rovara.run=old")).toEqual([]);
    // The app container and both networks (internal and build) of the fresh run stay.
    expect(fake.liveResources("rovara.run=fresh")).toHaveLength(3);
    expect(await readdir(runRoot)).toEqual(["fresh"]);
  });

  it("leaves alone a labeled resource whose creation time is missing or unreadable", async () => {
    const fake = new FakeDockerCli(); const now = Date.now();
    fake.seedUnlabeled("no-time", ""); fake.seedUnlabeled("bad-time", "yesterday"); fake.seedStale({ runId: "old", ageMs: 3_700_000, now });
    expect(await sweepStaleRovaraRuns(fake, 3_600_000, { now: () => now })).toBe(1);
    expect(fake.liveResources("rovara.run=no-time")).toHaveLength(1);
    expect(fake.liveResources("rovara.run=bad-time")).toHaveLength(1);
    expect(fake.liveResources("rovara.run=old")).toEqual([]);
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

    it("attests exactly the run's inventory as the containers it removed, so the cleanup receipt a broker derives from the run id is the one the host attests", async () => {
      const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep });
      fake.onExecutor = okOutput(s);
      const result = await runWith(s);
      expect(result.unavailableReason).toBeNull();
      const { cleanup } = s.assemble.mock.calls[0]![0] as { cleanup: { removedAt: string; containers: string[]; network: string } };
      // Not "contains the app": the whole list, so a run that left a build container, lost its executor or removed something that is not its own would differ from the derivation.
      const inventory = dockerOwnedResourceInventory(s.runId, []);
      expect([...cleanup.containers].sort()).toEqual([...inventory.containers].sort());
      expect(cleanup.network).toBe(inventory.network);
      const derived = JSON.parse(Buffer.from(dockerOwnedCleanupReceipt(s.runId, cleanup.removedAt, []).bytes).toString("utf8")) as { containers: string[]; network: string; removedAt: string };
      expect(derived).toMatchObject({ containers: [...cleanup.containers].sort(), network: cleanup.network, removedAt: cleanup.removedAt });
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

    it("refuses a result file written for another run, before the output hook or any readback", async () => {
      const fake = new FakeDockerCli(); const hook = vi.fn(async () => undefined);
      const s = await setup({ fake, onRunOutput: hook });
      fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: "00000000-0000-4000-8000-000000000000", groupId: s.groupId });
      const result = await runWith(s);
      expect(result.actualRun).toBeNull();
      expect(result.unavailableReason).toBe("executor-result-mismatch");
      expect(hook).not.toHaveBeenCalled();
      expect(s.assemble).not.toHaveBeenCalled();
    });

    it("hands the output hook only the out directory, the profile ids and a credential predicate", async () => {
      const fake = new FakeDockerCli(); let seen: { keys: string[]; leaks: boolean; clean: boolean; profiles: readonly string[] } | null = null;
      const holder: { password: string } = { password: "" };
      const s = await setup({ fake, onRunOutput: async (run) => {
        seen = { keys: Object.keys(run).sort(), leaks: run.containsCredential(Buffer.from(`x ${holder.password} y`)), clean: run.containsCredential(Buffer.from("nothing here")), profiles: run.accountProfileIds };
      } });
      fake.onExecutor = (outDir, args) => {
        okOutput(s)(outDir);
        const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(":/run/rovara/plan.json:ro"))!.slice(0, -":/run/rovara/plan.json:ro".length);
        holder.password = (JSON.parse(readFileSync(mount, "utf8")) as { accounts: { password: string }[] }).accounts[0]!.password;
      };
      await runWith(s);
      expect(seen).toEqual({ keys: ["accountProfileIds", "containsCredential", "outDir"], leaks: true, clean: false, profiles: ["orders-owner"] });
    });

    it("exposes the collector inputs only after confirmed cleanup, built from the same cleanup the readback saw", async () => {
      const fake = new FakeDockerCli(); const s = await setup({ fake });
      fake.onExecutor = okOutput(s);
      await expect(s.host.readCollectionInputs(new AbortController().signal)).rejects.toThrow("owned cleanup is not confirmed");
      const result = await runWith(s);
      expect(result.actualRun).toBe(sentinel);
      await expect(s.host.readCollectionInputs(new AbortController().signal)).resolves.toBe(collectionSentinel);
      const call = s.assembleCollectionInputs.mock.calls[0]![0] as { cleanup: { removedAt: string; network: string } };
      const readbackCall = s.assemble.mock.calls[0]![0] as { cleanup: { removedAt: string; network: string } };
      expect(call.cleanup).toEqual(readbackCall.cleanup);
      expect(call.cleanup.network).toBe(`rovara-e2e-${s.runId}`);
    });

    it("exposes no collector inputs for a run that was unavailable", async () => {
      const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep });
      fake.failOn("build", 1);
      await runWith(s);
      await expect(s.host.readCollectionInputs(new AbortController().signal)).rejects.toThrow("build-failed");
      expect(s.assembleCollectionInputs).not.toHaveBeenCalled();
    });
  });
});

describe("structured build result", () => {
  it("reports the exit code docker returned for the failing command, never a number read out of the log", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep });
    // The log claims a different exit code than the one the build container returned, and nothing in it may be believed.
    fake.failOn("build", 7); fake.buildOutput = "build command 1 (npm) ended with exit code 3\n";
    expect((await runWith(s)).unavailableReason).toBe("build-failed");
    expect(s.host.readBuildResult(s.runId)).toEqual({ commandIndex: 1, exitCode: 7, command: buildStep[0] });
  });

  it("reports no exit code when the build timed out or the run ended it", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep });
    fake.failOn("build", 124);
    await runWith(s);
    expect(s.host.readBuildResult(s.runId)).toEqual({ commandIndex: 1, exitCode: null, command: buildStep[0] });
  });

  it("reports the last command's success, and nothing for a recipe without a build or for another run", async () => {
    const built = new FakeDockerCli(); const withBuild = await setup({ fake: built, recipeBuild: buildStep }); built.onExecutor = okOutput(withBuild);
    await runWith(withBuild);
    expect(withBuild.host.readBuildResult(withBuild.runId)).toEqual({ commandIndex: 2, exitCode: 0, command: buildStep[1] });
    expect(withBuild.host.readBuildResult("another-run")).toBeNull();
    const plain = new FakeDockerCli(); const noBuild = await setup({ fake: plain }); plain.onExecutor = okOutput(noBuild);
    await runWith(noBuild);
    expect(noBuild.host.readBuildResult(noBuild.runId)).toBeNull();
  });

  it("reports the exit code of a failed source copy as command 0", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, recipeBuild: buildStep });
    const run = fake.run.bind(fake);
    fake.run = async (args, opts) => (args.includes("--entrypoint") && args.includes("cp") ? { code: 5, stdout: "", stderr: "cp: cannot read" } : run(args, opts));
    expect((await runWith(s)).unavailableReason).toBe("build-failed");
    expect(s.host.readBuildResult(s.runId)).toEqual({ commandIndex: 0, exitCode: 5, command: null });
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
    // The timeout is the host's own setTimeout, driven here by the test; the child is a real process that never exits on its own, so the code can only come from the kill.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const timedOut = cli.run(["run"], { signal: signal(), timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect((await timedOut).code).toBe(124);
    } finally { vi.useRealTimers(); }
    // An abort needs no timer at all: the listener is attached as the call starts.
    const controller = new AbortController();
    const aborted = cli.run(["run"], { signal: controller.signal, timeoutMs: 20_000 });
    controller.abort();
    expect((await aborted).code).toBe(130);
  });

  it("reports a missing docker binary as 127 instead of throwing", async () => {
    const result = await createProcessDockerCli("/nonexistent/docker").run(["ps"], { signal: signal(), timeoutMs: 1_000 });
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/could not run/);
  });
});

describe("docker application host: approved external-origin mocks and the sinkhole", () => {
  const mockedPlan = (fake: FakeDockerCli, extra: Partial<Parameters<typeof setup>[0]> = {}) => setup({ fake, probe: "web-inventory-status-v1", mock: true, ...extra });
  const envOf = (args: string[]): Record<string, string> => Object.fromEntries(args.flatMap((value, index) => (args[index - 1] === "-e"
    ? [[value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)] as [string, string]] : [])));
  const lastEnv = (args: string[], name: string) => args.filter((value, index) => args[index - 1] === "-e" && value.startsWith(`${name}=`)).at(-1)?.slice(name.length + 1);
  const mountsOf = (args: string[]) => args.flatMap((value, index) => (args[index - 1] === "-v" ? [value] : []));
  const ledgerLine = (variantId: "success" | "refusal" | "invalid-data" | null, ms: number, path = "/v1/stock") => {
    const variant = { success: { inputValue: "a1", status: 200, body: { status: "in-stock" } }, refusal: { inputValue: "a2", status: 404, body: { error: "unknown order" } },
      "invalid-data": { inputValue: "b1", status: 200, body: { status: 7 } } };
    const chosen = variantId === null ? null : variant[variantId];
    const request = { method: "GET", path, inputValue: chosen?.inputValue ?? null };
    return { requestId: `req-${ms}`, ...request, variantId, status: chosen?.status ?? 599, remoteAddress: "172.30.0.3", requestSha256: mockRequestDigest(request),
      responseSha256: chosen === null ? MOCK_UNMOCKED_RESPONSE_DIGEST : mockResponseDigest({ status: chosen.status, body: chosen.body }), observedAt: new Date(Date.parse("2026-10-20T12:00:00.000Z") + ms).toISOString() };
  };

  it("runs one mock container per approved origin on the run's internal network only, hardened, with nothing but its fixture path in its environment", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const args = fake.mockArgsFor("inventory-v1");
    expect(args).toEqual(expect.arrayContaining(["--name", `rovara-mock-${s.runId}-inventory-v1`, "--network", `rovara-e2e-${s.runId}`, "--network-alias", "mock-inventory-v1",
      "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "node", "--pull=never", "--label", `rovara.run=${s.runId}`,
      "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64", "--cpus", "0.5"]));
    // The run's one internal bridge (rvi...) is the only network, never the build network, never the default bridge.
    expect(args.filter((value, index) => args[index - 1] === "--network")).toEqual([`rovara-e2e-${s.runId}`]);
    const internal = fake.calls.find((call) => call[0] === "network" && call[1] === "create" && call.includes("--internal"))!;
    expect(internal.some((value) => /^com\.docker\.network\.bridge\.name=rvi[a-f0-9]{8}$/.test(value))).toBe(true);
    expect(internal.at(-1)).toBe(`rovara-e2e-${s.runId}`);
    // No secrets, no socket, no published port, no profile of its own, nothing that widens the sandbox.
    expect(args.join(" ")).not.toMatch(/docker\.sock|seccomp|AWS_|AGENTX_|PI_|GIT_|TOKEN|SECRET|--privileged|--cap-add|unconfined|(^| )-p |rovara-e2e-build|--add-host|--dns/);
    expect(envOf(args)).toEqual({ ROVARA_MOCK_FIXTURE: "/mock/fixture.json" });
    expect(args.slice(args.indexOf("rovara-executor:test"))).toEqual(["rovara-executor:test", "node", "/opt/agentx/packages/verifier/dist/executor/entry.js", "--mock", "/mock/fixture.json", "--origin", "inventory-v1"]);
    const mounts = mountsOf(args);
    expect(mounts).toHaveLength(2);
    expect(mounts.some((mount) => mount.endsWith(":/mock:ro"))).toBe(true);
    expect(mounts.some((mount) => mount.endsWith(":/out/mock"))).toBe(true);
    // The mock sees neither the plan, nor the executor's out directory, nor the app, nor the owned seed.
    for (const mount of mounts) expect(mount).not.toMatch(/plan\.json|\/app|\/owned|:\/out$|:\/out:/);
  });

  it("keeps the executor's out directory apart from the mock ledgers, so nothing the executor holds can edit what the mocks recorded", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
    await runWith(s);
    const ledgerMount = mountsOf(fake.mockArgsFor("inventory-v1")).find((mount) => mount.endsWith(":/out/mock"))!.replace(/:\/out\/mock$/, "");
    const outMount = fake.mountsFor("executor").find((mount) => mount.endsWith(":/out"))!.replace(/:\/out$/, "");
    expect(ledgerMount).not.toBe(outMount);
    expect(ledgerMount.startsWith(`${outMount}/`)).toBe(false);
    expect(fake.mountsFor("executor").some((mount) => mount.includes("mock"))).toBe(false);
    expect(fake.mountsFor("app").some((mount) => mount.includes("mock"))).toBe(false);
  });

  it("starts one sinkhole per run with no fixture and no environment, and points every declared origin that has no approved mock at it", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
    await runWith(s);
    expect(fake.mockOrigins().sort()).toEqual(["inventory-v1", "unbound"]);
    const sink = fake.mockArgsFor("unbound");
    expect(sink).toEqual(expect.arrayContaining(["--name", `rovara-mock-${s.runId}-unbound`, "--network", `rovara-e2e-${s.runId}`, "--network-alias", "mock-unbound", "--read-only", "--cap-drop=ALL", "--user", "node"]));
    expect(envOf(sink)).toEqual({});
    // Only the sinkhole may bind the ports a resolved name is asked on (80, 443) and its resolver (53), through one namespaced sysctl; no mock gets it, and nothing else about it is loosened.
    expect(sink).toEqual(expect.arrayContaining(["--sysctl", "net.ipv4.ip_unprivileged_port_start=0"]));
    expect(fake.mockArgsFor("inventory-v1")).not.toContain("--sysctl");
    expect(sink.join(" ")).not.toMatch(/--cap-add|--privileged|seccomp|unconfined|--add-host/);
    expect(mountsOf(sink).some((mount) => mount.endsWith(":/mock:ro"))).toBe(false);
    expect(sink.slice(sink.indexOf("rovara-executor:test"))).toEqual(["rovara-executor:test", "node", "/opt/agentx/packages/verifier/dist/executor/entry.js", "--mock", "--origin", "unbound"]);
    const app = fake.argsFor("app");
    expect(lastEnv(app, "INVENTORY_ORIGIN")).toBe("http://mock-inventory-v1:8080");
    expect(lastEnv(app, "ORDERS_SERVICE_ORIGIN")).toBe("http://mock-unbound:8080");
  });

  it("resolves every name the run does not serve to the sinkhole through a run-owned read-only resolv.conf, not --dns; the executor's arguments are not touched", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake);
    // The app's resolver file is read while the run is live: the workspace (and the file) is removed at close.
    let resolv: { source: string; content: string; mode: number } | null = null;
    fake.onExecutor = (outDir, args) => {
      okOutput(s)(outDir);
      void args;
      const mount = mountsOf(fake.argsFor("app")).find((item) => item.endsWith(":/etc/resolv.conf:ro"))!;
      const source = mount.slice(0, -":/etc/resolv.conf:ro".length);
      resolv = { source, content: readFileSync(source, "utf8"), mode: statSync(source).mode & 0o777 };
    };
    await runWith(s);
    const app = fake.argsFor("app");
    // Docker 25 does not forward an internal-only container's embedded-resolver queries to a --dns server, so the app names the sinkhole itself.
    expect(app).not.toContain("--dns");
    expect(mountsOf(app).filter((item) => item.includes("/etc/resolv.conf"))).toHaveLength(1);
    expect(resolv).not.toBeNull();
    expect(resolv!.content).toBe(`nameserver ${fake.sinkholeAddress}\noptions ndots:0 timeout:2 attempts:2\n`);
    expect(resolv!.mode).toBe(0o644);
    expect(resolv!.source.startsWith(`${join(s.runRoot, s.runId)}/`)).toBe(true);
    // The file is run-owned: it is not under the app, the owned seed, the executor's out directory or the mock directories.
    expect(resolv!.source).not.toMatch(/\/(app|owned|out|mock|mock-out)\//);
    // Without the embedded resolver the run's own names are written to the app's hosts file: every mock alias and the sinkhole's, never anything else.
    const hosts = app.filter((value, index) => app[index - 1] === "--add-host").sort();
    expect(hosts).toEqual(["app:127.0.0.1", "mock-inventory-v1:172.30.0.10", `mock-unbound:${fake.sinkholeAddress}`]);
    const executor = fake.argsFor("executor");
    expect(executor).not.toContain("--dns");
    expect(executor).not.toContain("--add-host");
    expect(executor.some((value) => value.includes("resolv.conf"))).toBe(false);
    const shared = executorContainerArgs(installedExecutorSeccompProfilePath());
    expect(executor.slice(executor.indexOf(shared[0]!), executor.indexOf(shared[0]!) + shared.length)).toEqual(shared);
    // The sinkhole is up, listening and addressed before the app starts: the app's resolver file names it.
    const indexOfRun = (prefix: string) => fake.calls.findIndex((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith(prefix));
    expect(fake.calls.findIndex((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.endsWith("-unbound"))).toBeLessThan(indexOfRun("rovara-app-"));
    // The resolver file is removed with the rest of the workspace.
    expect(existsSync(resolv!.source)).toBe(false);
    expect(existsSync(join(s.runRoot, s.runId))).toBe(false);
  });

  it("gives the app's hosts file only the sinkhole when no mock is approved", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.onExecutor = okOutput(s);
    await runWith(s);
    const app = fake.argsFor("app");
    expect(app.filter((value, index) => app[index - 1] === "--add-host")).toEqual(["app:127.0.0.1", `mock-unbound:${fake.sinkholeAddress}`]);
    expect(app).not.toContain("--dns");
  });

  it("is unavailable when the sinkhole or the app has no address on the run network, because nothing could then be attributed", async () => {
    for (const missing of ["sinkhole", "mock", "app"] as const) {
      const fake = new FakeDockerCli(); const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
      fake.withoutAddress.add(missing === "app" ? `rovara-app-${s.runId}` : missing === "mock" ? `rovara-mock-${s.runId}-inventory-v1` : `rovara-mock-${s.runId}-unbound`);
      const result = await runWith(s);
      expect(result.unavailableReason, missing).toBe("mock-unavailable");
      expect(s.assemble).not.toHaveBeenCalled();
    }
  });

  it("reports an app that exited before its address could be read as app-exited, not as a mock failure", async () => {
    // A start command that exits at once can still be "running" when the host first looks and gone, with its address, a moment later.
    const fake = new FakeDockerCli(); fake.appExitsBeforeAddressRead = 3; const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("app-exited");
    expect(result.actualRun).toBeNull();
    expect(fake.calls.some((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith("rovara-executor-"))).toBe(false);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("counts a mock as ready only once its server listens, not when its ledger file exists", async () => {
    const fake = new FakeDockerCli(); fake.mocksNeverReady = true;
    const s = await mockedPlan(fake, { mockReadyMs: 300 }); fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("mock-unavailable");
    expect(fake.calls.some((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith("rovara-app-"))).toBe(false);
    expect(s.host.readDiagnostics(s.runId).buildLogTail).toMatch(/did not become ready/);
  });

  it("takes a consumption from any address but the app container's as a call no mock matched", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake);
    fake.onExecutor = (outDir) => {
      okOutput(s)(outDir);
      fake.appendMockLedger("inventory-v1", [ledgerLine("success", 10), { ...ledgerLine("success", 20), remoteAddress: "172.30.0.4" }]);
    };
    expect((await runWith(s)).unavailableReason).toBeNull();
    const snapshot = (s.assemble.mock.calls[0]![0] as { snapshot: { mockLedgers: { origin: string; lines: { kind: string; reason?: string }[] }[] } }).snapshot;
    expect(snapshot.mockLedgers.find((ledger) => ledger.origin === "inventory-v1")!.lines.map((line) => [line.kind, line.reason])).toEqual([["consumption", undefined], ["unmatched", "foreign-caller"]]);
  });

  it("points every declared origin at the sinkhole when no mock is approved, and never leaves one unset", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake }); fake.onExecutor = okOutput(s);
    await runWith(s);
    expect(fake.mockOrigins()).toEqual(["unbound"]);
    const app = fake.argsFor("app");
    expect(lastEnv(app, "INVENTORY_ORIGIN")).toBe("http://mock-unbound:8080");
    expect(lastEnv(app, "ORDERS_SERVICE_ORIGIN")).toBe("http://mock-unbound:8080");
  });

  it("never lets a recipe variable, or the candidate, point a declared origin at a host that is not one of the run's own mocks", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake, { recipeStart: { env: { INVENTORY_ORIGIN: "https://inventory.example.com", ORDERS_SERVICE_ORIGIN: "http://169.254.169.254" } } });
    fake.onExecutor = okOutput(s);
    await runWith(s);
    const app = fake.argsFor("app");
    for (const name of ["INVENTORY_ORIGIN", "ORDERS_SERVICE_ORIGIN"]) {
      const value = lastEnv(app, name)!;
      expect(new URL(value).hostname, name).toMatch(/^mock-[A-Za-z0-9-]+$/);
      expect(new URL(value).port).toBe("8080");
    }
    // The host's own value is the last `-e` for the name, which is the one Docker applies.
    expect(lastEnv(app, "INVENTORY_ORIGIN")).toBe("http://mock-inventory-v1:8080");
  });

  it("starts the mocks and the sinkhole before the app", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
    await runWith(s);
    const indexOfRun = (prefix: string) => fake.calls.findIndex((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith(prefix));
    expect(indexOfRun("rovara-mock-")).toBeGreaterThan(-1);
    expect(indexOfRun("rovara-mock-")).toBeLessThan(indexOfRun("rovara-app-"));
    const lastMock = Math.max(...fake.calls.flatMap((call, index) => (call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith("rovara-mock-") ? [index] : [])));
    expect(lastMock).toBeLessThan(indexOfRun("rovara-app-"));
  });

  it("is unavailable when a mock or the sinkhole cannot be started, and starts neither the app nor the executor", async () => {
    const fake = new FakeDockerCli(); fake.mockStartFails = true; const s = await mockedPlan(fake);
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("mock-unavailable");
    expect(fake.calls.some((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith("rovara-app-"))).toBe(false);
    expect(fake.calls.some((call) => call[0] === "run" && call[call.indexOf("--name") + 1]?.startsWith("rovara-executor-"))).toBe(false);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("is unavailable when a mock died while the executor ran: its ledger can no longer show every call, and nothing is read", async () => {
    for (const origin of ["inventory-v1", "unbound"]) {
      const fake = new FakeDockerCli(); const s = await mockedPlan(fake);
      fake.mocksDyingDuringExecutor.add(origin); fake.onExecutor = okOutput(s);
      const result = await runWith(s);
      expect(result.unavailableReason, origin).toBe("mock-unavailable");
      expect(result.actualRun).toBeNull();
      expect(s.assemble).not.toHaveBeenCalled();
    }
  });

  it("stops the mocks once the executor is done, then reads every ledger and hands them to the readback", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake);
    fake.onExecutor = (outDir) => {
      okOutput(s)(outDir);
      fake.appendMockLedger("inventory-v1", [ledgerLine("success", 10), ledgerLine("refusal", 20), ledgerLine(null, 30, "/internal/admin")]);
      fake.appendMockLedger("unbound", [ledgerLine(null, 40, "/")]);
    };
    const result = await runWith(s);
    expect(result.unavailableReason).toBeNull();
    const snapshot = (s.assemble.mock.calls[0]![0] as { snapshot: { mockLedgers: { origin: string; componentId: string | null; malformed: number; lines: { kind: string; line: { variantId: string | null } }[] }[] } }).snapshot;
    expect(snapshot.mockLedgers.map((ledger) => ledger.origin).sort()).toEqual(["inventory-v1", "unbound"]);
    const inventory = snapshot.mockLedgers.find((ledger) => ledger.origin === "inventory-v1")!;
    expect(inventory.componentId).toMatch(/^api-schema-[a-f0-9]{12}$/);
    expect(inventory.lines.map((line) => [line.kind, line.line.variantId])).toEqual([["consumption", "success"], ["consumption", "refusal"], ["unmatched", null]]);
    expect(inventory.malformed).toBe(0);
    expect(snapshot.mockLedgers.find((ledger) => ledger.origin === "unbound")!.lines.map((line) => line.kind)).toEqual(["unmatched"]);
    const killAt = fake.events.findIndex((event) => event.startsWith("kill rovara-mock-"));
    expect(killAt).toBeGreaterThan(fake.events.indexOf("executor finished"));
  });

  it("withholds a run credential the app put into a call it made, and still counts that call as unmocked", async () => {
    // The app sees the run's passwords when the executor signs in through its form, and the mocks record what it asks verbatim: a call to
    // `http://mock-unbound:8080/<password>` would otherwise carry the credential into the unmocked-call evidence and the display.
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake);
    let account = { email: "", password: "" };
    const unmatched = (requestId: string, method: string, path: string, inputValue: string | null, ms: number) => {
      const request = { method, path, inputValue };
      return { requestId, ...request, variantId: null, status: 599, remoteAddress: "172.30.0.3", requestSha256: mockRequestDigest(request),
        responseSha256: MOCK_UNMOCKED_RESPONSE_DIGEST, observedAt: new Date(Date.parse("2026-10-20T12:00:00.000Z") + ms).toISOString() };
    };
    fake.onExecutor = (outDir) => {
      account = (JSON.parse(readFileSync(join(dirname(outDir), "plan.json"), "utf8")) as { accounts: { email: string; password: string }[] }).accounts[0]!;
      okOutput(s)(outDir);
      fake.appendMockLedger("unbound", [unmatched("req-1", "GET", `/${account.password}`, null, 10), unmatched("req-2", "GET", `/login?u=${encodeURIComponent(account.email)}`, null, 20),
        unmatched("req-3", "GET", "/plain", null, 30)]);
      fake.appendMockLedger("inventory-v1", [unmatched("req-4", "GET", "/v1/stock", account.password, 40)]);
    };
    const result = await runWith(s);
    expect(result.unavailableReason).toBeNull();
    expect(account.password.length).toBeGreaterThan(16);
    const snapshot = (s.assemble.mock.calls[0]![0] as { snapshot: { mockLedgers: { origin: string; malformed: number; lines: { kind: string; line: { requestId: string; method: string; path: string; inputValue: string | null } }[] }[] } }).snapshot;
    const text = JSON.stringify(snapshot.mockLedgers);
    for (const secret of [account.password, account.email, encodeURIComponent(account.email)]) expect(text).not.toContain(secret);
    const sink = snapshot.mockLedgers.find((ledger) => ledger.origin === "unbound")!;
    // Every call is still there and still unmatched (so its case is UNKNOWN `unmocked-external-call`); only the text that carried a credential is replaced.
    expect(sink.malformed).toBe(0);
    expect(sink.lines.map((line) => [line.kind, line.line.requestId, line.line.method, line.line.path])).toEqual([
      ["unmatched", "req-1", "GET", "[credential]"], ["unmatched", "req-2", "GET", "[credential]"], ["unmatched", "req-3", "GET", "/plain"]]);
    const inventory = snapshot.mockLedgers.find((ledger) => ledger.origin === "inventory-v1")!;
    expect(inventory.lines.map((line) => [line.kind, line.line.path, line.line.inputValue])).toEqual([["unmatched", "/v1/stock", "[credential]"]]);
  });

  it("removes the mock and sinkhole containers with the rest of the run, and attests only the run's two core containers", async () => {
    const fake = new FakeDockerCli(); const s = await mockedPlan(fake); fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.unavailableReason).toBeNull();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(fake.events.filter((event) => event.startsWith("rm rovara-mock-"))).toHaveLength(2);
    expect(dockerOwnedCleanupReceipt(s.runId, "2026-10-20T12:00:00.000Z", ["inventory-v1"]).bytes).not.toEqual(dockerOwnedCleanupReceipt(s.runId, "2026-10-20T12:00:00.000Z", []).bytes);
    const { cleanup } = s.assemble.mock.calls[0]![0] as { cleanup: { containers: string[] } };
    // The receipt names the mock and the sinkhole as well, so a broker derives the very list from the run id and the plan's mocked origins.
    expect([...cleanup.containers].sort()).toEqual([...dockerOwnedResourceInventory(s.runId, ["inventory-v1"]).containers].sort());
    expect(cleanup.containers).toEqual(expect.arrayContaining([`rovara-mock-${s.runId}-inventory-v1`, `rovara-mock-${s.runId}-unbound`]));
  });
});

// Task 3.2: a recipe-declared account seed (`rovara-accounts-file/v1`) and form login (`rovara-form-login/v1`). The built-in orders-seed/v1 and orders-auth/v1 are exercised above, unchanged.
describe("docker application host: the recipe-declared account seed", () => {
  const mountSource = (args: string[], suffix: string): string => {
    const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(suffix));
    if (mount === undefined) throw new Error(`no mount ending ${suffix}`);
    return mount.slice(0, -suffix.length);
  };
  type AccountsFile = { schemaVersion: string; accounts: { profileId: string; email: string; password: string; tenantRef: string; roleRef: string }[] };
  const accountsSetup = async (fake: FakeDockerCli, options: Partial<Parameters<typeof setup>[0]> = {}) => {
    const s = await setup({ fake, fixture: createAccountsExecutorPlan(), ...options });
    const seen: { file: AccountsFile | null; fileText: string; planText: string } = { file: null, fileText: "", planText: "" };
    fake.onSeed = (args) => {
      seen.fileText = readFileSync(join(mountSource(args, ":/app/.owned:ro"), "rovara-accounts.json"), "utf8");
      seen.file = JSON.parse(seen.fileText) as AccountsFile;
    };
    fake.onExecutor = (outDir, args) => { okOutput(s)(outDir); seen.planText = readFileSync(mountSource(args, ":/run/rovara/plan.json:ro"), "utf8"); };
    return { s, seen };
  };
  const rows = (fake: FakeDockerCli) => fake.calls.filter((args) => args[0] === "run");
  const nameOf = (args: string[]) => args[args.indexOf("--name") + 1]!;

  it("writes /app/.owned/rovara-accounts.json with one record per account of the group, each with its own email and a 24-byte password", async () => {
    const fake = new FakeDockerCli(); const { s, seen } = await accountsSetup(fake);
    const result = await runWith(s);
    expect(result.unavailableReason, JSON.stringify(s.host.readDiagnostics(s.runId))).toBeNull();
    expect(seen.file).toMatchObject({ schemaVersion: "rovara-accounts/v1" });
    const byProfile = Object.fromEntries(seen.file!.accounts.map((account) => [account.profileId, account]));
    expect(Object.keys(byProfile).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer"]);
    expect([byProfile["orders-viewer"]!.tenantRef, byProfile["orders-viewer"]!.roleRef]).toEqual(["tenant-a", "viewer"]);
    expect([byProfile["orders-owner"]!.tenantRef, byProfile["orders-owner"]!.roleRef]).toEqual(["tenant-a", "owner"]);
    expect([byProfile["orders-owner-b"]!.tenantRef, byProfile["orders-owner-b"]!.roleRef]).toEqual(["tenant-b", "owner"]);
    for (const account of seen.file!.accounts) {
      expect(Object.keys(account).sort()).toEqual(["email", "password", "profileId", "roleRef", "tenantRef"]);
      expect(account.email).toMatch(new RegExp(`^rovara-${account.profileId}-[0-9a-f]{6}@example\\.test$`));
      expect(account.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
    expect(new Set(seen.file!.accounts.map((account) => account.email)).size).toBe(3);
    expect(new Set(seen.file!.accounts.map((account) => account.password)).size).toBe(3);
    // The executor's plan carries the same credentials, each with the login form its profile declares.
    const plan = E2EExecutorPlanSchema.parse(JSON.parse(seen.planText));
    expect(plan.accounts.map((account) => [account.profileId, account.email, account.password]).sort()).toEqual(
      seen.file!.accounts.map((account) => [account.profileId, account.email, account.password]).sort());
    for (const account of plan.accounts) expect(account.login).toEqual({ kind: "form", path: "/", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "identity" });
  });

  it("gives two runs different emails and passwords", async () => {
    const files: AccountsFile[] = [];
    for (let run = 0; run < 2; run += 1) {
      const fake = new FakeDockerCli(); const { s, seen } = await accountsSetup(fake);
      expect((await runWith(s)).unavailableReason).toBeNull();
      files.push(seen.file!);
    }
    const [first, second] = files as [AccountsFile, AccountsFile];
    for (const profileId of ["orders-viewer", "orders-owner", "orders-owner-b"]) {
      const a = first.accounts.find((account) => account.profileId === profileId)!; const b = second.accounts.find((account) => account.profileId === profileId)!;
      expect(a.email).not.toBe(b.email);
      expect(a.password).not.toBe(b.password);
    }
  });

  it("gives the seed and the app a home and an npm cache where /tmp is writable, and no registry call of their own (F3, and the unmocked-external-call CI saw)", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    for (const args of [fake.argsFor("seed"), fake.argsFor("app")]) {
      for (const setting of ["HOME=/tmp/home", "npm_config_cache=/tmp/home/.npm", "npm_config_update_notifier=false", "npm_config_audit=false", "npm_config_fund=false", "npm_config_offline=true"]) {
        expect(args.some((value, index) => args[index - 1] === "-e" && value === setting), setting).toBe(true);
      }
    }
  });

  it("runs the recipe's seed command in a seed container with the app container's flags, the data volume and the two file variables, before the app starts", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const seed = fake.argsFor("seed"); const app = fake.argsFor("app");
    expect(seed.slice(seed.indexOf("node:build-test"))).toEqual(["node:build-test", "node", "seed.mjs"]);
    expect(seed).toEqual(expect.arrayContaining(["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m", "--user", "1000:1000",
      "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "512", "--cpus", "1", "--pull=never", "--network", `rovara-e2e-${s.runId}`, "--label", `rovara.run=${s.runId}`, "-w", "/app"]));
    // Every flag the app container is given that is not about its own name, alias, detachment or command, the seed is given too.
    const flagsOf = (args: string[]) => args.slice(0, args.indexOf("node:build-test"));
    const own = new Set([`rovara-app-${s.runId}`, `rovara-seed-${s.runId}`, "-d", "--name", "--network-alias", "app"]);
    const shared = flagsOf(app).filter((value) => !own.has(value) && !value.startsWith("rovara.created="));
    for (const value of shared) expect(flagsOf(seed), value).toContain(value);
    for (const args of [seed, app]) {
      expect(args).toEqual(expect.arrayContaining(["-e", "ROVARA_ACCOUNTS_FILE=/app/.owned/rovara-accounts.json", "-e", "ROVARA_DATA_DIR=/data", "-e", "APP_PORT=4317", "-v", `rovara-data-${s.runId}:/data`]));
      expect(args.filter((value) => value.endsWith(":/app:ro"))).toHaveLength(1);
      expect(args.filter((value) => value.endsWith(":/app/.owned:ro"))).toHaveLength(1);
      expect(args).not.toContain("ORDERS_TEST_SEED_FILE=/app/.owned/seed.json");
      // The seed resolves like the app: the run-owned resolver file and hosts entries, never --dns.
      expect(args).not.toContain("--dns");
      expect(args.filter((value) => value.endsWith(":/etc/resolv.conf:ro"))).toHaveLength(1);
      expect(args.filter((value, index) => args[index - 1] === "--add-host")).toContain("app:127.0.0.1");
    }
    expect(seed).not.toContain("--network-alias");
    // The seed finishes before the app exists, and after the mocks and the sinkhole it may need to resolve names through.
    const order = rows(fake).map(nameOf);
    expect(order.findIndex((name) => name.startsWith("rovara-seed-"))).toBeLessThan(order.findIndex((name) => name.startsWith("rovara-app-")));
    expect(order.findIndex((name) => name.startsWith("rovara-seed-"))).toBeGreaterThan(order.findIndex((name) => name.startsWith("rovara-mock-")));
  });

  it("creates the data volume labeled for the run and mounts it read-write in the seed and the app only", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const create = fake.call("volume create");
    expect(create).toEqual(expect.arrayContaining(["--label", `rovara.run=${s.runId}`]));
    // A tmpfs of 256 MiB, owned by the unprivileged user: nothing seeded reaches the runner's disk, and nothing can fill it.
    expect(create).toEqual(expect.arrayContaining(["--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", "o=size=256m,uid=1000,gid=1000,mode=0700"]));
    expect(create.some((value) => /^rovara\.created=\d+$/.test(value))).toBe(true);
    expect(create.at(-1)).toBe(`rovara-data-${s.runId}`);
    const holders = rows(fake).filter((args) => args.some((value, index) => args[index - 1] === "-v" && value.startsWith(`rovara-data-${s.runId}:`)))
      .map((args) => nameOf(args).replace(`-${s.runId}`, ""));
    // The one other holder is the keeper that keeps the tmpfs mounted between the seed and the app; it has no network and no capability, and runs as the unprivileged user.
    expect(holders.sort()).toEqual(["rovara-app", "rovara-datakeep", "rovara-seed"]);
    for (const kind of ["seed", "app"] as const) expect(fake.mountsFor(kind)).toContain(`rovara-data-${s.runId}:/data`);
    expect(fake.mountsFor("executor").some((mount) => mount.includes("rovara-data"))).toBe(false);
    for (const args of rows(fake).filter((call) => nameOf(call).startsWith("rovara-mock-"))) expect(args.join(" ")).not.toContain("rovara-data");
    const keeper = fake.argsFor("datakeep");
    expect(keeper).toEqual(expect.arrayContaining(["-d", "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "1000:1000", "--entrypoint", "sleep"]));
    expect(keeper).not.toContain("0:0");
    expect(keeper.slice(-2)).toEqual(["rovara-executor:test", "infinity"]);
    // The keeper only holds the volume open, so it may not write to it: the mount is read-only (N4), while the seed's and the app's stay read-write.
    expect(fake.mountsFor("datakeep")).toEqual([`rovara-data-${s.runId}:/data:ro`]);
    for (const kind of ["seed", "app"] as const) expect(fake.mountsFor(kind)).not.toContain(`rovara-data-${s.runId}:/data:ro`);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("sizes the tmpfs from the recipe's dataSizeMiB when it states one", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake, { fixture: createAccountsExecutorPlan({ recipe: { dataSizeMiB: 64 } }) });
    expect((await runWith(s)).unavailableReason).toBeNull();
    expect(fake.call("volume create")).toEqual(expect.arrayContaining(["--opt", "o=size=64m,uid=1000,gid=1000,mode=0700"]));
  });

  it("holds the data volume open before the seed, and is unavailable with seed-failed when the keeper cannot be started or does not stay up", async () => {
    for (const keeperFails of ["refused", "exits"] as const) {
      const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
      fake.keeperFails = keeperFails;
      expect((await runWith(s)).unavailableReason, keeperFails).toBe("seed-failed");
      expect(() => fake.argsFor("seed")).toThrow();
      expect(() => fake.argsFor("app")).toThrow();
      expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    }
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const order = rows(fake).map(nameOf);
    expect(order.findIndex((name) => name.startsWith("rovara-datakeep-"))).toBeLessThan(order.findIndex((name) => name.startsWith("rovara-seed-")));
  });

  it("runs the seed with at most the recipe's timeout (never more than 60 s) and removes its container", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const index = fake.calls.indexOf(fake.argsFor("seed"));
    expect(fake.timeouts[index]).toBe(30_000);
    expect(fake.events).toContain(`rm rovara-seed-${s.runId}`);
  });

  it("is unavailable with seed-failed when the seed exits 3, starts neither the app nor the executor, and removes every labeled resource, the volume included", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    fake.seedExitCode = 3; fake.seedStdout = "the accounts file is not rovara-accounts/v1\n";
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("seed-failed");
    expect(result.actualRun).toBeNull();
    expect(() => fake.argsFor("app")).toThrow();
    expect(() => fake.argsFor("executor")).toThrow();
    expect(fake.calls.some((args) => args[0] === "volume" && args[1] === "create")).toBe(true);
    expect(fake.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(true);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(await readdir(s.runRoot)).toEqual([]);
    expect(s.host.readDiagnostics(s.runId).appLogTail).toContain("the accounts file is not rovara-accounts/v1");
  });

  it("keeps a credential that the seed printed out of the diagnostics", async () => {
    const fake = new FakeDockerCli(); const { s, seen } = await accountsSetup(fake);
    fake.seedExitCode = 1;
    fake.onSeed = (args) => {
      const file = JSON.parse(readFileSync(join(mountSource(args, ":/app/.owned:ro"), "rovara-accounts.json"), "utf8")) as AccountsFile;
      seen.file = file;
      fake.seedStdout = `could not create ${file.accounts[0]!.email} with ${file.accounts[0]!.password}\n`;
    };
    expect((await runWith(s)).unavailableReason).toBe("seed-failed");
    const text = JSON.stringify(s.host.readDiagnostics(s.runId));
    for (const account of seen.file!.accounts) { expect(text).not.toContain(account.password); expect(text).not.toContain(account.email); }
    expect(text).toContain("<account:");
  });

  it("is unavailable with deadline-exceeded, not seed-failed, when the plan deadline cuts the seed short", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake, { fixture: createAccountsExecutorPlan({ deadlineMs: 20_000 }) });
    fake.seedExitCode = 124;
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("deadline-exceeded");
  });

  it("gives the app, the seed and the volume setup no AWS_, AGENTX_, TOKEN or SECRET variable and no docker socket", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    for (const args of [fake.argsFor("seed"), fake.argsFor("app"), fake.argsFor("datakeep"), fake.call("volume create")]) {
      expect(args.join(" ")).not.toMatch(/docker\.sock|AWS_|AGENTX_|PI_|GIT_|TOKEN|SECRET|(^| )-p /);
    }
  });

  it("puts no password or email in any docker argument", async () => {
    const fake = new FakeDockerCli(); const { s, seen } = await accountsSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const everything = fake.calls.map((args) => args.join(" ")).join("\n");
    for (const account of seen.file!.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); }
  });

  it("is unavailable with login-failed when the executor ended the run because a form login failed", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    fake.exitCodeOfExecutor(2);
    fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason: "login-failed", runId: s.runId, groupId: s.groupId });
    expect((await runWith(s)).unavailableReason).toBe("login-failed");
  });

  it("does not let an owned file take the accounts file's name", async () => {
    const fake = new FakeDockerCli();
    const s = await setup({ fake, fixture: createAccountsExecutorPlan(), ownedFiles: { "rovara-accounts.json": "{}" } });
    fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.actualRun).toBeNull();
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("leaves the built-in orders-seed/v1 run exactly as it was: seed.json, no volume, no seed container, no accounts file", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    let owned: string[] = [];
    fake.onExecutor = (outDir) => { okOutput(s)(outDir); owned = readdirSync(mountSource(fake.argsFor("app"), ":/app/.owned:ro")); };
    expect((await runWith(s)).unavailableReason).toBeNull();
    expect(owned).toEqual(["seed.json"]);
    // (The stale-run sweep that starts every allocation only lists volumes.)
    expect(fake.calls.filter((args) => args[0] === "volume").map((args) => args[1])).toEqual(["ls"]);
    expect(() => fake.argsFor("seed")).toThrow();
    const app = fake.argsFor("app");
    expect(app).toContain("ORDERS_TEST_SEED_FILE=/app/.owned/seed.json");
    expect(app.join(" ")).not.toMatch(/ROVARA_ACCOUNTS_FILE|ROVARA_DATA_DIR|\/data/);
  });

  it("sweeps a stale run's data volume with the rest of its resources", async () => {
    const fake = new FakeDockerCli(); const now = Date.now();
    fake.seedStale({ runId: "old", ageMs: 3_700_000, now, volume: true }); fake.seedStale({ runId: "fresh", ageMs: 60_000, now, volume: true });
    expect(await sweepStaleRovaraRuns(fake, 3_600_000, { now: () => now })).toBe(1);
    expect(fake.liveResources("rovara.run=old")).toEqual([]);
    expect(fake.liveResources("rovara.run=fresh")).toHaveLength(4);
  });

  it("does not confirm cleanup while the run's data volume is still there", async () => {
    const fake = new FakeDockerCli(); const { s } = await accountsSetup(fake);
    fake.volumesSurviveRemoval = true;
    const result = await runWith(s);
    expect(result.lifecycle.cleanup).not.toBe("confirmed");
  });
});


// Task 3.3 (Ruling AZ): an application with only an inferred launch recipe (no agentx.e2e project contract) runs signed-out scenarios. The host synthesizes the service contract
// `{ listenPort: 4317, portEnv: "PORT" }`, has no account to create, and the inferred seed profile (`synthetic-seed-v1`) seeds nothing.
describe("docker application host: an inferred-recipe app and the anonymous profile", () => {
  const mountSource = (args: string[], suffix: string): string => {
    const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(suffix));
    if (mount === undefined) throw new Error(`no mount ending ${suffix}`);
    return mount.slice(0, -suffix.length);
  };
  const inferredSetup = async (fake: FakeDockerCli, options: Partial<Parameters<typeof setup>[0]> = {}) => {
    const s = await setup({ fake, fixture: createInferredExecutorPlan(), ...options });
    const seen: { planText: string; owned: string[] } = { planText: "", owned: [] };
    fake.onExecutor = (outDir, args) => {
      okOutput(s)(outDir);
      seen.planText = readFileSync(mountSource(args, ":/run/rovara/plan.json:ro"), "utf8");
      seen.owned = readdirSync(mountSource(fake.argsFor("app"), ":/app/.owned:ro"));
    };
    return { s, seen };
  };
  const rows = (fake: FakeDockerCli) => fake.calls.filter((args) => args[0] === "run");
  const nameOf = (args: string[]) => args[args.indexOf("--name") + 1]!;

  it("runs an app with no project contract: the recipe's own build and start commands, the port in PORT, and every container of the run removed", async () => {
    const fake = new FakeDockerCli(); const { s } = await inferredSetup(fake);
    const result = await runWith(s);
    expect(result.unavailableReason, JSON.stringify(s.host.readDiagnostics(s.runId))).toBeNull();
    const app = fake.argsFor("app");
    expect(app.slice(app.indexOf("node:build-test"))).toEqual(["node:build-test", "npm", "start"]);
    expect(app).toEqual(expect.arrayContaining(["-e", "PORT=4317"]));
    expect(app).not.toContain("APP_PORT=4317");
    // The source copy, then the recipe's `npm ci` in a build container of its own.
    const commands = rows(fake).filter((args) => nameOf(args).startsWith("rovara-build-")).map((args) => args.slice(args.indexOf("node:build-test") + 1));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(["npm", "ci"]);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("starts the inferred app with npm's home and cache in /tmp and no registry call of npm's own: an update check or audit would reach the sinkhole and make the case unmocked-external-call", async () => {
    const fake = new FakeDockerCli(); const { s } = await inferredSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    const app = fake.argsFor("app");
    for (const setting of ["HOME=/tmp/home", "npm_config_cache=/tmp/home/.npm", "npm_config_update_notifier=false", "npm_config_audit=false", "npm_config_fund=false", "npm_config_offline=true"]) {
      expect(app.some((value, index) => app[index - 1] === "-e" && value === setting), setting).toBe(true);
    }
  });

  it("creates no account, no seed, no data volume and no keeper: the plan has no accounts and the owned mount no seed file or accounts file", async () => {
    const fake = new FakeDockerCli(); const { s, seen } = await inferredSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    expect(E2EExecutorPlanSchema.parse(JSON.parse(seen.planText)).accounts).toEqual([]);
    expect(seen.owned).toEqual([]);
    expect(() => fake.argsFor("seed")).toThrow();
    expect(() => fake.argsFor("datakeep")).toThrow();
    // (The stale-run sweep that starts every allocation only lists volumes.)
    expect(fake.calls.filter((args) => args[0] === "volume").map((args) => args[1])).toEqual(["ls"]);
    expect(fake.argsFor("app").join(" ")).not.toMatch(/ROVARA_ACCOUNTS_FILE|ROVARA_DATA_DIR|ORDERS_TEST_SEED_FILE|\/data/);
  });

  it("gives the app and the executor no AWS_, AGENTX_, TOKEN or SECRET variable and no docker socket, like any other app", async () => {
    const fake = new FakeDockerCli(); const { s } = await inferredSetup(fake);
    expect((await runWith(s)).unavailableReason).toBeNull();
    for (const args of [fake.argsFor("app"), fake.argsFor("executor")]) expect(args.join(" ")).not.toMatch(/docker\.sock|AWS_|AGENTX_|PI_|GIT_|TOKEN|SECRET|(^| )-p /);
  });

  it("reports the anonymous profile as the only account profile of the run to the output hook, and puts no credential in the plan mount", async () => {
    const fake = new FakeDockerCli(); const profiles: string[][] = [];
    const { s, seen } = await inferredSetup(fake, { onRunOutput: async (run) => { profiles.push([...run.accountProfileIds]); } });
    expect((await runWith(s)).unavailableReason).toBeNull();
    expect(profiles).toEqual([["rovara-anonymous"]]);
    expect(seen.planText).not.toMatch(/"password"|"email"/);
  });
});

// Task 4.3a, test case 8 (Ruling DB-1): the model channel is the executor container's, for a group that has an agent step, and no other container's.
describe("docker application host: the model channel", () => {
  const ROUTE = { routeId: "rovara-e2e-default", routeRevision: "r1-0123456789ab" };
  const agentScenario = (targetId: string) => ({ scenarioId: "agent-export", requirementId: "orders-export", requestedTargetIds: [targetId], required: true, accountProfileId: "orders-owner",
    minimumEvidence: "runtime" as const, requiredRealComponentIds: [], steps: [{ kind: "agent" as const, goal: "Export the orders as a CSV file", maxActions: 4 }],
    assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: ["id", "total"], rows: [["1", "10"]] }] });
  const agentFixture = () => createOrdersExecutorPlan({ probe: "web-csv-positive-v1", modelRoute: ROUTE, accountScenarios: [{ accountProfileId: "orders-owner", scenario: agentScenario }] });
  const MODEL_SOCKET = (runRoot: string, runId: string) => join(runRoot, runId, "model", "model.sock");
  /** A unix socket path is short (about 100 bytes): a run with a model channel runs in a short root. */
  const shortRoot = async () => { const dir = realpathSync(await mkdtemp(join("/tmp", "rr-"))); roots.push(dir); return dir; };

  /** A model channel that records when it was opened relative to the executor, and what it was given. */
  function channel(events: string[], fake: FakeDockerCli, behaviour: { open?: () => void | Promise<void>; close?: () => void | Promise<void> } = {}) {
    const opened: Array<{ socketPath: string; credentialSet: { passwords: string[]; emails: string[] }; deadlineAt: number; aborted: boolean; valueKey: string }> = [];
    let closes = 0;
    return { opened, closes: () => closes, port: { async open(input: { socketPath: string; credentialSet: { passwords: string[]; emails: string[] }; deadlineAt: number; signal: AbortSignal; valueKey: string }) {
      events.push(`open:executor-started=${fake.calls.some((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-executor-"))}`);
      await behaviour.open?.();
      opened.push({ socketPath: input.socketPath, credentialSet: input.credentialSet, deadlineAt: input.deadlineAt, aborted: input.signal.aborted, valueKey: input.valueKey });
      return { async close() { closes += 1; events.push("close"); await behaviour.close?.(); } };
    } } };
  }

  it("mounts exactly one model socket into the executor container, and into no other, and the executor's arguments carry no cloud or credential names", async () => {
    const fake = new FakeDockerCli(); const events: string[] = []; const used = channel(events, fake);
    const fixture = agentFixture();
    const s = await setup({ fake, fixture, runRoot: await shortRoot(), modelChannel: used.port }); fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.unavailableReason).toBeNull();
    const mounts = fake.mountsFor("executor");
    expect(mounts.filter((mount) => mount.endsWith(":/run/rovara/model.sock"))).toEqual([`${MODEL_SOCKET(s.runRoot, s.runId)}:/run/rovara/model.sock`]);
    const executorArgs = fake.argsFor("executor");
    expect(executorArgs.join(" ")).not.toMatch(/AWS_|AGENTX_|TOKEN|SECRET|bedrock|amazonaws/i);
    // Only the executor's arguments name the model; the app, seed, build, mock and keeper containers never do.
    for (const args of fake.calls.filter((call) => call[0] === "run" && !call[call.indexOf("--name") + 1]?.startsWith("rovara-executor-"))) {
      expect(args.join(" "), args.join(" ")).not.toMatch(/model/i);
    }
    expect(fake.mountsFor("app").some((mount) => mount.includes("model"))).toBe(false);
  });

  it("opens the channel before the executor container exists, with the run's own socket path, account credentials and deadline, and closes it when the executor is done", async () => {
    const fake = new FakeDockerCli(); const events: string[] = []; const used = channel(events, fake);
    const s = await setup({ fake, fixture: agentFixture(), runRoot: await shortRoot(), modelChannel: used.port }); fake.onExecutor = okOutput(s);
    await runWith(s);
    expect(events).toEqual(["open:executor-started=false", "close"]);
    expect(used.opened).toHaveLength(1);
    const [opened] = used.opened;
    expect(opened!.socketPath).toBe(MODEL_SOCKET(s.runRoot, s.runId));
    expect(opened!.credentialSet.passwords).toHaveLength(1);
    expect(opened!.credentialSet.emails[0]).toMatch(/^rovara-orders-owner-[0-9a-f]{6}@example\.test$/);
    expect(opened!.deadlineAt).toBe(s.fixture.plan.deadlineAt);
    expect(used.closes()).toBe(1);
  });

  it("writes the plan's modelChannel from the admission's own route, and the executor schema accepts it", async () => {
    const fake = new FakeDockerCli(); const fixture = agentFixture();
    let planText = "";
    const s = await setup({ fake, fixture, runRoot: await shortRoot(), modelChannel: channel([], fake).port });
    fake.onExecutor = (outDir) => { planText = readFileSync(join(s.runRoot, s.runId, "plan.json"), "utf8"); okOutput(s)(outDir); };
    await runWith(s);
    const plan = E2EExecutorPlanSchema.parse(JSON.parse(planText));
    expect(plan.modelChannel!.valueKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.modelChannel).toEqual({ protocol: "rovara-e2e-model-channel/v1", socketPath: "/run/rovara/model.sock", ...ROUTE, valueKey: plan.modelChannel!.valueKey });
    expect(plan.modelChannel).toMatchObject(plan.admission.modelRoute!);
  });

  // Task 4.3b (Ruling DB-6): the value key is the host's, made per run; the plan carries it for the executor and the channel's `open` gets the same one for the worker to keep.
  it("makes a value key per run, writes it into the plan's modelChannel, and hands the same key to the channel's open; two runs never share one", async () => {
    const keys: string[] = []; const planKeys: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const fake = new FakeDockerCli(); const used = channel([], fake);
      const s = await setup({ fake, fixture: agentFixture(), runRoot: await shortRoot(), modelChannel: used.port });
      fake.onExecutor = (outDir) => { planKeys.push(E2EExecutorPlanSchema.parse(JSON.parse(readFileSync(join(s.runRoot, s.runId, "plan.json"), "utf8"))).modelChannel!.valueKey); okOutput(s)(outDir); };
      await runWith(s);
      keys.push(used.opened[0]!.valueKey);
    }
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(planKeys).toEqual(keys);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("puts the value key in no docker argument and in no file of the out directory the host reads back (it is in the read-only plan and the channel's open, nowhere else)", async () => {
    const fake = new FakeDockerCli(); const used = channel([], fake);
    const s = await setup({ fake, fixture: agentFixture(), runRoot: await shortRoot(), modelChannel: used.port }); fake.onExecutor = okOutput(s);
    await runWith(s);
    const key = used.opened[0]!.valueKey;
    expect(fake.calls.map((args) => args.join(" ")).join("\n")).not.toContain(key);
  });

  it("closes the channel on every exit: an executor that fails, a deadline, a cancellation, and a close of the lease; and closes it once", async () => {
    for (const how of ["exit-2", "cancelled", "close-only"] as const) {
      const fake = new FakeDockerCli(); const events: string[] = []; const used = channel(events, fake);
      const s = await setup({ fake, fixture: agentFixture(), runRoot: await shortRoot(), modelChannel: used.port });
      if (how === "exit-2") { fake.exitCodeOfExecutor(2); fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason: "x", runId: s.runId, groupId: s.groupId }); await runWith(s); }
      else if (how === "cancelled") {
        const abort = new AbortController(); fake.onExecutor = () => abort.abort(new Error("stop")); await runWith(s, abort.signal);
      } else {
        const signal = new AbortController().signal;
        const lease = await s.host.allocate(s.input as never, signal);
        await lease.close(signal);
      }
      expect(used.closes(), how).toBe(how === "close-only" ? 0 : 1);
      expect(events.filter((event) => event === "close"), how).toHaveLength(how === "close-only" ? 0 : 1);
    }
  });

  it("is unavailable, and starts no executor, when the channel cannot be opened; what it says is a fixed sentence, not the error's words", async () => {
    const fake = new FakeDockerCli(); const events: string[] = [];
    const used = channel(events, fake, { open: () => { throw new Error("this worker's environment can redirect model calls (AWS_ACCESS_KEY_ID=AKIASECRET)"); } });
    const s = await setup({ fake, fixture: agentFixture(), runRoot: await shortRoot(), modelChannel: used.port });
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("model-channel-unavailable");
    expect(fake.calls.some((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-executor-"))).toBe(false);
    const diagnostics = s.host.readDiagnostics(s.runId);
    expect(diagnostics.buildLogTail).toContain("model channel could not be opened");
    expect(JSON.stringify(diagnostics)).not.toMatch(/AKIASECRET|AWS_ACCESS_KEY_ID/);
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  });

  it("gives a group with no agent step no mount, and refuses to be built with a channel", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake });
    let planText = "";
    fake.onExecutor = (outDir) => { planText = readFileSync(join(s.runRoot, s.runId, "plan.json"), "utf8"); okOutput(s)(outDir); };
    await runWith(s);
    expect(fake.argsFor("executor").join(" ")).not.toMatch(/model/i);
    expect(fake.mountsFor("executor").some((mount) => mount.includes("model.sock"))).toBe(false);
    expect(E2EExecutorPlanSchema.parse(JSON.parse(planText)).modelChannel).toBeUndefined();
    expect(existsSync(join(s.runRoot, s.runId, "model"))).toBe(false);
    await expect(setup({ fake: new FakeDockerCli(), modelChannel: channel([], fake).port })).rejects.toThrow(/no AI navigation step and must not get the model channel/);
  });

  it("refuses a run root so deep that the model socket path could not be bound, at construction", async () => {
    const deep = join(await temp("deep-"), "x".repeat(60));
    await expect(setup({ fake: new FakeDockerCli(), fixture: agentFixture(), runRoot: deep, modelChannel: channel([], new FakeDockerCli()).port })).rejects.toThrow(/too deep for the model socket/);
    // The worker's own run root leaves the path room to spare.
    const production = "/mnt/agentx-runtime/candidates/web-api-runs";
    expect(Buffer.byteLength(join(production, "11111111-1111-4111-8111-111111111111", "model", "model.sock"))).toBeLessThanOrEqual(103);
  });

  it("refuses to be built for an agent group without a channel", async () => {
    await expect(setup({ fake: new FakeDockerCli(), fixture: agentFixture() })).rejects.toThrow(/needs the model channel/);
  });

  it("removes /d/model with the rest of the workspace through the labeled root container", async () => {
    const fake = new FakeDockerCli(); const s = await setup({ fake, fixture: agentFixture(), runRoot: await shortRoot(), modelChannel: channel([], fake).port });
    const locked = join(s.runRoot, s.runId, "out", "locked");
    fake.onExecutor = (outDir) => { writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: s.runId, groupId: s.groupId });
      mkdirSync(join(outDir, "locked")); writeFileSync(join(outDir, "locked", "file"), "x"); chmodSync(join(outDir, "locked"), 0o555); };
    try {
      await runWith(s);
      const root = fake.calls.find((args) => args[0] === "run" && args.includes("--entrypoint") && args[args.indexOf("--entrypoint") + 1] === "rm")!;
      expect(root.slice(root.indexOf("-rf"))).toEqual(["-rf", "/d/app", "/d/out", "/d/owned", "/d/mock", "/d/mock-out", "/d/model"]);
    } finally { await chmod(locked, 0o755).catch(() => undefined); }
  });

  it("sweeps a model socket left behind by a worker that was killed, once it is older than the sweep age, and leaves a fresh one and a file that is not a socket", async () => {
    const { createServer } = await import("node:net");
    const { renameSync, mkdtempSync } = await import("node:fs");
    const runRoot = await temp("sweep-model-");
    const now = Date.now();
    const servers: Array<{ close(): void }> = [];
    // A unix socket path is limited to about 100 bytes, so each socket is made at a short path and moved to where the run left it.
    const shortDir = mkdtempSync(join("/tmp", "rsw-"));
    roots.push(shortDir);
    const makeSocket = async (root: string, runId: string) => {
      const short = join(shortDir, `${runId}.sock`);
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(short, resolve));
      servers.push(server);
      mkdirSync(join(root, runId, "model"), { recursive: true });
      renameSync(short, join(root, runId, "model", "model.sock"));
    };
    await makeSocket(runRoot, "old-run");
    mkdirSync(join(runRoot, "not-a-socket", "model"), { recursive: true }); writeFileSync(join(runRoot, "not-a-socket", "model", "model.sock"), "x");
    try {
      // "Old" is by the clock the sweep is given; the sweep age is an hour.
      expect(await sweepStaleRovaraRuns(new FakeDockerCli(), 3_600_000, { now: () => now + 3_700_000, runRoot })).toBe(1);
      expect(existsSync(join(runRoot, "old-run", "model"))).toBe(false);
      expect(existsSync(join(runRoot, "not-a-socket", "model", "model.sock"))).toBe(true);
      const fresh = await temp("sweep-model-fresh-");
      await makeSocket(fresh, "fresh-run");
      expect(await sweepStaleRovaraRuns(new FakeDockerCli(), 3_600_000, { now: () => Date.now(), runRoot: fresh })).toBe(0);
      expect(existsSync(join(fresh, "fresh-run", "model", "model.sock"))).toBe(true);
    } finally { for (const server of servers) server.close(); }
  });
});
