// TE-F3-b (part B): the worker's gated eval round (DECISIONS 170). It builds on eval-round.ts (the same reader, cache seam, hidden-set plan) and adds what the gate needs: per-question results of the head run and of Rovara's own
// REPEATED old-code runs, a holdout check that is counted before it starts and rotated, and an answer to the coding agent that is only pass, fail or not run.
//
// WHAT IT DOES
//   1. `planGatedEvalRound`, before the runner: the trigger; the holdout check is taken from the per-task ledger BEFORE anything runs (a check that dies half way still counts; a ledger that is down or used up stops the check); the hidden
//      set is planned by `planEvalRound` (sealed round only, read-only mount). A round that may not see the hidden set stops here with "no holdout".
//   2. `completeGatedEvalRound`, after the runner: reads the head's v2 measures through A4's reader; finds or measures the base (visible: no hidden set; holdout: the hidden set's hash). A cached base is used only when it holds
//      questions, was measured with the EXACT model version now in use and the plan's seed, and is within the maximum age; otherwise Rovara's own base round runs (old code only when the model version changed or the cache aged out).
//      Only an ATTESTED, clean (no case left unrun) base round is cached. The hash of the eval set is the one ROVARA computed from the files, never the head runner's word.
//   3. The gate (contracts: `evalGate`) gives the label and the words; the agent hears `evalGateAgentFeedback` only.
// It runs no model call (it is handed the facts of the calls) and mounts nothing (the mount spec goes back to the caller, for the sealed check sandbox's plan only). The hidden round must run on a throwaway copy of the workspace with
// the working sandbox paused, and its runner logs never go back to the agent: that is the caller's wiring (see the PR body).
import {
  EVAL_BASE_ROUND_KINDS, EVAL_MIN_QUESTIONS, EVAL_NOISE_K, evalBaseCacheKey, evalGate, evalGateAgentFeedback, evalGateStopped, evalSettingsFingerprint, normalizedQuestions, rotateHoldout,
  type BaseScoreCache, type EvalBaseAttestation, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalBaselineFacts, type EvalGateAgentFeedback, type EvalGateInput, type EvalGateMeasuresOnly, type EvalGateResult, type EvalGateSetData,
  type EvalRoundFacts, type EvalRoundKind, type EvalSettings, type EvalTaskBudget, type HiddenEvalMount, type HiddenEvalSetSource, type HoldoutLedger, type MeasuresFile,
} from "@agentx/contracts";
import { planEvalRound, readEvalMeasures, type EvalReportLocation, type EvalTrigger } from "./eval-round.js";

/**
 * Rovara's own base round for one set: the measures file it read (version 2, with every old-code run), the facts of its calls, Rovara's own hash of the eval files in the base checkout, and the runner's attestation that the round ran
 * in a Rovara-only checkout of the base commit with the working sandbox paused. Without a valid attestation the base is neither compared nor cached.
 */
export type GatedBaseRoundRead = { readonly ok: true; readonly measures: MeasuresFile; readonly caseCount: number; readonly facts: EvalRoundFacts; readonly evalSetHash: string; readonly attestation: EvalBaseAttestation } | { readonly ok: false };

export interface GatedSetInput {
  /** Where the head's measures file for this set is. */
  readonly report: EvalReportLocation;
  /** Rovara's own hash (`hashEvalDirectory`) of the eval files at the BASE commit; the cache key holds it. Never read from a runner's file. */
  readonly baseEvalSetHash: string;
  /** Rovara's own hash of the eval files in the HEAD. When it differs from the base's the change edited the eval, and the edit facts must say what (else the gate refuses: fail closed). */
  readonly headEvalSetHash: string;
  /** When the questions and their scoring were committed, UTC, and the questions the independent agent wrote. */
  readonly setCommittedAt: string;
  readonly independentQuestionIds?: readonly string[];
  /** Rovara's own base round (old code, the plan's number of runs and seed). Called only on a cache miss. */
  readonly runBaseRound: () => Promise<GatedBaseRoundRead>;
}
export interface GatedHoldoutInput extends GatedSetInput {
  /** Questions scored this check (the rotation takes this many from the pool). */
  readonly sampleSize: number;
  /** Rovara's rotation secret (never reaches the agent). */
  readonly rotationSecret: string;
}

export interface GatedEvalRoundInput {
  readonly trigger: EvalTrigger;
  readonly roundKind: EvalRoundKind;
  readonly project: string;
  readonly task: string;
  readonly key: Omit<EvalBaseCacheKeyParts, "evalSetHash" | "hiddenSetHash" | "settingsFingerprint">;
  /** How the eval is run besides what the plan fixes (runs, seed and repeats come from the plan): the pinned image and the route. Part of the cache key. */
  readonly settings: { readonly imageDigest: string; readonly route: string };
  /** The task's remaining budget, shared by the base and head rounds (see eval-gate-budget.ts); the caller hands `evalPacingLimitsFrom(budget)` to the pacer.  A round with no budget left is not started (and no holdout check is counted). */
  readonly budget?: EvalTaskBudget;
  readonly hashHiddenSet?: (hostPath: string) => Promise<string>;
  readonly cache: BaseScoreCache;
  readonly ledger: HoldoutLedger;
  readonly hiddenSet?: HiddenEvalSetSource;
  readonly visible: GatedSetInput;
  readonly holdout?: GatedHoldoutInput;
  /** Everything the gate takes except the two sets and the facts. */
  readonly gate: Omit<EvalGateInput, "visible" | "holdout" | "facts" | "baseline" | "holdoutChecks" | "measuresOnly">;
  /** The facts of the VISIBLE head round's model calls (counts only). */
  readonly facts: EvalRoundFacts;
  /** The facts of the HIDDEN head round's model calls (counts only; never shown while the task runs). Any case not run makes the whole holdout not run. */
  readonly holdoutFacts: EvalRoundFacts;
  readonly measuresOnly?: EvalGateMeasuresOnly;
  readonly maxAgeDays?: number;
  readonly today: () => string;
}

export type GatedEvalRoundPlan =
  | { readonly status: "ready"; readonly hiddenHash: string; readonly hiddenMount?: HiddenEvalMount; readonly checkIndex?: number; readonly hiddenRound: typeof HIDDEN_ROUND_REQUIREMENTS }
  | { readonly status: "stopped"; readonly output: GatedEvalRoundOutput };
export type GatedEvalRoundOutput =
  | { readonly status: "skipped"; readonly reason: EvalTrigger["reason"] }
  | { readonly status: "done"; readonly gate: EvalGateResult; readonly feedback: EvalGateAgentFeedback; readonly hiddenMount?: HiddenEvalMount; readonly cache: { readonly visible: BaseSource; readonly holdout?: BaseSource } };
type BaseSource = "hit" | "filled" | "not_filled" | "not_used";

/** What the caller must do for a hidden round (F3 part 1 enforces the first two in the sandbox plan): a throwaway copy of the workspace, the working sandbox paused, and nothing the runner printed going back to the agent. */
export const HIDDEN_ROUND_REQUIREMENTS = { throwawayWorkspaceCopy: true, pauseWorkingSandbox: true, returnRunnerOutputToAgent: false } as const;

const stopped = (detail: Parameters<typeof evalGateStopped>[0]): GatedEvalRoundOutput => {
  const gate = evalGateStopped(detail);
  return { status: "done", gate, feedback: evalGateAgentFeedback(gate), cache: { visible: "not_used" } };
};

/** Before the runner: the trigger, the holdout check taken from the ledger, and the hidden set (sealed round only). */
export async function planGatedEvalRound(input: Pick<GatedEvalRoundInput, "trigger" | "roundKind" | "project" | "task" | "hiddenSet" | "ledger" | "holdout" | "hashHiddenSet" | "budget">): Promise<GatedEvalRoundPlan> {
  if (!input.trigger.needed) return { status: "stopped", output: { status: "skipped", reason: input.trigger.reason } };
  // No budget left: nothing may run, and no holdout check is taken.
  if (input.budget !== undefined && !(Number.isSafeInteger(input.budget.calls) && input.budget.calls > 0 && Number.isSafeInteger(input.budget.micros) && input.budget.micros > 0)) return { status: "stopped", output: stopped("cap_hit") };
  // No holdout kept for this project: the gate cannot qualify anything, and nothing is counted or mounted.
  if (input.holdout === undefined || input.hiddenSet === undefined) return { status: "stopped", output: stopped("no_holdout") };
  const planned = await planEvalRound({ trigger: input.trigger, roundKind: input.roundKind, hiddenSet: input.hiddenSet, ...(input.hashHiddenSet === undefined ? {} : { hashHiddenSet: input.hashHiddenSet }) });
  if (planned.status === "stopped") return { status: "stopped", output: planned.output.status === "skipped" ? planned.output : stopped("no_holdout") };
  if (planned.hiddenMount === undefined) return { status: "stopped", output: stopped("no_holdout") };
  // Count the check BEFORE it runs.
  const taken = await input.ledger.reserve({ project: input.project, task: input.task });
  if (taken.status !== "allowed") return { status: "stopped", output: stopped("holdout_checks_used_up") };
  return { status: "ready", hiddenHash: planned.hiddenHash, hiddenMount: planned.hiddenMount, checkIndex: taken.checkIndex, hiddenRound: HIDDEN_ROUND_REQUIREMENTS };
}

interface BaseFound { readonly record: EvalBaseRecord; readonly source: BaseSource; readonly facts?: EvalRoundFacts }
const hasUsableQuestions = (record: EvalBaseRecord, seed: string | undefined, modelVersion: string): boolean => record.questions !== undefined && record.questions.length > 0 && record.seed === seed && record.modelVersion === modelVersion;

/** The base record for one set: from the cache when it can be used, else from Rovara's own base round (cached only when clean and attested). */
async function baseFor(args: { set: GatedSetInput; hiddenHash: string; key: GatedEvalRoundInput["key"]; settingsFingerprint: string; cache: BaseScoreCache; roundKind: EvalRoundKind; seed: string; today: string; maxAgeDays: number | undefined }): Promise<BaseFound | "unattested" | undefined> {
  const parts: EvalBaseCacheKeyParts = { ...args.key, evalSetHash: args.set.baseEvalSetHash, hiddenSetHash: args.hiddenHash, settingsFingerprint: args.settingsFingerprint };
  try {
    evalBaseCacheKey(parts);
  } catch {
    return undefined;
  }
  const cached = await args.cache.read(parts).catch(() => undefined);
  if (cached !== undefined && hasUsableQuestions(cached, args.seed, args.key.modelVersion)) return { record: cached, source: "hit" };
  let base: GatedBaseRoundRead;
  try {
    base = await args.set.runBaseRound();
  } catch {
    return undefined;
  }
  if (!base.ok) return undefined;
  // The base round counts only with the runner's attestation (a Rovara-only checkout of THIS base commit, the working sandbox paused), and only for the eval files Rovara hashed at the base commit.
  const attestation = base.attestation as Partial<EvalBaseAttestation> | undefined;
  if (attestation === undefined || attestation === null || attestation.checkout !== "rovara_only" || attestation.workingSandboxPaused !== true || attestation.baseCommit !== parts.baseCommit) return "unattested";
  if (base.evalSetHash !== args.set.baseEvalSetHash) return undefined;
  const record: EvalBaseRecord = {
    schemaVersion: 1, measures: base.measures.measures, caseCount: base.caseCount, recordedOn: args.today, roundKind: (EVAL_BASE_ROUND_KINDS as readonly string[]).includes(args.roundKind) ? (args.roundKind as EvalBaseRecord["roundKind"]) : "check_unsealed",
    runnerSchemaVersion: base.measures.schemaVersion, ...(base.measures.questions === undefined ? {} : { questions: base.measures.questions }), ...(base.measures.seed === undefined ? {} : { seed: base.measures.seed }), modelVersion: args.key.modelVersion,
  };
  let source: BaseSource = "not_filled";
  // Only a clean, attested base round, of a round kind that may write, fills the cache.
  if (base.facts.notRun === 0 && (EVAL_BASE_ROUND_KINDS as readonly string[]).includes(args.roundKind) && base.measures.questions !== undefined) {
    const written = await args.cache.write(parts, record, { writer: "rovara_base_round", baseCommit: parts.baseCommit }).catch(() => "refused" as const);
    if (written === "stored") source = "filled";
  }
  return { record, source, facts: base.facts };
}

const mergeFacts = (...all: readonly EvalRoundFacts[]): EvalRoundFacts => {
  const byClass: Partial<Record<keyof EvalRoundFacts["byClass"], number>> = {};
  let total = 0, run = 0, notRun = 0, overrunStop = false;
  for (const facts of all) {
    total += facts.total; run += facts.run; notRun += facts.notRun; overrunStop ||= facts.overrunStop;
    for (const [word, count] of Object.entries(facts.byClass)) { const key = word as keyof EvalRoundFacts["byClass"]; byClass[key] = (byClass[key] ?? 0) + (count ?? 0); }
  }
  return { total, run, notRun, byClass, overrunStop };
};

/** After the runner: the gate over the visible and holdout sets. */
export async function completeGatedEvalRound(input: GatedEvalRoundInput, plan: Extract<GatedEvalRoundPlan, { status: "ready" }>): Promise<GatedEvalRoundOutput> {
  const done = (gate: EvalGateResult, cache: { visible: BaseSource; holdout?: BaseSource }): GatedEvalRoundOutput => ({ status: "done", gate, feedback: evalGateAgentFeedback(gate), ...(plan.hiddenMount === undefined ? {} : { hiddenMount: plan.hiddenMount }), cache });
  const unreadable = (cache: { visible: BaseSource; holdout?: BaseSource } = { visible: "not_used" }): GatedEvalRoundOutput => done(evalGateStopped("inputs_unreadable"), cache);
  const gatePlan = input.gate.plan;
  if (input.holdout === undefined || gatePlan === undefined || plan.checkIndex === undefined) return unreadable();
  const holdoutInput = input.holdout;
  const today = input.today();
  let settingsFingerprint: string;
  try {
    const settings: EvalSettings = { runs: gatePlan.headRuns, seed: gatePlan.seed, repeats: gatePlan.baseRuns, k: EVAL_NOISE_K, minQuestions: EVAL_MIN_QUESTIONS, imageDigest: input.settings.imageDigest, route: input.settings.route };
    settingsFingerprint = evalSettingsFingerprint(settings);
  } catch {
    return unreadable();
  }
  const [visibleHead, holdoutHead] = await Promise.all([readEvalMeasures(input.visible.report), readEvalMeasures(holdoutInput.report)]);
  if (!visibleHead.ok || !holdoutHead.ok) return unreadable();
  const visibleBase = await baseFor({ set: input.visible, hiddenHash: "none", key: input.key, settingsFingerprint, cache: input.cache, roundKind: input.roundKind, seed: gatePlan.seed, today, maxAgeDays: input.maxAgeDays });
  const holdoutBase = await baseFor({ set: holdoutInput, hiddenHash: plan.hiddenHash, key: input.key, settingsFingerprint, cache: input.cache, roundKind: input.roundKind, seed: gatePlan.seed, today, maxAgeDays: input.maxAgeDays });
  const source = (found: BaseFound | "unattested" | undefined): BaseSource => (typeof found === "object" ? found.source : "not_filled");
  const cache = { visible: source(visibleBase), holdout: source(holdoutBase) };
  if (visibleBase === "unattested" || holdoutBase === "unattested") return done(evalGateStopped("base_round_unattested"), cache);
  if (visibleBase === undefined || holdoutBase === undefined) return unreadable(cache);

  const baseRows = (found: BaseFound) => normalizedQuestions({ questions: found.record.questions });
  const holdoutBaseRows = baseRows(holdoutBase);
  const selected = rotateHoldout({ poolIds: [...new Set(holdoutBaseRows.map((row) => row.id))], size: holdoutInput.sampleSize, taskId: input.task, checkIndex: plan.checkIndex, secret: holdoutInput.rotationSecret });
  if (selected.length === 0) return unreadable(cache);
  const visibleData: EvalGateSetData = {
    base: baseRows(visibleBase), head: normalizedQuestions(visibleHead.measures), baseSeed: visibleBase.record.seed, headSeed: visibleHead.measures.seed, setCommittedAt: input.visible.setCommittedAt,
    ...(input.visible.independentQuestionIds === undefined ? {} : { independentQuestionIds: input.visible.independentQuestionIds }),
  };
  const holdoutData: EvalGateSetData = {
    base: holdoutBaseRows, head: normalizedQuestions(holdoutHead.measures), baseSeed: holdoutBase.record.seed, headSeed: holdoutHead.measures.seed, setCommittedAt: holdoutInput.setCommittedAt, selectedQuestionIds: selected,
    ...(holdoutInput.independentQuestionIds === undefined ? {} : { independentQuestionIds: holdoutInput.independentQuestionIds }),
  };
  // The baseline is the OLDER of the two records, and both must be of the exact model version in use.
  const older = visibleBase.record.recordedOn <= holdoutBase.record.recordedOn ? visibleBase.record : holdoutBase.record;
  const sameVersion = visibleBase.record.modelVersion === holdoutBase.record.modelVersion;
  const baseline: EvalBaselineFacts = { modelVersionAtBase: sameVersion ? (older.modelVersion ?? "") : "", modelVersionNow: input.key.modelVersion, recordedOn: older.recordedOn, today, ...(input.maxAgeDays === undefined ? {} : { maxAgeDays: input.maxAgeDays }) };
  const factsOf = (found: BaseFound): EvalRoundFacts[] => (found.facts === undefined ? [] : [found.facts]);
  const facts = mergeFacts(input.facts, ...factsOf(visibleBase));
  const holdoutFacts = mergeFacts(input.holdoutFacts, ...factsOf(holdoutBase));
  // Rovara's own hashes of the eval files say whether the change touched them. If a hash moved, the edit facts must say what was edited; "nothing" does not square with it, so the edits are treated as unknown (fail closed).
  const hashesMoved = input.visible.baseEvalSetHash !== input.visible.headEvalSetHash || holdoutInput.baseEvalSetHash !== holdoutInput.headEvalSetHash;
  const said = input.gate.edits;
  const edits = hashesMoved && said !== undefined && said.status === "known" && said.editedQuestionIds.length === 0 && !said.scoringEdited && !said.thresholdsEdited ? { status: "unknown" as const } : said;
  const gate = evalGate({ ...input.gate, edits, visible: visibleData, holdout: holdoutData, facts, holdoutFacts, baseline, ...(input.measuresOnly === undefined ? {} : { measuresOnly: input.measuresOnly }) });
  return done(gate, cache);
}

/** Plans, then completes: for callers (and tests) with no step between the two. */
export async function runGatedEvalRound(input: GatedEvalRoundInput): Promise<GatedEvalRoundOutput> {
  const plan = await planGatedEvalRound(input);
  return plan.status === "stopped" ? plan.output : completeGatedEvalRound(input, plan);
}
