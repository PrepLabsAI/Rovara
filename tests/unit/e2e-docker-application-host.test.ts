import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2EExecutorPlanSchema } from "@agentx/contracts";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createDockerApplicationHost, createProcessDockerCli, e2eRunNetworks, sweepStaleRovaraRuns } from "../../packages/verifier/src/host/docker-application-host.js";
import { createOrdersExecutorPlan, type OrdersExecutorFixture } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }

const collectionSentinel = { marker: "collection-inputs" };
const sentinel = { protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" } };
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(options: { fake: FakeDockerCli; imagePullRetryMs?: number; deadlineMs?: number; recipeBuild?: Parameters<typeof createOrdersExecutorPlan>[0]["recipeBuild"];
  recipeStart?: Parameters<typeof createOrdersExecutorPlan>[0]["recipeStart"]; runRoot?: string; role?: "owner" | "viewer";
  onRunOutput?: NonNullable<Parameters<typeof createDockerApplicationHost>[0]["onRunOutput"]> }) {
  const fixture: OrdersExecutorFixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.recipeBuild ? { recipeBuild: options.recipeBuild } : {}), ...(options.recipeStart ? { recipeStart: options.recipeStart } : {}), ...(options.role ? { role: options.role } : {}) });
  const source = await temp("candidate-source-"); await writeFile(join(source, "package.json"), "{}");
  const runRoot = options.runRoot ?? await temp("run-root-");
  const assemble = vi.fn<(input: unknown) => never>(() => sentinel as never);
  const assembleCollectionInputs = vi.fn<(input: unknown) => never>(() => collectionSentinel as never);
  const host = createDockerApplicationHost({ docker: options.fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, now: () => Date.now(),
    admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source, appPollMs: 10, deadlineGraceMs: 60, assemble, assembleCollectionInputs, ...(options.imagePullRetryMs ? { imagePullRetryMs: options.imagePullRetryMs } : {}),
    ...(options.onRunOutput ? { onRunOutput: options.onRunOutput } : {}) });
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
    const fake = new FakeDockerCli(); const hook = vi.fn(async () => undefined);
    const s = await setup({ fake, deadlineMs: 300, onRunOutput: hook });
    // The executor does not stop when the signal fires: it finishes, cleanly and in full, well after the deadline.
    fake.executorIgnoresAbortForMs = 900;
    fake.onExecutor = okOutput(s);
    const result = await runWith(s);
    expect(result.unavailableReason).toBe("deadline-exceeded");
    expect(result.actualRun).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(s.assemble).not.toHaveBeenCalled();
    expect(fake.events.indexOf("executor finished")).toBeGreaterThanOrEqual(0);
    expect(fake.events.indexOf("executor finished")).toBeLessThan(fake.events.findIndex((event) => event.startsWith("rm ")));
    expect(fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  }, 20_000);

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
    expect(fake.networks().sort()).toEqual([`rovara-e2e-${s.runId}`, `rovara-e2e-build-${s.runId}`]);
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
