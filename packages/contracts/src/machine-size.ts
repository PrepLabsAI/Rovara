import type { TestEnvProveReport } from "./test-environment.js";

export const MACHINE_MEMORY_HEADROOM = 1.5;
/** Bounds for measured facts, not machine capacity or the existing round budget. */
export const MAX_PEAK_MEMORY_MIB = 1_048_576;
export const MAX_SUITE_MS = 7 * 24 * 60 * 60 * 1000;
export const TEST_ENV_PROVE_MEASURE_FEATURE = "task.testEnvProveMeasure.v1" as const;
export type MachineChip = "arm64" | "x86_64";
export interface MachineSizeRow { readonly id: string; readonly chip: MachineChip; readonly vcpu: number; readonly memoryGiB: number }
export const MACHINE_SIZE_ROWS: readonly MachineSizeRow[] = [
  { id: "arm64-2-8", chip: "arm64", vcpu: 2, memoryGiB: 8 },
  { id: "arm64-4-16", chip: "arm64", vcpu: 4, memoryGiB: 16 },
  { id: "arm64-8-32", chip: "arm64", vcpu: 8, memoryGiB: 32 },
  { id: "x86_64-2-8", chip: "x86_64", vcpu: 2, memoryGiB: 8 },
  { id: "x86_64-4-16", chip: "x86_64", vcpu: 4, memoryGiB: 16 },
  { id: "x86_64-8-32", chip: "x86_64", vcpu: 8, memoryGiB: 32 },
];
export type ArmVerdict = "arm_ok" | "arm_incompatible" | "unknown";
export function validPeakMemory(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PEAK_MEMORY_MIB;
}
/** Available ids are install policy, never arbitrary row shapes. An absent row means no suggested change. Time is display only. */
export function suggestMachine(input: { peakMemoryMiB?: number | undefined; suiteMs?: number; armVerdict: ArmVerdict; available: readonly string[]; currentRowId?: string }): { row?: MachineSizeRow; reasons: string[] } {
  if (!validPeakMemory(input.peakMemoryMiB)) return { reasons: ["peak memory not measured"] };
  const chip = input.armVerdict === "arm_incompatible" ? "x86_64" : (MACHINE_SIZE_ROWS.find(row => row.id === input.currentRowId)?.chip ?? "arm64");
  const row = MACHINE_SIZE_ROWS.find(row => row.chip === chip && input.available.includes(row.id) && row.memoryGiB * 1024 >= input.peakMemoryMiB! * MACHINE_MEMORY_HEADROOM);
  const reasons = [`peak memory ${String(Math.ceil(input.peakMemoryMiB))} MiB`, "memory headroom 1.5x"];
  if (typeof input.suiteMs === "number" && Number.isFinite(input.suiteMs) && input.suiteMs >= 0 && input.suiteMs <= MAX_SUITE_MS) reasons.push(`suite ${String(Math.ceil(input.suiteMs / 60000))} min`);
  reasons.push(input.armVerdict === "arm_incompatible" ? "ARM incompatible; x86 required" : "current chip retained");
  if (row === undefined) reasons.push("no available size meets the measured memory requirement");
  return { ...(row === undefined ? {} : { row: { ...row } }), reasons };
}
/** Literal signatures and a bounded word-boundary expression: linear in the output size. No output text is returned. */
export const ARM_INCOMPATIBILITY_PATTERNS = [
  { id: "exec_format", pattern: /\bexec format error\b/iu },
  { id: "unsupported_wheel", pattern: /\bis not a supported wheel on this platform\b/iu },
  // npm WARN optional/notsup notices can accompany an unrelated failure. Only npm's error lines are evidence.
  { id: "npm_platform", pattern: /^npm[ \t]+(?:ERR!|error)[ \t]+(?:code[ \t]+EBADPLATFORM\b|(?:notsup[ \t]+)?Unsupported platform for\b)/imu },
  { id: "manifest_arm64", pattern: /\bno matching manifest for linux\/arm64\b/iu },
  { id: "image_amd64", pattern: /image's platform \(linux\/amd64\) does not match/iu },
] as const;
export function armCompatibilityOf(report: TestEnvProveReport): { verdict: ArmVerdict; patternId?: (typeof ARM_INCOMPATIBILITY_PATTERNS)[number]["id"] } {
  if (report.machineChip !== "arm64") return { verdict: "unknown" };
  const failures = report.steps.filter(step => step.status === "failed");
  for (const step of failures) for (const { id, pattern } of ARM_INCOMPATIBILITY_PATTERNS) {
    if (pattern.test(step.outputTail ?? "")) return { verdict: "arm_incompatible", patternId: id };
  }
  const exercised = report.steps.some(step => (step.step === "full_suite" || step.step === "smoke") && step.status === "passed");
  return { verdict: failures.length === 0 && exercised ? "arm_ok" : "unknown" };
}
/** Engine-side negotiation for future setup wiring. The current workers deliberately do not advertise this feature. */
export function machineMeasurementRequest(machineSize: boolean, workerFeatures: readonly string[]): { measureMachine?: true } {
  return machineSize && workerFeatures.includes(TEST_ENV_PROVE_MEASURE_FEATURE) ? { measureMachine: true } : {};
}
