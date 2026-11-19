// Lessons replay (DECISIONS 38, 47, 49): the replay of past tasks with named memory arms, as a SANITY CHECK of the lesson pipelines, not proof. This file is the contract of its result rows and the pure
// report over them. It runs nothing, calls no model and reads no store.
//
// What the report does, in this order (DECISIONS 49):
//   1. The loaded-lesson difference between the two pipelines being compared (B and C). When they loaded nearly the same lessons the replay says nothing about the pipelines: the report prints a STOP
//      line and nothing more (unless the reader asks to continue; the line stays first). "Nearly the same" is `LOADED_DIFFERENCE_NEARLY_SAME`.
//   2. Pass rate per arm with Wilson 95% intervals over the runs graded in every arm; the tasks only one arm of a pair solved.
//   3. The same-mistake count (a graded run repeating a mistake a historical correction before that task already named), the learning cost per project-day, the final lesson set (size, duplicates,
//      contradictions) and the blind reviewer marks.
//   NO verdict, no winner, no recommendation and no pass/fail rule: the owner reads the numbers and decides.
//
// The grader is FIXED: every graded run names the grader (model and version) and how it graded (hidden tests, or a written rubric scored blind to the arm). Runs graded differently are refused, never compared.
import { z } from "zod";
import { ARM_NAME_ERROR, canonicalArm, compareArms, type ArmRunRow } from "./eval-memory.js";

/** Each task is run this many times in each arm (DECISIONS 49). */
export const REPLAY_REPEATS = 3;
/** The size of the replay set (DECISIONS 49): 40 to 60 past tasks. */
export const REPLAY_TASKS_MIN = 40;
export const REPLAY_TASKS_MAX = 60;
/** Two arms loaded "nearly the same" lessons when fewer than this share of their (task, lesson) loads differ. */
export const LOADED_DIFFERENCE_NEARLY_SAME = 0.1;

export const REPLAY_GRADED_BY = ["hidden_tests", "rubric"] as const;
export type ReplayGradedBy = (typeof REPLAY_GRADED_BY)[number];
export interface ReplayGrader { model: string; version: string }

const Id = z.string().trim().min(1).max(200);
export const ReplayGraderSchema = z.object({ model: Id.max(100), version: Id.max(100) }).strict();

/** One run of one task in one arm. Old two-arm rows (task, arm, resolved, repeat) read with the rest absent. */
export const ReplayRunRowSchema = z.object({
  task: Id,
  repeat: z.number().int().min(1).max(20).default(1),
  arm: z.string(),
  /** Whether the grader resolved the run; null: not graded (the run failed, was cancelled or retried). */
  resolved: z.boolean().nullable().default(null),
  grader: ReplayGraderSchema.nullable().default(null),
  gradedBy: z.enum(REPLAY_GRADED_BY).nullable().default(null),
  /** The content keys of the lessons loaded into the run (any stage), from its load records. */
  loaded: z.array(Id.max(100)).max(500).default([]),
  /** The historical corrections (their ids) the grader flagged as a mistake this run repeated. */
  mistakes: z.array(Id.max(100)).max(100).default([]),
  /** What the run itself cost, in US dollars; null when unpriced. */
  costUsd: z.number().min(0).max(100_000).nullable().default(null),
}).strict().superRefine((row, context) => {
  try { canonicalArm(row.arm); } catch { context.addIssue({ code: "custom", path: ["arm"], message: ARM_NAME_ERROR }); }
  if (row.resolved === null && (row.grader !== null || row.gradedBy !== null)) context.addIssue({ code: "custom", path: ["grader"], message: "a run that was not graded names no grader" });
});
export type ReplayRunRow = z.infer<typeof ReplayRunRowSchema>;

/** Reads result rows, old or new. Anything malformed is refused (nothing is skipped); the arm is made canonical. */
export function readReplayRunRows(raw: unknown): ReplayRunRow[] {
  if (!Array.isArray(raw)) throw new RangeError("Result rows are a list.");
  return raw.map((entry: unknown, index) => {
    const parsed = ReplayRunRowSchema.safeParse(entry);
    if (!parsed.success) throw new RangeError(`Row ${String(index)} is not a replay run: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
    return { ...parsed.data, arm: canonicalArm(parsed.data.arm) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// The fixed grader

/** Runs were graded by different graders, or one task was graded by tests in one arm and by a rubric in another. */
export class GraderMismatchError extends Error {
  constructor(message: string) { super(message); this.name = "GraderMismatchError"; }
}

const graderName = (grader: ReplayGrader | null): string => (grader === null ? "an unrecorded grader (old result)" : `${grader.model} ${grader.version}`);

/**
 * The one grader every graded run used: null when every graded run is an old row that recorded none. Refuses runs graded by different graders (or some by a recorded grader and some by none), and a task graded by
 * hidden tests in one arm and by a rubric in another.
 */
export function assertOneGrader(rows: readonly ReplayRunRow[]): ReplayGrader | null {
  const graded = rows.filter((row) => row.resolved !== null);
  const keyOf = (grader: ReplayGrader | null): string => (grader === null ? "none" : `${grader.model}\u0000${grader.version}`);
  const distinct = new Map<string, ReplayGrader | null>();
  for (const row of graded) distinct.set(keyOf(row.grader), row.grader);
  if (distinct.size > 1) {
    throw new GraderMismatchError(`The runs were graded by different graders (${[...distinct.values()].map(graderName).join("; ")}). Grade every run again with one grader before comparing them.`);
  }
  const methodOf = new Map<string, ReplayGradedBy | null>();
  for (const row of graded) {
    const known = methodOf.get(row.task);
    if (known !== undefined && known !== row.gradedBy) throw new GraderMismatchError(`Task ${row.task} was graded by ${known ?? "an unrecorded method"} in one arm and by ${row.gradedBy ?? "an unrecorded method"} in another. Grade it the same way in every arm.`);
    methodOf.set(row.task, row.gradedBy);
  }
  return [...distinct.values()][0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The loaded-lesson difference

export interface LoadedDifference {
  a: string;
  b: string;
  /** Both arms have COMPLETED (graded) runs on at least one common (task, repeat). */
  comparable: boolean;
  /** Runs completed in both arms (a task's repeat), and the tasks they cover. */
  completedPairs: number;
  tasksCompared: number;
  /** (task, lesson) loads made by both arms, by only `a`, by only `b`, over the completed pairs only. */
  identical: number;
  onlyA: number;
  onlyB: number;
  /** The share of (task, lesson) loads that only one arm made; null when no lesson was loaded by either. */
  differ: number | null;
  /** Of the completed pairs, in how many each arm loaded at least one lesson. */
  loadedRunsA: number;
  loadedRunsB: number;
  /** The arms loaded nothing at all. */
  nothingLoaded: boolean;
  /** (task, repeat) pairs the plan had in either arm, and the share of them that completed in both. A replay where fewer than `MIN_COMPLETED_PAIR_SHARE` of them did says too little to compare (a stall in one arm is not a loss for the other). */
  plannedPairs: number;
  /** Runs each arm left ungraded (a stalled plan, a failure, a grading that failed): their own outcome, never a pass or a miss. */
  ungradedA: number;
  ungradedB: number;
  /** Fewer than `MIN_COMPLETED_PAIR_SHARE` of the planned pairs completed in both arms. */
  thinPairs?: true;
  /** An arm that has runs in the results but none completed: it did not run, and nothing can be said of it. */
  armDidNotRun?: string;
  /** An arm that loaded no lesson on more than half of its completed runs: its pipeline gave the replay nothing to measure. */
  armLoadedNothing?: string;
  /** Fewer than LOADED_DIFFERENCE_NEARLY_SAME of the loads differ, or an arm did not run or loaded nothing, or nothing was loaded: the replay says nothing about the two pipelines, and the report stops. */
  nearlySame: boolean;
}

/**
 * Per completed (task, repeat) pair, the lessons each arm loaded; over a task, the union of its repeats. Lessons are compared by their content key, so a reworded lesson is a different one. Only runs that COMPLETED
 * in both arms count: an arm whose runs all failed is reported as not having run, never as having loaded "different" (nothing) lessons.
 */
/** The least share of the planned (task, repeat) pairs that must have completed in BOTH arms for the comparison to be reported. */
export const MIN_COMPLETED_PAIR_SHARE = 0.5;

export function loadedLessonDifference(rows: readonly ReplayRunRow[], a: string, b: string): LoadedDifference {
  const armA = canonicalArm(a), armB = canonicalArm(b);
  const mine = (arm: string): ReplayRunRow[] => rows.filter((row) => canonicalArm(row.arm) === arm);
  const rowsA = mine(armA), rowsB = mine(armB);
  const done = (list: ReplayRunRow[]): Map<string, ReplayRunRow> => new Map(list.filter((row) => row.resolved !== null).map((row) => [JSON.stringify([row.task, row.repeat]), row] as const));
  const doneA = done(rowsA), doneB = done(rowsB);
  const pairKey = (row: ReplayRunRow): string => JSON.stringify([row.task, row.repeat]);
  const plannedPairs = new Set([...rowsA, ...rowsB].map(pairKey)).size;
  const ungradedA = rowsA.filter((row) => row.resolved === null).length, ungradedB = rowsB.filter((row) => row.resolved === null).length;
  const base = { a: armA, b: armB, identical: 0, onlyA: 0, onlyB: 0, differ: null, loadedRunsA: 0, loadedRunsB: 0, nothingLoaded: false, completedPairs: 0, tasksCompared: 0, plannedPairs, ungradedA, ungradedB };
  // An arm with rows and no completed run did not run; an arm with no rows at all is just not part of these results.
  const armDidNotRun = rowsA.length > 0 && doneA.size === 0 ? armA : rowsB.length > 0 && doneB.size === 0 ? armB : undefined;
  if (armDidNotRun !== undefined) return { ...base, comparable: false, armDidNotRun, nearlySame: true };
  const keys = [...doneA.keys()].filter((key) => doneB.has(key));
  const perTaskA = new Map<string, Set<string>>(), perTaskB = new Map<string, Set<string>>();
  let loadedRunsA = 0, loadedRunsB = 0;
  for (const key of keys) {
    const left = doneA.get(key)!, right = doneB.get(key)!;
    if (left.loaded.length > 0) loadedRunsA += 1;
    if (right.loaded.length > 0) loadedRunsB += 1;
    perTaskA.set(left.task, new Set([...(perTaskA.get(left.task) ?? []), ...left.loaded]));
    perTaskB.set(right.task, new Set([...(perTaskB.get(right.task) ?? []), ...right.loaded]));
  }
  let identical = 0, onlyA = 0, onlyB = 0;
  for (const [task, lessonsA] of perTaskA) {
    const lessonsB = perTaskB.get(task)!;
    for (const key of lessonsA) if (lessonsB.has(key)) identical += 1; else onlyA += 1;
    for (const key of lessonsB) if (!lessonsA.has(key)) onlyB += 1;
  }
  const total = identical + onlyA + onlyB;
  const comparable = keys.length > 0;
  const differ = total === 0 ? null : (onlyA + onlyB) / total;
  const nothingLoaded = comparable && total === 0;
  const armLoadedNothing = !comparable ? undefined : loadedRunsA * 2 < keys.length ? armA : loadedRunsB * 2 < keys.length ? armB : undefined;
  const thinPairs = comparable && keys.length < plannedPairs * MIN_COMPLETED_PAIR_SHARE;
  return { a: armA, b: armB, comparable, completedPairs: keys.length, tasksCompared: perTaskA.size, identical, onlyA, onlyB, differ, loadedRunsA, loadedRunsB, nothingLoaded, plannedPairs, ungradedA, ungradedB, ...(armLoadedNothing === undefined ? {} : { armLoadedNothing }), ...(thinPairs ? { thinPairs: true as const } : {}),
    nearlySame: comparable && (nothingLoaded || armLoadedNothing !== undefined || thinPairs || (differ ?? 1) < LOADED_DIFFERENCE_NEARLY_SAME) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The report

/** What learning cost an arm, over the whole replay: building its lesson snapshots (reflector, curator, judge, or the consolidation pass). `off` costs 0. */
export interface ArmLearningCost {
  arm: string; /** null: this arm's learning cost was not measured (a pipeline read as of a date, not run). */ usd: number | null; calls: number | null;
  /** Lessons the pipeline proposed over the whole replay (active, pending or candidate at the end of each day, summed over days' last set), how many of them would have needed a person under the project's real rules (so were NOT delivered), how many the 80-lesson cap cut, and how many model calls failed and were left out. Absent: not recorded (an older result). */
  proposed?: number; needsPerson?: number; truncated?: number; droppedCalls?: number;
  /** Of the proposed lessons, how many had a code citation that could not be verified (they wait for a person under the live rule). */
  unverified?: number;
  /** Every way the arm's lessons were built differently from live (no embedder, citations unchecked, the lessons switch assumed on, ...). */
  overrides?: string[];
}
export interface ArmLessonSet { arm: string; size: number; duplicates: number; contradictions: number }
export interface ArmUsefulMarks { arm: string; size: number; marked: number; useful: number }
/** The repeat-mistake metric's own check of the grader's flags (`sameMistakeTwice` over the arm's frozen lessons). */
export interface ArmSameMistakeCheck { arm: string; confirmed: number; unjudged: number; split: { lessonLoaded: number; lessonNotLoaded: number; noLesson: number } }
/** Decision 47: what the replay was run under. */
export interface LearningCallsNote { lessonsSwitch: "off" | "on"; replayLearningCalls: number; snapshotBuilds: "explicit" }

export interface MeasureInput {
  rows: readonly ReplayRunRow[];
  /** The two pipelines whose loaded lessons are compared first (B and C). */
  compare: { b: string; c: string };
  /** Simulated project-days the replay covered, for the cost per project-day. */
  projectDays: number;
  learning: readonly ArmLearningCost[];
  lessonSets: readonly ArmLessonSet[];
  marks?: readonly ArmUsefulMarks[];
  sameMistakeChecks?: readonly ArmSameMistakeCheck[];
  learningCalls?: LearningCallsNote;
  /** Print everything even though the pipelines loaded nearly the same lessons; the STOP line stays first. */
  continueAnyway?: boolean;
}

export interface MeasureResults {
  /** Task runs graded in every arm, and runs left out. */
  pairs: number;
  unpaired: number;
  arms: Array<{ arm: string; runs: number; resolved: number; rate: number | null; low: number; high: number; /** The same over tasks: each task counted once (solved when most of its repeats resolved). */ tasks: { tasks: number; solved: number; rate: number | null; low: number; high: number } }>;
  discordant: Array<{ a: string; b: string; onlyA: string[]; onlyB: string[] }>;
  sameMistakes: Array<{ arm: string; runs: number; runsWithRepeat: number; repeats: number; confirmed: number | null; unjudged: number | null; split: ArmSameMistakeCheck["split"] | null }>;
  learningCost: Array<{ arm: string; usd: number | null; calls: number | null; projectDays: number; perProjectDay: number | null; proposed: number | null; needsPerson: number | null; unverified: number | null; truncated: number | null; droppedCalls: number | null }>;
  /** Per arm: the runs the plan had, how many were graded and how many were left ungraded (a stalled plan, a failure, a failed grading): their own outcome. */
  outcomes: Array<{ arm: string; runs: number; graded: number; ungraded: number }>;
  runCost: Array<{ arm: string; runs: number; meanUsd: number | null }>;
  lessonSets: ArmLessonSet[];
  usefulMarks: ArmUsefulMarks[];
}
export interface MeasureReport {
  version: 1;
  grader: ReplayGrader | null;
  loadedDifference: LoadedDifference;
  nearlySameLine: number;
  stopped: boolean;
  continuedAnyway: boolean;
  learningCalls?: LearningCallsNote;
  /** Every override in force, per arm, stated even when the report stops. */
  overrides?: Array<{ arm: string; overrides: string[] }>;
  results?: MeasureResults;
}

/** Builds the report. Refuses runs graded differently (`GraderMismatchError`) and rows that name one run twice. Reports numbers only: it never says which arm to choose. */
export function buildMeasureReport(input: MeasureInput): MeasureReport {
  const grader = assertOneGrader(input.rows);
  const loadedDifference = loadedLessonDifference(input.rows, input.compare.b, input.compare.c);
  const stopped = loadedDifference.nearlySame;
  const base: MeasureReport = { version: 1, grader, loadedDifference, nearlySameLine: LOADED_DIFFERENCE_NEARLY_SAME, stopped, continuedAnyway: stopped && input.continueAnyway === true, ...(input.learningCalls === undefined ? {} : { learningCalls: input.learningCalls }),
    ...(input.learning.some((cost) => (cost.overrides ?? []).length > 0) ? { overrides: input.learning.filter((cost) => (cost.overrides ?? []).length > 0).map((cost) => ({ arm: canonicalArm(cost.arm), overrides: cost.overrides! })) } : {}) };
  if (stopped && input.continueAnyway !== true) return base;

  const armRows: ArmRunRow[] = input.rows.map((row) => ({ task: row.task, repeat: row.repeat, arm: row.arm, resolved: row.resolved ?? undefined }));
  const comparison = compareArms(armRows);
  const runKey = (row: ReplayRunRow): string => JSON.stringify([row.task, row.repeat]);
  const gradedIn = new Map<string, Set<string>>();
  for (const row of input.rows) if (row.resolved !== null) gradedIn.set(runKey(row), (gradedIn.get(runKey(row)) ?? new Set<string>()).add(canonicalArm(row.arm)));
  const common = new Set([...gradedIn].filter(([, arms]) => comparison.arms.every((arm) => arms.has(arm))).map(([key]) => key));

  const checks = new Map((input.sameMistakeChecks ?? []).map((check) => [canonicalArm(check.arm), check] as const));
  const costs = new Map(input.learning.map((cost) => [canonicalArm(cost.arm), cost] as const));
  const days = Math.max(1, Math.round(input.projectDays));
  const results: MeasureResults = {
    pairs: comparison.pairs, unpaired: comparison.unpaired,
    arms: comparison.arms.map((arm) => { const t = comparison.perArmTasks[arm]!; return { arm, ...comparison.perArm[arm]!, tasks: { tasks: t.runs, solved: t.resolved, rate: t.rate, low: t.low, high: t.high } }; }),
    discordant: comparison.discordant,
    sameMistakes: comparison.arms.map((arm) => {
      const mine = input.rows.filter((row) => canonicalArm(row.arm) === arm && common.has(runKey(row)));
      const check = checks.get(arm);
      return {
        arm, runs: mine.length, runsWithRepeat: mine.filter((row) => row.mistakes.length > 0).length, repeats: mine.reduce((sum, row) => sum + new Set(row.mistakes).size, 0),
        confirmed: check?.confirmed ?? null, unjudged: check?.unjudged ?? null, split: check?.split ?? null,
      };
    }),
    learningCost: comparison.arms.map((arm) => {
      const cost = costs.get(arm);
      return { arm, usd: cost?.usd ?? null, calls: cost?.calls ?? null, projectDays: days, perProjectDay: cost?.usd === undefined || cost.usd === null ? null : cost.usd / days,
        proposed: cost?.proposed ?? null, needsPerson: cost?.needsPerson ?? null, unverified: cost?.unverified ?? null, truncated: cost?.truncated ?? null, droppedCalls: cost?.droppedCalls ?? null };
    }),
    outcomes: comparison.arms.map((arm) => {
      const mine = input.rows.filter((row) => canonicalArm(row.arm) === arm);
      return { arm, runs: mine.length, graded: mine.filter((row) => row.resolved !== null).length, ungraded: mine.filter((row) => row.resolved === null).length };
    }),
    runCost: comparison.arms.map((arm) => {
      const priced = input.rows.filter((row) => canonicalArm(row.arm) === arm && row.costUsd !== null);
      return { arm, runs: priced.length, meanUsd: priced.length === 0 ? null : priced.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) / priced.length };
    }),
    lessonSets: input.lessonSets.map((set) => ({ ...set, arm: canonicalArm(set.arm) })),
    usefulMarks: (input.marks ?? []).map((mark) => ({ ...mark, arm: canonicalArm(mark.arm) })),
  };
  return { ...base, results };
}

const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const usd = (value: number | null): string => (value === null ? "not recorded" : `$${value.toFixed(value < 1 ? 3 : 2)}`);
const list = (ids: readonly string[]): string => (ids.length === 0 ? "none" : ids.join(", "));

/** The report in plain words. It states numbers and what they mean; it never says which pipeline to keep. */
export function renderMeasureReport(report: MeasureReport): string {
  const d = report.loadedDifference;
  const out: string[] = [];
  out.push("Lessons replay: a sanity check of the lesson pipelines, not proof. The owner decides.");
  out.push("");
  out.push(`1. Did ${d.a} and ${d.b} load different lessons?`);
  if (d.armDidNotRun !== undefined) out.push(`   ${d.armDidNotRun} has runs in the results but none completed: it did not run.`);
  else if (!d.comparable) out.push(`   Not comparable: no run completed in both ${d.a} and ${d.b}.`);
  else {
    out.push(`   Over ${String(d.completedPairs)} runs completed in both arms (${String(d.tasksCompared)} tasks), ${String(d.identical)} (task, lesson) loads were the same in both, ${String(d.onlyA)} only in ${d.a}, ${String(d.onlyB)} only in ${d.b}: ${pct(d.differ)} differ.`);
    out.push(`   Runs that loaded at least one lesson: ${d.a} ${String(d.loadedRunsA)} of ${String(d.completedPairs)}, ${d.b} ${String(d.loadedRunsB)} of ${String(d.completedPairs)}.`);
    out.push(`   Runs left ungraded (a stalled plan, a failure): ${d.a} ${String(d.ungradedA)}, ${d.b} ${String(d.ungradedB)} of ${String(d.plannedPairs)} planned.`);
    out.push(`   "Nearly the same" means fewer than ${String(report.nearlySameLine * 100)}% of the loads differ. Lessons are matched by their words, so a reworded lesson counts as different.`);
  }
  if (report.stopped) {
    out.push(d.armDidNotRun !== undefined
      ? `   STOP: ${d.armDidNotRun} did not run (every run of it failed or went ungraded). The replay says nothing about the two pipelines.`
      : d.thinPairs === true
        ? `   STOP: only ${String(d.completedPairs)} of ${String(d.plannedPairs)} planned runs completed in both arms (ungraded: ${d.a} ${String(d.ungradedA)}, ${d.b} ${String(d.ungradedB)}); fewer than ${String(MIN_COMPLETED_PAIR_SHARE * 100)}% is too few to compare. The replay says nothing about the two pipelines.`
      : d.armLoadedNothing !== undefined
        ? `   STOP: ${d.armLoadedNothing} loaded no lesson on more than half of its completed runs. The replay says nothing about the two pipelines.`
        : d.nothingLoaded
          ? `   STOP: neither ${d.a} nor ${d.b} loaded any lesson. The replay says nothing about the two pipelines.`
          : `   STOP: ${d.a} and ${d.b} loaded nearly the same lessons. The replay says nothing about the two pipelines.`);
    if (!report.continuedAnyway) out.push("   Nothing further is reported. Run the report again with --continue-anyway to see the rest.");
  }
  if (report.learningCalls !== undefined) {
    const calls = report.learningCalls;
    out.push("");
    out.push(`Learning calls (decision 47): lessons switch: ${calls.lessonsSwitch}; replays made ${String(calls.replayLearningCalls)} learning calls; lesson snapshots were built by the harness with the learning calls named in the plan (${calls.snapshotBuilds}), not by the install.`);
  }
  if (report.overrides !== undefined) {
    out.push("");
    out.push("Overrides in force (how this replay differs from live):");
    for (const o of report.overrides) out.push(`   ${o.arm}: ${o.overrides.join("; ")}`);
  }
  const results = report.results;
  if (results !== undefined) {
    out.push("");
    out.push(`Grader: ${report.grader === null ? "not recorded (old result)" : `${report.grader.model} ${report.grader.version}`}, the same for every graded run.`);
    out.push("");
    out.push("Runs by outcome (a stalled or failed run is ungraded: neither a pass nor a miss):");
    for (const o of results.outcomes) out.push(`   ${o.arm}: ${String(o.runs)} runs, ${String(o.graded)} graded, ${String(o.ungraded)} ungraded`);
    out.push("");
    out.push(`2. Pass rate, with a 95% interval (Wilson), over ${String(results.pairs)} runs graded in every arm (${String(results.unpaired)} runs left out). With this many tasks luck moves a rate by more than 10 points, so read the intervals, not the middle numbers.`);
    for (const arm of results.arms) out.push(`   ${arm.arm}: ${String(arm.resolved)} of ${String(arm.runs)} = ${pct(arm.rate)} (95% interval ${pct(arm.low)} to ${pct(arm.high)}); by task (the repeats of a task are not independent, so this interval is the honest one): ${String(arm.tasks.solved)} of ${String(arm.tasks.tasks)} = ${pct(arm.tasks.rate)} (95% interval ${pct(arm.tasks.low)} to ${pct(arm.tasks.high)})`);
    out.push("");
    out.push("   Tasks only one arm of a pair solved (more than half of its repeats resolved):");
    for (const pair of results.discordant) out.push(`   ${pair.a} against ${pair.b}: only ${pair.a} solved ${String(pair.onlyA.length)} (${list(pair.onlyA)}); only ${pair.b} solved ${String(pair.onlyB.length)} (${list(pair.onlyB)})`);
    out.push("");
    out.push("3. Same mistake: runs that repeated a mistake a historical correction before that task had already named.");
    for (const m of results.sameMistakes) {
      const checked = m.confirmed === null ? "" : `; the repeat-mistake metric confirmed ${String(m.confirmed)} (lesson loaded ${String(m.split?.lessonLoaded ?? 0)}, lesson not loaded ${String(m.split?.lessonNotLoaded ?? 0)}, no lesson ${String(m.split?.noLesson ?? 0)}; unjudged ${String(m.unjudged ?? 0)})`;
      out.push(`   ${m.arm}: ${String(m.runsWithRepeat)} of ${String(m.runs)} runs, ${String(m.repeats)} repeated mistakes${checked}`);
    }
    out.push("");
    out.push(`4. Learning cost per project-day (over ${String(results.learningCost[0]?.projectDays ?? 0)} simulated days), and the mean cost of a run:`);
    for (const cost of results.learningCost) {
      const run = results.runCost.find((r) => r.arm === cost.arm);
      out.push(`   ${cost.arm}: learning ${usd(cost.perProjectDay)} per project-day (${usd(cost.usd)} in ${cost.calls === null ? "an unrecorded number of" : String(cost.calls)} calls); a run cost ${usd(run?.meanUsd ?? null)} on average`);
      if (cost.proposed !== null) out.push(`      lessons proposed ${String(cost.proposed)}: ${String(cost.needsPerson ?? 0)} would have needed a person under the project's rules and were not delivered (${String(cost.unverified ?? 0)} had a citation that could not be verified); ${String(cost.truncated ?? 0)} cut at the ${String(80)}-lesson cap; ${String(cost.droppedCalls ?? 0)} model calls failed and were left out`);
    }
    out.push("");
    out.push("5. The final lesson set:");
    if (results.lessonSets.length === 0) out.push("   not recorded");
    for (const set of results.lessonSets) out.push(`   ${set.arm}: ${String(set.size)} lessons, ${String(set.duplicates)} duplicates, ${String(set.contradictions)} unresolved contradictions`);
    out.push("");
    out.push("6. Lessons a reviewer marked useful (blind to the arm):");
    if (results.usefulMarks.length === 0) out.push("   no marks imported yet");
    for (const mark of results.usefulMarks) out.push(`   ${mark.arm}: ${String(mark.useful)} useful of ${String(mark.marked)} marked (${String(mark.size)} lessons in the set)`);
  }
  out.push("");
  out.push("This report states numbers only. It sets no pass line and names no arm to keep. The owner decides.");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------
// The blind sheet

export interface BlindLesson { arm: string; title: string; body: string }
export interface BlindSheet { items: Array<{ id: string; title: string; body: string }> }
/** The key to a sheet: for each id, the arms whose final lesson set held that lesson. Kept apart from the sheet and never given to the reviewer. */
export type BlindKey = Record<string, { arms: string[] }>;
export interface BlindMark { id: string; useful: boolean | null }

const normalised = (lesson: BlindLesson): string => `${lesson.title}\n${lesson.body}`.toLowerCase().replace(/\s+/gu, " ").trim();
function seedOf(seed: string): number {
  let h = 0x811c9dc5;
  for (const ch of seed) { h ^= ch.codePointAt(0) ?? 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function randomFrom(seed: string): () => number {
  let a = seedOf(seed);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The reviewer's sheet: each distinct lesson once (a lesson two arms share is one item and counts for both), under an opaque id, in an order that depends only on the seed and the lessons, never on the arm that
 * held them. The sheet shows no arm, pipeline or lesson id. The key says which arms held each item.
 */
export function blindSheet(lessons: readonly BlindLesson[], seed: string): { sheet: BlindSheet; key: BlindKey } {
  const groups = new Map<string, { title: string; body: string; arms: Set<string> }>();
  for (const lesson of lessons) {
    const key = normalised(lesson);
    const group = groups.get(key) ?? { title: lesson.title, body: lesson.body, arms: new Set<string>() };
    group.arms.add(canonicalArm(lesson.arm));
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, group]) => group);
  const random = randomFrom(seed);
  for (let i = ordered.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]; }
  const items: BlindSheet["items"] = [];
  const key: BlindKey = {};
  ordered.forEach((group, index) => {
    const id = `R${String(index + 1).padStart(3, "0")}`;
    items.push({ id, title: group.title, body: group.body });
    key[id] = { arms: [...group.arms].sort() };
  });
  return { sheet: { items }, key };
}

/** Reads the reviewer's marks back against the key. A mark for an unknown id, an id marked twice, or a mark that is not true, false or null is refused. */
export function importMarks(key: BlindKey, marks: readonly BlindMark[]): ArmUsefulMarks[] {
  const seen = new Set<string>();
  const byArm = new Map<string, ArmUsefulMarks>();
  for (const [, entry] of Object.entries(key)) for (const arm of entry.arms) { if (!byArm.has(arm)) byArm.set(arm, { arm, size: 0, marked: 0, useful: 0 }); byArm.get(arm)!.size += 1; }
  for (const mark of marks) {
    const entry = key[mark.id];
    if (entry === undefined) throw new RangeError(`The sheet has no item ${String(mark.id)}.`);
    if (seen.has(mark.id)) throw new RangeError(`Item ${mark.id} is marked twice.`);
    seen.add(mark.id);
    if (mark.useful !== true && mark.useful !== false && mark.useful !== null) throw new RangeError(`Item ${mark.id} is marked with something other than true, false or null.`);
    if (mark.useful === null) continue;
    for (const arm of entry.arms) { const tally = byArm.get(arm)!; tally.marked += 1; if (mark.useful) tally.useful += 1; }
  }
  return [...byArm.values()].sort((a, b) => (a.arm < b.arm ? -1 : 1));
}
