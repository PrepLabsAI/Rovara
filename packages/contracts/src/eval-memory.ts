// Learning v2 W1 (design learning-v2-team-record.md 4.12, 4.13): the MEMORY dimension of an eval batch. A replay can run the same tasks with lessons loaded ("on") and without
// ("off"), and compare. This file is the contract only. The quality-suite batch that will carry it (`quality-suite.md` Q12: `QualityBatchFile`, `Arm.memory`) is not on this branch, and
// the batch file of today (`EvalBatchFileSchema`) does not carry it: a file that names `memory` is refused until a runner honours it, so an arm can never silently run with memory
// it was not meant to have.
//
//   - The dimension is a short unique list of NAMED arms (DECISIONS 38/49). `off` loads nothing. `on:<pipeline>` loads a frozen snapshot made by the named lesson pipeline (`on:current`,
//     `on:consolidated`); every "on" arm carries its pipeline label. `file:<label>` and `mcp:<label>` (DECISIONS 50.5) offer the same lessons to a LOCAL agent through a repository file or the
//     MCP tool; they are not a Rovara task's memory input. The bare "on" of the two-arm contract is still read, as the pipeline `legacy`. Absent means one arm that changes nothing.
//   - Each Rovara arm becomes the dispatch's `memory` input (lessons.ts `MemoryInput`): "off" loads nothing and offers no record tools; "on:*" reads a FROZEN snapshot of the lessons,
//     never the live set, so the same snapshot and task give the same loaded set. An eval never reads live memory, and an "on" arm without a snapshot is refused.
//   - `compareArms` pairs N arms run by run and reports the resolve rate of each over the runs graded in EVERY arm, with Wilson intervals, and which tasks only one arm of a pair solved.
//     `compareMemoryArms` is the two-arm form, kept so old results are still read.
import { z } from "zod";
import { wilsonInterval } from "./eval-stats.js";
import { MemoryInputSchema, type MemoryInput } from "./lessons.js";

/** The arms of the two-arm contract. New results name the pipeline of an "on" arm; these are still read. */
export const EVAL_MEMORY_ARMS = ["off", "on"] as const;
export const EvalMemoryArmSchema = z.enum(EVAL_MEMORY_ARMS);
export type EvalMemoryArm = z.infer<typeof EvalMemoryArmSchema>;

/** How many different arms one batch may name. */
export const EVAL_ARMS_MAX = 8;
/** The pipeline label a bare "on" of an old result is read as. */
export const LEGACY_PIPELINE = "legacy";
export const EVAL_ARM_KINDS = ["off", "on", "file", "mcp"] as const;
export type EvalArmKind = (typeof EVAL_ARM_KINDS)[number];
const ARM_LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const ARM_NAME_ERROR = "An arm is off, on:<pipeline>, file:<label> or mcp:<label>, with a lowercase label of letters, digits and hyphens.";

export interface ParsedArm {
  /** The canonical name: `off`, `on:<pipeline>`, `file:<label>` or `mcp:<label>`. */
  name: string;
  kind: EvalArmKind;
  /** The pipeline (or lesson set) the arm reads. Absent for `off`. */
  label?: string;
  /** The name was the bare "on" of the two-arm contract. */
  legacy?: true;
}

/** Reads an arm name, or throws. The bare "on" is accepted as `on:legacy`; no other name without a label is. */
export function parseArm(name: unknown): ParsedArm {
  if (typeof name !== "string") throw new RangeError("An arm name is a string.");
  if (name === "off") return { name, kind: "off" };
  if (name === "on") return { name: `on:${LEGACY_PIPELINE}`, kind: "on", label: LEGACY_PIPELINE, legacy: true };
  const split = name.split(":");
  const kind = split[0];
  const label = split[1];
  if (split.length !== 2 || (kind !== "on" && kind !== "file" && kind !== "mcp") || label === undefined || !ARM_LABEL.test(label)) {
    throw new RangeError(ARM_NAME_ERROR);
  }
  return { name, kind, label };
}
/** The canonical name of an arm: the bare "on" becomes `on:legacy`. */
export const canonicalArm = (name: unknown): string => parseArm(name).name;
/** The pipeline an arm reads, or undefined for `off`. */
export const armPipeline = (name: string): string | undefined => parseArm(name).label;

export const EvalArmNameSchema = z.string().refine((value) => { try { parseArm(value); return true; } catch { return false; } }, "not an arm name");

/** Which arms run for each task: up to EVAL_ARMS_MAX different ones (the bare "on" and "on:legacy" are the same arm). */
export const EvalMemoryDimensionSchema = z.array(EvalArmNameSchema).min(1).max(EVAL_ARMS_MAX).refine((arms) => new Set(arms.map((arm) => { try { return canonicalArm(arm); } catch { return arm; } })).size === arms.length, "an arm is listed twice");
export type EvalMemoryDimension = z.infer<typeof EvalMemoryDimensionSchema>;

/** The arms to expand a batch by: the listed ones, or a single arm with no memory setting when the batch names none (a run exactly as before). */
export function evalMemoryArms(dimension: EvalMemoryDimension | undefined): ReadonlyArray<string | undefined> {
  return dimension === undefined ? [undefined] : EvalMemoryDimensionSchema.parse(dimension);
}

/** How many times the dimension multiplies a batch's run count. */
export const evalMemoryArmCount = (dimension: EvalMemoryDimension | undefined): number => evalMemoryArms(dimension).length;

/** The dispatch `memory` input an arm stands for. An "on" arm needs the frozen snapshot it reads; an eval run never gets `live`. A file or MCP arm is not a Rovara task's memory. */
export function memoryInputForArm(arm: string, snapshotId?: string): MemoryInput {
  const parsed = parseArm(arm);
  if (parsed.kind === "off") return MemoryInputSchema.parse({ mode: "off" });
  if (parsed.kind !== "on") throw new RangeError("A file or MCP arm is offered to a local agent outside a Rovara task; it has no memory input. Use its delivery adapter.");
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


// ---------------------------------------------------------------------------------------------------------------------------
// N arms

export interface ArmRunRow {
  task: string;
  /** The repeat of the task (1 when the batch does not repeat). Arms are paired repeat by repeat. */
  repeat?: number;
  /** An arm name; the bare "on" is read as `on:legacy`. */
  arm: string;
  /** Whether the run was graded resolved. `undefined`: the run was not graded, so its run is left out of every arm. */
  resolved: boolean | undefined;
}

/**
 * Reads result rows written by the two-arm contract (arm "on" / "off") or by this one. A row that is not an object, names no task, an unknown arm or a `resolved` that is not true, false or absent is refused: a
 * result is never read with rows quietly left out.
 */
export function readArmRows(raw: unknown): ArmRunRow[] {
  if (!Array.isArray(raw)) throw new RangeError("Result rows are a list.");
  return raw.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null) throw new RangeError(`Row ${String(index)} is not an object.`);
    const row = entry as Record<string, unknown>;
    if (typeof row["task"] !== "string" || row["task"] === "") throw new RangeError(`Row ${String(index)} names no task.`);
    const repeat = row["repeat"];
    if (repeat !== undefined && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1)) throw new RangeError(`Row ${String(index)} has a repeat that is not a whole number from 1.`);
    const resolved = row["resolved"];
    if (resolved !== undefined && resolved !== null && typeof resolved !== "boolean") throw new RangeError(`Row ${String(index)} has a resolved that is not true or false.`);
    return { task: row["task"], repeat: repeat ?? 1, arm: canonicalArm(row["arm"]), resolved: resolved ?? undefined };
  });
}

export interface ArmsDiscordance {
  /** The pair, in the order of `arms`. */
  a: string;
  b: string;
  /** Tasks only `a` solved (most of its graded repeats resolved, and not most of `b`'s), and tasks only `b` solved. */
  onlyA: string[];
  onlyB: string[];
}
export interface ArmsComparison {
  /** Every arm that had a row: `off` first, then the others by name, whatever the order of the rows. */
  arms: string[];
  /** Task runs graded in EVERY arm: the common ground every rate is over. */
  pairs: number;
  /** Task runs left out because an arm was missing or did not grade them. */
  unpaired: number;
  perArm: Record<string, ArmResult>;
  /**
   * Per ARM, the same over TASKS (a task is solved by an arm when more than half of its graded repeats resolved). The repeats of one task are not independent, so the run-level interval above is narrower than the truth;
   * this one counts each task once.
   */
  perArmTasks: Record<string, ArmResult>;
  /** Every pair of arms, with the tasks only one of them solved. A task is solved by an arm when MORE than half of its graded repeats resolved (a tie is not solved). */
  discordant: ArmsDiscordance[];
}

const armOrder = (a: string, b: string): number => (a === b ? 0 : a === "off" ? -1 : b === "off" ? 1 : a < b ? -1 : 1);

/** Compares any number of arms over the runs graded in all of them. A run listed twice for one arm is refused. */
export function compareArms(input: readonly ArmRunRow[]): ArmsComparison {
  const arms = new Set<string>();
  const runs = new Map<string, { task: string; byArm: Map<string, boolean | undefined> }>();
  for (const row of input) {
    const arm = canonicalArm(row.arm);
    arms.add(arm);
    const key = JSON.stringify([row.task, row.repeat ?? 1]);
    const run = runs.get(key) ?? { task: row.task, byArm: new Map<string, boolean | undefined>() };
    if (run.byArm.has(arm)) throw new RangeError(`The ${arm} arm has two rows for one task run.`);
    run.byArm.set(arm, row.resolved);
    runs.set(key, run);
  }
  const names = [...arms].sort(armOrder);
  const resolved = new Map<string, number>(names.map((name) => [name, 0]));
  const solvedBy = new Map<string, Map<string, { graded: number; resolved: number }>>(names.map((name) => [name, new Map()]));
  let pairs = 0, unpaired = 0;
  for (const run of runs.values()) {
    const complete = names.every((name) => run.byArm.get(name) !== undefined);
    if (!complete) { unpaired += 1; continue; }
    pairs += 1;
    for (const name of names) {
      const ok = run.byArm.get(name) === true;
      if (ok) resolved.set(name, (resolved.get(name) ?? 0) + 1);
      const tally = solvedBy.get(name)!.get(run.task) ?? { graded: 0, resolved: 0 };
      tally.graded += 1;
      if (ok) tally.resolved += 1;
      solvedBy.get(name)!.set(run.task, tally);
    }
  }
  const perArm: Record<string, ArmResult> = {};
  for (const name of names) perArm[name] = result(resolved.get(name) ?? 0, pairs);
  const solved = (arm: string, task: string): boolean => { const t = solvedBy.get(arm)!.get(task); return t !== undefined && t.resolved * 2 > t.graded; };
  const tasks = [...new Set([...runs.values()].filter((run) => names.every((name) => run.byArm.get(name) !== undefined)).map((run) => run.task))].sort();
  const perArmTasks: Record<string, ArmResult> = {};
  for (const name of names) perArmTasks[name] = result(tasks.filter((task) => solved(name, task)).length, tasks.length);
  const discordant: ArmsDiscordance[] = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i]!, b = names[j]!;
      discordant.push({ a, b, onlyA: tasks.filter((task) => solved(a, task) && !solved(b, task)), onlyB: tasks.filter((task) => solved(b, task) && !solved(a, task)) });
    }
  }
  return { arms: names, pairs, unpaired, perArm, perArmTasks, discordant };
}


// ---------------------------------------------------------------------------------------------------------------------------
// The replay copy of a past task: what a copy is told about its memory. Never `live`.

/** The memory of a replay copy: none, or exactly one frozen snapshot. A copy never reads live memory. */
export const EvalCopyMemorySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z.object({ mode: z.literal("snapshot"), snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/) }).strict(),
]);
export type EvalCopyMemory = z.infer<typeof EvalCopyMemorySchema>;
