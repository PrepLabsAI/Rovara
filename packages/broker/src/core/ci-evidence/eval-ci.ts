// L4-EVCI (owner decision D7): the customer's OWN eval result on Rovara's pull request. One check of the customer's CI is named at setup as their eval (`CiEvidenceSettings.evalCheck`, confirmed
// by a maintainer: settings are the host's to store, as for the marked checks). When that check completes on the head, the pass keeps its result on the tracking item (`ciEval`, the marked-check entry shape, read
// with the same run facts and per-test report reader) and says it once as one line in the description, next to Rovara's own eval label: "Eval (reported by your CI): passed, <link>".
//
// ADVISORY ONLY. This is not a marked check: the pass never waits for it before a draft is taken out of draft, never starts a fix round or a question, never writes a comment, and never feeds the Rovara Check.
// Two verdicts, never one: Rovara's own eval word keeps its own rule; this line says what the customer's CI said and nothing else. No model reads anything here; the line is fixed words, numbers and a plain
// https address (the check's name, a test's name and a failure text are never printed).
import {
  MarkedCheckEntrySchema, change, evalCiLine, when,
  type ChangeRequestRef, type CheckRunner, type CiEvidenceSettings, type CodeHost, type DocumentStore, type EvalCheck, type EvalCiResult, type HostScope, type MarkedCheck, type MergeTrackingItem, type OrgId,
  type PipelineReportParser, type ReadBudget, type ChangeRequestStatus,
} from "@agentx/contracts";
import { pullRequestRecordKey, pullRequestRecordOf } from "../build-step/records.js";
import { workspaceKeys } from "../task-flow/workspace-location.js";
import { withEvalCiLine } from "../proof/pull-request-body.js";
import { REPORT_TRIES_MAX, isPassLimit, observeMarked, reportsOn, withReports, type MarkedEntry } from "./tracking.js";
import { waitCapMs } from "./marked-checks.js";

/** The eval check as the marked-check machinery reads it: matched by name (and reporting app), never waited for as a long or paid run. */
const asMarked = (check: EvalCheck): MarkedCheck => ({ name: check.name, ...(check.source === undefined ? {} : { source: check.source }), calledAs: "your eval", longOrPaid: false });

/** The result a finished entry stands for; undefined while the check is still running (nothing is said until the CI answers). */
export function evalResultOf(entry: MarkedEntry | undefined): EvalCiResult | undefined {
  if (entry === undefined) return undefined;
  const url = entry.url === undefined ? {} : { url: entry.url };
  if (entry.state === "passed" || entry.state === "failed") return { outcome: entry.state, ...(entry.counts === undefined ? {} : { counts: entry.counts }), ...url };
  if (entry.state === "not_run") return { outcome: "not_run", ...(entry.reason === undefined ? {} : { reason: entry.reason }), ...(entry.afterMs === undefined ? {} : { afterMs: entry.afterMs }), ...url };
  return undefined;
}

/** The line a finished entry is said with, or undefined while it is not finished. */
export const evalLineOf = (entry: MarkedEntry | undefined): string | undefined => {
  const result = evalResultOf(entry);
  return result === undefined ? undefined : evalCiLine(result);
};

export interface EvalDescriptionSink {
  host: Pick<CodeHost, "getChangeRequest" | "updateChangeRequest">;
  store: DocumentStore;
  companyId: OrgId;
  workspaceId: string;
  repositoryId: string;
  number: number;
  ref: ChangeRequestRef;
  scope: HostScope;
  budget?: ReadBudget | undefined;
  now: () => number;
}

/**
 * Makes the pull request's description say `line` (or nothing, for undefined) under the verdict's "Proven" line. Only that one line of Rovara's own is touched (`withEvalCiLine`): the person's words and the rest of
 * the block stay. A description Rovara wrote and nobody edited is also kept in step in the pull request's record (so the next rewrite does not take it for a person's edit); one a person edited is left as its
 * record has it. Returns what happened; a host that refuses is the caller's to log. A pass limit is thrown.
 */
export async function writeEvalDescription(sink: EvalDescriptionSink, line: string | undefined): Promise<"written" | "same" | "no_block" | "not_open"> {
  sink.budget?.beforeRequest();
  const now = await sink.host.getChangeRequest(sink.ref, sink.scope);
  if (now.state !== "open") return "not_open";
  const next = withEvalCiLine(now.body, line);
  if (next.kind !== "changed") return next.kind;
  const record = await pullRequestRecordOf({ store: sink.store, companyId: sink.companyId }, sink.workspaceId, sink.repositoryId, sink.number);
  sink.budget?.beforeRequest();
  await sink.host.updateChangeRequest(sink.ref, { body: next.body }, sink.scope);
  if (record !== undefined && record.body === now.body) {
    const key = pullRequestRecordKey((await workspaceKeys({ store: sink.store, companyId: sink.companyId }, sink.workspaceId)).workspaceKey, sink.repositoryId, sink.number);
    await sink.store.update({ key, ops: [change.set("body", next.body), change.set("updatedAt", new Date(sink.now()).toISOString())], condition: when.eq("body", record.body) });
  }
  return "written";
}

export interface EvalCiPass {
  /** The fields the tracking item takes for the eval check. */
  fields: { ciEval: MarkedEntry; ciEvalSince?: string };
  recheckAt?: number;
  /** What the check said, once it has said it. */
  result: EvalCiResult | undefined;
}

/**
 * The eval check for one pass over one pull request. Reads the check's run once (facts and per-test report, as the marked checks do), keeps the entry on the item, and brings the description in step: the line is
 * written once, when the result has landed (and its per-test report has been read or given up on), and taken out again when the head or the run it spoke for is no longer the current one. A description that
 * cannot be written (the host says no) leaves the entry as told, so the pass does not ask again every time.
 */
export async function evalCiPass(input: {
  eval: EvalCheck;
  settings: CiEvidenceSettings;
  status: ChangeRequestStatus;
  prior: MergeTrackingItem | undefined;
  fields: Pick<MergeTrackingItem, "headByRovara" | "lastRovaraPushAt">;
  now: number;
  runner?: CheckRunner | undefined;
  ref: ChangeRequestRef;
  repository: { url: string };
  scope: HostScope;
  budget?: ReadBudget | undefined;
  reportParser?: PipelineReportParser | undefined;
  /** Writes the line (or takes it out). Absent: the entry is kept and the description is not touched. */
  describe?: ((line: string | undefined) => Promise<unknown>) | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}): Promise<EvalCiPass> {
  const head = input.status.headRevision;
  const marked = asMarked(input.eval);
  // The marked-check readers take the marked checks from the settings: this pass hands them the eval check alone, and no history (the wait is the settings' cap).
  const settings: CiEvidenceSettings = { ...input.settings, markedChecks: [marked] };
  const rovaraStart = input.fields.headByRovara && input.fields.lastRovaraPushAt !== undefined ? Date.parse(input.fields.lastRovaraPushAt) : undefined;
  const priorSince = input.prior?.headSha === head && input.prior.ciEvalSince !== undefined ? Date.parse(input.prior.ciEvalSince) : undefined;
  const ownSince = priorSince !== undefined && Number.isFinite(priorSince) && priorSince <= input.now ? priorSince : input.now;
  const waitStart = rovaraStart !== undefined && Number.isFinite(rovaraStart) ? rovaraStart : ownSince;
  const priorEntry = input.prior?.ciEval;
  const sameHead = input.prior?.headSha === head && priorEntry !== undefined;
  const shim = sameHead ? { headSha: head, ciMarked: [priorEntry] } : undefined;
  const observed = await observeMarked({
    settings, status: input.status, prior: shim, waitStart, now: input.now, history: () => [], runner: input.runner,
    target: { kind: "change-request", ref: input.ref }, scope: input.scope, budget: input.budget, log: input.log,
  });
  // No base commit: the eval line is the customer's own word, so no change proof is worked out from it.
  const withReported = await withReports({ settings, status: input.status, prior: shim, now: input.now, runner: input.runner, repository: input.repository, scope: input.scope, budget: input.budget, log: input.log, reportParser: input.reportParser }, observed.entries);
  const read = withReported.entries[0];
  const valid = read !== undefined && MarkedCheckEntrySchema.safeParse(read).success ? read
    : read === undefined ? undefined : ((): MarkedEntry | undefined => {
      const { attempt: _attempt, startedAt: _started, completedAt: _completed, url: _url, ...rest } = read;
      void _attempt; void _started; void _completed; void _url;
      return MarkedCheckEntrySchema.safeParse(rest).success ? rest : undefined;
    })();
  // `observeMarked` always answers one entry for the one check it is given; one that does not read leaves the check as waiting, never as an invented result.
  const entry: MarkedEntry = valid ?? { name: marked.name, ...(marked.source === undefined ? {} : { source: marked.source }), state: "waiting", until: new Date(input.now + waitCapMs(input.settings.waitCapMinutes)).toISOString(), expectedMs: waitCapMs(input.settings.waitCapMinutes) };
  const recheck = [observed.recheckAt, withReported.recheckAt].filter((value): value is number => value !== undefined).sort((left, right) => left - right)[0];
  // A per-test report still to be read (or read again) holds the line a little: it is written once, with the counts when there are some.
  const reportPending = reportsOn({ settings, reportParser: input.reportParser, runner: input.runner }) && (entry.state === "passed" || entry.state === "failed") && entry.workflowRunId !== undefined
    && (entry.report === undefined || ((entry.report === "none" || entry.report === "unreadable") && (entry.reportTries ?? 0) < REPORT_TRIES_MAX));
  const result = evalResultOf(entry);
  // Only counts are kept: failed tests' names and texts are not needed for one line (and are not shown on the task view).
  const { failedTests: _failedTests, flaky: _flaky, proven: _proven, added: _added, ...counted } = entry;
  void _failedTests; void _flaky; void _proven; void _added;
  let kept: MarkedEntry = counted;
  // Said once for the head, run, state and reason it speaks for. `observeMarked` keeps `announced` only for a passed or failed run, so a "not run" is remembered here (else it would be written on every pass).
  const already = sameHead && priorEntry !== undefined && priorEntry.announced === true && priorEntry.state === entry.state && priorEntry.runId === entry.runId && priorEntry.reason === entry.reason;
  if (result !== undefined && !reportPending) {
    if (entry.announced !== true && !already) {
      await tell(input, evalCiLine(result));
    }
    kept = { ...counted, announced: true };
  } else if (priorEntry?.announced === true) {
    // What the description says was said for a head or a run that is no longer the current one (a push, a re-run in progress): it is taken out until the check answers again.
    await tell(input, undefined);
  }
  return {
    fields: { ciEval: kept, ...(rovaraStart === undefined || !Number.isFinite(rovaraStart) ? { ciEvalSince: new Date(ownSince).toISOString() } : {}) },
    ...(recheck === undefined ? {} : { recheckAt: recheck }),
    result: reportPending ? undefined : result,
  };
}

/** One write of the description, best effort: a host that refuses is logged by error name and not asked again for this result; a pass limit goes on up. */
async function tell(input: { describe?: ((line: string | undefined) => Promise<unknown>) | undefined; log?: ((event: string, fields: Record<string, unknown>) => void) | undefined }, line: string | undefined): Promise<void> {
  if (input.describe === undefined) return;
  try {
    await input.describe(line);
  } catch (error) {
    if (isPassLimit(error)) throw error;
    input.log?.("eval_ci.description_not_written", { error: error instanceof Error ? error.name : "unknown" });
  }
}
