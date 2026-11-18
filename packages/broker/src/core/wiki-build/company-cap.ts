// C-PC: durable build admission, using fields on the existing company workspace
// counter (orgLimitKey). Its workspace count is untouched. No new record kind.
// Ownership tokens prevent a delayed end/failure from releasing a reused slot.
import { randomUUID } from "node:crypto";
import { agentXError, change, orgLimitKey, when, type DocumentStore, type OrgId } from "@agentx/contracts";

const BUILDS_PER_COMPANY = 2;
export interface WikiCompanySlot { field: string; token: string }

export async function reserveWikiBuildSlot(store: Pick<DocumentStore, "update">, companyId: OrgId, project: string, now: number, until: number): Promise<WikiCompanySlot> {
  const token = randomUUID();
  for (let index = 0; index < BUILDS_PER_COMPANY; index += 1) {
    const field = `wikiBuildSlot${String(index)}`;
    const reserved = await store.update({
      key: orgLimitKey(companyId), ops: [change.set(field, { token, project, until }), change.set("entityType", "ORG_LIMIT")],
      condition: when.or(when.notExists(field), when.lt([field, "until"], now)),
    });
    if (reserved.applied) return { field, token };
  }
  throw agentXError("WORKSPACE_BUSY", "Two wiki builds are already running for this company. Try again after one finishes.");
}

export async function releaseWikiBuildSlot(store: Pick<DocumentStore, "update">, companyId: OrgId, slot: WikiCompanySlot): Promise<void> {
  // A corrupted pointer must never be able to remove an unrelated counter field.
  if (!/^wikiBuildSlot[01]$/u.test(slot.field)) return;
  await store.update({ key: orgLimitKey(companyId), ops: [change.remove(slot.field)], condition: when.eq([slot.field, "token"], slot.token) });
}
