// TE-F3 (part B): the worker's eval round. It turns the facts of one round (the runner's `rovara-measures.json`, the base score, the calls that were made) into the `eval` check for the evidence writer, through a typed seam
// (`EvalCheckResult`, in contracts). It does NOT write evidence: the v2 writer is another lane's (A2b); and it does not run a model call: it is handed the facts of the calls (the pacing module in contracts makes them).
//
// WHAT IT DOES
//   1. `planEvalRound`, before the runner runs. Trigger: a typed `{needed, reason}` (the shape of F4's `PromptChangeDecision`; the coordinator wires it); not needed means nothing is read, run or cached.
//   2. The hidden eval set (same step): only the sealed round opens it, and the plan hands back the read-only mount for the sealed check sandbox's plan. Any other round answers "not run: the hidden eval set needs the sealed round" BEFORE
//      anything is read or run (`hiddenEvalSetFor`, contracts). `completeEvalRound` is the part after the runner ran (3 to 5); `runEvalRound` is both in one call.
//   3. The runner's file is read through A4's reader (`readReportPartsFile`: contained, fresh, bounded, strict UTF-8; never a guessed path). No new reader exists.
//   4. The base score: looked up in the cache by the key of everything it depends on; on a miss Rovara's OWN base round runs, and only a clean one (no case left unrun) fills the cache. The head round never writes the cache, so a
//      value a coding agent could write is never cached. A base round whose eval set is not the head's is not comparable ("the eval set changed"), but its own score is still cached under its own hash.
//   5. The verdicts, the v2 measures and the summary line come from `evalCheckResult`; what the coding agent is told comes only from `agentFeedbackFor`.
// WHAT IT NEVER DOES: read a repository for the hidden set, hold a log, print a runner word that did not pass the inert-text function (in contracts), or mount anything (the mount spec goes back to the caller, which passes it to the
// sealed check sandbox's plan and to nothing else).
import {
  EVAL_BASE_ROUND_KINDS, agentFeedbackFor, evalBaseCacheKey, evalCheckResult, evalNotRunResult, hiddenEvalSetFor,
  type BaseScoreCache, type EvalAgentFeedback, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalCheckResult, type EvalRoundFacts, type EvalRoundKind, type HiddenEvalMount, type HiddenEvalSetSource, type MeasuresFile,
} from "@agentx/contracts";
import { readReportPartsFile } from "./report-file.js";

/** The shape of F4's `PromptChangeDecision`: whether an eval is needed, and why. */
export interface EvalTrigger {
  readonly needed: boolean;
  readonly reason: "incomplete" | "changes" | "none_found";
}

/** Where the runner's measures file is, and when this round began (a file older than the round says nothing about this code). */
export interface EvalReportLocation {
  readonly root: string;
  readonly cwd: string;
  readonly argument: string;
  readonly notBeforeMs: number | undefined;
  readonly nowMs?: number;
}

/** What Rovara's own base round hands back: the measures file it read (through `readEvalMeasures`), the cases behind it, and the facts of its calls. */
export type EvalBaseRoundRead = { readonly ok: true; readonly measures: MeasuresFile; readonly caseCount: number; readonly facts: EvalRoundFacts } | { readonly ok: false };

export interface EvalRoundInput {
  readonly trigger: EvalTrigger;
  readonly roundKind: EvalRoundKind;
  readonly report: EvalReportLocation;
  /** Everything the base score depends on except the two hashes (the eval set's comes from the runner's file, the hidden set's from the source). */
  readonly key: Omit<EvalBaseCacheKeyParts, "evalSetHash" | "hiddenSetHash">;
  readonly cache: BaseScoreCache;
  /** The project's hidden eval set, when it keeps one. */
  readonly hiddenSet?: HiddenEvalSetSource;
  /** Rovara's own base round (the base commit, the same command and model). Called only on a cache miss. */
  readonly runBaseRound: () => Promise<EvalBaseRoundRead>;
  /** The facts of the head round's model calls (counts only). */
  readonly facts: EvalRoundFacts;
  readonly capMicros?: number;
  /** Today as `YYYY-MM-DD`, for the cache record. */
  readonly today: () => string;
}

export type EvalRoundOutput =
  | { readonly status: "skipped"; readonly reason: EvalTrigger["reason"] }
  | {
    readonly status: "done";
    /** The eval check for the evidence writer. */
    readonly result: EvalCheckResult;
    /** What the coding agent may be told: a score and a count per measure, nothing else. */
    readonly feedback: EvalAgentFeedback;
    /** The read-only mount for the sealed check sandbox's plan: present only in the sealed round, with a hidden set. */
    readonly hiddenMount?: HiddenEvalMount;
    /** `hit`: the base score came from the cache. `filled`: Rovara's base round ran and its clean score was cached. `not_filled`: it ran (or could not) and nothing was cached. `not_used`: no base lookup was made. */
    readonly cache: "hit" | "filled" | "not_filled" | "not_used";
  };

/** The runner's measures file through A4's reader, or the fixed reason it could not be read. */
export async function readEvalMeasures(location: EvalReportLocation): Promise<{ ok: true; measures: MeasuresFile } | { ok: false }> {
  const read = await readReportPartsFile({ root: location.root, cwd: location.cwd, argument: location.argument, notBeforeMs: location.notBeforeMs, ...(location.nowMs === undefined ? {} : { nowMs: location.nowMs }) });
  if (!read.ok || read.parts.measures === undefined) return { ok: false };
  return { ok: true, measures: read.parts.measures };
}

const done = (result: EvalCheckResult, cache: "hit" | "filled" | "not_filled" | "not_used", extra: { hiddenMount?: HiddenEvalMount } = {}): EvalRoundOutput => ({
  status: "done", result, feedback: agentFeedbackFor(result), ...(extra.hiddenMount === undefined ? {} : { hiddenMount: extra.hiddenMount }), cache,
});

/** What the round settles BEFORE the sealed check sandbox is planned: whether an eval is needed, and whether (and how) the hidden eval set is mounted. */
export type EvalRoundPlan =
  | { readonly status: "ready"; readonly hiddenHash: string; readonly hiddenMount?: HiddenEvalMount }
  | { readonly status: "stopped"; readonly output: EvalRoundOutput };

/**
 * The part of the round that comes before the runner runs: the trigger and the hidden set. A round that may not see the hidden set stops here (nothing is read or run), and the sealed round gets the read-only mount for the
 * sealed check sandbox's plan (`checkSandboxPlan`'s `hiddenEvalSetPath`). Nothing else may be mounted from it.
 */
export async function planEvalRound(input: Pick<EvalRoundInput, "trigger" | "roundKind" | "hiddenSet">): Promise<EvalRoundPlan> {
  if (!input.trigger.needed) return { status: "stopped", output: { status: "skipped", reason: input.trigger.reason } };
  const { roundKind } = input;
  if (input.hiddenSet === undefined) return { status: "ready", hiddenHash: "none" };
  const hidden = await hiddenEvalSetFor(roundKind, input.hiddenSet);
  if (hidden.status === "needs_sealed_round") return { status: "stopped", output: done(evalNotRunResult({ roundKind, reason: "hidden_set_needs_sealed_round" }), "not_used") };
  if (hidden.status === "unavailable") return { status: "stopped", output: done(evalNotRunResult({ roundKind, reason: "hidden_set_unavailable" }), "not_used") };
  return hidden.status === "mounted" ? { status: "ready", hiddenHash: hidden.hash, hiddenMount: hidden.mount } : { status: "ready", hiddenHash: "none" };
}

/** Plans, then completes: for callers (and tests) that have no step between the two. The sealed round's caller uses `planEvalRound`, then the sandbox, then `completeEvalRound`. */
export async function runEvalRound(input: EvalRoundInput): Promise<EvalRoundOutput> {
  const plan = await planEvalRound(input);
  return plan.status === "stopped" ? plan.output : completeEvalRound(input, plan);
}

/** The part of the round that comes after the runner ran: read its file, find or measure the base score, and build the check. */
export async function completeEvalRound(input: EvalRoundInput, plan: Extract<EvalRoundPlan, { status: "ready" }>): Promise<EvalRoundOutput> {
  const { roundKind, facts } = input;
  const hiddenHash = plan.hiddenHash;
  const hiddenMount = plan.hiddenMount;
  const usedHidden = hiddenMount !== undefined;
  const mount = usedHidden ? { hiddenMount } : {};
  const finish = (result: EvalCheckResult, cache: "hit" | "filled" | "not_filled" | "not_used"): EvalRoundOutput => done(result, cache, mount);
  const notRun = (reason: Parameters<typeof evalNotRunResult>[0]["reason"], cache: "hit" | "filled" | "not_filled" | "not_used"): EvalRoundOutput => finish(evalNotRunResult({ roundKind, reason, facts, ...(usedHidden ? { hiddenSetUsed: true } : {}) }), cache);

  const head = await readEvalMeasures(input.report);
  if (!head.ok) return notRun("no_measures_file", "not_used");
  const evalSetHash = head.measures.eval_set_hash;
  // Without the hash of the eval set that ran, nothing proves the base and the head ran the same cases: no comparison is made.
  if (evalSetHash === undefined) return notRun("eval_set_unknown", "not_used");

  const parts: EvalBaseCacheKeyParts = { ...input.key, evalSetHash, hiddenSetHash: hiddenHash };
  let cached: EvalBaseRecord | undefined;
  try {
    evalBaseCacheKey(parts);
    cached = await input.cache.read(parts);
  } catch {
    cached = undefined;
  }
  if (cached !== undefined) return finish(evalCheckResult({ roundKind, head: head.measures, base: cached, facts, ...(input.capMicros === undefined ? {} : { capMicros: input.capMicros }), ...(usedHidden ? { hiddenSetUsed: true } : {}) }), "hit");

  // A miss: Rovara's own base round. Its scores are cached only when the round was clean (no case left unrun) and only under the eval set hash the BASE round itself reports.
  let base: EvalBaseRoundRead;
  try {
    base = await input.runBaseRound();
  } catch {
    base = { ok: false };
  }
  if (!base.ok) return notRun("no_base_score", "not_filled");
  const baseHash = base.measures.eval_set_hash;
  let cache: "filled" | "not_filled" = "not_filled";
  let record: EvalBaseRecord | undefined;
  if (baseHash !== undefined && base.facts.notRun === 0 && (EVAL_BASE_ROUND_KINDS as readonly string[]).includes(roundKind)) {
    record = { schemaVersion: 1, measures: base.measures.measures, caseCount: base.caseCount, recordedOn: input.today(), roundKind: roundKind as EvalBaseRecord["roundKind"], runnerSchemaVersion: base.measures.schemaVersion };
    const written = await input.cache.write({ ...parts, evalSetHash: baseHash }, record, { writer: "rovara_base_round", baseCommit: parts.baseCommit }).catch(() => "refused" as const);
    if (written === "stored") cache = "filled";
  }
  if (baseHash !== evalSetHash) return notRun("eval_set_changed", cache);
  // Compared even when the base round could not be cached (a base round with unrun cases is not a base score).
  if (base.facts.notRun > 0) return notRun("no_base_score", cache);
  record ??= { schemaVersion: 1, measures: base.measures.measures, caseCount: base.caseCount, recordedOn: input.today(), roundKind: "check_unsealed", runnerSchemaVersion: base.measures.schemaVersion };
  return finish(evalCheckResult({ roundKind, head: head.measures, base: record, facts, ...(input.capMicros === undefined ? {} : { capMicros: input.capMicros }), ...(usedHidden ? { hiddenSetUsed: true } : {}) }), cache);
}
