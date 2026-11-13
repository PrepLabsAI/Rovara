// TE-F3-b (DECISIONS 170: "The holdout has limited checks per task, shows only pass/fail to the agent, and its questions rotate"). This is the answer to a hidden-set differencing attack: an agent that may ask "does this pass?" many
// times, with small edits in between, can learn which hidden questions it fails. Three limits stand against it:
//   1. a per-task check limit (default 3, never more than 5), counted when the check STARTS, before anything runs, by an atomic counter in the document store (a check that dies half way still counts; a store that is down denies);
//   2. the agent hears only pass, fail or not run (`evalGateAgentFeedback`): no score, no count, no reason, no category, not even which set failed. The limit makes that at most `limit` bits per task;
//   3. the holdout questions ROTATE: each check scores a different, keyed subset of the pool (`rotateHoldout`), chosen from a secret Rovara keeps, so two checks of one task, and two tasks, do not score the same questions.
// What is NOT here: a limit across tasks of one project (see the DEFERRED row).
import { companyScoped } from "./ports/company-scope.js";
import { type DocumentStore, when, change } from "./ports/document-store.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const HOLDOUT_CHECKS_PER_TASK_DEFAULT = 3;
export const HOLDOUT_CHECKS_PER_TASK_CEILING = 5;
const PARTITION = "EVALHOLDOUT";
const ID = /^[A-Za-z0-9._:-]{1,200}$/u;

export type HoldoutReservation = { readonly status: "allowed"; readonly checkIndex: number; readonly checksLeft: number } | { readonly status: "used_up" };
export interface HoldoutLedger {
  /** Takes one check for the task, before the check runs. */
  reserve(args: { readonly project: string; readonly task: string }): Promise<HoldoutReservation>;
}

/** The ledger over the document store's atomic conditional update, for one company. A store that throws, or an id that is not plain, is `used_up` (fail closed). */
export function createDocumentHoldoutLedger(store: Pick<DocumentStore, "update">, options: { readonly companyId: string; /** At most `HOLDOUT_CHECKS_PER_TASK_CEILING`. */ readonly limit?: number }): HoldoutLedger {
  const requested = options.limit;
  const limit = Number.isSafeInteger(requested) && (requested as number) >= 1 ? Math.min(HOLDOUT_CHECKS_PER_TASK_CEILING, requested as number) : HOLDOUT_CHECKS_PER_TASK_DEFAULT;
  return {
    async reserve(args) {
      if (!ID.test(args.project) || !ID.test(args.task)) return { status: "used_up" };
      try {
        const pk = companyScoped(options.companyId, PARTITION);
        const sk = `T#${args.project}#${args.task}`;
        const result = await store.update({
          key: { pk, sk }, ops: [change.add(["used"], 1)], condition: when.or(when.notExists(["used"]), when.lt(["used"], limit)), return: "new",
        });
        if (!result.applied) return { status: "used_up" };
        const used = result.item?.["used"];
        if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 1 || used > limit) return { status: "used_up" };
        return { status: "allowed", checkIndex: used - 1, checksLeft: limit - used };
      } catch {
        return { status: "used_up" };
      }
    },
  };
}

/**
 * The questions this check scores: the `size` pool questions that sort first by a keyed hash of (secret, task, check number, question id). The same inputs give the same subset; another task or another check number gives another one.
 * The secret is Rovara's and never reaches the agent. A size above the pool is the whole pool.
 */
export function rotateHoldout(args: { readonly poolIds: readonly string[]; readonly size: number; readonly taskId: string; readonly checkIndex: number; readonly secret: string }): string[] {
  if (typeof args.secret !== "string" || args.secret.length < 16 || !Number.isSafeInteger(args.size) || args.size < 1 || !Number.isSafeInteger(args.checkIndex) || args.checkIndex < 0) return [];
  const unique = [...new Set(args.poolIds)];
  const keyed = unique.map((id) => ({ id, key: sha256HexOf(new TextEncoder().encode(`rovara-holdout-rotation/v1\n${args.secret}\n${args.taskId}\n${String(args.checkIndex)}\n${id}`)) }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.id < right.id ? -1 : 1));
  return keyed.slice(0, args.size).map((entry) => entry.id);
}
