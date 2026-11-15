// TE-E0 option A, slice A3: the marked checks on one pull request head, as a merge-tracking pass sees them. For each check the customer marked (settings, read through a port: Cloud stores them), the
// pass finds the run that speaks for the head, reads its run attempt and times once (the runner's `runFacts`, only for a run it has not read before), puts it on the marked check's own clock (learned
// from past runs, never above the cap) and keeps one entry per marked check on the tracking item. Nothing here holds a machine: the pass is a poll, and the entry says when to look again.
// When a marked check failed or timed out, the verdict (environment, ask, fix within the cap) is worked out here, with the main branch's latest run of the same check read once, for the CI slot to act on.
import {
  CI_FIX_ROUNDS_MAX, MarkedCheckEntrySchema, PIPELINE_FAILURE_TEXTS_MAX, PIPELINE_REPORT_TESTS_MAX, PipelineReportSchema, parseCiEvidenceSettings, realCheckLine,
  PIPELINE_FAILURE_TEXT_TOTAL_MAX, type PipelineReportParser, type PipelineReportReading,
  type ChangeRequestRef, type ChangeRequestStatus, type CheckRunner, type CodeHost, type DocumentStore, type OrgId, type CheckTarget, type CiEvidenceSettings, type HostScope, type MarkedCheck, type MarkedCheckEntry, type MergeTrackingItem, type ReadBudget,
} from "@agentx/contracts";
import { currentRun, expectedWaitMs, waitCapMs, isMarked, markedCheckState, type MarkedRun, type MarkedState } from "./marked-checks.js";
import { pipelineProof, type PipelineTestOutcome } from "./change-proof.js";
import { LONG_CHECK_FIX_ROUNDS_MAX, decideMarkedCheck, type MainRun, type MarkedVerdict } from "./fix-or-ask.js";
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
    ...(run.workflowRunId === undefined ? {} : { workflowRunId: run.workflowRunId }),
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
      const known = finished && prior !== undefined && check.runId !== undefined && prior.runId === check.runId && (prior.state === "passed" || prior.state === "failed");
      if (known) {
        runs.push({ check, ...(prior.workflowRunId === undefined ? {} : { workflowRunId: prior.workflowRunId }), ...(prior.attempt === undefined ? {} : { attempt: prior.attempt }), ...(ms(prior.startedAt) === undefined ? {} : { startedAt: ms(prior.startedAt)! }), ...(ms(prior.completedAt) === undefined ? {} : { completedAt: ms(prior.completedAt)! }) });
        continue;
      }
      if (!finished || check.runId === undefined || input.runner?.runFacts === undefined) { runs.push({ check }); continue; }
      try {
        const facts = await input.runner.runFacts(input.target, check, input.scope, input.budget);
        runs.push({ check, ...(facts?.workflowRunId === undefined ? {} : { workflowRunId: facts.workflowRunId }), ...(facts?.attempt === undefined ? {} : { attempt: facts.attempt }), ...(ms(facts?.startedAt) === undefined ? {} : { startedAt: ms(facts?.startedAt)! }), ...(ms(facts?.completedAt) === undefined ? {} : { completedAt: ms(facts?.completedAt)! }) });
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
  const say = (calledAs: string, check: string): string => realCheckLine({ calledAs, check, outcome: entry.state === "passed" ? "passed" : "failed", attempt: entry.attempt, commit, counts: entry.counts, proven: entry.proven, flaky: entry.flaky?.length })
    .replace(/[\p{Cc}@]+/gu, " ").replace(/\s+/gu, " ").trim();
  const full = say(marked.calledAs, marked.name);
  if (full.length <= LANDED_LINE_MAX) return full;
  const short = say(Array.from(marked.calledAs).slice(0, 24).join(""), Array.from(marked.name).slice(0, 40).join(""));
  return short.length <= LANDED_LINE_MAX ? short : `${Array.from(short).slice(0, LANDED_LINE_MAX - 1).join("")}…`;
}

/** What the CI slot is told about the marked check that needs it: the first one, in the order the customer marked them, that is not passed or waiting. */
export interface MarkedDecision {
  /** The check failed and its per-test report is still being read: the CI slot does nothing about it on this pass (no fix, no question on half the facts). */
  pending?: true;
  name: string;
  calledAs: string;
  verdict: Exclude<MarkedVerdict, { kind: "none" } | { kind: "wait" }>;
  /** TE-E0 option B: the failed tests and their capped failure text from the pipeline's report (what a fix is based on when logs are off). */
  failedTests?: ReadonlyArray<{ id: string; text?: string | undefined }> | undefined;
  /** The fix rounds Rovara may try on its own for this check (2 for a long or paid one, else today's 3): a round past it, after a person's Retry, is not counted as one of them. */
  roundsMax: number;
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
  /** A failed run whose per-test report is still to be read (or read again): nothing is decided about it yet, so no fix or question is started on half the facts. */
  reportPending?: ((entry: MarkedEntry) => boolean) | undefined;
}): Promise<MarkedDecision | undefined> {
  for (const marked of input.settings.markedChecks) {
    const entry = input.entries.find((candidate) => candidate.name === marked.name && candidate.source === marked.source);
    if (entry === undefined || (entry.state !== "failed" && entry.state !== "not_run")) continue;
    if (entry.state === "failed" && input.reportPending?.(entry) === true) {
      return { pending: true, name: marked.name, calledAs: marked.calledAs, verdict: { kind: "ask", reason: "no_detail" }, roundsMax: CI_FIX_ROUNDS_MAX, baseBranch: input.baseBranch };
    }
    const state: MarkedState = entry.state === "failed" ? { kind: "failed", run: { check: { name: marked.name, state: "completed", conclusion: "failure", required: false, url: entry.url ?? "" } } } : { kind: "not_run", reason: entry.reason ?? "timed_out", ...(entry.afterMs === undefined ? {} : { afterMs: entry.afterMs }) };
    const mainRun = entry.state === "failed" ? await mainRunOf({ runner: input.runner, repository: input.repository, baseBranch: input.baseBranch, marked, scope: input.scope, budget: input.budget }) : "unknown";
    const verdict = decideMarkedCheck({
      state, longOrPaid: marked.longOrPaid,
      testsRan: entry.report === "read" && entry.counts !== undefined ? entry.counts.passed + entry.counts.failed + entry.counts.skipped : undefined,
      testsFailed: entry.report === "read" && entry.counts !== undefined ? entry.counts.failed : undefined, logShared: input.settings.shareLogs && input.logReadable(entry), mainRun, roundsUsed: input.roundsUsed, roundsMax: CI_FIX_ROUNDS_MAX,
    });
    if (verdict.kind === "none" || verdict.kind === "wait") continue;
    return { name: marked.name, calledAs: marked.calledAs, verdict, ...(entry.failedTests === undefined ? {} : { failedTests: entry.failedTests }), roundsMax: marked.longOrPaid ? Math.min(LONG_CHECK_FIX_ROUNDS_MAX, CI_FIX_ROUNDS_MAX) : CI_FIX_ROUNDS_MAX, baseBranch: input.baseBranch, ...(entry.url === undefined ? {} : { rerunUrl: entry.url }) };
  }
  return undefined;
}

const soonest = (left: number | undefined, right: number | undefined): number | undefined => (left === undefined ? right : right === undefined ? left : Math.min(left, right));

// ---- one tracking pass

/** What a settings read that failed gives: not "nothing marked" (that would treat a marked check as an ordinary one, and hand its log to a model), but "not known", so the pass is tried again. */
export const SETTINGS_UNKNOWN = "settings_unknown" as const;

/**
 * The settings for a task, read through the pass's port and parsed at run time. A port that is absent or answers nothing gives undefined (nothing marked), and so does an answer that does not parse (a
 * project's settings that are wrong are not marks). A port that throws gives `SETTINGS_UNKNOWN`: the caller does not run the pass on a guess.
 */
export async function readEvidenceSettings(deps: { ciEvidence?(task: never): unknown; log?(event: string, fields: Record<string, unknown>): void }, task: unknown): Promise<CiEvidenceSettings | typeof SETTINGS_UNKNOWN | undefined> {
  if (deps.ciEvidence === undefined) return undefined;
  let answer: unknown;
  try {
    answer = await (deps as { ciEvidence(task: unknown): unknown }).ciEvidence(task);
  } catch {
    deps.log?.("ci_evidence.settings_unreadable", {});
    return SETTINGS_UNKNOWN;
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
  /**
   * The results to tell after a commit made on top of `current` (the item this commit attempt read): those landed on this pass that `current` does not already hold as told for the same run. A racing pass
   * that committed first already told them, so a retry never tells them twice.
   */
  toTell(current: MergeTrackingItem | undefined): MarkedEntry[];
  /** After the item is committed: the given results told once on the pull request, and their durations kept. Best effort; a host limit ends it quietly (the line is not retried: at most once). */
  afterCommit(told: readonly MarkedEntry[]): Promise<void>;
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
  /** TE-E0 option B: the host's report parser (absent: no per-test reports are read), and the commit the change is based on (for the change proof). */
  reportParser?: PipelineReportParser | undefined;
  baseCommit?: string | undefined;
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
  const withReported = await withReports(input, observed.entries);
  const reported = withReported.entries;
  const recheck = soonest(observed.recheckAt, withReported.recheckAt);
  // Every entry is checked against the item's schema before it is written: a value an adapter got wrong is left out, never stored where it would stop the next read.
  const valid = reported.map((entry) => {
    if (MarkedCheckEntrySchema.safeParse(entry).success) return entry;
    const { attempt: _attempt, startedAt: _started, completedAt: _completed, url: _url, ...rest } = entry;
    void _attempt; void _started; void _completed; void _url;
    return rest;
  }).filter((entry) => MarkedCheckEntrySchema.safeParse(entry).success);
  const landed = landedEntries(valid);
  const entries = valid.map((entry) => (landed.includes(entry) ? { ...entry, announced: true as const } : entry));
  const logReadable = (entry: MarkedEntry): boolean => input.status.checks.some((check) => check.runId !== undefined && check.runId === entry.runId && check.logReadable === true);
  const decision = await markedDecision({
    settings: input.settings, entries, roundsUsed: input.roundsUsed, baseBranch: input.fields.baseBranch, runner: input.runner, repository: input.repository, scope: input.scope, budget: input.budget, logReadable,
    reportPending: (entry) => reportsOn(input) && entry.workflowRunId !== undefined && (entry.report === undefined || ((entry.report === "none" || entry.report === "unreadable") && (entry.reportTries ?? 0) < REPORT_TRIES_MAX)),
  });
  const markedNames = input.settings.markedChecks;
  return {
    fields: { ciMarked: entries, ...(rovaraStart === undefined || !Number.isFinite(rovaraStart) ? { ciMarkedSince: new Date(ownSince).toISOString() } : {}) },
    ...(recheck === undefined ? {} : { recheckAt: recheck }),
    ...(decision === undefined ? {} : { decision }),
    failing: (failing) => failing.map((check) => {
      if (input.settings.shareLogs || !markedNames.some((marked) => isMarked(marked, check))) return check;
      const { logReadable: _dropped, ...rest } = check;
      void _dropped;
      return rest;
    }),
    toTell(current) {
      const held = current?.headSha === head ? current.ciMarked ?? [] : [];
      return landed.filter((entry) => !held.some((other) => other.announced === true && other.name === entry.name && other.source === entry.source && other.state === entry.state && other.runId === entry.runId));
    },
    async afterCommit(told) {
      for (const entry of told) {
        const marked = input.settings.markedChecks.find((candidate) => candidate.name === entry.name && candidate.source === entry.source);
        if (marked === undefined || input.host.postComment === undefined) continue;
        try {
          await input.host.postComment(input.ref, landedLine(entry, marked, head), input.scope, input.budget);
        } catch (error) {
          if (isPassLimit(error)) return;
          input.log?.("ci_evidence.result_not_posted", { error: error instanceof Error ? error.name : "unknown" });
        }
      }
      const finished = told.flatMap((entry) => {
        const started = ms(entry.startedAt);
        const completed = ms(entry.completedAt);
        return started === undefined || completed === undefined ? [] : [{ check: { name: entry.name, ...(entry.source === undefined ? {} : { source: entry.source }) }, durationMs: completed - started }];
      });
      await recordCheckTimes(input.store, { orgId: input.task.orgId, project: input.task.project, repositoryId: input.pullRequest.repositoryId, times, finished, keep: input.settings.markedChecks }, input.log);
    },
  };
}

// ---- per-test reports (TE-E0 option B)

/** One run's per-test outcomes, as the report parser read them; `none`, `unreadable` or `ambiguous` when there is no report to read whole for this check. */
export type RunReport = { kind: "read"; commit: string; tests: Map<string, PipelineTestOutcome>; failed: Array<{ id: string; text?: string }> } | { kind: "none" } | { kind: "unreadable" } | { kind: "ambiguous" };

/**
 * The per-test report of one workflow run made since `since`: every report file the runner hands out, read through the host's parser. A file that is not a test report is left out; one that claims to be
 * and could not be read whole makes the whole run `unreadable` (never a partial report). More tests than the cap is `unreadable`. The same test in two files: a failure wins. Failure text is cut to one
 * total for the run.
 */
export async function readRunReport(input: { runner: CheckRunner; parser: PipelineReportParser; repository: { url: string }; workflowRunId: string; commit: string; since?: string | undefined; scope: HostScope; budget?: ReadBudget | undefined }): Promise<RunReport> {
  const files = await input.runner.reportFiles!(input.repository, input.workflowRunId, input.scope, input.budget, input.since === undefined ? {} : { since: input.since });
  if (files.kind !== "read") return files;
  const tests = new Map<string, PipelineTestOutcome>();
  const failed = new Map<string, string | undefined>();
  let read = 0;
  for (const file of files.files) {
    let reading: PipelineReportReading;
    try {
      reading = input.parser(file.text);
    } catch {
      return { kind: "unreadable" };
    }
    if (reading === null || typeof reading !== "object" || reading.kind === "not_report") continue;
    if (reading.kind !== "report") return { kind: "unreadable" };
    const parsed = PipelineReportSchema.safeParse(reading.report);
    if (!parsed.success) return { kind: "unreadable" };
    read += 1;
    for (const test of parsed.data.tests) {
      const before = tests.get(test.id);
      tests.set(test.id, before === "failed" || test.outcome === "failed" ? "failed" : test.outcome === "passed" || before === "passed" ? "passed" : "skipped");
      if (test.outcome === "failed" && !failed.has(test.id)) failed.set(test.id, test.failureText);
      if (tests.size > PIPELINE_REPORT_TESTS_MAX) return { kind: "unreadable" };
    }
  }
  if (read === 0) return { kind: "none" };
  let budget = PIPELINE_FAILURE_TEXT_TOTAL_MAX;
  const kept = [...failed].slice(0, PIPELINE_FAILURE_TEXTS_MAX).map(([id, text]) => {
    const cut = text === undefined || budget <= 0 ? undefined : Array.from(text).slice(0, budget).join("");
    if (cut !== undefined) budget -= cut.length;
    return { id: Array.from(id).slice(0, 300).join(""), ...(cut === undefined || cut === "" ? {} : { text: cut }) };
  });
  return { kind: "read", commit: input.commit, tests, failed: kept };
}

/** What a run's report adds to its entry: the counts, the failed tests, the proof against the base run, and the tests that failed on an earlier run of this head and pass now. */
export function reportFields(input: { report: RunReport; base: RunReport | undefined; baseCommit: string | undefined; headCommit: string; earlierFailed: readonly string[] }): Partial<MarkedEntry> {
  const { report } = input;
  if (report.kind !== "read") return { report: report.kind };
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const outcome of report.tests.values()) counts[outcome] += 1;
  const proof = input.baseCommit === undefined ? undefined : pipelineProof({
    head: { commit: report.commit, tests: report.tests }, headCommit: input.headCommit,
    base: input.base?.kind === "read" ? { commit: input.base.commit, tests: input.base.tests } : undefined, baseCommit: input.baseCommit,
    // A test the base run did not have cannot have run on the old code there: it was added by the change, and keeps its sandbox proof.
    addedTests: input.base?.kind === "read" ? new Set([...report.tests.keys()].filter((id) => !(input.base as Extract<RunReport, { kind: "read" }>).tests.has(id))) : new Set(),
  });
  const flaky = input.earlierFailed.filter((id) => report.tests.get(id) === "passed").slice(0, 20).map((id) => Array.from(id).slice(0, 300).join(""));
  return {
    report: "read", counts,
    ...(report.failed.length === 0 ? {} : { failedTests: report.failed }),
    ...(proof === undefined || proof.noBase !== undefined ? {} : { proven: proof.proven.length, added: proof.addedByChange.length }),
    ...(flaky.length === 0 ? {} : { flaky }),
  };
}

/** Whether per-test reports are read for this pass: the customer left them on, and the host gave a parser and a runner that hands out report files. */
const reportsOn = (input: { settings: CiEvidenceSettings; reportParser?: PipelineReportParser | undefined; runner?: CheckRunner | undefined }): boolean =>
  input.settings.perTestReports && input.reportParser !== undefined && input.runner?.reportFiles !== undefined;

const REPORT_FIELDS = ["report", "reportTries", "counts", "proven", "added", "flaky", "failedTests"] as const;
/** Reports read on one pass: the reads cost requests from the pass's allowance, so the rest wait for the next pass (soon), never all at once. */
export const REPORT_READS_PER_PASS = 1;
/** Times a run's report is read again while it has nothing to keep (`none`/`unreadable`: a later job may still upload it, or a read failed). */
export const REPORT_TRIES_MAX = 3;
/** When a run whose report is still to be read is looked at again. */
export const REPORT_RETRY_MS = 60_000;
/** The most UTF-8 bytes of report text (failed test ids and failure text, flaky ids) all entries of one tracking item keep together. */
export const REPORT_TEXT_ITEM_BYTES_MAX = 32 * 1024;

const without = (entry: MarkedEntry): MarkedEntry => {
  const copy: Record<string, unknown> = { ...entry };
  for (const field of REPORT_FIELDS) delete copy[field];
  return copy as MarkedEntry;
};

/**
 * The entries with what their runs' per-test reports say. A report kept for the same run on this head is reused (read once per run); `none` and `unreadable` are read again up to `REPORT_TRIES_MAX`
 * times. At most `REPORT_READS_PER_PASS` runs are read on one pass; one left for later makes the pass look again soon. With per-test reports off (or no parser), nothing read is kept or used.
 */
async function withReports(input: Parameters<typeof ciEvidencePass>[0], entries: readonly MarkedEntry[]): Promise<{ entries: MarkedEntry[]; recheckAt?: number }> {
  const head = input.status.headRevision;
  const priorEntries = input.prior?.headSha === head ? input.prior.ciMarked ?? [] : [];
  const on = reportsOn(input);
  const out: MarkedEntry[] = [];
  let reads = 0;
  let recheckAt: number | undefined;
  for (const entry of entries) {
    if (!on || (entry.state !== "passed" && entry.state !== "failed")) { out.push(without(entry)); continue; }
    const prior = priorEntries.find((other) => other.name === entry.name && other.source === entry.source);
    const same = prior !== undefined && prior.runId === entry.runId ? prior : undefined;
    const settled = same?.report === "read" || same?.report === "ambiguous" || (same?.reportTries ?? 0) >= REPORT_TRIES_MAX;
    if (same !== undefined && same.report !== undefined && settled) {
      const kept: Partial<MarkedEntry> = {};
      for (const field of REPORT_FIELDS) if (same[field] !== undefined) (kept as Record<string, unknown>)[field] = same[field];
      out.push({ ...without(entry), ...kept });
      continue;
    }
    if (entry.workflowRunId === undefined) { out.push(without(entry)); continue; }
    if (reads >= REPORT_READS_PER_PASS) {
      // Left for the next pass; what an earlier try found (if anything) stays as it was.
      out.push(same?.report === undefined ? without(entry) : { ...without(entry), report: same.report, ...(same.reportTries === undefined ? {} : { reportTries: same.reportTries }) });
      recheckAt = input.now + REPORT_RETRY_MS;
      continue;
    }
    reads += 1;
    const tries = (same?.reportTries ?? 0) + 1;
    try {
      const report = await readRunReport({ runner: input.runner!, parser: input.reportParser!, repository: input.repository, workflowRunId: entry.workflowRunId, commit: head, since: entry.startedAt, scope: input.scope, budget: input.budget });
      const base = report.kind === "read" && input.baseCommit !== undefined && [...report.tests.values()].includes("passed")
        ? await baseReport({ runner: input.runner!, parser: input.reportParser!, repository: input.repository, baseCommit: input.baseCommit, check: { name: entry.name, ...(entry.source === undefined ? {} : { source: entry.source }) }, scope: input.scope, budget: input.budget })
        : undefined;
      const earlierFailed = prior !== undefined && prior.runId !== entry.runId ? (prior.failedTests ?? []).map((test) => test.id) : [];
      const fields = reportFields({ report, base, baseCommit: input.baseCommit, headCommit: head, earlierFailed });
      const retry = fields.report === "none" || fields.report === "unreadable";
      if (retry && tries < REPORT_TRIES_MAX) recheckAt = input.now + REPORT_RETRY_MS;
      out.push({ ...without(entry), ...fields, ...(retry ? { reportTries: tries } : {}) });
    } catch (error) {
      if (isPassLimit(error)) throw error;
      input.log?.("ci_evidence.report_unreadable", { error: error instanceof Error ? error.name : "unknown" });
      if (tries < REPORT_TRIES_MAX) recheckAt = input.now + REPORT_RETRY_MS;
      out.push({ ...without(entry), report: "unreadable", reportTries: tries });
    }
  }
  return { entries: capReportText(out), ...(recheckAt === undefined ? {} : { recheckAt }) };
}

/** Report text kept on one item stays within `REPORT_TEXT_ITEM_BYTES_MAX`: entries keep it in order while it fits; past it, failure text goes first, then the ids (the counts and proof stay). */
function capReportText(entries: readonly MarkedEntry[]): MarkedEntry[] {
  let left = REPORT_TEXT_ITEM_BYTES_MAX;
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
  return entries.map((entry) => {
    if (entry.failedTests === undefined && entry.flaky === undefined) return entry;
    const failedTests = (entry.failedTests ?? []).flatMap((test) => {
      const idBytes = bytes(test.id);
      if (idBytes > left) return [];
      left -= idBytes;
      if (test.text === undefined || bytes(test.text) > left) return [{ id: test.id }];
      left -= bytes(test.text);
      return [test];
    });
    const flaky = (entry.flaky ?? []).filter((id) => { const size = bytes(id); if (size > left) return false; left -= size; return true; });
    const { failedTests: _failed, flaky: _flaky, ...rest } = entry;
    void _failed; void _flaky;
    return { ...rest, ...(failedTests.length === 0 ? {} : { failedTests }), ...(flaky.length === 0 ? {} : { flaky }) };
  });
}

/** The base commit's latest run of the same check, and its report (read for free from what GitHub holds; Rovara never runs old code in the customer's environment). Undefined when there is none. */
async function baseReport(input: { runner: CheckRunner; parser: PipelineReportParser; repository: { url: string }; baseCommit: string; check: { name: string; source?: string }; scope: HostScope; budget?: ReadBudget | undefined }): Promise<RunReport | undefined> {
  if (input.runner.latestCheck === undefined || input.runner.runFacts === undefined) return undefined;
  const latest = await input.runner.latestCheck(input.repository, { revision: input.baseCommit }, input.check, input.scope, input.budget);
  if (latest === undefined || latest.revision !== input.baseCommit || latest.check.state !== "completed") return undefined;
  const facts = await input.runner.runFacts({ kind: "revision", repository: input.repository, revision: input.baseCommit }, latest.check, input.scope, input.budget);
  if (facts?.workflowRunId === undefined) return undefined;
  return readRunReport({ runner: input.runner, parser: input.parser, repository: input.repository, workflowRunId: facts.workflowRunId, commit: input.baseCommit, since: facts.startedAt, scope: input.scope, budget: input.budget });
}
