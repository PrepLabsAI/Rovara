// TE-E0 option A, slice A3: the marked checks on one pull request head, as a merge-tracking pass sees them. For each check the customer marked (settings, read through a port: Cloud stores them), the
// pass finds the run that speaks for the head, reads its run attempt and times once (the runner's `runFacts`, only for a run it has not read before), puts it on the marked check's own clock (learned
// from past runs, never above the cap) and keeps one entry per marked check on the tracking item. Nothing here holds a machine: the pass is a poll, and the entry says when to look again.
// When a marked check failed or timed out, the verdict (environment, ask, fix within the cap) is worked out here, with the main branch's latest run of the same check read once, for the CI slot to act on.
import {
  CI_FIX_ROUNDS_MAX, parseCiEvidenceSettings, realCheckLine,
  type ChangeRequestRef, type ChangeRequestStatus, type CheckRunner, type CodeHost, type DocumentStore, type OrgId, type CheckTarget, type CiEvidenceSettings, type HostScope, type MarkedCheck, type MarkedCheckEntry, type MergeTrackingItem, type ReadBudget,
} from "@agentx/contracts";
import { currentRun, expectedWaitMs, waitCapMs, isMarked, markedCheckState, type MarkedRun, type MarkedState } from "./marked-checks.js";
import { decideMarkedCheck, type MainRun, type MarkedVerdict } from "./fix-or-ask.js";
import { durationsOf, readCheckTimes, recordCheckTimes } from "./history.js";
import type { FailingCheck } from "../branch-sync/merge-action.js";

export type MarkedEntry = MarkedCheckEntry;

/** The errors a pass must not swallow (the host's rate limit, the pass's allowance): named, so this module needs no import of the pass. */
const PASS_LIMIT_NAMES: ReadonlySet<string> = new Set(["TrackingRequestCapError", "GithubBudgetExhaustedError", "GithubMergeRateLimitError", "HostRateLimitError"]);
const isPassLimit = (error: unknown): boolean => error instanceof Error && (PASS_LIMIT_NAMES.has(error.name) || (error as { retryAt?: unknown }).retryAt !== undefined);

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : undefined;
};

/** The entry a state is kept as. */
function entryOf(marked: MarkedCheck, state: MarkedState, run: MarkedRun | undefined, prior: MarkedEntry | undefined): MarkedEntry {
  const base = { name: marked.name, ...(marked.source === undefined ? {} : { source: marked.source }) };
  const runPart = run === undefined ? {} : {
    ...(run.check.runId === undefined ? {} : { runId: run.check.runId }),
    ...(run.attempt === undefined ? {} : { attempt: run.attempt }),
    ...(run.startedAt === undefined ? {} : { startedAt: iso(run.startedAt) }),
    ...(run.completedAt === undefined ? {} : { completedAt: iso(run.completedAt) }),
    ...(run.check.url === "" ? {} : { url: run.check.url }),
  };
  const kept = prior?.announced === true && prior.state === state.kind && prior.runId === run?.check.runId ? { announced: true as const } : {};
  if (state.kind === "waiting") return { ...base, state: "waiting", until: iso(state.until), expectedMs: state.expectedMs, ...runPart };
  if (state.kind === "not_run") return { ...base, state: "not_run", reason: state.reason, ...(state.afterMs === undefined ? {} : { afterMs: state.afterMs }), ...runPart };
  return { ...base, state: state.kind, ...runPart, ...kept };
}

/**
 * The marked checks' entries for this head. `waitStart` is when the wait for this head began (Rovara's push of it, or the first time a person's head was seen). `history` gives a check's past durations.
 * Facts already read for the same run on the same head are reused from `prior`; a run read for the first time asks the runner once. A runner that cannot say gives no attempt (the line says so), never a guess.
 */
export async function observeMarked(input: {
  settings: CiEvidenceSettings;
  status: ChangeRequestStatus;
  prior: MergeTrackingItem | undefined;
  waitStart: number;
  now: number;
  history: (check: MarkedCheck) => readonly number[];
  runner?: CheckRunner | undefined;
  target: CheckTarget;
  scope: HostScope;
  budget?: ReadBudget | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}): Promise<{ entries: MarkedEntry[]; recheckAt?: number }> {
  const priorEntries = input.prior?.headSha === input.status.headRevision ? input.prior.ciMarked ?? [] : [];
  const entries: MarkedEntry[] = [];
  let recheckAt: number | undefined;
  for (const marked of input.settings.markedChecks) {
    const prior = priorEntries.find((entry) => entry.name === marked.name && entry.source === marked.source);
    const runs: MarkedRun[] = [];
    for (const check of input.status.checks.filter((entry) => isMarked(marked, entry))) {
      const finished = check.state === "completed";
      const known = prior !== undefined && check.runId !== undefined && prior.runId === check.runId && prior.completedAt !== undefined;
      if (known) {
        runs.push({ check, ...(prior.attempt === undefined ? {} : { attempt: prior.attempt }), ...(ms(prior.startedAt) === undefined ? {} : { startedAt: ms(prior.startedAt)! }), completedAt: ms(prior.completedAt)! });
        continue;
      }
      if (!finished || check.runId === undefined || input.runner?.runFacts === undefined) { runs.push({ check }); continue; }
      try {
        const facts = await input.runner.runFacts(input.target, check, input.scope, input.budget);
        runs.push({ check, ...(facts?.attempt === undefined ? {} : { attempt: facts.attempt }), ...(ms(facts?.startedAt) === undefined ? {} : { startedAt: ms(facts?.startedAt)! }), ...(ms(facts?.completedAt) === undefined ? {} : { completedAt: ms(facts?.completedAt)! }) });
      } catch (error) {
        if (isPassLimit(error)) throw error;
        input.log?.("ci_evidence.run_facts_unreadable", { error: error instanceof Error ? error.name : "unknown" });
        runs.push({ check });
      }
    }
    const run = currentRun(marked, runs);
    const expectedMs = expectedWaitMs({ durationsMs: input.history(marked), expectedMinutes: marked.expectedMinutes, capMinutes: input.settings.waitCapMinutes });
    const state = markedCheckState({ run, waitStart: input.waitStart, expectedMs, capMs: waitCapMs(input.settings.waitCapMinutes), now: input.now });
    if (state.kind === "waiting") recheckAt = recheckAt === undefined ? state.until : Math.min(recheckAt, state.until);
    entries.push(entryOf(marked, state, run, prior));
  }
  return { entries, ...(recheckAt === undefined ? {} : { recheckAt }) };
}

/** The entries whose result landed on this pass: passed or failed now, and not already said for the same run. */
export const landedEntries = (entries: readonly MarkedEntry[]): MarkedEntry[] => entries.filter((entry) => (entry.state === "passed" || entry.state === "failed") && entry.announced !== true);

/** The most characters a pull request comment of Rovara's own may have (the code host refuses longer, and any `@` or control character). */
export const LANDED_LINE_MAX = 200;

/** The line a landed result is said with on the pull request: the shared words, with no `@` or control character, cut to fit (the customer's words are shortened first, never the run or the commit). */
export function landedLine(entry: MarkedEntry, marked: MarkedCheck, commit: string): string {
  const say = (calledAs: string, check: string): string => realCheckLine({ calledAs, check, outcome: entry.state === "passed" ? "passed" : "failed", attempt: entry.attempt, commit })
    .replace(/[\p{Cc}@]+/gu, " ").replace(/\s+/gu, " ").trim();
  const full = say(marked.calledAs, marked.name);
  if (full.length <= LANDED_LINE_MAX) return full;
  const short = say(Array.from(marked.calledAs).slice(0, 24).join(""), Array.from(marked.name).slice(0, 40).join(""));
  return short.length <= LANDED_LINE_MAX ? short : `${Array.from(short).slice(0, LANDED_LINE_MAX - 1).join("")}…`;
}

/** What the CI slot is told about the marked check that needs it: the first one, in the order the customer marked them, that is not passed or waiting. */
export interface MarkedDecision {
  name: string;
  calledAs: string;
  verdict: Exclude<MarkedVerdict, { kind: "none" } | { kind: "wait" }>;
  baseBranch: string;
  rerunUrl?: string | undefined;
}

/** The main branch's latest run of the check: red, green, or not known. A read that fails is "not known" (a pass limit goes up). */
export async function mainRunOf(input: { runner?: CheckRunner | undefined; repository: { url: string }; baseBranch: string; marked: MarkedCheck; scope: HostScope; budget?: ReadBudget | undefined }): Promise<MainRun> {
  if (input.runner?.latestCheck === undefined) return "unknown";
  try {
    const latest = await input.runner.latestCheck(input.repository, { branch: input.baseBranch }, { name: input.marked.name, ...(input.marked.source === undefined ? {} : { source: input.marked.source }) }, input.scope, input.budget);
    if (latest === undefined || latest.check.state !== "completed") return "unknown";
    if (latest.check.conclusion === "success") return "passed";
    return ["failure", "timed_out", "cancelled", "startup_failure", "error", "stale"].includes(latest.check.conclusion ?? "") ? "failed" : "unknown";
  } catch (error) {
    if (isPassLimit(error)) throw error;
    return "unknown";
  }
}

/**
 * The decision for the CI slot: the first marked check (in the customer's order) that failed or timed out, judged by `decideMarkedCheck`. The main branch's run is read only for a failed one. `roundsUsed` is the
 * task's CI fix rounds so far. Undefined when every marked check passed, is waiting, or was skipped.
 */
export async function markedDecision(input: {
  settings: CiEvidenceSettings; entries: readonly MarkedEntry[]; roundsUsed: number; baseBranch: string;
  runner?: CheckRunner | undefined; repository: { url: string }; scope: HostScope; budget?: ReadBudget | undefined; logReadable: (entry: MarkedEntry) => boolean;
}): Promise<MarkedDecision | undefined> {
  for (const marked of input.settings.markedChecks) {
    const entry = input.entries.find((candidate) => candidate.name === marked.name && candidate.source === marked.source);
    if (entry === undefined || (entry.state !== "failed" && !(entry.state === "not_run" && entry.reason === "timed_out"))) continue;
    const state: MarkedState = entry.state === "failed" ? { kind: "failed", run: { check: { name: marked.name, state: "completed", conclusion: "failure", required: false, url: entry.url ?? "" } } } : { kind: "not_run", reason: "timed_out", ...(entry.afterMs === undefined ? {} : { afterMs: entry.afterMs }) };
    const mainRun = entry.state === "failed" ? await mainRunOf({ runner: input.runner, repository: input.repository, baseBranch: input.baseBranch, marked, scope: input.scope, budget: input.budget }) : "unknown";
    const verdict = decideMarkedCheck({
      state, longOrPaid: marked.longOrPaid, testsRan: undefined, testsFailed: undefined, logShared: input.settings.shareLogs && input.logReadable(entry), mainRun, roundsUsed: input.roundsUsed, roundsMax: CI_FIX_ROUNDS_MAX,
    });
    if (verdict.kind === "none" || verdict.kind === "wait") continue;
    return { name: marked.name, calledAs: marked.calledAs, verdict, baseBranch: input.baseBranch, ...(entry.url === undefined ? {} : { rerunUrl: entry.url }) };
  }
  return undefined;
}

// ---- one tracking pass

/** The settings for a task, read through the pass's port and parsed at run time. A port that is absent, answers nothing, throws or answers what does not parse gives undefined (nothing marked). */
export async function readEvidenceSettings(deps: { ciEvidence?(task: never): unknown; log?(event: string, fields: Record<string, unknown>): void }, task: unknown): Promise<CiEvidenceSettings | undefined> {
  if (deps.ciEvidence === undefined) return undefined;
  let answer: unknown;
  try {
    answer = await (deps.ciEvidence as (task: unknown) => unknown)(task);
  } catch {
    deps.log?.("ci_evidence.settings_unreadable", {});
    return undefined;
  }
  if (answer === undefined) return undefined;
  const parsed = parseCiEvidenceSettings(answer);
  if (!parsed.ok) {
    deps.log?.("ci_evidence.settings_unreadable", {});
    return undefined;
  }
  return parsed.settings;
}

export interface CiEvidencePass {
  /** The fields the tracking item takes for the marked checks. */
  fields: { ciMarked: MarkedEntry[]; ciMarkedSince?: string };
  recheckAt?: number;
  /** The CI slot's decision about a marked check, when one failed or timed out. */
  decision?: MarkedDecision | undefined;
  /** The failing checks as the CI slot sees them: a marked check's log is not offered unless the customer turned logs on. */
  failing(failing: readonly FailingCheck[]): FailingCheck[];
  /** After the item is committed: each landed result told once on the pull request, and the finished runs' durations kept. Best effort, never throws. */
  afterCommit(): Promise<void>;
}

/**
 * The marked checks for one pass over one pull request: their entries (on `fields`, the item being written), the decision for the CI slot, and what to do after the commit. A landed result is written
 * `announced` in the same item as it is told, so a later pass never tells it again; a pull request comment that fails is not retried (at most once, never twice).
 */
export async function ciEvidencePass(input: {
  settings: CiEvidenceSettings;
  status: ChangeRequestStatus;
  prior: MergeTrackingItem | undefined;
  fields: Pick<MergeTrackingItem, "headSha" | "headByRovara" | "lastRovaraPushAt" | "baseBranch">;
  now: number;
  runner?: CheckRunner | undefined;
  ref: ChangeRequestRef;
  repository: { url: string };
  scope: HostScope;
  budget?: ReadBudget | undefined;
  store: Pick<DocumentStore, "get" | "put">;
  task: { orgId: OrgId; project: string };
  pullRequest: { repositoryId: string };
  host: { postComment?: CodeHost["postComment"] };
  roundsUsed: number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}): Promise<CiEvidencePass> {
  const head = input.status.headRevision;
  const rovaraStart = input.fields.headByRovara && input.fields.lastRovaraPushAt !== undefined ? Date.parse(input.fields.lastRovaraPushAt) : undefined;
  const priorSince = input.prior?.headSha === head && input.prior.ciMarkedSince !== undefined ? Date.parse(input.prior.ciMarkedSince) : undefined;
  const ownSince = priorSince !== undefined && Number.isFinite(priorSince) && priorSince <= input.now ? priorSince : input.now;
  const waitStart = rovaraStart !== undefined && Number.isFinite(rovaraStart) ? rovaraStart : ownSince;
  const times = await readCheckTimes(input.store, input.task.orgId, input.task.project, input.pullRequest.repositoryId);
  const observed = await observeMarked({
    settings: input.settings, status: input.status, prior: input.prior, waitStart, now: input.now, history: (check) => durationsOf(times, check), runner: input.runner,
    target: { kind: "change-request", ref: input.ref }, scope: input.scope, budget: input.budget, log: input.log,
  });
  const landed = landedEntries(observed.entries);
  const entries = observed.entries.map((entry) => (landed.includes(entry) ? { ...entry, announced: true as const } : entry));
  const logReadable = (entry: MarkedEntry): boolean => input.status.checks.some((check) => check.runId !== undefined && check.runId === entry.runId && check.logReadable === true);
  const decision = await markedDecision({
    settings: input.settings, entries, roundsUsed: input.roundsUsed, baseBranch: input.fields.baseBranch, runner: input.runner, repository: input.repository, scope: input.scope, budget: input.budget, logReadable,
  });
  const markedNames = input.settings.markedChecks;
  return {
    fields: { ciMarked: entries, ...(rovaraStart === undefined || !Number.isFinite(rovaraStart) ? { ciMarkedSince: new Date(ownSince).toISOString() } : {}) },
    ...(observed.recheckAt === undefined ? {} : { recheckAt: observed.recheckAt }),
    ...(decision === undefined ? {} : { decision }),
    failing: (failing) => failing.map((check) => {
      if (input.settings.shareLogs || !markedNames.some((marked) => isMarked(marked, check))) return check;
      const { logReadable: _dropped, ...rest } = check;
      void _dropped;
      return rest;
    }),
    async afterCommit() {
      for (const entry of landed) {
        const marked = input.settings.markedChecks.find((candidate) => candidate.name === entry.name && candidate.source === entry.source);
        if (marked === undefined || input.host.postComment === undefined) continue;
        try {
          await input.host.postComment(input.ref, landedLine(entry, marked, head), input.scope, input.budget);
        } catch (error) {
          if (isPassLimit(error)) return;
          input.log?.("ci_evidence.result_not_posted", { error: error instanceof Error ? error.name : "unknown" });
        }
      }
      const finished = landed.flatMap((entry) => {
        const started = ms(entry.startedAt);
        const completed = ms(entry.completedAt);
        return started === undefined || completed === undefined ? [] : [{ check: { name: entry.name, ...(entry.source === undefined ? {} : { source: entry.source }) }, durationMs: completed - started }];
      });
      await recordCheckTimes(input.store, { orgId: input.task.orgId, project: input.task.project, repositoryId: input.pullRequest.repositoryId, times, finished, keep: input.settings.markedChecks }, input.log);
    },
  };
}
