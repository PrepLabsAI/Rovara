import { AsyncLocalStorage } from "node:async_hooks";
import type { ReadBudget } from "@agentx/contracts";

// Invocation-local: adapters keep their own caches and tenant checks. No budget can leak to another job.
const requests = new AsyncLocalStorage<ReadBudget | undefined>();
export function withHostRequests<T>(budget: ReadBudget, work: () => Promise<T>): Promise<T> {
  return requests.run(budget, work);
}

/** Count actual HTTP traffic, including installation/token requests and provider expansion, and cancel it at the phase deadline. */
export function guardedHostFetch(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const budget = requests.getStore();
    if (budget === undefined) return transport(input, init);
    budget.beforeRequest();
    budget.signal.throwIfAborted();
    const signal = AbortSignal.any([budget.signal, ...(init?.signal == null ? [] : [init.signal])]);
    return requests.run(undefined, () => transport(input, { ...init, signal }));
  };
}
