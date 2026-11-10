// Design review stage: the model key of one reviewer slot (or the merge step) of a design-review operation.
//
// A design-review operation never has a model key of its own: every key request must name a slot of the binding the broker stored (`/v1/internal/model-access?slot=`), and gets a key minted for
// that (operation, slot) alone, able to call only that slot's resolved model (security S6 to S9, N4).
//
// ONE-SHOT: a slot's key is minted once per operation, with a life past the whole stage (`DESIGN_REVIEW_KEY_TTL_SECONDS`), and a second request for the same slot is REFUSED, not answered with the same
// or a new key. The proxy cannot return a key it minted, and the broker stores NO key secret anywhere: only the key id (a SHA-256, safe to store), its budget and a few facts. A well-behaved worker asks
// once per slot. A re-ask fails that slot closed: it is recorded on the slot's row (`askedAgain`), the slot's key is blocked at the proxy, and `designReviewKeyIds` no longer returns it, so the slot
// counts as "no result". One key per slot also keeps "the first call of this key" (the proxy's record that proves what a reviewer was sent) unambiguous.
//
// A slot's money is a fixed ceiling, allocated for the whole round in ONE conditional write at dispatch (`allocateSlotBudgets`); a slot's key can never be given more than its ceiling.
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, change, queryAll, when, type DesignReviewBinding, type DocumentStore, type ModelSelection, type OrgId } from "@agentx/contracts";
import type { OperationRecord } from "../task-flow/records.js";
import { designReviewKeyBudgets } from "./estimate.js";
import { designReviewPartition, SLOT_PACKET_TTL_SECONDS, SLOT_PATTERN } from "./packet-store.js";

/**
 * A slot's key lives for the whole stage: the stage limit is 40 minutes, a reviewer is asked for its key at the start of its run, and the key lives 20 minutes past the limit as a margin (60 minutes).
 * The proxy's own maximum for a key's life is 7 days (`model-proxy/protocol.ts`), so this is well inside it. The key is blocked and its hold released when the round is recorded; the life only bounds a key nobody closed.
 */
export const DESIGN_REVIEW_KEY_TTL_SECONDS = 60 * 60;
const KEY_ENTITY = "DESIGN_REVIEW_SLOT_KEY";
const ALLOCATION_ENTITY = "DESIGN_REVIEW_ALLOCATION";
const KEY_ID = /^[0-9a-f]{64}$/u;

/** What a slot of the stored binding is: a reviewer's or the merge step's, and the model it runs. */
export interface BindingSlot {
  keySlot: string;
  purpose: "reviewer" | "merge";
  role?: string;
  model: ModelSelection;
  modelRoute?: { alias: string; api: string; catalog: string } | undefined;
}

/** Looks a slot up in the STORED binding only (reviewers, and the merge step when it is a model). Anything else, malformed names included, is undefined. */
export function bindingSlotOf(binding: DesignReviewBinding, slot: string | null | undefined): BindingSlot | undefined {
  if (typeof slot !== "string" || !SLOT_PATTERN.test(slot)) return undefined;
  const reviewer = binding.reviewers.find((entry) => entry.keySlot === slot);
  if (reviewer !== undefined) return { keySlot: slot, purpose: "reviewer", role: reviewer.role, model: reviewer.model, modelRoute: reviewer.modelRoute };
  if (binding.merge !== undefined && binding.merge.keySlot === slot) return { keySlot: slot, purpose: "merge", model: binding.merge.model, modelRoute: binding.merge.modelRoute };
  return undefined;
}

const keyItem = (orgId: string, operationId: string, slot: string) => ({ pk: designReviewPartition(orgId, operationId), sk: `KEY#${slot}` });
const allocationItem = (orgId: string, operationId: string) => ({ pk: designReviewPartition(orgId, operationId), sk: "ALLOC" });

/** The slots of a binding, reviewers first and then the merge step when it is a model. */
export function bindingSlots(binding: DesignReviewBinding): BindingSlot[] {
  return [
    ...binding.reviewers.map((reviewer): BindingSlot => ({ keySlot: reviewer.keySlot, purpose: "reviewer", role: reviewer.role, model: reviewer.model, modelRoute: reviewer.modelRoute })),
    ...(binding.merge === undefined ? [] : [{ keySlot: binding.merge.keySlot, purpose: "merge" as const, model: binding.merge.model, modelRoute: binding.merge.modelRoute }]),
  ];
}

export interface SlotBudgetAllocationInput {
  orgId: OrgId;
  operationId: string;
  binding: DesignReviewBinding;
  /** What is left under the review's cap for this round (`designReviewKeyBudgets(...).roomUsd`, which already holds back `reservedUsd`). */
  reviewRoomUsd: number;
  /** What is left of the task's run limit for model spend (`taskRunRoomUsd`): the least of the stop-at limit and the test cap, less what the task's keys have spent in this window. */
  taskRoomUsd: number;
  nowMs: number;
}

export interface SlotBudgetAllocation {
  /** The most each slot's key may be given, by key slot. Their sum is at most `min(reviewRoomUsd, taskRoomUsd)`. */
  ceilings: Readonly<Record<string, number>>;
  totalUsd: number;
}

/**
 * Allocates the round's per-slot ceilings, in ONE conditional write (the first allocation of an operation wins; a second is refused). The sum of the ceilings is at most the review's room AND the task's remaining run
 * limit, so keys minted by slots at the same moment cannot together spend more than either. Slice B calls this at dispatch, BEFORE it stores the binding on the operation. Nothing is allocated (and the caller must
 * not dispatch: `not_run`) when either room is used up: BUDGET_EXCEEDED. A slot's key request reads this row and is given no key without it.
 */
export async function allocateSlotBudgets(deps: Pick<DocumentStore, "get" | "put" | "update" | "query">, input: SlotBudgetAllocationInput): Promise<SlotBudgetAllocation> {
  const slots = bindingSlots(input.binding);
  if (slots.length < 1 || new Set(slots.map((slot) => slot.keySlot)).size !== slots.length || slots.some((slot) => !SLOT_PATTERN.test(slot.keySlot))) throw agentXError("CONFIG_INVALID", "a design review needs valid, distinct key slots");
  const room = Math.min(input.reviewRoomUsd, input.taskRoomUsd);
  if (!Number.isFinite(room) || !(room > 0)) throw agentXError("BUDGET_EXCEEDED", "The design review has no budget left for this round.");
  // One equal share per slot, rounded down to a millionth of a dollar: the sum can only fall short of the room.
  const share = designReviewKeyBudgets({ capUsd: room, spentUsd: 0, reviewers: input.binding.reviewers.length, hasMergeModel: input.binding.merge !== undefined });
  const ceilings: Record<string, number> = {};
  for (const slot of slots) ceilings[slot.keySlot] = slot.purpose === "merge" ? share.mergeUsd : share.reviewerUsd;
  const totalUsd = Object.values(ceilings).reduce((sum, usd) => sum + usd, 0);
  if (!(share.reviewerUsd > 0) || totalUsd > room + 1e-9) throw agentXError("BUDGET_EXCEEDED", "The design review has no budget left for this round.");
  const written = await deps.put({
    item: { ...allocationItem(input.orgId, input.operationId), entityType: ALLOCATION_ENTITY, orgId: input.orgId, operationId: input.operationId, round: input.binding.round, ceilings, totalUsd, createdAt: input.nowMs,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.nowMs / 1000) + SLOT_PACKET_TTL_SECONDS },
    condition: when.absent(),
  });
  if (!written.applied) throw agentXError("CONFIG_INVALID", "this design-review operation already has its budgets allocated");
  return { ceilings, totalUsd };
}

/** The ceiling allocated to a slot, or undefined when the operation has no allocation (or one that does not name the slot): no key is minted then. */
export async function readSlotCeiling(deps: Pick<DocumentStore, "get" | "put" | "update" | "query">, scope: { orgId: OrgId; operationId: string; slot: string }): Promise<number | undefined> {
  const item = await deps.get(allocationItem(scope.orgId, scope.operationId));
  if (item === undefined || item.entityType !== ALLOCATION_ENTITY || item.orgId !== scope.orgId || item.operationId !== scope.operationId) return undefined;
  const ceilings = item.ceilings as Record<string, unknown> | undefined;
  const ceiling = ceilings === undefined || typeof ceilings !== "object" ? undefined : ceilings[scope.slot];
  return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined;
}

/** What is recorded of a slot's key: ids and facts only, never the key. */
export interface SlotKeyRecord {
  keyId: string;
  purpose: "reviewer" | "merge";
  budgetUsd: number;
  expiresAt: number;
  /** How many times the slot was asked for a key after the first. Above 0 the slot has failed closed. */
  askedAgain: number;
}

function recordOf(item: Record<string, unknown> | undefined, scope: { orgId: string; operationId: string; slot: string }): SlotKeyRecord | undefined {
  if (item === undefined || item.entityType !== KEY_ENTITY || item.orgId !== scope.orgId || item.operationId !== scope.operationId || item.keySlot !== scope.slot) return undefined;
  const { keyId, purpose, budgetUsd, expiresAt, askedAgain } = item;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId) || (purpose !== "reviewer" && purpose !== "merge") || typeof budgetUsd !== "number" || typeof expiresAt !== "number") return undefined;
  return { keyId, purpose, budgetUsd, expiresAt, askedAgain: typeof askedAgain === "number" && askedAgain > 0 ? askedAgain : 0 };
}

/** Whether the slot has a key row at all, damaged or not: any row means the slot's one key was already minted (or half-recorded), so the slot is closed. */
export async function slotKeyRowExists(deps: Pick<DocumentStore, "get" | "put" | "update" | "query">, scope: { orgId: OrgId; operationId: string; slot: string }): Promise<boolean> {
  return (await deps.get(keyItem(scope.orgId, scope.operationId, scope.slot))) !== undefined;
}

/** The record of the key already minted for a slot, or undefined when none was. */
export async function readSlotKeyRecord(deps: Pick<DocumentStore, "get" | "put" | "update" | "query">, scope: { orgId: OrgId; operationId: string; slot: string }): Promise<SlotKeyRecord | undefined> {
  return recordOf(await deps.get(keyItem(scope.orgId, scope.operationId, scope.slot)), scope);
}

export interface SlotKeyRecordInput {
  orgId: OrgId;
  operationId: string;
  slot: string;
  purpose: "reviewer" | "merge";
  round: number;
  keyId: string;
  expiresAt: number;
  budgetUsd: number;
  alias: string;
  nowMs: number;
}

/** Records the key just minted for a slot (its id and facts, never the key). False when the slot already has a key: the caller gives its own key back and the slot is asked-again. */
export async function putSlotKey(deps: Pick<DocumentStore, "put">, input: SlotKeyRecordInput): Promise<boolean> {
  const written = await deps.put({
    item: {
      ...keyItem(input.orgId, input.operationId, input.slot), entityType: KEY_ENTITY, orgId: input.orgId, operationId: input.operationId, keySlot: input.slot, purpose: input.purpose, round: input.round,
      keyId: input.keyId, expiresAt: input.expiresAt, budgetUsd: input.budgetUsd, alias: input.alias, createdAt: input.nowMs, askedAgain: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.nowMs / 1000) + SLOT_PACKET_TTL_SECONDS,
    },
    condition: when.absent(),
  });
  return written.applied;
}

/** Records that a slot was asked for a key again, and answers the key id of the key it already has (the caller blocks it). Undefined when the slot has no row. */
export async function recordSlotReask(deps: Pick<DocumentStore, "update">, scope: { orgId: OrgId; operationId: string; slot: string }, nowMs: number): Promise<string | undefined> {
  const result = await deps.update({ key: keyItem(scope.orgId, scope.operationId, scope.slot), ops: [change.add("askedAgain", 1), change.set("askedAgainAt", nowMs)], condition: when.present(), return: "new" });
  return result.applied ? recordOf(result.item, scope)?.keyId : undefined;
}

/**
 * The id a design-review operation's OWN key would have. None is ever minted (a request without a slot is refused, and nothing else hands the operation a key), so this is a placeholder that no real
 * key can equal. `verifyRound` still refuses a slot key that equals it, so the check is in place; the guarantee itself is the route's refusal.
 */
export const designReviewNoOperationKeyId = (operationId: string): string => createHash("sha256").update(`design-review:no-operation-key:${operationId}`).digest("hex");

export interface DesignReviewKeyIds {
  /** The ONE key id minted for each slot (reviewer slots and the merge slot), by key slot. A slot that was never asked for, or that was asked again (it failed closed), is NOT here: it has no result. */
  bySlot: ReadonlyMap<string, string>;
  /** The merge step's key id (`verifyRound`'s `mergeKeyId`), when the binding has a merge step and it asked once. */
  mergeKeyId?: string;
  /** The operation's own key (`verifyRound`'s `operationKeyId`): none is ever minted, so a placeholder no key can equal. */
  operationKeyId: string;
  /** The slots asked for a key more than once, with the key id each had (blocked at the proxy). They have no result, but their key may have spent: charge `budgetUsdBySlot` for them when nothing was measured. */
  askedAgain: ReadonlyMap<string, string>;
  /** What each minted key was capped at (at most its allocated ceiling), by key slot, for every slot with a key row including those that were asked again. */
  budgetUsdBySlot: ReadonlyMap<string, number>;
}

/**
 * What `verifyRound` needs of the keys: each reviewer's key (read it with `bySlot.get(reviewer.keySlot)`; a reviewer whose slot has no key never ran, or failed closed, and is not verified), the merge key, and the
 * operation key. Read from the rows written when the keys were minted, never from the worker. Any extra key minted in a race was blocked at once and never recorded, so it is not here.
 */
export async function designReviewKeyIds(deps: Pick<DocumentStore, "get" | "put" | "update" | "query">, operation: Pick<OperationRecord, "id" | "orgId" | "designReview">): Promise<DesignReviewKeyIds> {
  const bySlot = new Map<string, string>();
  const askedAgain = new Map<string, string>();
  const budgetUsdBySlot = new Map<string, number>();
  const binding = operation.designReview;
  if (operation.orgId !== undefined && binding !== undefined) {
    for (const item of await queryAll(deps, { pk: designReviewPartition(operation.orgId, operation.id), sk: { op: "beginsWith", prefix: "KEY#" } })) {
      if (typeof item.keySlot !== "string" || bindingSlotOf(binding, item.keySlot) === undefined) continue;
      const record = recordOf(item, { orgId: operation.orgId, operationId: operation.id, slot: item.keySlot });
      if (record === undefined) continue;
      budgetUsdBySlot.set(item.keySlot, record.budgetUsd);
      if (record.askedAgain > 0) askedAgain.set(item.keySlot, record.keyId);
      else bySlot.set(item.keySlot, record.keyId);
    }
  }
  const mergeKeyId = binding?.merge === undefined ? undefined : bySlot.get(binding.merge.keySlot);
  return { bySlot, ...(mergeKeyId === undefined ? {} : { mergeKeyId }), operationKeyId: designReviewNoOperationKeyId(operation.id), askedAgain, budgetUsdBySlot };
}
