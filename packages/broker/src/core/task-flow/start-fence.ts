// A start's fence: checks a caller adds to ONE start's own transaction (`startExtras`), for what it read before it started the task (the host's view of the company, or the chat link that says who
// is speaking). A start that finds one of them changed commits nothing. The context belongs to the call and its awaits, so concurrent starts never see each other's fences.
// Shared by the deployed host (core-host/core-runtime.ts) and the laptop (local/app/app.ts), so both apply a fence the same way.
import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactItem } from "@agentx/contracts";
import type { StartExtras, StartExtrasInput } from "./deps.js";

const startFences = new AsyncLocalStorage<readonly TransactItem[]>();

/** Runs a start (and anything it awaits) with these checks added to the start's own transaction. */
export function withStartFence<T>(items: readonly TransactItem[], run: () => Promise<T>): Promise<T> {
  return startFences.run(items, run);
}

/** The fence of the current call; empty outside `withStartFence`. */
export function startFenceItems(): readonly TransactItem[] {
  return startFences.getStore() ?? [];
}

/** A flow's `startExtras` that also carries the current call's fence, after the given extras' own items. */
export function withStartFenceExtras(given?: (input: StartExtrasInput) => StartExtras): (input: StartExtrasInput) => StartExtras {
  return (input) => {
    const own = given?.(input);
    return { ...(own ?? {}), items: [...(own?.items ?? []), ...startFenceItems()] };
  };
}
