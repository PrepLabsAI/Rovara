import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, WorkerInvocationSchema, testEnvDigest, testEnvIsProved, armCompatibilityOf, suggestMachine, TEST_ENV_PROVE_MEASURE_FEATURE } from "@agentx/contracts";
import { runSetupProve, runSetupProveJob, type SetupProvePorts } from "../../packages/worker/src/setup-prove.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import type { BuildSandbox } from "../../packages/worker/src/saved-env/build.js";
import { proveEnvironment } from "../../packages/worker/src/prove.js";
import { proveWithMachineMeasurement } from "../../packages/worker/src/machine-measurement.js";

// Fake methods are function properties so assertions inspect them without detaching a receiver.
interface TestSandbox extends BuildSandbox {
  start: BuildSandbox["start"];
  dispose: BuildSandbox["dispose"];
  ports: Omit<BuildSandbox["ports"], "runCommand"> & { runCommand: BuildSandbox["ports"]["runCommand"] };
}
interface TestPorts extends SetupProvePorts {
  makeFresh: SetupProvePorts["makeFresh"];
  cgroupDirectoryOf?: (sandbox: BuildSandbox) => string | undefined;
}
function bodyText(body: RequestInit["body"]): string {
  if (typeof body !== "string") throw new Error("expected string callback body");
  return body;
}
const commit = "d".repeat(40);
const command = { cwd: "svc", executable: "npm", args: ["test"], timeoutSeconds: 60 };
function environment() {
  return TestEnvironmentBodySchema.parse({
    tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [{ id: "unit", label: "Unit", command, kind: "test" }] }], roundBudgetMin: 30,
    selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
    data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  });
}
function bench() {
  const env = environment();
  let time = 0;
  const fresh: TestSandbox = {
    id: "fresh", rootPath: "/work/fresh", hasStarted: () => false,
    start: vi.fn(async () => undefined), stopProcesses: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    ports: {
      now: () => time,
      runCommand: vi.fn(async () => { time += 35_000; return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; }),
      startMock: vi.fn(async () => undefined), probePreprod: vi.fn(async () => false), mockUnmatched: async () => [], buildCoverageMap: async () => undefined,
      suiteTestCount: async () => 7,
    },
  };
  const ports: TestPorts = {
    makeFresh: vi.fn(async () => fresh), cgroupDirectoryOf: vi.fn(() => undefined),
    realPath: async path => path, arch: "arm64", workerFeatures: [TEST_ENV_PROVE_MEASURE_FEATURE],
  };
  const input = {
    job: { jobId: "job-1", proposalDigest: testEnvDigest(env), environment: env, commits: { svc: commit } },
    manifest: { repositories: [{ name: "svc", path: "svc", defaultBranch: "main", resolvedCommit: commit, resolvedAt: "x", completedAt: "x" }] },
    notFrom: [{ id: "check", rootPath: "/work/check" }], signal: new AbortController().signal, deadlineMs: 60_000,
  };
  return { fresh, ports, input };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("runs the pinned proposal in a fresh sandbox and disposes it; absent cgroup preserves time, chip and ARM verdict", async () => {
  const b = bench();
  const result = await runSetupProve(b.input, b.ports);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected report");
  expect(result.report.fullSuite).toEqual({ durationMs: 35_000, tests: 7 });
  expect(result.report.machineChip).toBe("arm64");
  expect(armCompatibilityOf(result.report)).toEqual({ verdict: "arm_ok" });
  expect(suggestMachine({ peakMemoryMiB: result.report.fullSuite?.peakMemoryMiB, armVerdict: "arm_ok", available: [] })).toEqual({ reasons: ["peak memory not measured"] });
  expect(b.fresh.start).toHaveBeenCalledOnce();
  expect(b.ports.cgroupDirectoryOf).toHaveBeenCalledExactlyOnceWith(b.fresh);
  expect(b.fresh.dispose).toHaveBeenCalledOnce();
});
it("absent advertising list uses the own list and returns a byte-identical old report", async () => {
  const b = bench(); delete b.ports.workerFeatures;
  const result = await runSetupProve(b.input, b.ports);
  const control = bench();
  const old = await proveEnvironment(control.fresh.ports, { ...control.input.job, signal: control.input.signal, deadlineMs: control.input.deadlineMs });
  expect(result).toEqual({ ok: true, report: old });
  expect(JSON.stringify(result)).toBe(JSON.stringify({ ok: true, report: old }));
});
it("absent test command keeps the ordinary skipped full_suite golden", async () => {
  const b = bench(); b.input.job.environment.repos[0]!.checks = [];
  b.input.job.proposalDigest = testEnvDigest(b.input.job.environment);
  const result = await runSetupProve(b.input, b.ports);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected report");
  expect(result.report.steps).toEqual(["setup", "build", "boot", "smoke", "full_suite", "mocks", "preprod_probe"].map(step => ({ step, status: "skipped", durationMs: 0 })));
  expect(result.report.fullSuite).toBeUndefined();
  expect(armCompatibilityOf(result.report)).toEqual({ verdict: "unknown" });
});
it.each(["x64", "arm64", "riscv64"])("uses only the worker architecture %s", async arch => {
  const b = bench(); b.ports.arch = arch;
  const result = await runSetupProve(b.input, b.ports);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected report");
  expect(result.report.machineChip).toBe(arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : undefined);
});
it("absent chip disables all measurement even with advertising and a peak port", async () => {
  const b = bench(); const peakMemory = vi.fn(async () => 123);
  const report = await proveWithMachineMeasurement({ ...b.fresh.ports, peakMemory }, { ...b.input.job, signal: b.input.signal, deadlineMs: 60_000 }, { machineSize: true, workerFeatures: [TEST_ENV_PROVE_MEASURE_FEATURE], cgroupDirectory: "/absent" });
  expect(report.machineChip).toBeUndefined(); expect(report.fullSuite).not.toHaveProperty("peakMemoryMiB");
  expect(peakMemory).not.toHaveBeenCalled();
});
it.each([null, {}, { machineChip: "x86_64" }, { commits: {} }, { proposalDigest: "a".repeat(64) }, { environment: { tier: "unknown" } }])("invalid job refuses with fixed words before creating a sandbox: %j", async bad => {
  const b = bench();
  const job = bad === null ? null : { ...b.input.job, ...bad, ...(Object.keys(bad).length === 0 ? { jobId: undefined } : {}) };
  expect(await runSetupProve({ ...b.input, job }, b.ports)).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("services refuse before a sandbox exists", async () => {
  const b = bench(); b.input.job.environment.services = [{ name: "api", kind: "http", match: { host: "example.test" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }];
  b.input.job.proposalDigest = testEnvDigest(b.input.job.environment);
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "services_need_prove" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it.each(["mismatch", "missing", "duplicate"])("refuses %s prepared commits", async variant => {
  const b = bench();
  if (variant === "mismatch") b.input.manifest.repositories[0]!.resolvedCommit = "e".repeat(40);
  if (variant === "missing") b.input.manifest.repositories = [];
  if (variant === "duplicate") b.input.manifest.repositories.push({ ...b.input.manifest.repositories[0]! });
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "commits_mismatch" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it.each(["id", "root", "nested", "alias", "started", "unreadable"])("refuses a non-fresh sandbox (%s) without starting it", async variant => {
  const b = bench();
  if (variant === "id") b.fresh.id = "check";
  if (variant === "root") b.fresh.rootPath = "/work/check";
  if (variant === "nested") b.fresh.rootPath = "/work/check/sub";
  if (variant === "alias") b.ports.realPath = async () => "/same";
  if (variant === "started") b.fresh.hasStarted = () => true;
  if (variant === "unreadable") b.ports.realPath = async () => { throw new Error("private-path"); };
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "not_fresh" });
  expect(b.fresh.start).not.toHaveBeenCalled(); expect(b.fresh.dispose).toHaveBeenCalledOnce();
});
it.each(["failed", "timeout", "throw", "abort"])("disposes on %s; never turns a failed suite into a size claim", async mode => {
  const b = bench(); const controller = new AbortController(); b.input.signal = controller.signal;
  b.fresh.ports.runCommand = async () => {
    if (mode === "throw") throw new Error("private-cause");
    if (mode === "abort") controller.abort();
    return { exitCode: 1, timedOut: mode === "timeout", stdout: "", stderr: "exec format error" };
  };
  const result = await runSetupProve(b.input, b.ports);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected failed report");
  expect(result.report.fullSuite).toBeUndefined();
  expect(testEnvIsProved(result.report, b.input.job.proposalDigest, b.input.job.environment)).toBe(false);
  expect(b.fresh.dispose).toHaveBeenCalledOnce();
});
it("start and creation failures use fixed words; created sandboxes are disposed", async () => {
  const b = bench(); b.fresh.start = vi.fn(async () => { throw new Error("private-cause"); });
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "fresh_sandbox_failed" });
  expect(b.fresh.dispose).toHaveBeenCalledOnce();
  b.ports.makeFresh = async () => { throw new Error("private-cause"); };
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "fresh_sandbox_failed" });
});
it("one overall deadline aborts commands and waits for their stop before disposal", async () => {
  vi.useFakeTimers(); const b = bench(); const events: string[] = [];
  b.fresh.ports.runCommand = async (_command, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => { events.push("stopped"); resolve({ exitCode: 1, timedOut: true, stdout: "", stderr: "" }); }, { once: true });
  });
  b.fresh.dispose = async () => { events.push("disposed"); };
  const result = runSetupProve({ ...b.input, deadlineMs: 100 }, b.ports);
  await vi.advanceTimersByTimeAsync(101);
  expect((await result).ok).toBe(true); expect(events).toEqual(["stopped", "disposed"]);
});
it("a megabyte of hostile output stays bounded, redacted and inert in the report", async () => {
  const b = bench(); const secret = ["sk", "proj", "a".repeat(80)].join("-");
  const hostile = `${"x".repeat(1_000_000)} ${secret} ![a[b]c](https://bad.test) [x](https://bad.test) ![x][ref] @owner #123 <b>\n# > --- \x60\x60\x60 ~~~ \u200b\ufe0f`;
  b.fresh.ports.runCommand = async () => ({ exitCode: 1, timedOut: false, stdout: hostile, stderr: "" });
  const start = performance.now(); const result = await runSetupProve(b.input, b.ports);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("expected report");
  const tail = result.report.steps.find(step => step.step === "full_suite")!.outputTail!;
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
  for (const text of [secret, "[", "@owner", "#123", "https://bad.test", "<b>", "\u200b", "\ufe0f"]) expect(tail).not.toContain(text);
  expect(result.report.steps.find(step => step.step === "full_suite")!.failure).toBe("tests_failed");
});

function jobBench() {
  const b = bench(); const lease = ["lease", "l".repeat(32)].join("-");
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "prepare", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(40),
    payload: { project: { name: "demo", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "r" }], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "g", readOnly: true, pins: [{ repository: "svc", commit }], setupProve: { ...b.input.job, leaseToken: lease } },
  });
  if (invocation.kind !== "prepare") throw new Error("prepare expected");
  const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const deps = { invocation, rootPath: "/work/fresh", manifest: b.input.manifest, docker: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) }, otherOperations: async () => b.input.notFrom, signal: b.input.signal, controlPlaneUrl: "https://broker.test", ports: b.ports, fetchImplementation };
  return { ...b, deps, fetchImplementation, log, lease };
}
it("the prepare rider runs real Prove and posts a bounded report with the delivery lease", async () => {
  const b = jobBench(); const result = await runSetupProveJob(b.deps);
  expect(result?.ok).toBe(true); expect(b.fetchImplementation).toHaveBeenCalledOnce();
  const [url, init] = b.fetchImplementation.mock.calls[0]!;
  expect(url).toBe(`https://broker.test/v1/internal/workspaces/${b.deps.invocation.workspaceId}/operations/${b.deps.invocation.operationId}/setup-prove-result`);
  expect(init?.headers).toEqual({ "content-type": "application/json", "x-agentx-callback-capability": b.deps.invocation.callbackCapability });
  expect(JSON.parse(bodyText(init?.body))).toEqual({ jobId: "job-1", leaseToken: b.lease, result });
  expect(JSON.stringify(result)).not.toContain(b.lease);
  expect(b.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ component: "worker", event: "setup-prove.result", jobId: "job-1", posted: true }));
});
it("absent job performs no work; missing lease refuses before running or posting", async () => {
  const b = jobBench(); delete b.deps.invocation.payload.setupProve;
  expect(await runSetupProveJob(b.deps)).toBeUndefined();
  expect(b.fetchImplementation).not.toHaveBeenCalled(); expect(b.ports.makeFresh).not.toHaveBeenCalled(); expect(b.log).not.toHaveBeenCalled();
  b.deps.invocation.payload.setupProve = b.input.job;
  expect(await runSetupProveJob(b.deps)).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.fetchImplementation).not.toHaveBeenCalled(); expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("posts failure and retries at most three times under one total transport deadline without echoing causes", async () => {
  const b = jobBench(); b.fresh.start = async () => { throw new Error(b.lease); };
  b.fetchImplementation.mockRejectedValue(new Error(`private-cause ${b.lease}`));
  expect(await runSetupProveJob(b.deps)).toEqual({ ok: false, reason: "fresh_sandbox_failed" });
  expect(b.fetchImplementation).toHaveBeenCalledTimes(3);
  const signals = b.fetchImplementation.mock.calls.map(call => call[1]?.signal);
  expect(new Set(signals).size).toBe(1);
  expect(b.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ component: "worker", event: "setup-prove.result", jobId: "job-1", posted: false }));
});
it("the lease cannot survive in command output, a report or logs", async () => {
  const b = jobBench();
  b.fresh.ports.runCommand = async () => ({ exitCode: 1, timedOut: false, stdout: b.lease, stderr: "" });
  const result = await runSetupProveJob(b.deps);
  expect(result?.ok).toBe(true); expect(JSON.stringify(result)).not.toContain(b.lease); expect(JSON.stringify(b.log.mock.calls)).not.toContain(b.lease);
});
it("a live sandbox shares no workspace with the new job; an unreadable registry refuses", async () => {
  const b = jobBench(); b.deps.docker.run.mockResolvedValue({ exitCode: 0, stdout: "live-task", stderr: "" });
  expect(await runSetupProveJob(b.deps)).toEqual({ ok: false, reason: "not_fresh" });
  expect(b.fresh.start).not.toHaveBeenCalled();
  const c = jobBench(); c.deps.docker.run.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "private-cause" });
  expect(await runSetupProveJob(c.deps)).toEqual({ ok: false, reason: "fresh_sandbox_failed" });
  expect(c.ports.makeFresh).not.toHaveBeenCalled();
});

it("reads only the fresh sandbox cgroup; garbage never becomes zero", async () => {
  await mkdir("node_modules/.cache", { recursive: true });
  const folder = await mkdtemp(join(await realpath("node_modules/.cache"), "dec185-cgroup-"));
  try {
    const own = join(folder, "own"), fresh = join(folder, "fresh");
    await mkdir(own); await mkdir(fresh);
    await writeFile(join(own, "memory.peak"), "1048576\n");
    await writeFile(join(fresh, "memory.peak"), "6442450944\n");
    const b = bench(); b.ports.cgroupDirectoryOf = sandbox => sandbox.id === "fresh" ? fresh : own;
    const measured = await runSetupProve(b.input, b.ports);
    expect(measured.ok).toBe(true); if (!measured.ok) throw new Error("expected report");
    expect(measured.report.fullSuite?.peakMemoryMiB).toBe(6144);
    await writeFile(join(fresh, "memory.peak"), "garbage");
    const missing = await runSetupProve(b.input, b.ports);
    expect(missing.ok).toBe(true); if (!missing.ok) throw new Error("expected report");
    expect(missing.report.fullSuite).not.toHaveProperty("peakMemoryMiB");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it.each([0, -1, NaN, Infinity, 2_400_001])("refuses invalid total deadline %s before making a sandbox", async deadlineMs => {
  const b = bench();
  expect(await runSetupProve({ ...b.input, deadlineMs }, b.ports)).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("an already aborted call creates nothing", async () => {
  const b = bench(); const controller = new AbortController(); controller.abort();
  expect(await runSetupProve({ ...b.input, signal: controller.signal }, b.ports)).toEqual({ ok: false, reason: "aborted" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("a disposal failure cannot silently return a successful result", async () => {
  const b = bench(); b.fresh.dispose = async () => { throw new Error("private-cause"); };
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "cleanup_failed" });
});
it("the stated maximum of sixteen repositories and 832 commands completes within a bounded test time", async () => {
  const b = bench();
  b.input.job.environment.repos = Array.from({ length: 16 }, (_, i) => ({ repositoryId: `r${i}`, setupCommands: Array.from({ length: 20 }, () => command), checks: Array.from({ length: 32 }, (_, j) => ({ id: `unit-${i}-${j}`, label: "Unit", kind: "test" as const, command })) }));
  b.input.job.proposalDigest = testEnvDigest(b.input.job.environment);
  const commits = Object.fromEntries(b.input.job.environment.repos.map(repo => [repo.repositoryId, commit]));
  const manifest = { repositories: b.input.job.environment.repos.map(repo => ({ ...b.input.manifest.repositories[0]!, name: repo.repositoryId, path: repo.repositoryId })) };
  b.fresh.ports.runCommand = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }));
  const started = performance.now();
  const result = await runSetupProve({ ...b.input, job: { ...b.input.job, commits }, manifest }, b.ports);
  expect(result.ok).toBe(true); expect(b.fresh.ports.runCommand).toHaveBeenCalledTimes(832);
  expect(performance.now() - started).toBeLessThan(1000);
});

it("cleanup failure is reported even when start or freshness already refused", async () => {
  const b = bench(); b.fresh.start = async () => { throw new Error("private-start"); };
  b.fresh.dispose = async () => { throw new Error("private-cleanup"); };
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "cleanup_failed" });
});
it.each([null, undefined, {}, { signal: {} }])("invalid outer input returns fixed refusal %j", async input => {
  const b = bench();
  expect(await runSetupProve(input as never, b.ports)).toEqual({ ok: false, reason: "invalid_job" });
});
it.each([{ repositories: [undefined] }, { repositories: [{}] }, { repositories: ["bad"] }])("invalid manifest entries return fixed refusal %j", async ({ repositories }) => {
  const b = bench();
  expect(await runSetupProve({ ...b.input, manifest: { repositories: repositories as never } }, b.ports)).toEqual({ ok: false, reason: "commits_mismatch" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("startup consumes the same deadline as Prove, with no restarted time allowance", async () => {
  vi.useFakeTimers(); const b = bench(); const events: string[] = [];
  b.fresh.start = async () => { await new Promise(resolve => setTimeout(resolve, 90)); };
  b.fresh.ports.runCommand = async (_command, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => { events.push("stopped"); resolve({ exitCode: 1, timedOut: true, stdout: "", stderr: "" }); }, { once: true });
  });
  const result = runSetupProve({ ...b.input, deadlineMs: 100 }, b.ports);
  await vi.advanceTimersByTimeAsync(101);
  expect((await result).ok).toBe(true); expect(events).toEqual(["stopped"]);
});

it.each([false, true])("the production adapter removes checkouts only after confirmed sandbox disposal (%s)", async confirmed => {
  await mkdir("node_modules/.cache", { recursive: true });
  const folder = await mkdtemp(join(await realpath("node_modules/.cache"), "dec185-cleanup-"));
  try {
    await mkdir(join(folder, "svc")); await writeFile(join(folder, "svc", "sentinel"), "synthetic");
    const b = jobBench(); const { ports: _ports, ...deps } = b.deps; void _ports;
    const job = deps.invocation.payload.setupProve!; job.environment.repos[0]!.checks = []; job.proposalDigest = testEnvDigest(job.environment);
    vi.spyOn(TaskSandbox.prototype, "start").mockResolvedValue();
    vi.spyOn(TaskSandbox.prototype, "dispose").mockResolvedValue(confirmed);
    const result = await runSetupProveJob({ ...deps, rootPath: folder, otherOperations: async () => [] });
    if (!confirmed) {
      expect(result).toEqual({ ok: false, reason: "cleanup_failed" });
      await expect(realpath(join(folder, "svc", "sentinel"))).resolves.toBeDefined();
    } else {
      expect(result?.ok).toBe(true); await expect(realpath(join(folder, "svc"))).rejects.toThrow();
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("total command output has one budget across commands and a refusal remains a failure", async () => {
  const b = bench(); b.input.job.environment.repos[0]!.checks = Array.from({ length: 5 }, (_, i) => ({ id: `unit-${i}`, label: "Unit", kind: "test", command }));
  b.input.job.proposalDigest = testEnvDigest(b.input.job.environment);
  b.fresh.ports.runCommand = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "x".repeat(1_048_576), stderr: "" }));
  const result = await runSetupProve(b.input, b.ports);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("expected failed report");
  expect(result.report.steps.find(step => step.step === "full_suite")).toMatchObject({ status: "failed", failure: "infrastructure" });
  expect(result.report.fullSuite).toBeUndefined();
});
it("production freshness refusal does not remove the other operation's checkout", async () => {
  await mkdir("node_modules/.cache", { recursive: true });
  const folder = await mkdtemp(join(await realpath("node_modules/.cache"), "dec185-borrowed-"));
  try {
    await mkdir(join(folder, "svc")); await writeFile(join(folder, "svc", "sentinel"), "synthetic");
    const b = jobBench(); const { ports: _ports, ...deps } = b.deps; void _ports;
    const result = await runSetupProveJob({ ...deps, rootPath: folder, otherOperations: async () => [{ id: "check", rootPath: folder }] });
    expect(result).toEqual({ ok: false, reason: "not_fresh" });
    await expect(realpath(join(folder, "svc", "sentinel"))).resolves.toBeDefined();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("cancellation still permits the bounded container removal before any checkout deletion", async () => {
  await mkdir("node_modules/.cache", { recursive: true });
  const folder = await mkdtemp(join(await realpath("node_modules/.cache"), "dec185-cancel-"));
  vi.stubEnv("AGENTX_SANDBOX_IMAGE", "fixture-image");
  try {
    await mkdir(join(folder, "svc")); const b = jobBench(); const { ports: _ports, ...deps } = b.deps; void _ports;
    const stop = new AbortController(); const removals: boolean[] = [];
    const docker: DockerCli = { run: async (args, options) => {
      if (args[0] === "run") stop.abort();
      if (args[0] === "rm") removals.push(options?.signal?.aborted ?? false);
      return { exitCode: options?.signal?.aborted === true && args[0] === "rm" ? 1 : 0, stdout: args[0] === "network" ? "bridge {} false" : "", stderr: "" };
    } };
    expect(await runSetupProveJob({ ...deps, docker, rootPath: folder, otherOperations: async () => [], signal: stop.signal })).toEqual({ ok: false, reason: "aborted" });
    expect(removals).toEqual([false]);
  } finally { vi.unstubAllEnvs(); await rm(folder, { recursive: true, force: true }); }
});
it("an aborted job still posts its fixed refusal after cleanup within the remaining callback budget", async () => {
  const b = jobBench(); const stop = new AbortController(); stop.abort();
  expect(await runSetupProveJob({ ...b.deps, signal: stop.signal })).toEqual({ ok: false, reason: "aborted" });
  expect(b.fetchImplementation).toHaveBeenCalledOnce();
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it.each([null, {}, { kind: "wrong", payload: {} }, { kind: "prepare", payload: null }])("invalid runtime invocation is a fixed refusal %j", async invocation => {
  const b = jobBench();
  expect(await runSetupProveJob({ ...b.deps, invocation: invocation as never })).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.fetchImplementation).not.toHaveBeenCalled();
});
it("duplicate prepared names cannot substitute for a missing repository", async () => {
  const b = bench(); b.input.manifest.repositories.push({ ...b.input.manifest.repositories[0]! });
  expect(await runSetupProve({ ...b.input, job: { ...b.input.job, commits: { svc: commit, other: commit } } }, b.ports)).toEqual({ ok: false, reason: "commits_mismatch" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("the entire other-operation inventory is bounded", async () => {
  const b = bench();
  expect(await runSetupProve({ ...b.input, notFrom: Array.from({ length: 65 }, () => b.input.notFrom[0]!) }, b.ports)).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it("refused responses are not reported as posted and total sent bytes stay bounded", async () => {
  const b = jobBench(); b.fetchImplementation.mockImplementation(async () => new Response("private-response", { status: 503 }));
  await runSetupProveJob(b.deps);
  expect(b.fetchImplementation).toHaveBeenCalledTimes(3);
  expect(b.fetchImplementation.mock.calls.reduce((sum, call) => sum + Buffer.byteLength(bodyText(call[1]?.body)), 0)).toBeLessThan(3 * 65_536);
  expect(b.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ component: "worker", event: "setup-prove.result", jobId: "job-1", posted: false }));
});
it("a hung callback has one total two-minute budget", async () => {
  vi.useFakeTimers(); const b = jobBench(); let settled = false;
  b.fetchImplementation.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { reject(new Error("private-response")); }, { once: true });
  }));
  const pending = runSetupProveJob(b.deps).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(120_001);
  expect(settled).toBe(true); await pending;
  expect(b.fetchImplementation).toHaveBeenCalledOnce();
});
it("startup consumes the total deadline before any command can begin", async () => {
  vi.useFakeTimers(); const b = bench();
  b.fresh.start = async () => { await new Promise(resolve => setTimeout(resolve, 150)); };
  const pending = runSetupProve({ ...b.input, deadlineMs: 100 }, b.ports);
  await vi.advanceTimersByTimeAsync(151);
  expect(await pending).toEqual({ ok: false, reason: "aborted" });
  expect(b.fresh.ports.runCommand).not.toHaveBeenCalled();
  expect(b.fresh.dispose).toHaveBeenCalledOnce();
});
it("external cancellation is joined before disposal", async () => {
  vi.useFakeTimers(); const b = bench(); const stop = new AbortController(); const events: string[] = []; let settled = false;
  b.fresh.ports.runCommand = async (_command, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => { events.push("stopped"); resolve({ exitCode: 1, timedOut: false, stdout: "", stderr: "" }); }, { once: true });
  });
  b.fresh.dispose = async () => { events.push("disposed"); };
  const pending = runSetupProve({ ...b.input, signal: stop.signal }, b.ports).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(1); stop.abort(); await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true); await pending;
  expect(events).toEqual(["stopped", "disposed"]);
});
