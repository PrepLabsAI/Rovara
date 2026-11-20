import { describe, expect, it } from "vitest";
import { armCompatibilityOf, LONG_SUITE_MS, MACHINE_SIZE_ROWS, machineMeasurementRequest, suggestMachine, MAX_SUITE_MS } from "../../packages/contracts/src/machine-size.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { TEST_ENV_PROVE_MEASURE_FEATURE } from "../../packages/contracts/src/protocol.js";
import type { TestEnvProveReport } from "../../packages/contracts/src/test-environment.js";
const available = MACHINE_SIZE_ROWS.map(row => row.id);
const suggest = (peakMemoryMiB?: number, extra = {}) => suggestMachine({ peakMemoryMiB, armVerdict: "unknown", available, ...extra });
const report = (tail?: string, machineChip: "arm64" | "x86_64" = "arm64"): TestEnvProveReport => ({ schemaVersion: 1, proposalDigest: "a".repeat(64), machineChip, steps: [{ step: "full_suite", status: tail === undefined ? "passed" : "failed", durationMs: 1, ...(tail === undefined ? {} : { failure: "tests_failed", outputTail: tail }) }], services: [], finishedAt: "2026-11-13T00:00:00.000Z" });
describe("machine suggestions", () => {
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
});
it("negotiation needs both the gate and feature; this worker does not advertise it", () => {
  expect(machineMeasurementRequest(false, [TEST_ENV_PROVE_MEASURE_FEATURE])).toEqual({});
  expect(machineMeasurementRequest(true, [])).toEqual({});
  expect(machineMeasurementRequest(true, [TEST_ENV_PROVE_MEASURE_FEATURE])).toEqual({ measureMachine: true });
  expect(WORKER_IMPLEMENTED_FEATURES).not.toContain(TEST_ENV_PROVE_MEASURE_FEATURE);
});

