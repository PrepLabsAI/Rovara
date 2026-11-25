import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, WorkerInvocationSchema, testEnvDigest, testEnvIsProved, TEST_ENV_PROVE_MEASURE_FEATURE } from "@agentx/contracts";
import { runSetupProve, runSetupProveJob, type SetupProvePorts } from "../../packages/worker/src/setup-prove.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";
import type { BuildSandbox } from "../../packages/worker/src/saved-env/build.js";

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
it.each(["x64", "riscv64"])("uses only the worker architecture %s", async arch => {
  const b = bench(); b.ports.arch = arch;
  const result = await runSetupProve(b.input, b.ports);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected report");
  expect(result.report.machineChip).toBe(arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : undefined);
});
it.each([null, { proposalDigest: "a".repeat(64) }])("invalid job refuses with fixed words before creating a sandbox: %j", async bad => {
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
it.each(["mismatch"])("refuses %s prepared commits", async variant => {
  const b = bench();
  if (variant === "mismatch") b.input.manifest.repositories[0]!.resolvedCommit = "e".repeat(40);
  if (variant === "missing") b.input.manifest.repositories = [];
  if (variant === "duplicate") b.input.manifest.repositories.push({ ...b.input.manifest.repositories[0]! });
  expect(await runSetupProve(b.input, b.ports)).toEqual({ ok: false, reason: "commits_mismatch" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
});
it.each(["started", "unreadable"])("refuses a non-fresh sandbox (%s) without starting it", async variant => {
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
it.each(["timeout"])("disposes on %s; never turns a failed suite into a size claim", async mode => {
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
it("absent job performs no work; missing lease refuses before running or posting", async () => {
  const b = jobBench(); delete b.deps.invocation.payload.setupProve;
  expect(await runSetupProveJob(b.deps)).toBeUndefined();
  expect(b.fetchImplementation).not.toHaveBeenCalled(); expect(b.ports.makeFresh).not.toHaveBeenCalled(); expect(b.log).not.toHaveBeenCalled();
  b.deps.invocation.payload.setupProve = b.input.job;
  expect(await runSetupProveJob(b.deps)).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.fetchImplementation).not.toHaveBeenCalled(); expect(b.ports.makeFresh).not.toHaveBeenCalled();
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

it.each([null])("invalid outer input returns fixed refusal %j", async input => {
  const b = bench();
  expect(await runSetupProve(input as never, b.ports)).toEqual({ ok: false, reason: "invalid_job" });
});

it.each([false])("the production adapter removes checkouts only after confirmed sandbox disposal (%s)", async confirmed => {
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
it.each([null])("invalid runtime invocation is a fixed refusal %j", async invocation => {
  const b = jobBench();
  expect(await runSetupProveJob({ ...b.deps, invocation: invocation as never })).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.fetchImplementation).not.toHaveBeenCalled();
});
it("the entire other-operation inventory is bounded", async () => {
  const b = bench();
  expect(await runSetupProve({ ...b.input, notFrom: Array.from({ length: 65 }, () => b.input.notFrom[0]!) }, b.ports)).toEqual({ ok: false, reason: "invalid_job" });
  expect(b.ports.makeFresh).not.toHaveBeenCalled();
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

it.each(["callbackCapability", "repositoryGrant"] as const)("the rider scrubs JSON-escaped, lowercase-percent and uppercase-hex %s", async field => {
  const b = jobBench();
  const secret = [field, 'quote"back\\slash/+ value', "x".repeat(32)].join("-");
  if (field === "callbackCapability") b.deps.invocation.callbackCapability = secret;
  else b.deps.invocation.payload.repositoryGrant = secret;
  const lowerPercent = (value: string) => value.replace(/%[0-9A-F]{2}/gu, escape => escape.toLowerCase());
  const json = JSON.stringify(secret).slice(1, -1);
  const variants = [json, JSON.stringify(json).slice(1, -1), lowerPercent(encodeURIComponent(secret)), lowerPercent(encodeURIComponent(encodeURIComponent(secret))), Buffer.from(secret).toString("hex").toUpperCase()];
  for (const variant of variants) {
    b.fresh.ports.runCommand = async () => ({ exitCode: 1, timedOut: false, stdout: variant, stderr: variant });
    const result = await runSetupProveJob(b.deps);
    if (!result?.ok) throw new Error("report expected");
    expect(result.report.steps.some(step => step.outputTail?.includes("redacted"))).toBe(true);
    for (const output of [JSON.stringify(result), bodyText(b.fetchImplementation.mock.calls.at(-1)?.[1]?.body), JSON.stringify(b.log.mock.calls)]) {
      expect(output).not.toContain(variant);
      expect(output).not.toContain(JSON.stringify(variant).slice(1, -1));
    }
  }
});

it.each(["callbackCapability", "repositoryGrant"] as const)("the rider scrubs raw and encoded %s from stdout, stderr, posted reports and logs", async field => {
  const b = jobBench();
  const secret = [field, "private/+value", "x".repeat(32)].join("-");
  if (field === "callbackCapability") b.deps.invocation.callbackCapability = secret;
  else b.deps.invocation.payload.repositoryGrant = secret;
  const variants = [secret, encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret)), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("hex")];
  for (const variant of variants) {
    b.fresh.ports.runCommand = async () => ({ exitCode: 1, timedOut: false, stdout: variant, stderr: variant });
    const result = await runSetupProveJob(b.deps);
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("report expected");
    expect(result.report.steps.some(step => step.outputTail?.includes("redacted"))).toBe(true);
    for (const output of [JSON.stringify(result), bodyText(b.fetchImplementation.mock.calls.at(-1)?.[1]?.body), JSON.stringify(b.log.mock.calls)]) expect(output).not.toContain(variant);
  }
});
