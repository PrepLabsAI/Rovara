// TE-E0 option A: a marked check's state on a head, on its own clock. A check the customer marked as running in their test environment (a deploy, a real model) can take far longer than the
// 15 minutes merge tracking gives a required check, so it is waited for as long as it usually takes (learned from past runs, never above the cap), with no sandbox machine held. When the wait ends
// with nothing reported, the check is "not run", never "failed": nothing answered. Pure: the caller passes the clock and the checks it read.
import { CI_EVIDENCE_LIMITS, type Check, type MarkedCheck, type NotRunReason } from "@agentx/contracts";

const MINUTE_MS = 60_000;
/** The shortest learned wait: a run that usually takes two minutes is still given this long before it is called "not run". */
export const EXPECTED_WAIT_FLOOR_MS = 10 * MINUTE_MS;
/** How many past durations a check's history keeps (the newest). */
export const DURATION_HISTORY_MAX = 20;
/** How many past durations are needed before the wait is learned from them; fewer, and the wait is the cap. */
export const DURATION_HISTORY_MIN = 3;
/** The longest duration that is believed (a value past it is a bad read, not a run). */
const DURATION_BELIEVED_MAX_MS = 2 * 24 * 60 * MINUTE_MS;
/** Headroom over the 90th percentile of past runs. */
const LEARNED_HEADROOM = 1.25;

/** The cap in milliseconds, from settings minutes; a value outside the settable range is the default (settings are parsed before, so this only guards a caller that skipped it). */
export function waitCapMs(capMinutes: number): number {
  const valid = Number.isSafeInteger(capMinutes) && capMinutes >= CI_EVIDENCE_LIMITS.waitCapMinutesMin && capMinutes <= CI_EVIDENCE_LIMITS.waitCapMinutesMax;
  return (valid ? capMinutes : CI_EVIDENCE_LIMITS.waitCapMinutesDefault) * MINUTE_MS;
}

/** Whether a duration is one a run could have taken. */
const believed = (ms: number): boolean => typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= DURATION_BELIEVED_MAX_MS;

/**
 * How long to wait for a marked check: the customer's own expected time when they gave one, else learned from past runs (the 90th percentile of the newest `DURATION_HISTORY_MAX` believable durations,
 * with a quarter more, at least `EXPECTED_WAIT_FLOOR_MS`), else the cap. Never above the cap.
 */
export function expectedWaitMs(input: { durationsMs: readonly number[]; expectedMinutes?: number | undefined; capMinutes: number }): number {
  const cap = waitCapMs(input.capMinutes);
  if (input.expectedMinutes !== undefined && Number.isSafeInteger(input.expectedMinutes) && input.expectedMinutes >= 1) return Math.min(input.expectedMinutes * MINUTE_MS, cap);
  const recent = input.durationsMs.slice(-DURATION_HISTORY_MAX).filter(believed);
  if (recent.length < DURATION_HISTORY_MIN) return cap;
  const sorted = [...recent].sort((left, right) => left - right);
  // Nearest rank: the smallest value with at least 90% of the values at or below it.
  const p90 = sorted[Math.ceil(0.9 * sorted.length) - 1]!;
  return Math.min(cap, Math.max(EXPECTED_WAIT_FLOOR_MS, Math.ceil(p90 * LEARNED_HEADROOM)));
}

/** The history with one more finished run's duration, the newest `DURATION_HISTORY_MAX` kept. A duration that cannot be a run is not kept. */
export function withDuration(history: readonly number[], durationMs: number): number[] {
  const kept = history.filter(believed);
  return believed(durationMs) ? [...kept, Math.round(durationMs)].slice(-DURATION_HISTORY_MAX) : kept.slice(-DURATION_HISTORY_MAX);
}

/** What GitHub said about one run of a check, with the run number and times when they were read. */
export interface MarkedRun {
  check: Check;
  /** The run attempt (1 for the first run, 2 for a re-run). Absent when it could not be read: the line then says so, never a plain pass. */
  attempt?: number | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

/** A marked check's state on one head. */
export type MarkedState =
  | { kind: "waiting"; until: number; expectedMs: number }
  | { kind: "passed"; attempt?: number | undefined; run: MarkedRun }
  | { kind: "failed"; attempt?: number | undefined; run: MarkedRun }
  | { kind: "not_run"; reason: NotRunReason; afterMs?: number | undefined };

const FAILED: ReadonlySet<string> = new Set(["failure", "timed_out", "cancelled", "startup_failure", "error", "stale"]);

/** Whether a check is the marked one: the same name, and the same reporting app when the mark names one. */
export const isMarked = (marked: Pick<MarkedCheck, "name" | "source">, check: Pick<Check, "name" | "source">): boolean =>
  check.name === marked.name && (marked.source === undefined || check.source === marked.source);

/**
 * The run of a marked check that speaks for the head, among every run reported with its name: one still running wins (a re-run in progress is not over), else the highest attempt, else the latest
 * finish; between runs that cannot be told apart, a failed one wins (never a pass read from a tie).
 */
export function currentRun(marked: Pick<MarkedCheck, "name" | "source">, runs: readonly MarkedRun[]): MarkedRun | undefined {
  const mine = runs.filter((run) => isMarked(marked, run.check));
  if (mine.length === 0) return undefined;
  const running = mine.find((run) => run.check.state !== "completed" || run.check.conclusion === "action_required");
  if (running !== undefined) return running;
  const rank = (run: MarkedRun): [number, number, number] => [run.attempt ?? 0, run.completedAt ?? 0, FAILED.has(run.check.conclusion ?? "") ? 1 : 0];
  return [...mine].sort((left, right) => {
    const [a, b] = [rank(left), rank(right)];
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  })[0];
}

/**
 * The marked check's state: passed or failed on its run, "not run" when the pipeline said skipped or neutral (a skip is not a pass: a pipeline that skips drafts says skipped), waiting while it runs or
 * has not reported and the wait has not ended, and "not run" (timed out) once it has: the wait starts at `waitStart` (Rovara's push of this head, or the first time a person's head was seen).
 */
export function markedCheckState(input: { run: MarkedRun | undefined; waitStart: number; expectedMs: number; now: number }): MarkedState {
  const { run } = input;
  if (run !== undefined && run.check.state === "completed" && run.check.conclusion !== "action_required") {
    const conclusion = run.check.conclusion ?? "";
    if (conclusion === "success") return { kind: "passed", ...(run.attempt === undefined ? {} : { attempt: run.attempt }), run };
    if (FAILED.has(conclusion)) return { kind: "failed", ...(run.attempt === undefined ? {} : { attempt: run.attempt }), run };
    return { kind: "not_run", reason: conclusion === "skipped" ? "skipped" : "neutral" };
  }
  const until = input.waitStart + input.expectedMs;
  if (input.now >= until) return { kind: "not_run", reason: "timed_out", afterMs: input.expectedMs };
  return { kind: "waiting", until, expectedMs: input.expectedMs };
}
