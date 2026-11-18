// The eval runner binding. The eval process runs in the check sandbox (an injected `EvalSandboxExec`: the model bridge and a
// sandbox exec in production, a script in tests). Its model traffic reaches `egress` and nothing else, and `egress` charges the
// metered stage's `call`. The exec never receives the reservation, a key, a payer or a scope it could read.
import {
  EVAL_QUESTION_LIMIT, MODEL_EGRESS_REFUSAL_HEADER, MODEL_EGRESS_SCHEMES, evalFactsAllRun, isEvalBaseAttestation,
  type EvalBaseAttestation, type EvalMeterReservation, type EvalStandInCounts, type ModelEgress, type ModelEgressEvent, type ModelEgressScope,
} from "@agentx/contracts";
import type { EvalFinalCheckPorts } from "./eval-final-check.js";
import { EvalSandboxRunFailure, runFailureOf } from "./eval-run-diagnostic.js";
import type { EvalReportLocation } from "./eval-round.js";

export interface EvalSandboxRequest {
  readonly side: "old" | "new";
  readonly ids: readonly string[];
  readonly runs: 1 | 2 | 3;
  /** The only way the eval's model calls leave the sandbox. */
  readonly egress: ModelEgress;
  /** Opaque and made here; the bridge passes it back to `egress` and reads nothing in it. */
  readonly scope: ModelEgressScope;
  readonly signal: AbortSignal;
}
export interface EvalSandboxResult {
  /** Where the eval wrote its measures file (A4's reader is the only reader). */
  readonly report: EvalReportLocation;
  /** Eval calls whose request carried a changed prompt, counted by the exec's own bridge ledger. */
  readonly changedPromptCalls: number;
  /** For the old side only: made by `attestRovaraOnlyBaseCheckout` after the exec ran the base commit in a Rovara-only checkout. */
  readonly attestation?: EvalBaseAttestation | undefined;
  /** L4-E56: only when the round has stand-ins: whether this run hit a gap (a made-up answer) and the round's counts as they stand. */
  readonly standIns?: { readonly hitGap: boolean; readonly counts: EvalStandInCounts } | undefined;
}
export interface EvalSandboxExec {
  /** Runs the confirmed eval command for one side, then resolves only after the sandbox process and every call have joined, also on abort. Never reads the reservation. */
  run(request: EvalSandboxRequest): Promise<EvalSandboxResult>;
}

const stopped = (): Error => new Error("eval stage stopped");
const enc = new TextEncoder();
/** What the client sees when the stage would not take its call: a 503 with the one refusal word; the cause is never repeated. */
function refusal(): ModelEgressEvent[] {
  return [
    { kind: "head", status: 503, headers: [["content-type", "application/json"], [MODEL_EGRESS_REFUSAL_HEADER, "not_allowed"]] },
    { kind: "chunk", bytes: enc.encode(JSON.stringify({ error: { message: "not run: the eval stage stopped" } })) },
    { kind: "settle", status: 503, class: "refused", refusal: "not_allowed", costMicros: 0, estimated: false },
  ];
}

/** A ModelEgress whose every call is the stage's metered `call`. The stage owns the hold, the ceilings and the classes. */
export function modelEgressFromEvalCall(call: EvalMeterReservation["call"]): ModelEgress {
  return {
    capabilities: { schemes: [...MODEL_EGRESS_SCHEMES] },
    async *forward(_scope, frame, options) {
      if (options?.signal?.aborted === true) { yield* refusal(); return; }
      let events: readonly ModelEgressEvent[] | undefined;
      try { events = (await call(frame)).events; } catch { events = undefined; }
      yield* events === undefined || events.length === 0 ? refusal() : events;
    },
  };
}

const location = (value: unknown): value is EvalReportLocation => typeof value === "object" && value !== null
  && typeof (value as EvalReportLocation).root === "string" && (value as EvalReportLocation).root.length > 0 && typeof (value as EvalReportLocation).cwd === "string" && typeof (value as EvalReportLocation).argument === "string"
  && ((value as EvalReportLocation).notBeforeMs === undefined || Number.isFinite((value as EvalReportLocation).notBeforeMs));

const isIds = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length >= 1 && value.length <= EVAL_QUESTION_LIMIT && value.every(id => typeof id === "string");

/** `EvalFinalCheckPorts["runner"]` over an exec. Runtime-checks both directions; the exec's own accounting is never used (the stage counts). */
export function createEvalRunner(exec: EvalSandboxExec): EvalFinalCheckPorts["runner"] {
  return async request => {
    if (typeof request !== "object" || request === null || !isIds(request.ids)) throw new Error("eval run unreadable");
    if (typeof exec?.run !== "function" || ![1, 2, 3].includes(request.runs)) throw new Error("eval run unreadable");
    if (request.signal.aborted) throw stopped();
    const ids = Object.freeze([...request.ids]);
    const scope = Object.freeze({}) as unknown as ModelEgressScope;
    let result: EvalSandboxResult;
    // A call the stage refused or failed reached the eval process as a 503 it may have written down as a failed question. Whatever it wrote is not a result.
    let refusedCall = false;
    const call: typeof request.call = frame => request.call(frame).catch((error: unknown) => { refusedCall = true; throw error; });
    try { result = await exec.run({ side: request.side, ids, runs: request.runs, egress: modelEgressFromEvalCall(call), scope, signal: request.signal }); }
    catch (error) {
      // L4-EVS: a failed install step or eval command carries its diagnostic (a fixed code, one allow-listed name, a redacted bounded tail) up to the check. When the stage refused or failed a model call the cause is the
      // call (the eval most likely crashed on the error it was handed), so no diagnostic is passed on and the stage's own reason stands.
      const failure = refusedCall ? undefined : runFailureOf(error);
      throw failure === undefined ? new Error("eval run failed") : new EvalSandboxRunFailure(failure);
    }
    if (refusedCall || request.signal.aborted) throw stopped();
    if (typeof result !== "object" || result === null || !location(result.report) || !Number.isSafeInteger(result.changedPromptCalls) || result.changedPromptCalls < 0) throw new Error("eval run unreadable");
    return {
      report: result.report, facts: evalFactsAllRun(ids.length * request.runs), calls: 0, costMicros: 0, changedPromptCalls: result.changedPromptCalls,
      ...(request.side === "old" && isEvalBaseAttestation(result.attestation) ? { attestation: result.attestation } : {}),
      ...(result.standIns === undefined || typeof result.standIns.hitGap !== "boolean" ? {} : { standIns: result.standIns }),
    };
  };
}
