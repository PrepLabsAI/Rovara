// TE-C5 part B (broker): the machine-size switch, the stored measurement (facts only, never the proof row), the person's stored choice and the card. Switch off: nothing is read or written.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type TestEnvProveReport } from "@agentx/contracts";
import { MACHINE_SIZE_ABOVE_MAX, MACHINE_SIZE_MAX_VCPU_VARIABLE, MACHINE_SIZE_VARIABLE, machineCard, machineSizeMaxVcpu, offeredMachineRows, machineSizeEnabled, readMachineChoice, readMachineFacts, recordMachineMeasurement, setMachineChoice, testEnvMachineChoiceKey, testEnvMachineKey } from "../../packages/broker/src/core/test-env/machine-size.js";
import { readTestEnvProveReport } from "../../packages/broker/src/core/test-env/environment.js";
import { bench, BENCH_ORG } from "../support/test-env-bench.js";

const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const environment = (over: Record<string, unknown> = {}) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: ["package-lock.json"] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false }, ...over,
});
const ON = { ROVARA_TEST_ENVIRONMENT: "1", [MACHINE_SIZE_VARIABLE]: "1" };
const CANARY = "CANARY-OUTPUT-TEXT-q7";
const lease = "l".repeat(40);
const reportFor = (digest: string, over: Partial<TestEnvProveReport> = {}): TestEnvProveReport => ({
  schemaVersion: 1, proposalDigest: digest, machineChip: "arm64", steps: [{ step: "full_suite", status: "passed", durationMs: 35 * 60_000 }], services: [], finishedAt: "2026-11-15T10:00:00.000Z",
  fullSuite: { peakMemoryMiB: 6246, durationMs: 35 * 60_000, tests: 10 }, ...over,
});
const body = (report: TestEnvProveReport) => ({ jobId: "job-1", leaseToken: lease, result: { ok: true, report } });

async function world(env: NodeJS.ProcessEnv = ON) {
  const b = await bench({ env });
  const proposed = await b.propose(environment());
  return { ...b, digest: proposed.digest, deps: b.deps };
}

describe("the switch", () => {
  it("is on by default, can be switched off, and does nothing without the test environment", () => {
    expect(machineSizeEnabled({})).toBe(true);
    for (const value of ["true", "", " 1", "1 ", "on", "yes", "offline", "nope"]) expect(machineSizeEnabled({ [MACHINE_SIZE_VARIABLE]: value }), value).toBe(true);
    for (const value of ["0", "false", "off", "no", "FALSE", " Off ", "No"]) expect(machineSizeEnabled({ [MACHINE_SIZE_VARIABLE]: value }), value).toBe(false);
    expect(machineSizeEnabled({ [MACHINE_SIZE_VARIABLE]: "1" })).toBe(true);
    expect(machineSizeEnabled({ [MACHINE_SIZE_VARIABLE]: "1", ROVARA_TEST_ENVIRONMENT: "0" })).toBe(false);
  });
});

describe("recording a measurement", () => {
  it("stores the facts for an existing proposal and nothing else", async () => {
    const w = await world();
    expect(await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest, { steps: [{ step: "full_suite", status: "passed", durationMs: 1 }] })) })).toEqual({ recorded: true });
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toMatchObject({ chip: "arm64", peakMemoryMiB: 6246, armVerdict: "arm_ok" });
    const stored = await w.store.get(testEnvMachineKey(BENCH_ORG, w.project, w.digest));
    expect(Object.keys(stored ?? {}).filter(key => !["pk", "sk", "digest", "entityType", "facts", "orgId", "project", "recordedAt", "indexExpiresAt"].includes(key))).toEqual([]);
    expect(stored?.["entityType"]).toBe("TEST_ENV_MACHINE_MEASURE");
    // It is never the proof row: nothing a worker says can approve.
    expect(await readTestEnvProveReport(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
  });
  it("switch off: nothing is read or written", async () => {
    const w = await world({ ROVARA_TEST_ENVIRONMENT: "1", [MACHINE_SIZE_VARIABLE]: "0" });
    await expect(recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await w.store.get(testEnvMachineKey(BENCH_ORG, w.project, w.digest))).toBeUndefined();
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
    expect(await machineCard(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
  });
  it("a failed or refused Prove records nothing and says so", async () => {
    const w = await world();
    expect(await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: { jobId: "job-1", leaseToken: lease, result: { ok: false, reason: "aborted" } } })).toEqual({ recorded: false, reason: "not_measured" });
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
  });
  it("a report with no chip records nothing", async () => {
    const w = await world();
    expect(await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest, { machineChip: undefined })) })).toEqual({ recorded: false, reason: "not_measured" });
  });
  it.each([[null]])("refuses a body that is not the shape (%#) without echoing it", async (raw) => {
    const w = await world();
    const error = await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: raw }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String((error as Error).message)).not.toContain(CANARY);
  });
  it("a digest with no proposal is refused and writes nothing (a worker cannot invent a digest)", async () => {
    const w = await world();
    const other = "b".repeat(64);
    await expect(recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(other)) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await w.store.get(testEnvMachineKey(BENCH_ORG, w.project, other))).toBeUndefined();
  });
  it("a stored row that does not read back (wrong digest, extra field, expired) is none", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    const key = testEnvMachineKey(BENCH_ORG, w.project, w.digest);
    const row = (await w.store.get(key))!;
    await w.store.put({ item: { ...row, facts: { ...(row["facts"] as object), outputTail: CANARY } } });
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
    await w.store.put({ item: { ...row, facts: { ...(row["facts"] as object), proposalDigest: "c".repeat(64) } } });
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
    await w.store.put({ item: row });
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toBeDefined();
    w.clock.now += 31 * 86_400_000;
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toBeUndefined();
  });
});

describe("the person's choice", () => {
  it.each([["evil"]])("refuses %j, stores nothing and never echoes it", async (rowId) => {
    const w = await world();
    const error = await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String((error as Error).message)).not.toContain(CANARY);
    expect(await w.store.get(testEnvMachineChoiceKey(BENCH_ORG, w.project))).toBeUndefined();
  });
  it("switch off: refused and nothing stored; a stored row reads as none", async () => {
    const on = await world();
    await setMachineChoice(on.deps, { orgId: BENCH_ORG, project: on.project, rowId: "arm64-2-8" });
    const off = { ...on.deps, env: { ROVARA_TEST_ENVIRONMENT: "1", [MACHINE_SIZE_VARIABLE]: "0" } };
    await expect(setMachineChoice(off, { orgId: BENCH_ORG, project: on.project, rowId: "arm64-4-16" })).rejects.toMatchObject({ code: "NOT_AVAILABLE_HERE" });
    expect(await readMachineChoice(off, BENCH_ORG, on.project)).toBeUndefined();
  });
});

describe("the card", () => {
  it("says not measured with no measurement, and shows the stored-only line", async () => {
    const w = await world();
    const card = await machineCard(w.deps, BENCH_ORG, w.project, w.digest);
    expect(card?.lines).toEqual(["Machine size: not measured", "Why: no measurement", "Your choice: none yet", "Stored only: Rovara does not launch this size yet."]);
    expect(card?.suggestedRowId).toBeUndefined();
  });
  it("the suggestion does not depend on the choice", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    const before = (await machineCard(w.deps, BENCH_ORG, w.project, w.digest))?.suggestedRowId;
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "x86_64-8-32" });
    expect((await machineCard(w.deps, BENCH_ORG, w.project, w.digest))?.suggestedRowId).toBe(before);
  });
});

describe("the install's largest size (ROVARA_MACHINE_SIZE_MAX_VCPU, DEC 254zv)", () => {
  const withMax = (value: string | undefined) => ({ ...ON, ...(value === undefined ? {} : { [MACHINE_SIZE_MAX_VCPU_VARIABLE]: value }) });
  it("offers all ten sizes by default (unset or empty)", () => {
    expect(offeredMachineRows(withMax(undefined))).toHaveLength(10);
    expect(offeredMachineRows(withMax(""))).toHaveLength(10);
    expect(machineSizeMaxVcpu(withMax(undefined))).toBe(Number.POSITIVE_INFINITY);
  });
  it.each(["0"])("fails closed to the standard size for the unusable value %j, never to all sizes", (value) => {
    expect(offeredMachineRows(withMax(value)).map(row => row.id)).toEqual(["arm64-2-8", "x86_64-2-8"]);
  });
  it.each(["arm64-16-64"])("refuses the listed size %s above a maximum of 8, with fixed words, and stores nothing", async (rowId) => {
    const w = await world(withMax("8"));
    const error = await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((error as Error).message).toBe(`CONFIG_INVALID: ${MACHINE_SIZE_ABOVE_MAX}`);
    expect(await w.store.get(testEnvMachineChoiceKey(BENCH_ORG, w.project))).toBeUndefined();
  });
});
