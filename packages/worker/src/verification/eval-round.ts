// Final-check eval orchestration: saved three-run baseline, fresh re-asks, exact rule.
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  inertEvidenceText, EVAL_PACING_DEFAULTS, EVAL_NOT_RUN_CLASSES, EvalBaseRecordSchema, EVAL_QUESTION_LIMIT, evalSuspects, evalNeedsSecondLook, agentFeedbackFor, evalBaseCacheKey, evalCheckResult, evalNotRunResult, evalSetHashOf, evalCommandFingerprint, hiddenEvalSetFor, isEvalBaseAttestation,
  type EvalQuestionComparison, type EvalQuestionSamples, type EvalNotRunReason, type EvalPacingLimits, type BaseScoreCache, type EvalBaseAttestation, type EvalAgentFeedback, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalCheckResult, type EvalRoundFacts, type EvalRoundKind, type HiddenEvalMount, type HiddenEvalSetSource, type MeasuresFile,
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

export interface EvalQuestionPlan {
  /** Bound by the caller to the customer's product-provider capability, never the agent's provider. */
  readonly company: string;
  readonly provider: "customer";
  readonly connected: boolean;
  readonly previousPasses: number;
  readonly judgePin: string;
  readonly baselineJudgePin: string;
  /** Trusted old-set hash, when edits make it differ from the head set. */
  readonly baseEvalSetHash?: string;
  readonly sameJudgeFamily?: boolean;
  readonly subsetSupported: boolean;
  /** Hashes/category come from Rovara's trusted base/head inventory, never the report. */
  readonly questions: ReadonlyArray<{ readonly id: string; readonly category: "ordinary" | "safety" | "refusal"; readonly baseHash: string; readonly headHash: string }>;
  /** Conservative measured upper bounds, including any judge calls. */
  readonly maxCallsPerQuestion: number;
  readonly maxCostMicrosPerQuestion: number;
  readonly callsAlreadyUsed?: number;
  readonly costAlreadyUsedMicros?: number;
  /** Explicit project budget, supplied from the approved health-check estimate when available.
   * Missing dimensions fall back to DEC 171: 200 calls / $2 per task. */
  readonly limits?: Partial<Pick<EvalPacingLimits, "maxCalls" | "maxCostMicros">>;
  /** Runs through F1's customer ModelEgress and F3 pacing; resolves only after all calls joined.
   * Reports are read by A4. No key, response header, error or stdout belongs in this return value. */
  readonly run: (request: { readonly side: "old" | "new"; readonly ids: readonly string[]; readonly runs: 1 | 2 | 3 }) => Promise<{
    readonly report: EvalReportLocation; readonly facts: EvalRoundFacts;
    readonly calls: number; readonly costMicros: number; readonly changedPromptCalls: number;
    readonly attestation?: EvalBaseAttestation;
  }>;
}
export interface EvalRoundInput {
  readonly tier?: { readonly reasons: ReadonlyArray<{ readonly code: string; readonly path?: string }> };
  /** Discovery explicitly found no configured eval; absence of a plan alone is not proof. */
  readonly evalConfigured?: boolean;
  readonly questionPlan?: EvalQuestionPlan;
  readonly trigger: EvalTrigger;
  readonly roundKind: EvalRoundKind;
  /** Everything the base score depends on except the two hashes (the eval set's comes from the runner's file, the hidden set's from the source). */
  readonly key: Omit<EvalBaseCacheKeyParts, "evalSetHash" | "hiddenSetHash" | "settingsFingerprint">;
  readonly settings: { readonly imageDigest: string; readonly route: string };
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
}

export type EvalRoundOutput =
  | { readonly status: "skipped"; readonly reason: EvalTrigger["reason"] }
  | {
    readonly status: "done";
    /** The eval check for the evidence writer. */
    readonly result: EvalCheckResult;
    /** Actual spend for this eval; omitted for private sets. Missing cost means it could not be read. */
    readonly usage?: { readonly calls: number; readonly costMicros?: number };
    /** Public question details, or one fixed pass/fail for a private set. */
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
export async function planEvalRound(input: Pick<EvalRoundInput, "trigger" | "tier" | "roundKind" | "hiddenSet" | "hashHiddenSet">): Promise<EvalRoundPlan> {
  if (!input.trigger.needed && !tierRequestsEval(input.tier)) return { status: "stopped", output: { status: "skipped", reason: input.trigger.reason } };
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

/** Adapter for PR #570: eval_hint is a REASON, never a new tier kind. */
export function tierRequestsEval(tier: EvalRoundInput["tier"]): boolean { return tier?.reasons.some(reason => reason.code === "eval_hint") === true; }

/** Legacy aggregate callers fail closed. The baseline is supplied by setup/background refresh (F3d).
 * It is never manufactured from an aggregate score or a task's new-code answers. */
export async function completeEvalRound(input: EvalRoundInput, plan: Extract<EvalRoundPlan, { status: "ready" }>): Promise<EvalRoundOutput> {
  const hidden = plan.hiddenMount !== undefined;
  let usage: { calls: number; costMicros?: number } | undefined;
  const estimates: string[] = [];
  let excluded: EvalCheckResult["excluded"] = [];
  let cacheState: "hit" | "not_used" = "not_used";
  const finish = (result: EvalCheckResult): EvalRoundOutput => {
    const count = excluded.length;
    const exclusionSummary = count === 0 ? "" : ` ${count} question${count === 1 ? "" : "s"} added, removed or edited: not compared.`;
    const evidence = hidden ? result : { ...result, excluded: [...excluded, ...result.excluded], casesTotal: result.casesTotal + count, notices: [...result.notices, ...estimates], summary: result.summary + exclusionSummary };
    const output = done(evidence, cacheState, plan.hiddenMount === undefined ? {} : { hiddenMount: plan.hiddenMount });
    return output.status === "done" && !hidden && usage !== undefined ? { ...output, usage } : output;
  };
  const refuse = (reason: EvalNotRunReason): EvalRoundOutput => finish(evalNotRunResult({ roundKind: input.roundKind, reason, hiddenSetUsed: hidden }));
  if (input.evalConfigured === false && tierRequestsEval(input.tier)) {
    const result = evalNotRunResult({ roundKind: input.roundKind, reason: "no_eval_configured", hiddenSetUsed: hidden });
    const notice = "Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below.";
    return finish({ ...result, notices: [notice], summary: notice, disposition: { ...result.disposition, retry: false } });
  }
  const config = input.questionPlan;
  if (config === undefined) return refuse("question_data_missing");
  if (!input.trigger.needed && !tierRequestsEval(input.tier)) return { status: "skipped", reason: input.trigger.reason };
  if (input.roundKind !== "check_sealed" && input.roundKind !== "check_unsealed") return refuse(hidden ? "hidden_set_needs_sealed_round" : "refused");
  if (hidden && input.roundKind !== "check_sealed") return refuse("hidden_set_needs_sealed_round");
  if (!config.connected) return refuse("no_product_key");
  if (config.company !== input.key.company || config.provider !== "customer") return refuse("refused");
  if (!Number.isSafeInteger(config.previousPasses) || config.previousPasses < 0 || config.previousPasses >= 2) return refuse("round_limit");
  if (!/^[a-f0-9]{64}$/u.test(config.judgePin) || config.judgePin !== config.baselineJudgePin) return refuse("judge_changed");
  if (input.evalSetHash === undefined) return refuse("eval_set_unknown");
  const definitions = config.questions;
  if (definitions.length > EVAL_QUESTION_LIMIT || new Set(definitions.map(q => q.id)).size !== definitions.length || definitions.some(q => !/^[a-f0-9]{64}$/u.test(q.baseHash) || !/^[a-f0-9]{64}$/u.test(q.headHash))) return refuse("invalid_question_data");
  const parts: EvalBaseCacheKeyParts = { ...input.key, evalSetHash: config.baseEvalSetHash ?? input.evalSetHash, hiddenSetHash: plan.hiddenHash,
    settingsFingerprint: evalCommandFingerprint(JSON.stringify({ rule: "question-exact-v1", imageDigest: input.settings.imageDigest, route: input.settings.route, judgePin: config.judgePin })) };
  let base: EvalBaseRecord | undefined;
  try { evalBaseCacheKey(parts); base = await input.cache.read(parts); } catch { return refuse("no_base_score"); }
  const parsedBase = EvalBaseRecordSchema.safeParse(base);
  if (!parsedBase.success || parsedBase.data.questions === undefined) return refuse("no_base_score");
  base = parsedBase.data;
  cacheState = "hit";
  const byId = new Map(base.questions!.map(q => [q.id, q]));
  const headIds = new Set(definitions.map(q => q.id));
  excluded = [
    ...definitions.filter(q => !byId.has(q.id) || q.baseHash !== q.headHash).map(q => ({ id: inertEvidenceText(q.id, 160), reason: "edited" as const })),
    ...base.questions!.filter(q => !headIds.has(q.id)).map(q => ({ id: inertEvidenceText(q.id, 160), reason: "edited" as const })),
  ];
  const untouched = definitions.filter(q => byId.has(q.id) && q.baseHash === q.headHash);
  if (untouched.length === 0) return refuse("too_few_questions");
  const maxCalls = config.limits?.maxCalls ?? EVAL_PACING_DEFAULTS.maxCalls;
  const maxCost = config.limits?.maxCostMicros ?? EVAL_PACING_DEFAULTS.maxCostMicros;
  let calls = config.callsAlreadyUsed ?? 0; let cost = config.costAlreadyUsedMicros ?? 0;
  const whole = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
  if (![maxCalls, maxCost, calls, cost, config.maxCallsPerQuestion, config.maxCostMicrosPerQuestion].every(whole) || config.maxCallsPerQuestion < 1 || config.maxCostMicrosPerQuestion < 1) return refuse("cap");
  const initialCalls = calls; const initialCost = cost;
  let costKnown = true;
  let changedPromptCalls = 0;
  let stop: EvalNotRunReason | undefined;
  const fits = (questionRuns: number): boolean => calls + questionRuns * config.maxCallsPerQuestion <= maxCalls && cost + questionRuns * config.maxCostMicrosPerQuestion <= maxCost;
  const reserve = (stage: "first run" | "re-asks" | "second look", questionRuns: number): boolean => {
    const estimatedCalls = questionRuns * config.maxCallsPerQuestion;
    const estimatedCost = questionRuns * config.maxCostMicrosPerQuestion;
    if (!Number.isSafeInteger(estimatedCalls) || !Number.isSafeInteger(estimatedCost)) { stop = "cap"; return false; }
    estimates.push(`Eval ${stage} estimate: ${estimatedCalls} calls, ${estimatedCost} microdollars.`);
    if (!fits(questionRuns)) { stop = "cap"; return false; }
    return true;
  };
  const run = async (side: "old" | "new", ids: readonly string[], runs: 1 | 2 | 3): Promise<Map<string, EvalQuestionSamples> | undefined> => {
    if (stop !== undefined) return undefined;
    try {
      const output = await config.run({ side, ids, runs });
      if (side === "old" && (!isEvalBaseAttestation(output.attestation) || output.attestation.baseCommit !== input.key.baseCommit)) { stop = "base_round_unattested"; return undefined; }
      if (!whole(output.calls) || !whole(output.changedPromptCalls) || output.changedPromptCalls > output.calls) { stop = "invalid_question_data"; return undefined; }
      calls += output.calls;
      if (whole(output.costMicros)) cost += output.costMicros; else costKnown = false;
      usage = { calls: calls - initialCalls, ...(costKnown ? { costMicros: cost - initialCost } : {}) };
      // Spending can stop further work, but cannot discard fully answered failures.
      if (!costKnown || output.calls > ids.length * runs * config.maxCallsPerQuestion || output.costMicros > ids.length * runs * config.maxCostMicrosPerQuestion || calls > maxCalls || cost > maxCost || output.facts.overrunStop) stop = "cap";
      if (output.facts.notRun > 0 || output.facts.run !== ids.length * runs || output.calls < 1) {
        stop = EVAL_NOT_RUN_CLASSES.find(reason => (output.facts.byClass[reason] ?? 0) > 0) ?? "provider_error"; return undefined;
      }
      const read = await readEvalMeasures(output.report);
      if (!read.ok || read.measures.questions === undefined) { stop = "no_measures_file"; return undefined; }
      if (read.measures.eval_set_hash !== undefined && read.measures.eval_set_hash !== (side === "old" ? parts.evalSetHash : input.evalSetHash)) { stop = "eval_set_changed"; return undefined; }
      const rows = read.measures.questions;
      const map = new Map(rows.map(row => [row.id, row]));
      if (rows.length !== ids.length || ids.some(id => map.get(id)?.samples.length !== runs)) { stop = "invalid_question_data"; return undefined; }
      if (side === "new") changedPromptCalls += output.changedPromptCalls;
      return map;
    } catch { stop = "provider_error"; return undefined; }
  };
  // Whole-set-only runners still execute the head inventory; excluded answers never enter the comparison.
  const ids = (config.subsetSupported ? untouched : definitions).map(q => q.id);
  if (!reserve("first run", ids.length)) return refuse("cap");
  const first = await run("new", ids, 1);
  if (first === undefined) return refuse(stop ?? "provider_error");
  let questions: EvalQuestionComparison[] = untouched.map(q => ({ id: q.id, category: q.category, old: byId.get(q.id)!.samples, first: first.get(q.id)!.samples[0]!, edited: q.baseHash !== q.headHash }));
  const judge = (): EvalCheckResult => evalCheckResult({ roundKind: input.roundKind, questions, changedPromptCalls, hiddenSetUsed: hidden, subsetSupported: config.subsetSupported, sameJudgeFamily: config.sameJudgeFamily === true });
  if (config.subsetSupported) {
    const suspects = evalSuspects(questions); const selected = [...suspects.down, ...suspects.up];
    if (selected.length > 0 && reserve("re-asks", 6 * selected.length)) {
      const old = await run("old", selected, 3); const newer = old === undefined ? undefined : await run("new", selected, 3);
      questions = questions.map(q => ({ ...q, freshOld: old?.get(q.id)?.samples, freshNew: newer?.get(q.id)?.samples }));
    }
  }
  // A confirmed failure survives an outage/cap on later work. Never turn it into Not run.
  if (judge().label !== "Worse on eval" && stop === undefined && evalNeedsSecondLook(questions)) {
    const more = reserve("second look", 2 * ids.length) ? await run("new", ids, 2) : undefined;
    questions = questions.map(q => ({ ...q, moreNew: more?.get(q.id)?.samples }));
  }
  const judged = judge();
  const result = { ...judged, fixRequested: judged.fixRequested && config.previousPasses === 0 };
  return stop !== undefined && result.label !== "Worse on eval" ? refuse(stop) : finish(result);
}
