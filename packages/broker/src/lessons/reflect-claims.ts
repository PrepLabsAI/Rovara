// The lease on a reflection, in the document store: `LEARN#<org>#<task>#<outcome>` / `CLAIM`, expiring after 30 days (the store's expiry attribute, where it has one).: the item is a
// lease, not a once-only flag, so a fault that spent nothing can be tried again while nothing that may have reached the provider ever runs twice.
//
//   leaseState   running | retry | done | spent        attempt   1, 2, 3 (LESSONS_REFLECT_MAX_ATTEMPTS)
//   leaseUntil   epoch ms; a `running` lease past it belongs to a worker that died      attemptId   this attempt's id (the model keys it mints are tagged with it)
//   modelKeyIds  the model keys the running attempt minted (noted by `mintOperationKey`'s `recordOn`)
//   callStartedAt  epoch ms, written (conditional on the attempt) immediately BEFORE the model completion is called (re-check). A lease that has it is SPENT: the call may have reached the provider, and what it
//                cost is not knowable here (an unpriced route books $0; spend can land after the key was finalized), so the work is never run again. Only the in-VPC client's typed "not forwarded" refusal takes it back.
//
// `take` is the only way in:
//   - no item: written as attempt 1, running;
//   - `done` / `spent`: already (a redelivery, a second task-end call, the nightly re-send: nothing to do);
//   - `running` with a live lease: already (another worker has it);
//   - `retry`, or `running` past its lease, with `callStartedAt`: the item becomes `spent` and the work is never repeated, whatever the keys settled at;
//   - `retry`, or `running` past its lease, without it (the attempt failed before any call): the keys it minted are asked about too (`keysOutcome`, a second check only). Spent: the item becomes `spent`.
//     Not yet settled: wait (the message comes back later). Settled with nothing spent: attempt + 1, running, a new lease. The attempts are capped: past the cap the answer is `exhausted`.
// Every write is conditional on the attempt that was read (a lost race is `already`). The org is part of the key: a task id of another company can never use up this company's claim. The item holds the org,
// times, the state and key ids; nothing a person wrote.
import { LESSONS_REFLECT_LEASE_GRACE_SECONDS, LESSONS_REFLECT_MAX_ATTEMPTS, LESSONS_WORKER_TIMEOUT_SECONDS, change, when, type DocumentStore } from "@agentx/contracts";
import { randomUUID } from "node:crypto";

/** How long a claim is kept: far past the queue's 4 days of retention, so no redelivery of the same message can find the claim gone. */
export const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;
export const LEASE_MS = (LESSONS_WORKER_TIMEOUT_SECONDS + LESSONS_REFLECT_LEASE_GRACE_SECONDS) * 1000;

export const reflectClaimKey = (orgId: string, taskId: string, outcome: string) => ({ pk: `LEARN#${orgId}#${taskId}#${outcome}`, sk: "CLAIM" as const });

/** What a lease is taken on: a reflection's (org, task, outcome word), or a human edit's (org, task, `human_edit-<head commit>`, `humanEditLeaseOutcome`). */
export interface LeaseTarget { orgId: string; taskId: string; outcome: string }

export interface Lease {
  orgId: string;
  taskId: string;
  outcome: string;
  attempt: number;
  attemptId: string;
  key: { pk: string; sk: "CLAIM" };
}
export type TakeResult = { kind: "taken"; lease: Lease } | { kind: "already" } | { kind: "wait" } | { kind: "exhausted" };
export type FinishState = "done" | "retry" | "spent";

export interface ClaimStore {
  /** Takes the lease on this (org, task, outcome) for one attempt. Throws when the table could not be read or written (the message is then tried again). */
  take(message: LeaseTarget, nowMs: number): Promise<TakeResult>;
  /** Ends the attempt: `done` (never run again), `retry` (the next take decides by the keys), `spent` (never run again, money was spent). A no-op when the lease is no longer this attempt's. */
  finish(lease: Lease, state: FinishState, nowMs: number): Promise<void>;
  /** Writes `callStartedAt` on the lease, conditional on this attempt still holding it. Throws when it cannot (the model call is then not made). */
  markCallStarted(lease: Lease, nowMs: number): Promise<void>;
  /** Removes `callStartedAt` again (the call was refused before anything was sent). Throws when it cannot (the call then stays counted as made). */
  clearCallStarted(lease: Lease): Promise<void>;
}

export interface ReflectClaimDeps {
  store: DocumentStore;
  /** What became of the earlier attempt's model keys (`keysOutcome` of the spend ledger). */
  keysOutcome(orgId: string, keyIds: readonly string[]): Promise<"clear" | "spent" | "pending">;
  newAttemptId?: () => string;
}

export function documentReflectClaims(deps: ReflectClaimDeps): ClaimStore {
  const newAttemptId = deps.newAttemptId ?? randomUUID;
  const store = deps.store;
  const lease = (message: LeaseTarget, attempt: number, attemptId: string): Lease => ({ orgId: message.orgId, taskId: message.taskId, outcome: message.outcome, attempt, attemptId, key: reflectClaimKey(message.orgId, message.taskId, message.outcome) });
  /** The expiry attribute the store sweeps on, when it has one. */
  const expiry = (nowSeconds: number): Record<string, number> => (store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: nowSeconds + CLAIM_TTL_SECONDS });
  return {
    async take(message, nowMs) {
      const key = reflectClaimKey(message.orgId, message.taskId, message.outcome);
      const item = await store.get(key);
      const nowSeconds = Math.floor(nowMs / 1000);
      if (item === undefined) {
        const attemptId = newAttemptId();
        const written = await store.put({
          item: { ...key, entityType: "LEARN_CLAIM", orgId: message.orgId, leaseState: "running", attempt: 1, attemptId, leaseUntil: nowMs + LEASE_MS, claimedAt: nowSeconds, ...expiry(nowSeconds) },
          condition: when.absent(),
        });
        return written.applied ? { kind: "taken", lease: lease(message, 1, attemptId) } : { kind: "already" };
      }
      const state = item["leaseState"], attempt = Number(item["attempt"]), previousAttempt = item["attemptId"];
      if (typeof previousAttempt !== "string" || !Number.isInteger(attempt)) return { kind: "already" };
      // An item an older worker wrote (no state) is a once-only claim: it stays one.
      if (state !== "running" && state !== "retry") return { kind: "already" };
      if (state === "running" && Number(item["leaseUntil"]) >= nowMs) return { kind: "already" };
      const guard = when.and(when.eq("attemptId", previousAttempt), when.eq("leaseState", state));
      const spend = async (): Promise<TakeResult> => {
        await store.update({ key, ops: [change.set("leaseState", "spent")], condition: guard });
        return { kind: "already" };
      };
      // A call was started by the earlier attempt: it may have been billed, in a way no figure can rule out. Never run again.
      if (typeof item["callStartedAt"] === "number") return spend();
      const keyIds = Array.isArray(item["modelKeyIds"]) ? item["modelKeyIds"].filter((id): id is string => typeof id === "string") : [];
      const outcome = await deps.keysOutcome(message.orgId, keyIds);
      if (outcome === "pending") return { kind: "wait" };
      if (outcome === "spent") return spend();
      if (attempt >= LESSONS_REFLECT_MAX_ATTEMPTS) return { kind: "exhausted" };
      const attemptId = newAttemptId();
      const taken = await store.update({
        key,
        ops: [change.set("leaseState", "running"), change.set("attempt", attempt + 1), change.set("attemptId", attemptId), change.set("leaseUntil", nowMs + LEASE_MS), change.remove("modelKeyIds"), change.remove("callStartedAt")],
        condition: guard,
      });
      return taken.applied ? { kind: "taken", lease: lease(message, attempt + 1, attemptId) } : { kind: "already" };
    },
    async markCallStarted(held, nowMs) {
      // Not swallowed: a lease that is no longer this attempt's (or a store fault) means the call must not be made.
      const marked = await store.update({ key: held.key, ops: [change.set("callStartedAt", nowMs)], condition: when.and(when.eq("attemptId", held.attemptId), when.eq("leaseState", "running")) });
      if (!marked.applied) throw new Error("the reflection's lease is no longer this attempt's");
    },
    async clearCallStarted(held) {
      const cleared = await store.update({ key: held.key, ops: [change.remove("callStartedAt")], condition: when.and(when.eq("attemptId", held.attemptId), when.eq("leaseState", "running")) });
      if (!cleared.applied) throw new Error("the reflection's lease is no longer this attempt's");
    },
    async finish(held, state) {
      // The lease is no longer this attempt's (it ran past its lease and another worker took over): theirs to end.
      await store.update({ key: held.key, ops: [change.set("leaseState", state)], condition: when.and(when.eq("attemptId", held.attemptId), when.eq("leaseState", "running")) });
    },
  };
}
