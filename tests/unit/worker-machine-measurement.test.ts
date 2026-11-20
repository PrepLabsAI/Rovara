import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCgroupPeakMemoryMiB } from "../../packages/worker/src/machine-measurement.js";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(await realpath(tmpdir()), "te-c5-cgroup-")); directories.push(dir); return dir; }
it("returns unknown for missing, garbage, huge, negative or non-file input", async () => {
  const dir = await directory(); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined();
  for (const value of ["garbage", "NaN", "-1", "1e6", "1099511627777", "1".repeat(1_000_000), "1048576" + " ".repeat(60) + "garbage"]) { await writeFile(join(dir, "memory.peak"), value); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined(); }
  await rm(join(dir, "memory.peak")); await mkdir(join(dir, "memory.peak")); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined();
});
it("refuses file and ancestor symlinks", async () => {
  const dir = await directory(), target = await directory(); await writeFile(join(target, "memory.peak"), "1048576\n");
  await symlink(join(target, "memory.peak"), join(dir, "memory.peak")); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined();
  await symlink(target, join(dir, "linked")); expect(await readCgroupPeakMemoryMiB(join(dir, "linked"))).toBeUndefined();
});

it("absent chip disables the reader, absent cgroup never reads the host, valid values keep the golden", async () => {
  const { proveWithMachineMeasurement } = await import("../../packages/worker/src/machine-measurement.js");
  const { TestEnvironmentBodySchema, TEST_ENV_PROVE_MEASURE_FEATURE, testEnvDigest } = await import("@agentx/contracts");
  const environment = TestEnvironmentBodySchema.parse({
    tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "svc", executable: "npm", args: ["test"], timeoutSeconds: 60 } }] }], roundBudgetMin: 30,
    selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
    data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  });
  const ports = { now: () => 0, runCommand: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }), startMock: async () => undefined, probePreprod: async () => false, mockUnmatched: async () => [], buildCoverageMap: async () => undefined };
  const input = { environment, proposalDigest: testEnvDigest(environment), signal: new AbortController().signal, deadlineMs: 1000 };
  const dir = await directory(); await writeFile(join(dir, "memory.peak"), "1048576\n");
  const gate = { machineSize: true, workerFeatures: [TEST_ENV_PROVE_MEASURE_FEATURE] };
  const measured = await proveWithMachineMeasurement(ports, input, { ...gate, machineChip: "arm64", cgroupDirectory: dir });
  expect(measured).toEqual({ schemaVersion: 1, proposalDigest: input.proposalDigest, machineChip: "arm64", steps: ["setup", "build", "boot", "smoke", "full_suite", "mocks", "preprod_probe"].map(step => ({ step, status: step === "full_suite" ? "passed" : "skipped", durationMs: 0 })), fullSuite: { durationMs: 0, tests: 0, peakMemoryMiB: 1 }, services: [], finishedAt: "1970-01-01T00:00:00.000Z" });
  vi.mocked(open).mockClear();
  const noChip = await proveWithMachineMeasurement(ports, input, { ...gate, cgroupDirectory: dir });
  expect(noChip.fullSuite).toEqual({ durationMs: 0, tests: 0 }); expect(noChip.machineChip).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  const noDirectory = await proveWithMachineMeasurement(ports, input, { ...gate, machineChip: "arm64" });
  expect(noDirectory.fullSuite).toEqual({ durationMs: 0, tests: 0 }); expect(noDirectory.machineChip).toBe("arm64");
  expect(open).not.toHaveBeenCalled();
});
