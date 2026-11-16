// TE-C5 part B: what the setup card says about the machine size, from a measured setup Prove.
//
// Three things live here, all pure:
//   - `SetupProveResultBodySchema`: the exact body the worker posts to `setup-prove-result` (`packages/worker/src/setup-prove.ts`), parsed strictly with fixed refusals;
//   - `machineFactsOf`: the only facts the broker keeps from a report (a chip, a bounded peak, a bounded suite time, a fixed ARM verdict). No output text is ever kept;
//   - `machineAdviceOf`: the card's words. Every sentence is fixed here; a size is shown only for a measured peak and a known ARM verdict, otherwise it says "not measured".
import { z } from "zod";
import {
  ARM_INCOMPATIBILITY_PATTERNS, MACHINE_SIZE_ROWS, MAX_SUITE_MS, armCompatibilityOf, suggestMachine, validPeakMemory,
  type ArmVerdict, type MachineChip, type MachineSizeRow,
} from "./machine-size.js";
import { TestEnvProveReportSchema, type TestEnvProveReport } from "./test-environment.js";

/** The worker's fixed refusal words (`SetupProveResult` in the worker). */
export const SETUP_PROVE_FAILURE_REASONS = ["invalid_job", "services_need_prove", "commits_mismatch", "not_fresh", "fresh_sandbox_failed", "prove_failed", "aborted", "cleanup_failed"] as const;
const PATTERN_IDS = ARM_INCOMPATIBILITY_PATTERNS.map(entry => entry.id) as [(typeof ARM_INCOMPATIBILITY_PATTERNS)[number]["id"], ...Array<(typeof ARM_INCOMPATIBILITY_PATTERNS)[number]["id"]>];

/** The body of the worker's post. The report is bounded by its own schema (seven 4-KiB tails); the lease is checked by the caller that mounts the route, never here. */
export const SetupProveResultBodySchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  leaseToken: z.string().min(16).max(200),
  result: z.union([
    z.object({ ok: z.literal(true), report: TestEnvProveReportSchema }).strict(),
    z.object({ ok: z.literal(false), reason: z.enum(SETUP_PROVE_FAILURE_REASONS) }).strict(),
  ]),
}).strict();
export type SetupProveResultBody = z.infer<typeof SetupProveResultBodySchema>;

/** What the broker stores of a measurement. Numbers and fixed words only. */
export const MachineFactsSchema = z.object({
  schemaVersion: z.literal(1),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  chip: z.enum(["arm64", "x86_64"]),
  peakMemoryMiB: z.number().refine(validPeakMemory, "peak memory out of range").optional(),
  suiteMs: z.number().int().min(0).max(MAX_SUITE_MS).optional(),
  armVerdict: z.enum(["arm_ok", "arm_incompatible", "unknown"]),
  patternId: z.enum(PATTERN_IDS).optional(),
}).strict();
export type MachineFacts = z.infer<typeof MachineFactsSchema>;

/** The facts of a validated report, or undefined when the run does not say what chip it ran on (then nothing is claimed). A peak counts only when a full suite passed in the same report. */
export function machineFactsOf(report: TestEnvProveReport): MachineFacts | undefined {
  if (report.machineChip === undefined) return undefined;
  const suitePassed = report.steps.some(step => step.step === "full_suite" && step.status === "passed");
  const peak = report.fullSuite?.peakMemoryMiB;
  const suiteMs = report.fullSuite?.durationMs;
  const arm = armCompatibilityOf(report);
  return {
    schemaVersion: 1, proposalDigest: report.proposalDigest, chip: report.machineChip,
    ...(suitePassed && validPeakMemory(peak) ? { peakMemoryMiB: peak } : {}),
    ...(suitePassed && typeof suiteMs === "number" && Number.isSafeInteger(suiteMs) && suiteMs >= 0 && suiteMs <= MAX_SUITE_MS ? { suiteMs } : {}),
    armVerdict: arm.verdict, ...(arm.patternId === undefined ? {} : { patternId: arm.patternId }),
  };
}

export const MACHINE_STORED_ONLY_LINE = "Stored only: Rovara does not launch this size yet.";
export const MACHINE_NOT_MEASURED_HEADLINE = "Machine size: not measured";
const CHIP_WORDS: Readonly<Record<MachineChip, string>> = { arm64: "ARM", x86_64: "x86" };

/** A row in fixed words, from its id. An id that is not one of the rows has no label. */
export function machineRowLabel(rowId: string): string | undefined {
  const row = MACHINE_SIZE_ROWS.find(entry => entry.id === rowId);
  return row === undefined ? undefined : `${CHIP_WORDS[row.chip]}, ${String(row.vcpu)} vCPU, ${String(row.memoryGiB)} GB`;
}

export interface MachineAdvice { status: "suggested" | "not_measured"; headline: string; reasons: string[]; row?: MachineSizeRow }

/**
 * The card's sentences. A size comes out only when the peak memory was measured, the ARM verdict is known (a measured ARM run that worked, or an ARM failure with the fixed signature) and a listed
 * size fits. Everything else is "not measured" with the fixed reasons: never a size taken from a guess. The suggestion never depends on what the person picked.
 */
export function machineAdviceOf(facts: MachineFacts | undefined, options: { available?: readonly string[] } = {}): MachineAdvice {
  const notMeasured = (reasons: string[]): MachineAdvice => ({ status: "not_measured", headline: MACHINE_NOT_MEASURED_HEADLINE, reasons });
  if (facts === undefined) return notMeasured(["no measurement"]);
  const verdict: ArmVerdict = facts.armVerdict;
  if (verdict === "unknown") return notMeasured(["ARM compatibility not known"]);
  if (!validPeakMemory(facts.peakMemoryMiB)) return notMeasured([...(verdict === "arm_incompatible" ? ["ARM incompatible; x86 required"] : []), "peak memory not measured"]);
  const suggestion = suggestMachine({
    peakMemoryMiB: facts.peakMemoryMiB, ...(facts.suiteMs === undefined ? {} : { suiteMs: facts.suiteMs }), armVerdict: verdict,
    available: options.available ?? MACHINE_SIZE_ROWS.map(row => row.id),
  });
  if (suggestion.row === undefined) return notMeasured(suggestion.reasons);
  return { status: "suggested", headline: `Suggested machine: ${machineRowLabel(suggestion.row.id) ?? ""}`, reasons: suggestion.reasons, row: suggestion.row };
}
