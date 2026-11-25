// The production EvalApprovalSource and per-project eval budget the stage hold reads (product-eval.ts; PRODUCT-EVAL-APPROVAL-ADAPTER).
// Both come from the project's product-AI document in the product key table, written by Cloud's settings routes (signed write,
// project admin, audited) through ProductKeyStore.setEvalApproval / setEvalBudget. Strongly consistent reads, on
// every hold: a withdrawn approval or a lowered budget applies to the next hold.
//
// roleOf (PRODUCT-EVAL-APPROVER-REREAD): the gateway has no way to re-read a person's Code membership (Cloud asks Code as that
// person; the gateway holds no person's session). So an approval counts only while it is fresh and not withdrawn:
//   - fresh: the settings route checked the approver's role with Code at most EVAL_APPROVAL_FRESH_MS (15 minutes) before the
//     hold. Older, the hold answers eval_approval_stale and the approver must approve again (with a new role check);
//   - not withdrawn: when Cloud learns that the approver's membership or role changed (its member and invite routes), it
//     withdraws every approval they made up to then (ProductKeyStore.withdrawApprovals), read here with the approval.
// Anything unreadable fails the hold (the store throws: 503, nothing held). Never a guess.
import { EVAL_APPROVAL_FRESH_MS, type ProductKeyStore, type StoredEvalApproval } from "./product-keys.js";
import { EVAL_APPROVAL_STALE, type EvalApproval, type EvalApprovalSource, type EvalRole } from "./product-eval.js";

export { EVAL_APPROVAL_FRESH_MS };

type Reader = Pick<ProductKeyStore, "evalFor">;
/** The approval when the store says it counts now; "stale" when one is recorded but no longer counts; undefined when none. */
async function counted(store: Reader, iss: string, cid: string, project: string, now: number): Promise<StoredEvalApproval | typeof EVAL_APPROVAL_STALE | undefined> {
  const { approval, approvalState } = await store.evalFor(iss, cid, project);
  if (approval === undefined) return undefined;
  // The store's state, and this hold's own clock again (fail closed: both must say it counts).
  return approvalState === "current" && approval.approvedAt <= now && now - approval.approvedAt < EVAL_APPROVAL_FRESH_MS ? approval : EVAL_APPROVAL_STALE;
}

export function storedEvalApprovals(store: Reader, now: () => number = Date.now): EvalApprovalSource {
  return {
    async current(iss, cid, project): Promise<EvalApproval | typeof EVAL_APPROVAL_STALE | undefined> {
      const approval = await counted(store, iss, cid, project, now());
      if (approval === undefined || approval === EVAL_APPROVAL_STALE) return approval;
      return { selection: approval.selection, inputsDigest: approval.inputsDigest, maxCalls: approval.maxCalls, maxCostMicros: approval.maxCostMicros, ...(approval.model === undefined ? {} : { model: approval.model }), approver: { ...approval.approver } };
    },
    async roleOf(iss, cid, project, approver): Promise<EvalRole | undefined> {
      // Re-read (never cached): the same record, still counted, and still naming this approver.
      const approval = await counted(store, iss, cid, project, now());
      if (approval === undefined || approval === EVAL_APPROVAL_STALE || approval.approver.personId !== approver.personId || approval.approver.provider !== approver.provider) return undefined;
      return approval.role;
    },
  };
}
/** The project's eval budget per stage run: its own, else DEC 203's default. A failed read throws (503, nothing held). */
export function storedEvalBudget(store: Reader): (iss: string, cid: string, project: string) => Promise<{ calls: number; costMicros: number }> {
  return async (iss, cid, project) => {
    const { budget } = await store.evalFor(iss, cid, project);
    return budget === undefined ? { calls: 400, costMicros: 4_000_000 } : { calls: budget.calls, costMicros: budget.costMicros };
  };
}
