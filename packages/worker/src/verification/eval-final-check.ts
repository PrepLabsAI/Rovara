// Only trusted worker wiring supplies these ports. Nothing here binds a production model or payer.
import {
  EvalRequestSchema, EvalSpendInputsSchema, EvalRoundArtifactSchema, EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS,
  EVAL_QUESTION_LIMIT, evalSpendInputsDigest, evalBaseCacheKey, evalResultFromArtifact,
  type EvalRequest, type EvalSpendInputs, type EvalSpendGrant, type EvalSpendApproval, type MonthlyMeter, type EvalMeterReservation,
  type EvalRoundArtifact, type EvalRoundKind, type EvalNotRunReason, type BaseScoreCache, type EvalRoundFacts,
} from "@agentx/contracts";
import { z } from "zod";
import { openMeteredStage } from "./eval-spend-guard.js";
import { runEvalRound, readEvalMeasures, evalSettingsFingerprint, type EvalRoundInput, type EvalQuestionPlan, type EvalRoundOutput } from "./eval-round.js";
import type { EvalBaselines } from "./eval-baseline-refresh.js";
import type { EvalHealthInput } from "./eval-health.js";

export interface EvalFinalCheckPlan {
  company: string; project: string; selection: string; inputs: EvalSpendInputs;
  key: EvalRoundInput["key"]; settings: EvalRoundInput["settings"]; evalSetHash: string; evalConfigured: boolean;
  judgePin: string; baselineJudgePin: string; baseEvalSetHash?: string; sameJudgeFamily?: boolean; subsetSupported: boolean;
  questions: EvalQuestionPlan["questions"]; maxCallsPerQuestion: number; maxCostMicrosPerQuestion: number;
}
export interface EvalFinalCheckPorts {
  roundKind?: EvalRoundKind;
  plan(): Promise<EvalFinalCheckPlan | undefined>;
  approval: EvalSpendApproval; meter: MonthlyMeter; cache: BaseScoreCache;
  baselines: Pick<EvalBaselines, "forTask">;
  /** Resolves only after the sandbox and every call have joined, including on abort. Bounded
   * provider deadlines are mandatory. Never returns repository-provided accounting as authority. */
  runner(this: void, request: { side: "old" | "new"; ids: readonly string[]; runs: 1 | 2 | 3; call: EvalMeterReservation["call"]; signal: AbortSignal }): ReturnType<EvalQuestionPlan["run"]>;
}
export interface EvalFinalCheckFacts { status: string; candidateDigest: string; signal: AbortSignal }
const whole = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const planSchema = z.object({
  company: z.string().min(1).max(100), project: z.string().min(1).max(200), selection: z.string().min(1).max(512), inputs: EvalSpendInputsSchema,
  key: z.object({ company: z.string(), project: z.string(), baseCommit: z.string(), codeHash: hash.optional(), judgePin: hash.optional(), commandFingerprint: hash, catalogRowId: z.string(), model: z.string(), modelVersion: z.string() }).strict(),
  settings: z.object({ imageDigest: z.string().max(2000), route: z.string().max(200) }).strict(), evalSetHash: hash, evalConfigured: z.boolean(),
  judgePin: hash, baselineJudgePin: hash, baseEvalSetHash: hash.optional(), sameJudgeFamily: z.boolean().optional(), subsetSupported: z.boolean(),
  questions: z.array(z.object({ id: z.string().min(1).max(160), category: z.enum(["ordinary", "safety", "refusal"]), baseHash: hash, headHash: hash }).strict()).max(EVAL_QUESTION_LIMIT),
  maxCallsPerQuestion: whole.min(1), maxCostMicrosPerQuestion: whole.min(1),
}).strict();
const grantSchema = z.object({ company: z.string(), project: z.string(), selection: z.string(), role: z.enum(["owner", "maintainer", "admin"]), inputsDigest: hash, provider: z.literal("customer"), connected: z.literal(true), maxCalls: whole.min(1).optional(), maxCostMicros: whole.min(1).optional() });
function validPlan(input: unknown): EvalFinalCheckPlan | undefined {
  // Bound arrays before schema traversal. All other arrays are rejected by the schema.
  if (typeof input !== "object" || input === null || !Array.isArray((input as EvalFinalCheckPlan).questions) || (input as EvalFinalCheckPlan).questions.length > EVAL_QUESTION_LIMIT) return undefined;
  const parsed = planSchema.safeParse(input); if (!parsed.success) return undefined;
  const { baseEvalSetHash, sameJudgeFamily, ...fields } = parsed.data;
  const { codeHash, judgePin, ...key } = fields.key;
  const p: EvalFinalCheckPlan = { ...fields, key: { ...key, ...(codeHash === undefined ? {} : { codeHash }), ...(judgePin === undefined ? {} : { judgePin }) }, ...(baseEvalSetHash === undefined ? {} : { baseEvalSetHash }), ...(sameJudgeFamily === undefined ? {} : { sameJudgeFamily }) };
  if (p.company !== p.key.company || p.project !== p.key.project || new Set(p.questions.map(q => q.id)).size !== p.questions.length) return undefined;
  const expected = { evalSetHash: p.evalSetHash, judgePin: p.judgePin, modelVersion: p.key.modelVersion, model: p.key.model, catalogRowId: p.key.catalogRowId, commandFingerprint: p.key.commandFingerprint, settingsFingerprint: evalSettingsFingerprint(p.settings, p.judgePin) };
  if (evalSpendInputsDigest(expected) !== evalSpendInputsDigest(p.inputs) || (p.key.judgePin !== undefined && p.key.judgePin !== p.judgePin)) return undefined;
  evalBaseCacheKey({ ...p.key, evalSetHash: p.baseEvalSetHash ?? p.evalSetHash, hiddenSetHash: "none", settingsFingerprint: p.inputs.settingsFingerprint });
  return p;
}
const failedFacts = (count: number, reason: EvalNotRunReason): EvalRoundFacts => ({ total: count, run: 0, notRun: count, byClass: { [reason === "cap" ? "cap" : "provider_error"]: count }, overrunStop: reason === "cap" });

/** All pre-reservation gates spend zero. Cancellation is joined by the injected runner; no work is
 * detached on a timer. The CHECKS host supplies its existing round stop signal and deadline. */
export async function runFinalCheckEval(request: EvalRequest | undefined, ports: EvalFinalCheckPorts | undefined, facts: EvalFinalCheckFacts): Promise<EvalRoundArtifact | undefined> {
  if (request === undefined) return undefined;
  const parsed = EvalRequestSchema.safeParse(request);
  const req = parsed.success ? parsed.data : { aiChange: true as const, reason: "eval_hint" as const, evalPass: 1 as const, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };
  const roundKind = ports?.roundKind === "check_sealed" || ports?.roundKind === "check_unsealed" ? ports.roundKind : "working";
  // An invalid binding cannot produce an artifact that another candidate could consume.
  if (typeof facts !== "object" || facts === null || !(facts.signal instanceof AbortSignal) || !hash.safeParse(facts.candidateDigest).success) return undefined;
  let plan: EvalFinalCheckPlan | undefined;
  let usedCalls = 0; let usedCost = 0; let costKnown = true;
  let closeFailed = false;
  const envelope = { schemaVersion: 1 as const, candidateDigest: facts.candidateDigest, roundKind, evalPass: req.evalPass } as const;
  const context = () => ({ aiChange: true, discovery: plan === undefined ? "unknown" as const : plan.evalConfigured ? "configured" as const : "not_configured" as const, previousPasses: (req.evalPass - 1) as 0 | 1 });
  const usage = () => ({ calls: usedCalls, ...(costKnown ? { costMicros: usedCost } : {}) });
  const refuse = (reason: EvalNotRunReason): EvalRoundArtifact => ({ ...envelope, outcome: "not_run", notRunReason: reason, context: context(), excluded: [], notices: [], usage: usage(), cache: "not_used", feedback: { notRun: true }, fixRequested: false, ...(plan === undefined ? {} : { evalConfigured: plan.evalConfigured }) });
  if (!parsed.success) return refuse("invalid_question_data");
  if (ports === undefined) return refuse("not_connected");
  if (roundKind === "working") return refuse("needs_fresh_sandbox");
  if (facts.status !== "verified") return refuse("checks_failed");
  if (facts.signal.aborted) return refuse("stopped");
  try { plan = validPlan(await ports.plan()); } catch { return refuse("not_connected"); }
  if (plan === undefined) return refuse("not_connected");
  const p = plan;
  const finish = (output: EvalRoundOutput): EvalRoundArtifact => {
    if (output.status !== "done" || output.evidence === undefined) return refuse("invalid_question_data");
    if (facts.signal.aborted && output.result.label !== "Worse on eval") return refuse("stopped");
    if (closeFailed && output.result.label !== "Worse on eval") return refuse("provider_error");
    const artifact = { ...envelope, outcome: output.result.outcome === "ran" ? "done" as const : "not_run" as const, ...(output.result.notRun === undefined ? {} : { notRunReason: output.result.notRun.reason }), ...output.evidence, context: context(), usage: usage(), cache: output.cache, evalConfigured: p.evalConfigured };
    const checked = EvalRoundArtifactSchema.safeParse(artifact);
    if (!checked.success) return refuse("invalid_question_data");
    if (evalResultFromArtifact(checked.data).notRun?.reason === "invalid_question_data" && output.result.notRun?.reason !== "invalid_question_data") return refuse("invalid_question_data");
    const derived = evalResultFromArtifact(checked.data);
    const displayed = new Set(checked.data.questions?.filter(q => q.answers !== undefined).map(q => q.id));
    return { ...checked.data, fixRequested: derived.fixRequested, feedback: derived.outcome === "not_run" ? { notRun: true } : { questions: derived.questions.filter(q => displayed.has(q.id)).slice(0, 20).map(q => ({ ...q, oldAnswers: [...q.oldAnswers], newAnswers: [...q.newAnswers] })) } };
  };
  const input: EvalRoundInput = { tier: { reasons: [{ code: "eval_hint" }] }, trigger: { needed: true, reason: "changes" }, roundKind, key: p.key, settings: p.settings, evalSetHash: p.evalSetHash, evalConfigured: p.evalConfigured, cache: ports.cache };
  if (!p.evalConfigured) return finish(await runEvalRound(input));
  if (typeof ports.approval?.read !== "function" || typeof ports.meter?.reserve !== "function" || typeof ports.cache?.read !== "function" || typeof ports.cache?.write !== "function" || typeof ports.baselines?.forTask !== "function" || typeof ports.runner !== "function") return refuse("not_connected");
  let grant: EvalSpendGrant;
  try {
    const read = grantSchema.safeParse(await ports.approval.read());
    if (!read.success || read.data.company !== p.company || read.data.project !== p.project || read.data.selection !== p.selection || read.data.inputsDigest !== evalSpendInputsDigest(p.inputs)) return refuse("spend_not_approved");
    grant = { ...read.data, maxCalls: read.data.maxCalls ?? EVAL_DEFAULT_CALL_BUDGET, maxCostMicros: read.data.maxCostMicros ?? EVAL_DEFAULT_COST_BUDGET_MICROS };
  } catch { return refuse("spend_not_approved"); }
  const account = (stage: Awaited<ReturnType<typeof openMeteredStage>>) => {
    if (stage === undefined) return;
    const counted = stage.usage(); usedCalls += counted.calls;
    if (counted.costMicros === undefined) costKnown = false; else usedCost += counted.costMicros;
  };
  const fits = (calls: number, cost: number) => costKnown && Number.isSafeInteger(calls) && Number.isSafeInteger(cost)
    && req.callsAlreadyUsed + usedCalls + calls <= grant.maxCalls && req.costAlreadyUsedMicros + usedCost + cost <= grant.maxCostMicros;
  let baselineCapped = false; let baselineCalls = 0; let baselineCost = 0;
  const run: EvalQuestionPlan["run"] = async r => {
    const count = r.ids.length * r.runs;
    const noRun = (reason: EvalNotRunReason, calls = 0, costMicros = 0): Awaited<ReturnType<EvalQuestionPlan["run"]>> => ({ report: { root: "", cwd: "", argument: "", notBeforeMs: undefined }, facts: failedFacts(count, reason), calls, costMicros, changedPromptCalls: 0 });
    if (facts.signal.aborted) return noRun("stopped");
    if (!fits(count * p.maxCallsPerQuestion, count * p.maxCostMicrosPerQuestion)) return noRun("cap");
    const stage = await openMeteredStage({ grant, meter: ports.meter, calls: count * p.maxCallsPerQuestion, costMicros: count * p.maxCostMicrosPerQuestion });
    if (stage === undefined) return noRun("cap");
    let output: Awaited<ReturnType<EvalFinalCheckPorts["runner"]>> | undefined;
    try {
      output = await ports.runner({ ...r, signal: facts.signal, call: frame => facts.signal.aborted ? Promise.reject(new Error("eval stage stopped")) : stage.call(frame) });
    } catch { /* Only fixed refusal words leave this boundary. */ }
    finally {
      await stage.close();
      if (stage.callFailure() === undefined && stage.failure() !== undefined) closeFailed = true;
      account(stage);
    }
    const counted = stage.usage();
    if (output === undefined || stage.callFailure() !== undefined) return noRun(stage.failure() ?? "provider_error", counted.calls, counted.costMicros ?? NaN);
    return { ...output, calls: counted.calls, costMicros: counted.costMicros ?? NaN };
  };
  const healthInput: EvalHealthInput = { key: { ...p.key, evalSetHash: p.baseEvalSetHash ?? p.evalSetHash, hiddenSetHash: "none", judgePin: p.judgePin }, settings: p.settings, selection: p.selection,
    questionIds: p.questions.map(q => q.id), maxCallsPerQuestion: p.maxCallsPerQuestion, maxCostMicrosPerQuestion: p.maxCostMicrosPerQuestion, limits: { maxCalls: grant.maxCalls, maxCostMicros: grant.maxCostMicros }, approval: { read: async () => grant },
    meter: { reserve: async estimate => {
      if (!fits(estimate.calls, estimate.costMicros)) { baselineCapped = true; return undefined; }
      const stage = await openMeteredStage({ grant, meter: ports.meter, calls: estimate.calls, costMicros: estimate.costMicros });
      if (stage === undefined) { baselineCapped = true; return undefined; }
      let accounted = false;
      return { call: frame => facts.signal.aborted ? Promise.reject(new Error("eval stage stopped")) : stage.call(frame), close: async () => {
        await stage.close();
        if (!accounted) { accounted = true; account(stage); baselineCalls = usedCalls; baselineCost = costKnown ? usedCost : NaN; }
      } };
    } }, cache: ports.cache,
    run: async ({ call }) => {
      if (facts.signal.aborted) throw new Error("eval stage stopped");
      const started = Date.now();
      const output = await ports.runner({ side: "old", ids: p.questions.map(q => q.id), runs: 1, call, signal: facts.signal });
      const read = await readEvalMeasures(output.report);
      if (!read.ok || output.attestation === undefined) throw new Error("eval baseline unavailable");
      return { measures: read.measures, attestation: output.attestation, seconds: (Date.now() - started) / 1000 };
    },
  };
  try {
    const output = await runEvalRound({ ...input, questionPlan: { company: p.company, provider: "customer", connected: true, previousPasses: req.evalPass - 1,
      judgePin: p.judgePin, baselineJudgePin: p.baselineJudgePin, ...(p.baseEvalSetHash === undefined ? {} : { baseEvalSetHash: p.baseEvalSetHash }), ...(p.sameJudgeFamily === undefined ? {} : { sameJudgeFamily: p.sameJudgeFamily }), subsetSupported: p.subsetSupported,
      questions: p.questions, maxCallsPerQuestion: p.maxCallsPerQuestion, maxCostMicrosPerQuestion: p.maxCostMicrosPerQuestion, limits: { maxCalls: grant.maxCalls, maxCostMicros: grant.maxCostMicros },
      get callsAlreadyUsed() { return req.callsAlreadyUsed + baselineCalls; }, get costAlreadyUsedMicros() { return req.costAlreadyUsedMicros + baselineCost; }, run },
      prepareBaseline: async () => {
        const couldFit = fits(3 * p.questions.length * p.maxCallsPerQuestion, 3 * p.questions.length * p.maxCostMicrosPerQuestion);
        const state = await ports.baselines.forTask(healthInput);
        if (state === "unavailable" && !couldFit) baselineCapped = true;
        return state;
      },
    });
    return baselineCapped ? refuse(facts.signal.aborted ? "stopped" : "cap") : finish(output);
  } catch { return refuse(facts.signal.aborted ? "stopped" : "provider_error"); }
}
