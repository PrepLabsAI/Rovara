// The worker's binding of the final-check eval (plan v3.2 row 20.2, EVAL-WIRE host binding). Everything trusted comes in as one
// injected capability set; this file only composes it into `EvalFinalCheckPorts` and refuses a set that is not whole.
//
// What each capability is in production, and what it is in tests:
//   plan        Rovara's confirmed setup selection, health record and head hash (broker-side; delivered to the worker)   | a plan object
//   approval    the persisted setup approval, re-read for current authority (F3e `createEvalSpendCapabilities`)          | a grant
//   cache       the company-scoped base-score cache                                                                       | in-memory
//   baselines   F3d `createEvalBaselines()` (post-merge refresh and the measuring mark)                                   | a fake
//   modelAccess the gateway's product route reached with the task token Code mints (#670), holding the whole estimate    | a script
//   exec        the sandbox exec behind the model bridge (F1-c) running the confirmed eval command for one side           | a script
// A set missing any capability binds nothing: the CHECKS request then reads "not run: not connected" with zero calls.
import type { BaseScoreCache, EvalRoundKind, EvalSpendApproval } from "@agentx/contracts";
import type { EvalBaselines } from "./eval-baseline-refresh.js";
import type { EvalFinalCheckPorts } from "./eval-final-check.js";
import { createEvalMeter, type EvalMeterOptions, type EvalModelAccess } from "./eval-model-access.js";
import { createEvalRunner, type EvalSandboxExec } from "./eval-runner.js";

export interface EvalHostCapabilities {
  /** The worker's own typed round kind; anything but a fresh check round reads "needs a fresh sandbox". */
  readonly roundKind?: EvalRoundKind | undefined;
  readonly plan: EvalFinalCheckPorts["plan"];
  readonly approval: EvalSpendApproval;
  readonly cache: BaseScoreCache;
  readonly baselines: Pick<EvalBaselines, "forTask">;
  readonly modelAccess: EvalModelAccess;
  readonly exec: EvalSandboxExec;
  readonly meter?: EvalMeterOptions | undefined;
}

const fn = (value: unknown): boolean => typeof value === "function";

/** The ports for one CHECKS invocation, or undefined when any capability is missing or not what it must be. Never throws. */
export function createEvalFinalCheckPorts(host: EvalHostCapabilities | undefined): EvalFinalCheckPorts | undefined {
  if (typeof host !== "object" || host === null) return undefined;
  if (!fn(host.plan) || !fn(host.approval?.read) || !fn(host.cache?.read) || !fn(host.cache?.write) || !fn(host.baselines?.forTask) || !fn(host.modelAccess?.hold) || !fn(host.exec?.run)) return undefined;
  return {
    ...(host.roundKind === undefined ? {} : { roundKind: host.roundKind }),
    plan: host.plan,
    approval: host.approval,
    cache: host.cache,
    baselines: host.baselines,
    meter: createEvalMeter(host.modelAccess, host.meter),
    runner: createEvalRunner(host.exec),
  };
}
