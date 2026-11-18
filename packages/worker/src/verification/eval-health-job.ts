// L4-EVH (DEC 254zzz20 D5): the worker's side of the opt-in eval HEALTH RUN. One job, for one request and one claim the broker made: measure the project's evals on main three times (`runEvalHealth`) and give back the
// baseline they make, or a closed reason. The job has no say in anything that matters:
//   - the plan, the grant and the model access are the broker's (`EvalFinalCheckPorts`, bound exactly as a CHECKS run's are: the delivered plan, the grant of the request's own approved item, the gateway's whole-estimate
//     hold and the monthly meter); a missing or refused one is "not run", with no model call;
//   - the sandbox is the fresh check sandbox on main (the pinned candidate IS main's own commit), in the project's saved environment where it has one;
//   - the cache it hands `runEvalHealth` keeps nothing: it only catches the record the three runs made, which is returned to the broker. The broker checks it against its own plan and keeps it under its own key. This
//     worker never writes a baseline, and its result has no key, company, project, cost or payer in it.
// Never throws. Words are the broker's (`evalHealthNotRunWords`); nothing a repository or a provider said is in the result but the measured record itself.
import { EVAL_HEALTH_WORKER_REASONS, EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS, type BaseScoreCache, type EvalBaseRecord, type EvalHealthResultBody, type EvalSpendGrant, type PrepareEvalHealth } from "@agentx/contracts";
import { EVAL_PLAN_QUESTIONS_CHANGED, validPlan, type EvalFinalCheckPorts } from "./eval-final-check.js";
import { runEvalHealth, type EvalHealthInput } from "./eval-health.js";
import { readEvalMeasures } from "./eval-round.js";

export type EvalHealthJobPorts = Pick<EvalFinalCheckPorts, "plan" | "approval" | "meter" | "runner">;
const WORKER_REASONS: ReadonlySet<string> = new Set(EVAL_HEALTH_WORKER_REASONS);
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Measures the evals for one claim. Never throws: every failure is a closed not-run reason in the result. */
export async function runEvalHealthJob(job: PrepareEvalHealth, ports: EvalHealthJobPorts | undefined, signal: AbortSignal): Promise<EvalHealthResultBody> {
  const result = (r: EvalHealthResultBody["result"]): EvalHealthResultBody => ({ requestId: job.requestId, claimId: job.claimId, result: r });
  const notRun = (reason: (typeof EVAL_HEALTH_WORKER_REASONS)[number]): EvalHealthResultBody => result({ status: "not_run", reason });
  try {
    if (!(signal instanceof AbortSignal)) return notRun("unavailable");
    if (signal.aborted) return notRun("stopped");
    if (ports === undefined || typeof ports.plan !== "function" || typeof ports.approval?.read !== "function" || typeof ports.meter?.reserve !== "function" || typeof ports.runner !== "function") return notRun("not_connected");
    const answered = await ports.plan();
    if (answered === EVAL_PLAN_QUESTIONS_CHANGED) return notRun("questions_changed");
    const plan = validPlan(answered);
    if (plan === undefined || !plan.evalConfigured) return notRun("not_connected");
    let grant: EvalSpendGrant | undefined;
    try { grant = await ports.approval.read(); } catch { grant = undefined; }
    if (grant === undefined) return notRun("not_confirmed");
    // What the grant allows is the limit of the three runs; nothing else (the request's own estimate is not here at all).
    const limits = { maxCalls: whole(grant.maxCalls) ? grant.maxCalls : EVAL_DEFAULT_CALL_BUDGET, maxCostMicros: whole(grant.maxCostMicros) ? grant.maxCostMicros : EVAL_DEFAULT_COST_BUDGET_MICROS };
    let caught: EvalBaseRecord | undefined;
    // Catches the record the three runs made; keeps nothing. Reading finds nothing, so no earlier baseline stands in for the measurement.
    const cache: BaseScoreCache = { read: async () => undefined, write: async (_parts, record) => { caught = record; return "stored"; } };
    const ids = plan.questions.map(q => q.id);
    const input: EvalHealthInput = {
      key: { ...plan.key, evalSetHash: plan.baseEvalSetHash ?? plan.evalSetHash, hiddenSetHash: "none", judgePin: plan.judgePin }, settings: plan.settings, selection: plan.selection,
      questionIds: ids, maxCallsPerQuestion: plan.maxCallsPerQuestion, maxCostMicrosPerQuestion: plan.maxCostMicrosPerQuestion, limits,
      approval: { read: async () => grant }, meter: ports.meter, cache,
      run: async ({ call }) => {
        if (signal.aborted) throw new Error("eval stage stopped");
        const started = Date.now();
        const output = await ports.runner({ side: "old", ids, runs: 1, call, signal });
        const read = await readEvalMeasures(output.report);
        if (!read.ok || output.attestation === undefined) throw new Error("eval baseline unavailable");
        return { measures: read.measures, attestation: output.attestation, seconds: (Date.now() - started) / 1000 };
      },
    };
    const outcome = await runEvalHealth(input);
    if (signal.aborted) return notRun("stopped");
    if (outcome.status === "not_run") return notRun(WORKER_REASONS.has(outcome.reason) ? outcome.reason : "unavailable");
    return caught === undefined ? notRun("unavailable") : result({ status: "measured", record: caught });
  } catch { return notRun("unavailable"); }
}
