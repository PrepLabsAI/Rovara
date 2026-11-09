// Lane L6a, task flow core: the workspace limits (Cloud's `developer/limits.ts`), rewritten onto the document store.
//
// Cloud keeps the tasks that hold a slot in a string set on the member's counter and tests it with `contains`. The port has no set operations
// (docs/ports.md, "What is not here"), so each charged task gets a marker item written with `when.absent()`, which also makes a repeated charge
// of one task fail instead of counting twice. That changes the stored form of the member counter (no `tasks` set): a decision for both owners.
import { change, when, type DocumentStore, type TransactItem } from "@agentx/contracts";
import { chargeMarkerKey, type CounterKey, type WorkspaceCharge } from "./keys.js";

export type ChargeConflict = "already_charged" | "member" | "organization";

const entityOf = (key: CounterKey): string => (key.pk.startsWith("DEVELOPER_LIMIT#") ? "DEVELOPER_LIMIT" : "ORG_LIMIT");
const hasRoom = (limit: number) => when.or(when.notExists("count"), when.lt("count", limit));

/** The steps that take one slot, at positions 0 (organization), 1 (member) and 2 (the task's marker): `chargeConflict` reads them by position. */
export function chargeItems(charge: WorkspaceCharge, limits: { member: number; organization: number }, taskId: string, now: string): TransactItem[] {
  return [
    { kind: "update", key: charge.organization, ops: [change.add("count", 1), change.set("entityType", entityOf(charge.organization))], condition: hasRoom(limits.organization) },
    { kind: "update", key: charge.member, ops: [change.add("count", 1), change.set("entityType", entityOf(charge.member))], condition: hasRoom(limits.member) },
    { kind: "put", item: { ...chargeMarkerKey(charge, taskId), entityType: "DEVELOPER_LIMIT_TASK", taskId, chargedAt: now }, condition: when.absent() },
  ];
}

/** The steps that give the slot back, once: the marker must still exist, so a repeated release fails instead of counting twice. */
export function releaseItems(charge: WorkspaceCharge, taskId: string): TransactItem[] {
  return [
    { kind: "update", key: charge.organization, ops: [change.add("count", -1)], condition: when.gte("count", 1) },
    { kind: "update", key: charge.member, ops: [change.add("count", -1)], condition: when.gte("count", 1) },
    { kind: "delete", key: chargeMarkerKey(charge, taskId), condition: when.present() },
  ];
}

/** Which counter is full, read before the start's transaction so the refusal can say so. */
export async function limitReached(store: Pick<DocumentStore, "get">, charge: WorkspaceCharge, limits: { member: number; organization: number }): Promise<"member" | "organization" | undefined> {
  const count = async (key: CounterKey): Promise<number> => {
    const item = await store.get(key);
    return typeof item?.count === "number" ? item.count : 0;
  };
  if (await count(charge.member) >= limits.member) return "member";
  if (await count(charge.organization) >= limits.organization) return "organization";
  return undefined;
}

/**
 * Classifies a failed `chargeItems` transaction from the steps that failed. A failed marker wins outright: the task already holds its slot,
 * whatever the counters say now (Cloud's `chargeConflict` ordering). Undefined when none of the charge steps failed.
 */
export function chargeConflict(failed: readonly number[], chargeStart: number): ChargeConflict | undefined {
  const at = (offset: number): boolean => failed.includes(chargeStart + offset);
  if (at(2)) return "already_charged";
  if (at(0)) return "organization";
  if (at(1)) return "member";
  return undefined;
}
