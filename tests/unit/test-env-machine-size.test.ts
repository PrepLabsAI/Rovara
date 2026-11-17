// TE-C5 part B (broker): the machine-size switch, the stored measurement (facts only, never the proof row), the person's stored choice and the card. Switch off: nothing is read or written.
import { describe, expect, it } from "vitest";
import { MACHINE_SIZE_ROWS, TestEnvironmentBodySchema, type TestEnvProveReport } from "@agentx/contracts";
import { MACHINE_SIZE_VARIABLE, machineCard, machineSizeEnabled, readMachineChoice, readMachineFacts, recordMachineMeasurement, setMachineChoice, testEnvMachineChoiceKey, testEnvMachineKey } from "../../packages/broker/src/core/test-env/machine-size.js";
import { readTestEnvProveReport } from "../../packages/broker/src/core/test-env/environment.js";
import { bench, BENCH_ORG } from "../support/test-env-bench.js";
const COMPANY_B_ID = "org_bbbbbbbbbbbbbbbbbbbb";

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
  it("keeps no output text (leak test)", async () => {
    const w = await world();
    const report = reportFor(w.digest, { fullSuite: undefined, steps: [{ step: "setup", status: "failed", failure: "setup_failed", durationMs: 1, outputTail: `${CANARY} exec format error` }] });
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(report) });
    expect(JSON.stringify(await w.store.get(testEnvMachineKey(BENCH_ORG, w.project, w.digest)))).not.toContain(CANARY);
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, w.digest)).toMatchObject({ armVerdict: "arm_incompatible", patternId: "exec_format" });
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
  it.each([[null], ["x"], [{}], [{ jobId: "j", leaseToken: "short", result: { ok: false, reason: "aborted" } }], [{ jobId: "job-1", leaseToken: lease, result: { ok: false, reason: CANARY } }]])("refuses a body that is not the shape (%#) without echoing it", async (raw) => {
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
  it("is scoped to the company and the project", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    expect(await readMachineFacts(w.deps, COMPANY_B_ID as never, w.project, w.digest)).toBeUndefined();
    expect(await readMachineFacts(w.deps, BENCH_ORG, "other", w.digest)).toBeUndefined();
    await expect(recordMachineMeasurement(w.deps, { orgId: COMPANY_B_ID, project: w.project, body: body(reportFor(w.digest)) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
  it("a row copied under another company's or project's key is not read there (the row names its own company, project and digest)", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    const row = (await w.store.get(testEnvMachineKey(BENCH_ORG, w.project, w.digest)))!;
    await w.store.put({ item: { ...row, ...testEnvMachineKey(COMPANY_B_ID, w.project, w.digest) } });
    expect(await readMachineFacts(w.deps, COMPANY_B_ID as never, w.project, w.digest)).toBeUndefined();
    await w.store.put({ item: { ...row, ...testEnvMachineKey(BENCH_ORG, "other", w.digest) } });
    expect(await readMachineFacts(w.deps, BENCH_ORG, "other", w.digest)).toBeUndefined();
    await w.store.put({ item: { ...row, ...testEnvMachineKey(BENCH_ORG, w.project, "d".repeat(64)) } });
    expect(await readMachineFacts(w.deps, BENCH_ORG, w.project, "d".repeat(64))).toBeUndefined();
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
  it("is stored for a known row, replaces the earlier one, and is read back", async () => {
    const w = await world();
    expect(await readMachineChoice(w.deps, BENCH_ORG, w.project)).toBeUndefined();
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "x86_64-4-16" });
    expect(await readMachineChoice(w.deps, BENCH_ORG, w.project)).toBe("x86_64-4-16");
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "arm64-8-32" });
    expect(await readMachineChoice(w.deps, BENCH_ORG, w.project)).toBe("arm64-8-32");
    expect(await readMachineChoice(w.deps, BENCH_ORG, "other")).toBeUndefined();
  });
  it.each([["evil"], [""], [42], [null], [undefined], [`${CANARY}`], ["arm64-2-8 "], ["ARM64-2-8"]])("refuses %j, stores nothing and never echoes it", async (rowId) => {
    const w = await world();
    const error = await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String((error as Error).message)).not.toContain(CANARY);
    expect(await w.store.get(testEnvMachineChoiceKey(BENCH_ORG, w.project))).toBeUndefined();
  });
  it("every listed row is accepted", async () => {
    const w = await world();
    for (const row of MACHINE_SIZE_ROWS) { await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: row.id }); expect(await readMachineChoice(w.deps, BENCH_ORG, w.project)).toBe(row.id); }
  });
  it("switch off: refused and nothing stored; a stored row reads as none", async () => {
    const on = await world();
    await setMachineChoice(on.deps, { orgId: BENCH_ORG, project: on.project, rowId: "arm64-2-8" });
    const off = { ...on.deps, env: { ROVARA_TEST_ENVIRONMENT: "1", [MACHINE_SIZE_VARIABLE]: "0" } };
    await expect(setMachineChoice(off, { orgId: BENCH_ORG, project: on.project, rowId: "arm64-4-16" })).rejects.toMatchObject({ code: "NOT_AVAILABLE_HERE" });
    expect(await readMachineChoice(off, BENCH_ORG, on.project)).toBeUndefined();
  });
  it("a choice row copied under another company's key is not read there", async () => {
    const w = await world();
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "arm64-2-8" });
    const row = (await w.store.get(testEnvMachineChoiceKey(BENCH_ORG, w.project)))!;
    await w.store.put({ item: { ...row, ...testEnvMachineChoiceKey(COMPANY_B_ID, w.project) } });
    expect(await readMachineChoice(w.deps, COMPANY_B_ID as never, w.project)).toBeUndefined();
  });
  it("a stored row that does not read back is none", async () => {
    const w = await world();
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "arm64-2-8" });
    const key = testEnvMachineChoiceKey(BENCH_ORG, w.project);
    await w.store.put({ item: { ...(await w.store.get(key))!, rowId: "evil" } });
    expect(await readMachineChoice(w.deps, BENCH_ORG, w.project)).toBeUndefined();
  });
});

describe("the card", () => {
  it("says not measured with no measurement, and shows the stored-only line", async () => {
    const w = await world();
    const card = await machineCard(w.deps, BENCH_ORG, w.project, w.digest);
    expect(card?.lines).toEqual(["Machine size: not measured", "Why: no measurement", "Your choice: none yet", "Stored only: Rovara does not launch this size yet."]);
    expect(card?.suggestedRowId).toBeUndefined();
  });
  it("shows the suggested size with its fixed reasons and the person's choice", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "x86_64-4-16" });
    const card = await machineCard(w.deps, BENCH_ORG, w.project, w.digest);
    expect(card).toMatchObject({ suggestedRowId: "arm64-4-16", chosenRowId: "x86_64-4-16" });
    expect(card?.lines[0]).toBe("Suggested machine: ARM, 4 vCPU, 16 GB");
    expect(card?.lines[1]).toBe("Why: peak memory 6246 MiB; memory headroom 1.5x; peak memory includes file cache; suite 35 min; current chip retained; an ARM run does not prove x86 compatibility");
    expect(card?.lines[2]).toBe("Your choice: x86, 4 vCPU, 16 GB");
    expect(card?.lines[3]).toBe("Stored only: Rovara does not launch this size yet.");
  });
  it("the suggestion does not depend on the choice", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    const before = (await machineCard(w.deps, BENCH_ORG, w.project, w.digest))?.suggestedRowId;
    await setMachineChoice(w.deps, { orgId: BENCH_ORG, project: w.project, rowId: "x86_64-8-32" });
    expect((await machineCard(w.deps, BENCH_ORG, w.project, w.digest))?.suggestedRowId).toBe(before);
  });
  it("reads a fixed number of rows, whatever is stored", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    for (let n = 0; n < 50; n++) await w.store.put({ item: { pk: `ORG#${String(BENCH_ORG)}#PROJECT#${w.project}`, sk: `TESTENV#MACHINE#${String(n).padStart(64, "0")}`, entityType: "TEST_ENV_MACHINE_MEASURE" } });
    let reads = 0;
    const counting = { ...w.deps, store: new Proxy(w.store, { get: (target, name, receiver) => { const value = Reflect.get(target, name, receiver) as unknown; if (name === "query" || name === "get" || name === "batchGet") return (...args: unknown[]) => { reads += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); }; return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value; } }) };
    await machineCard(counting, BENCH_ORG, w.project, w.digest);
    expect(reads).toBe(2);
  });
  it("a different company sees nothing of the project's facts", async () => {
    const w = await world();
    await recordMachineMeasurement(w.deps, { orgId: BENCH_ORG, project: w.project, body: body(reportFor(w.digest)) });
    expect((await machineCard(w.deps, COMPANY_B_ID as never, w.project, w.digest))?.lines[0]).toBe("Machine size: not measured");
  });
});
