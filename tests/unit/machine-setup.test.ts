// TE-C5 part B (contracts): the setup Prove post body, the facts the broker derives from a report, and the card's fixed lines.
import { describe, expect, it } from "vitest";
import { MACHINE_SIZE_ROWS, MAX_PEAK_MEMORY_MIB, MAX_SUITE_MS } from "../../packages/contracts/src/machine-size.js";
import { MACHINE_STORED_ONLY_LINE, MachineFactsSchema, SetupProveResultBodySchema, machineAdviceOf, machineFactsOf, machineRowLabel } from "../../packages/contracts/src/machine-setup.js";
import type { TestEnvProveReport } from "../../packages/contracts/src/test-environment.js";

const DIGEST = "a".repeat(64);
const CANARY = "CANARY-SECRET-OUTPUT-zz9";
type Step = TestEnvProveReport["steps"][number];
const passedSuite: Step = { step: "full_suite", status: "passed", durationMs: 35 * 60_000 };
const report = (over: Partial<TestEnvProveReport> = {}, steps: Step[] = [passedSuite]): TestEnvProveReport => ({
  schemaVersion: 1, proposalDigest: DIGEST, machineChip: "arm64", steps, services: [], finishedAt: "2026-11-15T10:00:00.000Z",
  fullSuite: { peakMemoryMiB: 6246, durationMs: 35 * 60_000, tests: 100 }, ...over,
});
const failedWith = (tail: string): Step[] => [{ step: "setup", status: "failed", failure: "setup_failed", durationMs: 1, outputTail: tail }];
const ALL = MACHINE_SIZE_ROWS.map(row => row.id);

describe("the setup Prove post body", () => {
  const lease = "l".repeat(40);
  it("accepts the exact body the worker posts, ok or refused", () => {
    expect(SetupProveResultBodySchema.safeParse({ jobId: "job-1", leaseToken: lease, result: { ok: true, report: report() } }).success).toBe(true);
    expect(SetupProveResultBodySchema.safeParse({ jobId: "job-1", leaseToken: lease, result: { ok: false, reason: "aborted" } }).success).toBe(true);
  });
  it.each([
    ["extra field", { extra: 1 }], ["missing lease", { leaseToken: undefined }], ["short lease", { leaseToken: "short" }], ["bad job id", { jobId: "../x" }],
    ["unknown reason", { result: { ok: false, reason: "my own words" } }], ["ok without report", { result: { ok: true } }],
    ["report with extra field", { result: { ok: true, report: { ...report(), extra: 1 } } }], ["both shapes", { result: { ok: true, report: report(), reason: "aborted" } }],
  ])("refuses %s", (_name, over) => {
    expect(SetupProveResultBodySchema.safeParse({ jobId: "job-1", leaseToken: lease, result: { ok: false, reason: "aborted" }, ...over }).success).toBe(false);
  });
});

describe("machine facts are derived, never copied", () => {
  it("keeps only bounded numbers and fixed words", () => {
    expect(machineFactsOf(report())).toEqual({ schemaVersion: 1, proposalDigest: DIGEST, chip: "arm64", peakMemoryMiB: 6246, suiteMs: 35 * 60_000, armVerdict: "arm_ok" });
  });
  it("no chip is no facts", () => { expect(machineFactsOf(report({ machineChip: undefined }))).toBeUndefined(); });
  it("a peak counts only after a passing full suite", () => {
    expect(machineFactsOf(report({}, [{ ...passedSuite, status: "failed", failure: "tests_failed" }]))?.peakMemoryMiB).toBeUndefined();
    expect(machineFactsOf(report({}, [{ step: "smoke", status: "passed", durationMs: 1 }]))?.peakMemoryMiB).toBeUndefined();
    expect(machineFactsOf(report({ fullSuite: undefined }))?.peakMemoryMiB).toBeUndefined();
  });
  it("drops an out-of-range peak or suite time instead of clamping it", () => {
    expect(machineFactsOf(report({ fullSuite: { peakMemoryMiB: MAX_PEAK_MEMORY_MIB + 1, durationMs: 1, tests: 1 } }))?.peakMemoryMiB).toBeUndefined();
    expect(machineFactsOf(report({ fullSuite: { peakMemoryMiB: 10, durationMs: MAX_SUITE_MS + 1, tests: 1 } }))?.suiteMs).toBeUndefined();
  });
  it("reads the ARM verdict from the failing step and keeps only the fixed pattern id", () => {
    const facts = machineFactsOf(report({ fullSuite: undefined }, failedWith(`${CANARY} exec format error`)));
    expect(facts).toMatchObject({ armVerdict: "arm_incompatible", patternId: "exec_format" });
    expect(JSON.stringify(facts)).not.toContain(CANARY);
  });
  it("the stored shape is strict", () => {
    const facts = machineFactsOf(report())!;
    expect(MachineFactsSchema.safeParse(facts).success).toBe(true);
    expect(MachineFactsSchema.safeParse({ ...facts, outputTail: CANARY }).success).toBe(false);
    expect(MachineFactsSchema.safeParse({ ...facts, patternId: "my own" }).success).toBe(false);
    expect(MachineFactsSchema.safeParse({ ...facts, peakMemoryMiB: -1 }).success).toBe(false);
  });
});

describe("the card never guesses a size", () => {
  const advice = (facts: Parameters<typeof machineAdviceOf>[0], available: readonly string[] = ALL) => machineAdviceOf(facts, { available });
  it("suggests the row that fits with headroom, in fixed words", () => {
    const a = advice(machineFactsOf(report())!);
    expect(a.status).toBe("suggested");
    expect(a.row?.id).toBe("arm64-4-16");
    expect(a.headline).toBe("Suggested machine: ARM, 4 vCPU, 16 GB");
    expect(a.reasons).toContain("suite 35 min");
    expect(a.reasons).toContain("peak memory 6246 MiB");
  });
  it("an ARM incompatibility with a measured peak asks for x86", () => {
    const facts = machineFactsOf(report({ fullSuite: { peakMemoryMiB: 9000, durationMs: 60_000, tests: 1 } }, [passedSuite, ...failedWith("exec format error")]))!;
    const a = advice(facts);
    expect(a.row?.chip).toBe("x86_64");
    expect(a.headline).toBe("Suggested machine: x86, 4 vCPU, 16 GB");
    expect(a.reasons).toContain("ARM incompatible; x86 required");
  });
  it("an ARM incompatibility with no peak says x86 is needed and the size is not measured", () => {
    const a = advice(machineFactsOf(report({ fullSuite: undefined }, failedWith("exec format error")))!);
    expect(a.status).toBe("not_measured");
    expect(a.row).toBeUndefined();
    expect(a.headline).toBe("Machine size: not measured");
    expect(a.reasons).toEqual(["ARM incompatible; x86 required", "peak memory not measured"]);
  });
  it.each([
    ["no facts", undefined],
    ["no peak", machineFactsOf(report({ fullSuite: undefined }))],
    ["unknown ARM verdict", machineFactsOf(report({}, [passedSuite, { step: "build", status: "failed", failure: "build_failed", durationMs: 1, outputTail: "plain failure" }]))],
    ["measured on x86", machineFactsOf(report({ machineChip: "x86_64" }))],
  ])("%s is not measured, never a size", (_name, facts) => {
    const a = advice(facts);
    expect(a.status).toBe("not_measured");
    expect(a.row).toBeUndefined();
    expect(a.headline).toBe("Machine size: not measured");
  });
  it.each([NaN, Infinity, -1, MAX_PEAK_MEMORY_MIB + 1])("a peak out of range (%s) is not measured, with the ARM word kept", (peak) => {
    const facts = { ...machineFactsOf(report({ fullSuite: undefined }, failedWith("exec format error")))!, peakMemoryMiB: peak };
    const a = advice(facts);
    expect(a.row).toBeUndefined();
    expect(a).toMatchObject({ status: "not_measured", reasons: ["ARM incompatible; x86 required", "peak memory not measured"] });
  });
  it("no available size is not a suggestion", () => {
    const a = advice(machineFactsOf(report())!, ["x86_64-8-32"]);
    expect(a.status).toBe("not_measured");
    expect(a.reasons).toContain("no available size meets the measured memory requirement");
  });
  it("labels rows in fixed words and never from input", () => {
    expect(machineRowLabel("x86_64-8-32")).toBe("x86, 8 vCPU, 32 GB");
    expect(machineRowLabel("evil")).toBeUndefined();
    expect(MACHINE_STORED_ONLY_LINE).toBe("Stored only: Rovara does not launch this size yet.");
  });
  it("prints no output text", () => {
    const a = advice(machineFactsOf(report({ fullSuite: undefined }, failedWith(`${CANARY} exec format error`)))!);
    expect(JSON.stringify(a)).not.toContain(CANARY);
  });
});
