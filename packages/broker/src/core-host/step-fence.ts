// Engine host (lane E2): a step's fence tripping must never drop the step silently. The core's step start (core/task-flow/stage-machine.ts `acceptStep`) puts the items the access rule's
// `checkStep` returned into the step's own transaction; when one fails and nothing else explains it, it answers `STALE`, which a dispatch row reads as "no longer wanted" and drops, leaving a task
// that waits for a step nobody will start. A fence that tripped is not that: the person's role, grant or the task's people changed since the check, and the check must be asked again. So the
// items `checkStep` returns are marked here, and a transaction that fails on a marked item throws a retryable error instead: the dispatch row is rescheduled (it asks `checkStep` again, which
// passes with a fresh fence or refuses with its reason, visibly). Nothing else about the store changes.
import { agentXError, type DocumentStore, type TransactItem } from "@agentx/contracts";

const marked = new WeakSet<object>();

/** Marks the items a step check returned as its fence. Returns the same array. */
export function markStepFence<T extends readonly TransactItem[]>(items: T): T {
  for (const item of items) marked.add(item);
  return items;
}

/** Whether an item is one a step check marked as its fence. */
export const isStepFence = (item: object): boolean => marked.has(item);

export const STEP_FENCE_TRIPPED_WORDS = "a role, a grant or the task's people changed while its next step was starting; the step is checked again and started if it still may";

const wrapped = new WeakMap<object, object>();

/** The store, with a transaction that failed on a marked fence item thrown as retryable (`WORKSPACE_BUSY`). */
export function retryOnFenceTrip<S extends Pick<DocumentStore, "transact">>(store: S): S {
  const found = wrapped.get(store);
  if (found !== undefined) return found as S;
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property !== "transact") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return async (items: readonly TransactItem[]) => {
        const result = await target.transact(items);
        if (!result.applied && result.failed.some((index) => items[index] !== undefined && marked.has(items[index]))) throw agentXError("WORKSPACE_BUSY", STEP_FENCE_TRIPPED_WORDS);
        return result;
      };
    },
  });
  wrapped.set(store, proxy);
  return proxy;
}

/** The registry the flow is built over, whose storage adapter is the one above (every other point and method is the registry's own). */
export function withStepFenceRetry<R extends { require(point: never, name?: never): unknown }>(registry: R): R {
  return new Proxy(registry, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "require") return (point: string, name?: string) => {
        const found = (value as (point: string, name?: string) => unknown).call(target, point, name);
        return point === "storage" ? retryOnFenceTrip(found as Pick<DocumentStore, "transact">) : found;
      };
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
