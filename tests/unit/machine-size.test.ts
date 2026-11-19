import { describe, expect, it } from "vitest";
import { armCompatibilityOf, LONG_SUITE_MS, MACHINE_SIZE_ROWS, machineMeasurementRequest, suggestMachine, MAX_PEAK_MEMORY_MIB, MAX_SUITE_MS } from "../../packages/contracts/src/machine-size.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { TEST_ENV_PROVE_MEASURE_FEATURE } from "../../packages/contracts/src/protocol.js";
import type { TestEnvProveReport } from "../../packages/contracts/src/test-environment.js";
const available = MACHINE_SIZE_ROWS.map(row => row.id);
const suggest = (peakMemoryMiB?: number, extra = {}) => suggestMachine({ peakMemoryMiB, armVerdict: "unknown", available, ...extra });
const report = (tail?: string, machineChip: "arm64" | "x86_64" = "arm64"): TestEnvProveReport => ({ schemaVersion: 1, proposalDigest: "a".repeat(64), machineChip, steps: [{ step: "full_suite", status: tail === undefined ? "passed" : "failed", durationMs: 1, ...(tail === undefined ? {} : { failure: "tests_failed", outputTail: tail }) }], services: [], finishedAt: "2026-11-13T00:00:00.000Z" });
describe("machine suggestions", () => {
  it.each([[8192 / 1.5, "arm64-2-8"], [8192 / 1.5 + 1, "arm64-4-16"], [16384 / 1.5, "arm64-4-16"], [16384 / 1.5 + 1, "arm64-8-32"], [32768 / 1.5, "arm64-8-32"], [32768 / 1.5 + 1, "arm64-16-64"], [65536 / 1.5, "arm64-16-64"], [65536 / 1.5 + 1, "arm64-32-128"], [131072 / 1.5, "arm64-32-128"]])("headroom boundary %s", (peak, id) => { expect(suggest(Number(peak)).row?.id).toBe(id); });
  it("picks the 16 vCPU / 64 GB and 32 vCPU / 128 GB sizes of the current chip from measured peak memory alone", () => {
    expect(suggest(30_000).row).toEqual({ id: "arm64-16-64", chip: "arm64", vcpu: 16, memoryGiB: 64 });
    expect(suggest(60_000).row).toEqual({ id: "arm64-32-128", chip: "arm64", vcpu: 32, memoryGiB: 128 });
    expect(suggest(30_000, { currentRowId: "x86_64-2-8" }).row).toEqual({ id: "x86_64-16-64", chip: "x86_64", vcpu: 16, memoryGiB: 64 });
    expect(suggest(60_000, { armVerdict: "arm_incompatible" }).row).toEqual({ id: "x86_64-32-128", chip: "x86_64", vcpu: 32, memoryGiB: 128 });
  });
  it("offers no size when even 128 GB does not fit, and never a big size the install does not list", () => {
    const none = suggest(131072 / 1.5 + 1);
    expect(none.row).toBeUndefined();
    expect(none.reasons).toContain("no available size meets the measured memory requirement");
    expect(suggest(60_000, { available: available.filter(id => id !== "arm64-32-128") }).row).toBeUndefined();
    expect(suggest(30_000, { available: ["arm64-2-8", "arm64-8-32"] }).row).toBeUndefined();
  });
  it.each([undefined, NaN, Infinity, -1, MAX_PEAK_MEMORY_MIB + 1])("no claim for invalid peak %s", peak => { expect(suggest(peak)).toEqual({ reasons: ["peak memory not measured"] }); });
  it("keeps the current chip unless ARM failed", () => {
    expect(suggest(100).row?.chip).toBe("arm64");
    expect(suggest(100, { currentRowId: "x86_64-4-16" }).row?.chip).toBe("x86_64");
    expect(suggest(100, { armVerdict: "arm_incompatible" }).row?.chip).toBe("x86_64");
  });
  it("never promises unavailable capacity or a fabricated row", () => {
    expect(suggest(6000, { available: ["arm64-2-8"] }).row).toBeUndefined();
    expect(suggest(100, { available: ["evil"] }).row).toBeUndefined();
    expect(suggest(100, { available: ["arm64-2-8"] }).row?.id).toBe("arm64-2-8");
    expect(suggest(MAX_PEAK_MEMORY_MIB).reasons).toContain("no available size meets the measured memory requirement");
  });
  it("a long suite moves the pick up one size of the same chip, only when the install lists it", () => {
    const long = suggest(1024, { suiteMs: LONG_SUITE_MS });
    expect(long.row?.id).toBe("arm64-4-16");
    expect(long.reasons).toContain("long suite; one size larger to shorten it");
    expect(suggest(1024, { suiteMs: LONG_SUITE_MS - 1 }).row?.id).toBe("arm64-2-8");
    expect(suggest(1024, { suiteMs: LONG_SUITE_MS - 1 }).reasons).not.toContain("long suite; one size larger to shorten it");
    expect(suggest(30_000, { suiteMs: 2 * LONG_SUITE_MS }).row?.id).toBe("arm64-32-128");
    expect(suggest(1024, { suiteMs: LONG_SUITE_MS, currentRowId: "x86_64-2-8" }).row?.id).toBe("x86_64-4-16");
    expect(suggest(1024, { suiteMs: LONG_SUITE_MS, available: ["arm64-2-8", "arm64-16-64"] }).row?.id).toBe("arm64-16-64");
    expect(suggest(1024, { suiteMs: LONG_SUITE_MS, available: ["arm64-2-8"] }).row?.id).toBe("arm64-2-8");
    expect(suggest(60_000, { suiteMs: MAX_SUITE_MS }).row?.id).toBe("arm64-32-128");
    expect(suggest(1024, { suiteMs: MAX_SUITE_MS, armVerdict: "arm_incompatible" }).row?.id).toBe("x86_64-4-16");
  });
  it("time never invents a size: nothing fits, nothing is suggested, however long the suite", () => {
    expect(suggest(131072 / 1.5 + 1, { suiteMs: MAX_SUITE_MS }).row).toBeUndefined();
    expect(suggest(undefined, { suiteMs: MAX_SUITE_MS })).toEqual({ reasons: ["peak memory not measured"] });
  });
  it("prints only bounded facts", () => {
    expect(suggest(1024, { suiteMs: 60_000 }).reasons).toEqual(["peak memory 1024 MiB", "memory headroom 1.5x", "peak memory includes file cache", "suite 1 min", "current chip retained", "an ARM run does not prove x86 compatibility"]);
    for (const suiteMs of [NaN, Infinity, -1, MAX_SUITE_MS + 1]) {
      expect(suggest(1024, { suiteMs }).reasons.some(reason => reason.startsWith("suite "))).toBe(false);
      expect(suggest(1024, { suiteMs }).row).toEqual(suggest(1024).row);
    }
  });
});
describe("ARM evidence is fixed words", () => {
  it.each([["exec format error", "exec_format"], ["x is not a supported wheel on this platform", "unsupported_wheel"], ["npm ERR! code EBADPLATFORM", "npm_platform"], ["npm error notsup Unsupported platform for x", "npm_platform"], ["no matching manifest for linux/arm64", "manifest_arm64"], ["image's platform (linux/amd64) does not match", "image_amd64"]])("%s", (tail, patternId) => { expect(armCompatibilityOf(report(tail))).toEqual({ verdict: "arm_incompatible", patternId }); });
  it("requires an ARM run and a passing suite or smoke; empty and skipped reports prove nothing", () => {
    expect(armCompatibilityOf(report())).toEqual({ verdict: "arm_ok" });
    expect(armCompatibilityOf(report(undefined, "x86_64"))).toEqual({ verdict: "unknown" });
    expect(armCompatibilityOf({ ...report(), steps: [] })).toEqual({ verdict: "unknown" });
    expect(armCompatibilityOf({ ...report(), steps: [{ step: "full_suite", status: "skipped", durationMs: 0 }] })).toEqual({ verdict: "unknown" });
    expect(armCompatibilityOf(report("exec format error", "x86_64"))).toEqual({ verdict: "unknown" });
  });
  it.each(["no matching distribution", "no matching manifest for linux/amd64", "exec formatting error", "xEBADPLATFORMx", "unsupported platform"])('near miss %s', tail => { expect(armCompatibilityOf(report(tail))).toEqual({ verdict: "unknown" }); });
  it.each([
    'npm WARN optional SKIPPING OPTIONAL DEPENDENCY: fsevents@2.3.3 (node_modules/fsevents):\nnpm WARN notsup SKIPPING OPTIONAL DEPENDENCY: Unsupported platform for fsevents@2.3.3: wanted {"os":"darwin"} (current: {"os":"linux","arch":"arm64"})\nnpm ERR! code ELIFECYCLE\nnpm ERR! test failed',
    'npm WARN optional EBADPLATFORM: skipping optional dependency fsevents\nnpm error code EACCES',
    'Unsupported platform for fsevents (optional dependency skipped)\nnpm error code EACCES',
    'npm WARN code EBADPLATFORM\nnpm error code ELIFECYCLE',
  ])("optional platform notices do not suggest x86: %s", tail => {
    const arm = armCompatibilityOf(report(tail));
    expect(arm).toEqual({ verdict: "unknown" });
    expect(suggest(100, { armVerdict: arm.verdict }).row?.chip).toBe("arm64");
  });
  it.each(["npm ERR! code EBADPLATFORM", "npm error code EBADPLATFORM", "npm ERR! notsup Unsupported platform for native-binary"])("a failing npm platform error still counts: %s", error => {
    const tail = "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: Unsupported platform for fsevents\n" + error;
    expect(armCompatibilityOf(report(tail))).toEqual({ verdict: "arm_incompatible", patternId: "npm_platform" });
  });
  it("a megabyte of hostile markup only selects a fixed pattern", () => {
    const tail = "[x](https://evil.test) ![x][ref] @owner #123 <b> # > --- ``` ~~~ \u200b\ufe0f" + "x".repeat(1_000_000) + " exec format error";
    expect(armCompatibilityOf(report(tail))).toEqual({ verdict: "arm_incompatible", patternId: "exec_format" });
    expect(suggest(100, { armVerdict: armCompatibilityOf(report(tail)).verdict }).reasons).toContain("ARM incompatible; x86 required");
  });
});
it("negotiation needs both the gate and feature; this worker does not advertise it", () => {
  expect(machineMeasurementRequest(false, [TEST_ENV_PROVE_MEASURE_FEATURE])).toEqual({});
  expect(machineMeasurementRequest(true, [])).toEqual({});
  expect(machineMeasurementRequest(true, [TEST_ENV_PROVE_MEASURE_FEATURE])).toEqual({ measureMachine: true });
  expect(WORKER_IMPLEMENTED_FEATURES).not.toContain(TEST_ENV_PROVE_MEASURE_FEATURE);
});
it("successful output tails and skipped steps cannot claim ARM incompatibility", () => {
 const passed = report(); passed.steps[0]!.outputTail = "exec format error";
 expect(armCompatibilityOf(passed)).toEqual({ verdict: "arm_ok" });
});

it("ARM incompatible golden omits the redundant compatibility caveat", () => {
  expect(suggest(1024, { suiteMs: 60_000, armVerdict: "arm_incompatible" }).reasons).toEqual(["peak memory 1024 MiB", "memory headroom 1.5x", "peak memory includes file cache", "suite 1 min", "ARM incompatible; x86 required"]);
});
