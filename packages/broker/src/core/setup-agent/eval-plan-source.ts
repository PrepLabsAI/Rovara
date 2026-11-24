// DEC 253j(1): the broker's TRUSTED eval plan source, the `EvalPlanSources` the `eval-plan` callback answers a CHECKS run from (core/proof/eval-plan-delivery.ts).
//
// ONE CONSISTENT READ (EVAL-PLAN-SNAPSHOT): `read` reads the approved item and its plan once (`readApprovedEvalPlan`, both rows, bound to each other by digest) and answers the plan AND an
// approval bound to that same item's digest. A re-approval in between, of another item, gives no grant; the plan of one item is never paired with the grant of another.
//
//   plan      the stored EVAL_PLAN of this company's project, only while it is bound to an APPROVED eval spend item and unedited since (`readApprovedEvalPlan`). The run's own pinned base
//             (the operation's stored `workflowBase`, never the request) fills the per-task key parts the broker can know: the base commit and its code hash (`evalCodeHash`). The worker
//             computes the same parts and every question's base and head hash from the pinned candidate and checks them against this plan; a mismatch is not runnable.
//   approval  `createBoundEvalSpendCapabilities(registry, ...).approval` (#805) over the same item, bound to the same stored plan. Spend AUTHORITY comes only from the
//             `EvalReservationAdapter` the install bound at its `eval-reservation` plug-in point. Code binds none: the approval reads undefined and the eval reads
//             "spend not approved", with zero calls.
//   cache     this company's own base-score cache (`createDocumentBaseScoreCache`), read by the callback at the plan's own key.
//
// Every source answers only its own company: a scope naming another company is no answer. The optional baseline hint comes only from the broker's finished health claim.
import { createDocumentBaseScoreCache, evalBaseCacheKey, evalCodeHash, type AdapterRegistry, type BaseScoreCache, type DocumentStore, type OrgId } from "@agentx/contracts";
import { baselineParts, type EvalPlanRead, type EvalPlanRun, type EvalPlanScope, type EvalPlanSources } from "../proof/eval-plan-delivery.js";
import type { EvalEnvironmentSource } from "./eval-environment-source.js";
import type { SessionMembers } from "../sessions/access.js";
import { readEvalHealthRow } from "./eval-health-request.js";
import { readApprovedEvalPlan } from "./eval-spend.js";
import { createBoundEvalSpendCapabilities } from "./eval-reservation.js";

export interface EvalPlanSourceDeps {
  readonly store: DocumentStore;
  readonly companyId: OrgId;
  /** The install's adapters: the approval uses ONLY the adapter bound at the `eval-reservation` plug-in point (#805, `createBoundEvalSpendCapabilities`). Code binds none: no approval is ever answered, so no eval spends. */
  readonly registry: Pick<AdapterRegistry, "names" | "get">;
  /** The install's members, for the approver's current role. Absent: the local owner only. */
  readonly members?: SessionMembers | undefined;
  readonly log?: ((event: "eval_spend_approval_invalid" | "eval_plan_invalid") => void) | undefined;
  /**
   * L4-EVS2: the environment the sealed eval runs in (the project's saved image, else its approved install steps), read for the run's own company and project (`createEvalEnvironmentSource`). Absent: the plan is
   * answered with no environment (the bare worker image, as before).
   */
  readonly environment?: EvalEnvironmentSource | undefined;
  /** L4-EINT: what the project's evals reach, for the run's own company and project (`createEvalStandInDescriptorSource`). Absent: the answer has no stand-in field. */
  readonly standIns?: ((scope: EvalPlanScope) => Promise<unknown>) | undefined;
}

/** The base commit of the plan's repository in the run's own pin, or undefined: the plan's named repository, else the run's only one. */
export function baseOf(run: Pick<EvalPlanRun, "bases"> | undefined, repository: string | undefined): string | undefined {
  const bases = run?.bases;
  if (bases === undefined || bases.length === 0) return undefined;
  const found = repository === undefined ? (bases.length === 1 ? bases[0] : undefined) : bases.find(entry => entry.repositoryId === repository);
  return found !== undefined && /^[a-f0-9]{40}$/u.test(found.baseCommitSha) ? found.baseCommitSha : undefined;
}

export function createEvalPlanSources(deps: EvalPlanSourceDeps): EvalPlanSources {
  const table = { store: deps.store, companyId: deps.companyId, ...(deps.members === undefined ? {} : { members: deps.members }), ...(deps.log === undefined ? {} : { log: deps.log }) };
  return {
    async read(scope: EvalPlanScope, run: EvalPlanRun): Promise<EvalPlanRead | undefined> {
      if (scope.companyId !== deps.companyId) return undefined;
      const found = await readApprovedEvalPlan(table, scope.project);
      if (found === undefined) return undefined;
      // L4-EVH: a run made under one approved item (a health run's request) is answered by that item only.
      if (run.spendDigest !== undefined && found.spend.digest !== run.spendDigest) return undefined;
      const baseCommit = baseOf(run, found.plan.repository);
      if (baseCommit === undefined) return undefined;
      const { key, ...body } = found.plan;
      const spend = found.spend;
      // L4-EVS2: the environment of THIS company's project and the plan's own repository. Any fault is "no environment" (never a reason to withhold the plan).
      let environment: Awaited<ReturnType<EvalEnvironmentSource>>;
      try { environment = await deps.environment?.(scope, found.plan.repository); } catch { environment = undefined; }
      // L4-EINT: the stand-in descriptor of THIS company's project. Any fault is "none".
      let standIns: unknown;
      try { standIns = await deps.standIns?.(scope); } catch { standIns = undefined; }
      const plan = {
        company: deps.companyId, project: scope.project, ...body,
        key: { company: deps.companyId, project: scope.project, baseCommit, codeHash: evalCodeHash(baseCommit), judgePin: body.judgePin, ...key },
        planDigest: spend.plan.evalPlanDigest,
      };
      // The health run may have saved the versioned baseline. Offer only that exact plan's bound version;
      // the worker still matches its independently prepared set before using the delivered record.
      let baselineStandInSetVersion: string | undefined;
      if (deps.standIns !== undefined) {
        const health = await readEvalHealthRow(table, scope.project);
        const parts = baselineParts(plan);
        if (health?.state === "finished" && health.result?.saved === true && health.claim?.standInSetVersion !== undefined
          && parts !== undefined && evalBaseCacheKey(health.claim.parts) === evalBaseCacheKey(parts)) baselineStandInSetVersion = health.claim.standInSetVersion;
      }
      return {
        ...(baselineStandInSetVersion === undefined ? {} : { baselineStandInSetVersion }),
        ...(environment === undefined ? {} : { environment }),
        ...(standIns === undefined ? {} : { standIns }),
        plan,
        // The grant of exactly the item this plan was read with: its digest is bound, and its "current" plan is that item's (never a later read's).
        approval: createBoundEvalSpendCapabilities(deps.registry, { ...table, project: scope.project, digest: spend.digest,
          // Re-read at grant time: the same item must still be approved WITH its stored plan bound to it (a plan row lost or edited since gives no grant).
          current: async () => { const now = await readApprovedEvalPlan(table, scope.project); return now !== undefined && now.spend.digest === spend.digest ? spend.plan : undefined; } }).approval,
      };
    },
    cache(companyId: string): BaseScoreCache | undefined {
      return companyId === deps.companyId ? createDocumentBaseScoreCache(deps.store, { companyId: deps.companyId }) : undefined;
    },
  };
}
