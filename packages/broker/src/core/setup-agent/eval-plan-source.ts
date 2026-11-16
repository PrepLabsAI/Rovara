// DEC 253j(1): the broker's TRUSTED eval plan source, the `EvalPlanSources` the `eval-plan` callback answers a CHECKS run from (core/proof/eval-plan-delivery.ts).
//
//   plan      the stored EVAL_PLAN of this company's project, only while it is bound to an APPROVED eval spend item and unedited since (`readApprovedEvalPlan`). The run's own pinned base
//             (the operation's stored `workflowBase`, never the request) fills the per-task key parts the broker can know: the base commit and its code hash (`evalCodeHash`). The worker
//             computes the same parts and every question's base and head hash from the pinned candidate and checks them against this plan; a mismatch is not runnable.
//   approval  `createEvalSpendCapabilities(...).approval` over the same item, bound to the same stored plan. Spend AUTHORITY comes only from the injected `EvalReservationAdapter`
//             (Cloud F1e). Code has none: the approval reads undefined and the eval reads "spend not approved", with zero calls.
//   cache     this company's own base-score cache (`createDocumentBaseScoreCache`), read by the callback at the plan's own key.
//
// Every source answers only its own company: a scope naming another company is no answer. Nothing here reads the request.
import { createDocumentBaseScoreCache, evalCodeHash, type BaseScoreCache, type DocumentStore, type EvalReservationAdapter, type EvalSpendApproval, type OrgId } from "@agentx/contracts";
import type { EvalPlanRun, EvalPlanScope, EvalPlanSources } from "../proof/eval-plan-delivery.js";
import type { SessionMembers } from "../sessions/access.js";
import { createEvalSpendCapabilities, readApprovedEvalPlan } from "./eval-spend.js";

export interface EvalPlanSourceDeps {
  readonly store: DocumentStore;
  readonly companyId: OrgId;
  /** Cloud F1e's trusted reservation adapter. Absent (Rovara Code today): no approval is ever answered, so no eval spends. */
  readonly adapter?: EvalReservationAdapter | undefined;
  /** The install's members, for the approver's current role. Absent: the local owner only. */
  readonly members?: SessionMembers | undefined;
  readonly log?: ((event: "eval_spend_approval_invalid" | "eval_plan_invalid") => void) | undefined;
}

/** The base commit of the plan's repository in the run's own pin, or undefined: the plan's named repository, else the run's only one. */
function baseOf(run: EvalPlanRun | undefined, repository: string | undefined): string | undefined {
  const bases = run?.bases;
  if (bases === undefined || bases.length === 0) return undefined;
  const found = repository === undefined ? (bases.length === 1 ? bases[0] : undefined) : bases.find(entry => entry.repositoryId === repository);
  return found !== undefined && /^[a-f0-9]{40}$/u.test(found.baseCommitSha) ? found.baseCommitSha : undefined;
}

export function createEvalPlanSources(deps: EvalPlanSourceDeps): EvalPlanSources {
  const table = { store: deps.store, companyId: deps.companyId, ...(deps.members === undefined ? {} : { members: deps.members }), ...(deps.log === undefined ? {} : { log: deps.log }) };
  return {
    async plan(scope: EvalPlanScope, run: EvalPlanRun): Promise<unknown> {
      if (scope.companyId !== deps.companyId) return undefined;
      const found = await readApprovedEvalPlan(table, scope.project);
      if (found === undefined) return undefined;
      const baseCommit = baseOf(run, found.plan.repository);
      if (baseCommit === undefined) return undefined;
      const { key, ...body } = found.plan;
      return {
        company: deps.companyId, project: scope.project, ...body,
        key: { company: deps.companyId, project: scope.project, baseCommit, codeHash: evalCodeHash(baseCommit), judgePin: body.judgePin, ...key },
        planDigest: found.spend.plan.evalPlanDigest,
      };
    },
    approval(scope: EvalPlanScope): EvalSpendApproval | undefined {
      if (scope.companyId !== deps.companyId) return undefined;
      return createEvalSpendCapabilities({ ...table, project: scope.project, ...(deps.adapter === undefined ? {} : { adapter: deps.adapter }),
        // The current trusted plan is the approved item, only while its stored eval plan is still bound to it.
        current: async () => (await readApprovedEvalPlan(table, scope.project))?.spend.plan }).approval;
    },
    cache(companyId: string): BaseScoreCache | undefined {
      return companyId === deps.companyId ? createDocumentBaseScoreCache(deps.store, { companyId: deps.companyId }) : undefined;
    },
  };
}
