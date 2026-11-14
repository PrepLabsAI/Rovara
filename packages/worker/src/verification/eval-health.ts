import { evalSpendInputsDigest, EVAL_QUESTION_LIMIT, MeasuresFileSchema, evalBaseCacheKey, inertEvidenceText, isEvalBaseAttestation, type EvalQuestionSamples, type BaseScoreCache, type EvalBaseAttestation, type EvalBaseCacheKeyParts, type MeasuresFile } from "@agentx/contracts";
import type { EvalSpendApproval, MonthlyMeter, EvalMeterReservation } from "@agentx/contracts";
import { EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS, evalSettingsFingerprint, type EvalRoundInput } from "./eval-round.js";
import { evalHealthSensitivity, type EvalHealthSensitivity } from "./eval-health-power.js";
export interface EvalHealthInput {
  key: Omit<EvalBaseCacheKeyParts, "settingsFingerprint">;
  settings: EvalRoundInput["settings"];
  selection: string;
  questionIds: readonly string[];
  maxCallsPerQuestion: number;
  maxCostMicrosPerQuestion: number;
  limits?: { maxCalls?: number; maxCostMicros?: number };
  approval?: EvalSpendApproval;
  meter?: MonthlyMeter;
  cache: BaseScoreCache;
  run(request: { run: number; call: EvalMeterReservation["call"] }): Promise<{ measures: MeasuresFile; attestation: EvalBaseAttestation; seconds: number }>;
}
export type EvalHealthResult =
  | { status: "not_run"; message: string }
  | { status: "measured"; questionCount: number; passRate: number; flaky: string[]; callsPerRun: number[]; secondsPerRun: number[]; perQuestion: true; baseline: "stored" | "refused"; sensitivity: EvalHealthSensitivity; summary: string };
const whole = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const refused = (message: string): EvalHealthResult => ({ status: "not_run", message: `Not run: ${message}.` });

/** Derive the same identity for cache reads, in-flight refreshes and measured writes. */
export function evalHealthKey(input: Pick<EvalHealthInput, "key" | "settings">): EvalBaseCacheKeyParts {
  return { ...input.key, settingsFingerprint: evalSettingsFingerprint(input.settings, input.key.judgePin ?? "") };
}

/** Trusted adapters only. The repository can supply results, never selection, approval or payer. */
export async function runEvalHealth(input: EvalHealthInput): Promise<EvalHealthResult> {
  if (input.approval === undefined || input.meter === undefined) return refused("eval approval and monthly meter are not connected");
  const ids = input.questionIds;
  const calls = 3 * ids.length * input.maxCallsPerQuestion;
  const costMicros = 3 * ids.length * input.maxCostMicrosPerQuestion;
  const maxCalls = input.limits?.maxCalls ?? EVAL_DEFAULT_CALL_BUDGET;
  const maxCost = input.limits?.maxCostMicros ?? EVAL_DEFAULT_COST_BUDGET_MICROS;
  if (ids.length === 0 || ids.length > EVAL_QUESTION_LIMIT || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || id.length === 0 || id.length > 160)) return refused("question inventory is incomplete");
  if (![calls, costMicros, maxCalls, maxCost, input.maxCallsPerQuestion, input.maxCostMicrosPerQuestion].every(whole) || input.maxCallsPerQuestion < 1 || input.maxCostMicrosPerQuestion < 1 || calls > maxCalls || costMicros > maxCost) return refused("the three runs exceed the call or cost cap");
  try {
    const key = evalHealthKey(input);
    evalBaseCacheKey(key);
    if (input.key.codeHash === undefined || input.key.judgePin === undefined || input.key.hiddenSetHash !== "none") return refused("a public eval needs its code hash and judge pin");
    const grant = await input.approval.read();
    if (grant === undefined || !["owner", "maintainer", "admin"].includes(grant.role) || grant.company !== input.key.company || grant.project !== input.key.project || grant.selection !== input.selection || grant.inputsDigest !== evalSpendInputsDigest({ evalSetHash: key.evalSetHash, judgePin: input.key.judgePin, modelVersion: key.modelVersion, model: key.model, catalogRowId: key.catalogRowId, commandFingerprint: key.commandFingerprint, settingsFingerprint: key.settingsFingerprint }) || grant.provider !== "customer" || grant.connected !== true || !whole(grant.maxCalls) || !whole(grant.maxCostMicros) || grant.maxCalls < calls || grant.maxCostMicros < costMicros) return refused("an owner, maintainer or admin must confirm the connected customer's call estimate");
    const reservation = await input.meter.reserve({ approval: grant, calls, costMicros });
    if (reservation === undefined) return refused("the monthly cap cannot fit these runs");
    let usedCalls = 0; let usedCost = 0; let dispatched = 0; let closed = false; let failed = false;
    const pending = new Set<Promise<unknown>>();
    const call: EvalMeterReservation["call"] = frame => {
      if (closed || failed || dispatched >= calls) return Promise.reject(new Error("eval call cap"));
      dispatched += 1;
      const work = (async () => {
        const result = await reservation.call(frame);
        if (result.calls !== 1 || !whole(result.costMicros) || result.class !== "ok") { failed = true; throw new Error("invalid eval usage"); }
        usedCalls += result.calls; usedCost += result.costMicros;
        if (usedCost > costMicros) { failed = true; throw new Error("eval cost cap"); }
        return result;
      })();
      pending.add(work);
      void work.then(() => pending.delete(work), () => { failed = true; pending.delete(work); });
      return work;
    };
    const saved = new Map<string, EvalQuestionSamples>(ids.map(id => [id, { id, samples: [] }]));
    const callsPerRun: number[] = []; const secondsPerRun: number[] = [];
    let measures: MeasuresFile | undefined;
    try {
      for (let run = 0; run < 3; run++) {
        const before = usedCalls;
        const output = await input.run({ run, call });
        await Promise.allSettled([...pending]);
        if (failed || usedCalls - before < 1) return refused("the provider did not complete the run");
        const parsed = MeasuresFileSchema.safeParse(output.measures);
        if (!parsed.success || parsed.data.questions === undefined || parsed.data.eval_set_hash !== input.key.evalSetHash || !isEvalBaseAttestation(output.attestation) || output.attestation.baseCommit !== input.key.baseCommit || !Number.isFinite(output.seconds) || output.seconds < 0) return refused("the main-branch run has no complete attested question results");
        measures = parsed.data;
        const rows = measures.questions!;
        if (rows.length !== ids.length || rows.some(q => !saved.has(q.id) || q.samples.length !== 1)) return refused("some questions were missing or repeated");
        for (const row of rows) saved.get(row.id)!.samples.push(row.samples[0]!);
        callsPerRun.push(usedCalls - before); secondsPerRun.push(output.seconds);
      }
    } finally {
      closed = true;
      await Promise.allSettled([...pending]);
      await reservation.close();
    }
    const questions = [...saved.values()];
    const passRate = questions.reduce((n, q) => n + q.samples.filter(s => s.pass).length, 0) / (3 * ids.length);
    const flaky = questions.filter(q => new Set(q.samples.map(s => JSON.stringify([s.pass, s.answer]))).size > 1).map(q => inertEvidenceText(q.id, 160));
    const baseline = await input.cache.write(key, { schemaVersion: 1, runnerSchemaVersion: 1, roundKind: "check_unsealed", recordedOn: new Date().toISOString().slice(0, 10), measures: measures!.measures, questions, caseCount: ids.length }, { writer: "rovara_base_round", baseCommit: input.key.baseCommit }).catch(() => "refused" as const);
    const sensitivity = evalHealthSensitivity(questions);
    return { status: "measured", sensitivity, questionCount: ids.length, passRate, flaky, callsPerRun, secondsPerRun, perQuestion: true, baseline,
      summary: `${ids.length} questions; ${(passRate * 100).toFixed(1)}% passed; ${flaky.length} gave different answers across three runs. ${sensitivity.smallestDropPoints === null ? "No tested drop reached 80% catch probability." : `Simulation estimate: the smallest tested drop caught at least 80% of the time was ${sensitivity.smallestDropPoints} points.`} ${sensitivity.additionalQuestionsFor20 === null ? "A 20-point catch was not reached within 1,000 comparable questions." : `${sensitivity.additionalQuestionsFor20} more comparable questions reach a 20-point catch in the simulation.`} Calls per run: ${callsPerRun.join(", ")}; seconds per run: ${secondsPerRun.join(", ")}. Per-question results are available for re-asks. ${baseline === "stored" ? "The three runs are saved as the old-code baseline." : "The baseline could not be saved."}` };
  } catch { return refused("the eval or its trusted setup capabilities could not be read"); }
}
