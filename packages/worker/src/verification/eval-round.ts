// TE-F3 (part B): the worker's eval round. It turns the facts of one round (the runner's `rovara-measures.json`, the base score, the calls that were made) into the `eval` check for the evidence writer, through a typed seam
// (`EvalCheckResult`, in contracts). It does NOT write evidence: the v2 writer is another lane's (A2b); and it does not run a model call: it is handed the facts of the calls (the pacing module in contracts makes them).
//
// WHAT IT DOES
//   1. `planEvalRound`, before the runner runs. Trigger: a typed `{needed, reason}` (the shape of F4's `PromptChangeDecision`; the coordinator wires it); not needed means nothing is read, run or cached.
//   2. The hidden eval set (same step): only the sealed round opens it, and the plan hands back the read-only mount for the sealed check sandbox's plan. Any other round answers "not run: the hidden eval set needs the sealed round" BEFORE
//      anything is read or run (`hiddenEvalSetFor`, contracts). `completeEvalRound` is the part after the runner ran (3 to 5); `runEvalRound` is both in one call.
//   3. The runner's file is read through A4's reader (`readReportPartsFile`: contained, fresh, bounded, strict UTF-8; never a guessed path). No new reader exists.
//   4. The base score: looked up in the cache by the key of everything it depends on (Rovara's own hash of the eval files, the hidden set's hash, the settings fingerprint, the exact model version); on a miss Rovara's OWN base round runs, only with
//      the runner's attestation of a Rovara-only checkout and a paused working sandbox, and only a clean one (no case left unrun, enough cases) fills the cache. The head round never writes the cache, so a
//      value a coding agent could write is never cached. A base round whose eval set is not the head's is not comparable ("the eval set changed"), but its own score is still cached under its own hash.
//   5. The verdicts, the v2 measures and the summary line come from `evalCheckResult`; what the coding agent is told comes only from `agentFeedbackFor`.
// WHAT IT NEVER DOES: read a repository for the hidden set, hold a log, print a runner word that did not pass the inert-text function (in contracts), or mount anything (the mount spec goes back to the caller, which passes it to the
// sealed check sandbox's plan and to nothing else).
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  EVAL_BASE_ROUND_KINDS, EVAL_MIN_QUESTIONS, EVAL_NOISE_K, agentFeedbackFor, evalBaseCacheKey, evalCheckResult, evalNotRunResult, evalSetHashOf, evalSettingsFingerprint, hiddenEvalSetFor,
  type BaseScoreCache, type EvalBaseAttestation, type EvalSettings, type EvalAgentFeedback, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalCheckResult, type EvalRoundFacts, type EvalRoundKind, type HiddenEvalMount, type HiddenEvalSetSource, type MeasuresFile,
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
export type EvalBaseRoundRead =
  | {
    readonly ok: true; readonly measures: MeasuresFile; readonly caseCount: number; readonly facts: EvalRoundFacts;
    /** Rovara's own hash of the eval files in the base checkout (`hashEvalDirectory`), never a value the runner wrote. */
    readonly evalSetHash: string;
    /** The runner's attestation that this round ran in a Rovara-only checkout of the base commit with the working sandbox paused. Without it the score is neither cached nor compared. */
    readonly attestation: EvalBaseAttestation;
  }
  | { readonly ok: false };

export interface EvalRoundInput {
  readonly trigger: EvalTrigger;
  readonly roundKind: EvalRoundKind;
  readonly report: EvalReportLocation;
  /** Everything the base score depends on except the two hashes (the eval set's comes from the runner's file, the hidden set's from the source). */
  readonly key: Omit<EvalBaseCacheKeyParts, "evalSetHash" | "hiddenSetHash" | "settingsFingerprint">;
  /** How the eval was run (the runs, the seed, the repeats, the image and the route); `k` and the minimum questions are added here. Part of the cache key. */
  readonly settings: Omit<EvalSettings, "k" | "minQuestions">;
  /** The fewest cases that must stand behind a score (default `EVAL_MIN_QUESTIONS`); also applied to the base round. */
  readonly minQuestions?: number;
  /**
   * Rovara's OWN hash of the head's eval files (`hashEvalDirectory`). Required: the hash the runner writes in its file is a claim, not evidence, and when this is missing the round refuses to compare. A hash in the runner's file
   * that differs from this one is "the eval set changed".
   */
  readonly evalSetHash?: string;
  /** Hashes the hidden set's directory (default `hashEvalDirectory`); the round mounts the set only when this equals the hash the source gave. */
  readonly hashHiddenSet?: (hostPath: string) => Promise<string>;
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
export async function planEvalRound(input: Pick<EvalRoundInput, "trigger" | "roundKind" | "hiddenSet" | "hashHiddenSet">): Promise<EvalRoundPlan> {
  if (!input.trigger.needed) return { status: "stopped", output: { status: "skipped", reason: input.trigger.reason } };
  const { roundKind } = input;
  if (input.hiddenSet === undefined) return { status: "ready", hiddenHash: "none" };
  const hidden = await hiddenEvalSetFor(roundKind, input.hiddenSet);
  if (hidden.status === "needs_sealed_round") return { status: "stopped", output: done(evalNotRunResult({ roundKind, reason: "hidden_set_needs_sealed_round" }), "not_used") };
  if (hidden.status === "unavailable") return { status: "stopped", output: done(evalNotRunResult({ roundKind, reason: "hidden_set_unavailable" }), "not_used") };
  if (hidden.status !== "mounted") return { status: "ready", hiddenHash: "none" };
  // The opened hash is checked against what would be mounted: Rovara hashes the directory itself, and docker is handed the REAL path (a link is resolved here, so it cannot be swapped between the check and the mount).
  try {
    const real = await realpath(hidden.mount.hostPath);
    if ((await (input.hashHiddenSet ?? hashEvalDirectory)(real)) !== hidden.hash) return { status: "stopped", output: done(evalNotRunResult({ roundKind, reason: "hidden_set_unavailable" }), "not_used") };
    return { status: "ready", hiddenHash: hidden.hash, hiddenMount: { ...hidden.mount, hostPath: real } };
  } catch {
    return { status: "stopped", output: done(evalNotRunResult({ roundKind, reason: "hidden_set_unavailable" }), "not_used") };
  }
}

const HASH_ENTRIES_MAX = 10_000;
const HASH_BYTES_MAX = 256 * 1024 * 1024;
/**
 * Rovara's own hash of an eval directory (`evalSetHashOf` over its files): every file under it, by relative path, with no link, device or other special entry (a link could point anywhere), at most 10,000 files and 256 MiB.
 * Throws when the directory holds no file or anything it must refuse. Used for the head's eval files, the base checkout's, and the hidden set's mount.
 */
export async function hashEvalDirectory(directory: string): Promise<string> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let total = 0;
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const name of (await readdir(absolute)).sort()) {
      const path = join(absolute, name);
      const rel = relative === "" ? name : `${relative}/${name}`;
      const info = await lstat(path);
      if (info.isDirectory()) { await walk(path, rel); continue; }
      if (!info.isFile()) throw new Error("an eval directory holds only plain files and folders");
      total += info.size;
      if (files.length >= HASH_ENTRIES_MAX || total > HASH_BYTES_MAX) throw new Error("the eval directory is too large");
      files.push({ path: rel, bytes: await readFile(path) });
    }
  };
  await walk(await realpath(directory), "");
  return evalSetHashOf(files);
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

  const minQuestions = input.minQuestions ?? EVAL_MIN_QUESTIONS;
  const capArgs = input.capMicros === undefined ? {} : { capMicros: input.capMicros };
  const judge = (base: EvalBaseRecord, head: MeasuresFile): EvalCheckResult => evalCheckResult({ roundKind, head, base, facts, minQuestions, ...capArgs, ...(usedHidden ? { hiddenSetUsed: true } : {}) });

  const head = await readEvalMeasures(input.report);
  if (!head.ok) return notRun("no_measures_file", "not_used");
  // The eval set's hash is Rovara's own, from the eval files. The runner's file may repeat it, and a different claim is a changed eval set; the runner's claim alone is never evidence.
  const evalSetHash = input.evalSetHash;
  if (evalSetHash === undefined) return notRun("eval_set_unknown", "not_used");
  if (head.measures.eval_set_hash !== undefined && head.measures.eval_set_hash !== evalSetHash) return notRun("eval_set_changed", "not_used");

  let settingsFingerprint: string;
  try {
    settingsFingerprint = evalSettingsFingerprint({ ...input.settings, k: EVAL_NOISE_K, minQuestions });
  } catch {
    return notRun("no_base_score", "not_used");
  }
  const parts: EvalBaseCacheKeyParts = { ...input.key, evalSetHash, hiddenSetHash: hiddenHash, settingsFingerprint };
  let cached: EvalBaseRecord | undefined;
  try {
    evalBaseCacheKey(parts);
    cached = await input.cache.read(parts);
  } catch {
    cached = undefined;
  }
  if (cached !== undefined) return finish(judge(cached, head.measures), "hit");

  // A miss: Rovara's own base round. It counts only with the runner's attestation that it ran in a Rovara-only checkout with the working sandbox paused; its scores are cached only when the round was clean (no case left
  // unrun, enough cases) and only under the eval set hash Rovara computed for the BASE checkout.
  let base: EvalBaseRoundRead;
  try {
    base = await input.runBaseRound();
  } catch {
    base = { ok: false };
  }
  if (!base.ok) return notRun("no_base_score", "not_filled");
  const attested = typeof base.attestation === "object" && base.attestation !== null && base.attestation.checkout === "rovara_only" && base.attestation.workingSandboxPaused === true && base.attestation.baseCommit === parts.baseCommit;
  if (!attested) return notRun("base_round_unattested", "not_filled");
  if (base.facts.run < minQuestions) return notRun("too_few_questions", "not_filled");
  const baseHash = base.evalSetHash;
  let cache: "filled" | "not_filled" = "not_filled";
  let record: EvalBaseRecord | undefined;
  if (typeof baseHash === "string" && base.facts.notRun === 0 && (EVAL_BASE_ROUND_KINDS as readonly string[]).includes(roundKind)) {
    record = { schemaVersion: 1, measures: base.measures.measures, caseCount: base.caseCount, recordedOn: input.today(), roundKind: roundKind as EvalBaseRecord["roundKind"], runnerSchemaVersion: base.measures.schemaVersion };
    const written = await input.cache.write({ ...parts, evalSetHash: baseHash }, record, { writer: "rovara_base_round", baseCommit: parts.baseCommit }).catch(() => "refused" as const);
    if (written === "stored") cache = "filled";
  }
  if (baseHash !== evalSetHash) return notRun("eval_set_changed", cache);
  // Compared even when the base round could not be cached, except when some of its cases did not run (that is not a base score).
  if (base.facts.notRun > 0) return notRun("no_base_score", cache);
  record ??= { schemaVersion: 1, measures: base.measures.measures, caseCount: base.caseCount, recordedOn: input.today(), roundKind: "check_unsealed", runnerSchemaVersion: base.measures.schemaVersion };
  return finish(judge(record, head.measures), cache);
}
