// A start's fence: checks a caller adds to ONE start's own transaction (`startExtras`), for what it read before it started the task (the host's view of the company, or the chat link that says who
// is speaking). A start that finds one of them changed commits nothing. The context belongs to the call and its awaits, so concurrent starts never see each other's fences.
// Shared by the deployed host (core-host/core-runtime.ts) and the laptop (local/app/app.ts), so both apply a fence the same way.
import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactItem } from "@agentx/contracts";
import type { StartExtras, StartExtrasInput } from "./deps.js";

/** The checks (and writes) a fence adds: fixed, or made from the start's own ids once it has them (a row that names the task, for one thread that may start only one). */
export type StartFence = readonly TransactItem[] | ((input: StartExtrasInput) => readonly TransactItem[]);

const startFences = new AsyncLocalStorage<StartFence>();

/** Runs a start (and anything it awaits) with these checks added to the start's own transaction. */
export function withStartFence<T>(items: StartFence, run: () => Promise<T>): Promise<T> {
  return startFences.run(items, run);
}

/** The fence of the current call; empty outside `withStartFence`. A fence given as a function is asked with this start's own ids. */
export function startFenceItems(input: StartExtrasInput): readonly TransactItem[] {
  const fence = startFences.getStore();
  if (fence === undefined) return [];
  return typeof fence === "function" ? fence(input) : fence;
}

/** A flow's `startExtras` that also carries the current call's fence, after the given extras' own items. */
export function withStartFenceExtras(given?: (input: StartExtrasInput) => StartExtras): (input: StartExtrasInput) => StartExtras {
  return (input) => {
    const own = given?.(input);
    return { ...(own ?? {}), items: [...(own?.items ?? []), ...startFenceItems(input)] };
  };
}
