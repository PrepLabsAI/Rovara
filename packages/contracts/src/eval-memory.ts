// Learning v2 W1 (design learning-v2-team-record.md 4.12, 4.13): the MEMORY dimension of an eval batch. A replay can run the same tasks with lessons loaded ("on") and without
// ("off"), and compare. This file is the contract only. The quality-suite batch that will carry it (`quality-suite.md` Q12: `QualityBatchFile`, `Arm.memory`) is not on this branch, and
// the batch file of today (`EvalBatchFileSchema`) does not carry it: a file that names `memory` is refused until a runner honours it, so an arm can never silently run with memory
// it was not meant to have.
//
//   - The dimension is a short unique list: ["off"], ["on"] or ["off", "on"]. Absent means one arm that changes nothing (`evalMemoryArms` returns [undefined]).
//   - Each arm becomes the dispatch's `memory` input (lessons.ts `MemoryInput`): "off" loads nothing and offers no record tools; "on" reads a FROZEN snapshot of the lessons,
//     never the live set, so the same snapshot and task give the same loaded set. An eval never reads live memory, and an "on" arm without a snapshot is refused.
//   - `compareMemoryArms` pairs the arms task by task and reports the resolve rate of each over the SAME tasks, with Wilson intervals, and which tasks only one arm solved.
import { z } from "zod";
import { wilsonInterval } from "./eval-stats.js";
import { MemoryInputSchema, type MemoryInput } from "./lessons.js";

export const EVAL_MEMORY_ARMS = ["off", "on"] as const;
export const EvalMemoryArmSchema = z.enum(EVAL_MEMORY_ARMS);
export type EvalMemoryArm = z.infer<typeof EvalMemoryArmSchema>;

/** Which arms run for each task. One or two, each once. */
export const EvalMemoryDimensionSchema = z.array(EvalMemoryArmSchema).min(1).max(EVAL_MEMORY_ARMS.length).refine((arms) => new Set(arms).size === arms.length, "an arm is listed twice");
export type EvalMemoryDimension = z.infer<typeof EvalMemoryDimensionSchema>;

/** The arms to expand a batch by: the listed ones, or a single arm with no memory setting when the batch names none (a run exactly as before). */
export function evalMemoryArms(dimension: EvalMemoryDimension | undefined): ReadonlyArray<EvalMemoryArm | undefined> {
  return dimension === undefined ? [undefined] : EvalMemoryDimensionSchema.parse(dimension);
}

/** How many times the dimension multiplies a batch's run count. */
export const evalMemoryArmCount = (dimension: EvalMemoryDimension | undefined): number => evalMemoryArms(dimension).length;

/** The dispatch `memory` input an arm stands for. "on" needs the frozen snapshot it reads; an eval run never gets `live`. */
export function memoryInputForArm(arm: EvalMemoryArm, snapshotId?: string): MemoryInput {
  EvalMemoryArmSchema.parse(arm);
  if (arm === "off") return MemoryInputSchema.parse({ mode: "off" });
  if (snapshotId === undefined) throw new RangeError("An arm with memory on reads a frozen snapshot; name its snapshot.");
  return MemoryInputSchema.parse({ mode: "snapshot", snapshotId });
}

export interface MemoryArmRow {
  task: string;
  /** The repeat of the task (1 when the batch does not repeat). Arms are paired repeat by repeat. */
  repeat?: number;
  arm: EvalMemoryArm;
  /** Whether the run was graded resolved. `undefined`: the run was not graded (it failed, was cancelled or retried), so its pair is left out. */
  resolved: boolean | undefined;
}
export interface ArmResult { runs: number; resolved: number; rate: number | null; low: number; high: number }
export interface MemoryArmComparison {
  /** Task runs graded in BOTH arms: the common ground both rates are over. */
  pairs: number;
  /** Task runs left out because one arm was missing or not graded. */
  unpaired: number;
  on: ArmResult;
  off: ArmResult;
  /** on rate minus off rate over the pairs, or null with no pairs. */
  delta: number | null;
  bothResolved: number;
  onlyWithMemory: number;
  onlyWithoutMemory: number;
  neither: number;
}

const result = (resolved: number, runs: number): ArmResult => ({ runs, resolved, rate: runs === 0 ? null : resolved / runs, ...wilsonInterval(resolved, runs) });

/** Pairs the rows by task and repeat. A row listed twice for one arm is refused (it would count a run twice); an ungraded row takes its pair out of both rates. */
export function compareMemoryArms(rows: readonly MemoryArmRow[]): MemoryArmComparison {
  const seen = new Map<string, { on?: boolean | undefined; off?: boolean | undefined; hasOn: boolean; hasOff: boolean }>();
  for (const row of rows) {
    EvalMemoryArmSchema.parse(row.arm);
    const key = JSON.stringify([row.task, row.repeat ?? 1]);
    const entry = seen.get(key) ?? { hasOn: false, hasOff: false };
    if ((row.arm === "on" && entry.hasOn) || (row.arm === "off" && entry.hasOff)) throw new RangeError(`The ${row.arm} arm has two rows for one task run.`);
    if (row.arm === "on") { entry.on = row.resolved; entry.hasOn = true; } else { entry.off = row.resolved; entry.hasOff = true; }
    seen.set(key, entry);
  }
  let pairs = 0, unpaired = 0, onResolved = 0, offResolved = 0, both = 0, onlyOn = 0, onlyOff = 0, neither = 0;
  for (const entry of seen.values()) {
    if (!entry.hasOn || !entry.hasOff || entry.on === undefined || entry.off === undefined) { unpaired += 1; continue; }
    pairs += 1;
    if (entry.on) onResolved += 1;
    if (entry.off) offResolved += 1;
    if (entry.on && entry.off) both += 1; else if (entry.on) onlyOn += 1; else if (entry.off) onlyOff += 1; else neither += 1;
  }
  const on = result(onResolved, pairs);
  const off = result(offResolved, pairs);
  return { pairs, unpaired, on, off, delta: on.rate === null || off.rate === null ? null : on.rate - off.rate, bothResolved: both, onlyWithMemory: onlyOn, onlyWithoutMemory: onlyOff, neither };
}
