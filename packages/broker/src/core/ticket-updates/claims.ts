// The small pieces the ticket updates share: the claim on one update (a conditional write in the task's partition, with a lease), the counters of a limit (one conditional update each, given back when the write
// did not happen) and what a tracker's refusal means. Moved out of `handler.ts` unchanged so the one-shot comments and the ticket thread (`thread.ts`) use the same code.
import {
  AgentXError, INDEX_EXPIRY_ATTRIBUTE, TrackerWriteRefusedError, change, when,
  type DocumentKey, type HostScope, type OrgId,
} from "@agentx/contracts";
import type { TicketUpdatesDependencies } from "./handler.js";

export const CLAIM_LEASE_MS = 60_000;
export const KEPT_SECONDS = 400 * 86_400;

/** Whether a task of this company may be written about with a scope: a handler scoped to one company (hosted: its own Linear connection) never writes for a task of another company, whatever id it is handed. */
export function scopeCoversCompany(scope: HostScope, orgId: OrgId): boolean {
  return !("orgId" in scope) || scope.orgId === orgId;
}

export const hourOf = (now: number): string => new Date(now).toISOString().slice(0, 13);

export const claimKey = (taskId: string, key: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: `TICKET_UPDATE#${key}` });

export async function claim(deps: TicketUpdatesDependencies, taskId: string, key: string): Promise<"claimed" | "done" | "busy"> {
  const now = deps.now();
  const written = await deps.store.put({
    item: { ...claimKey(taskId, key), entityType: "TICKET_UPDATE", state: "sending", leaseUntil: now + CLAIM_LEASE_MS, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + KEPT_SECONDS },
    condition: when.or(when.absent(), when.and(when.eq("state", "sending"), when.lt("leaseUntil", now))),
  });
  if (written.applied) return "claimed";
  const seen = await deps.store.get(claimKey(taskId, key));
  return seen?.["state"] === "sending" ? "busy" : "done";
}

export async function settle(deps: TicketUpdatesDependencies, taskId: string, key: string, outcome: string): Promise<void> {
  await deps.store.update({ key: claimKey(taskId, key), ops: [change.set("state", "done"), change.set("outcome", outcome), change.remove("leaseUntil")] });
}

export async function release(deps: TicketUpdatesDependencies, taskId: string, key: string): Promise<void> {
  await deps.store.delete({ key: claimKey(taskId, key), condition: when.eq("state", "sending") }).catch(() => undefined);
}

/** Counts one write against a limit in one conditional update; false when the limit is used up. */
export async function countWithin(deps: TicketUpdatesDependencies, key: DocumentKey, max: number, expiresSeconds: number): Promise<boolean> {
  return (await deps.store.update({ key, ops: [change.add("count", 1), change.set(INDEX_EXPIRY_ATTRIBUTE, expiresSeconds)], condition: when.or(when.notExists("count"), when.lt("count", max)) })).applied;
}

/** Gives one count back (a write that did not happen). Never below zero. */
export async function giveBack(deps: TicketUpdatesDependencies, key: DocumentKey): Promise<void> {
  await deps.store.update({ key, ops: [change.add("count", -1)], condition: when.gt("count", 0) });
}

/** A refusal that will not pass by itself (the tracker's own "no"): the update is skipped, not tried again. A rate limit or a fault may pass and is thrown. */
export const isFinal = (error: unknown): boolean => error instanceof TrackerWriteRefusedError || (error instanceof AgentXError && error.statusCode < 500 && error.code !== "TOO_MANY_REQUESTS");
export const refusalOf = (error: unknown): string => (error instanceof TrackerWriteRefusedError ? error.reason : "refused");

