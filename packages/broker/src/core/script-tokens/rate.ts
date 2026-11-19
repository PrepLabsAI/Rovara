// Script tokens: fixed-window rate limits over the document store. One row per actor and kind, overwritten in place when a new window starts, so the rows stay bounded; the
// row's own TTL lets the store delete it once the window is long over. Same row shape as Cloud's `takeRateAt` (`windowStart`, `count`), written with the port's conditional updates.
import { INDEX_EXPIRY_ATTRIBUTE, change, indexExpiresAt, when, type DocumentKey, type DocumentStore } from "@agentx/contracts";

/** True while fewer than `limit` uses fall in the current window; counts this use when it does. */
export async function takeRate(store: DocumentStore, key: DocumentKey, limit: number, windowMs: number, now: () => number): Promise<boolean> {
  const window = Math.floor(now() / windowMs) * windowMs;
  const increment = async (): Promise<boolean> =>
    (await store.update({ key, ops: [change.add("count", 1)], condition: when.and(when.eq("windowStart", window), when.lt("count", limit)) })).applied;
  if (await increment()) return true;
  const started = await store.update({
    key,
    ops: [change.set("entityType", "TASK_RATE"), change.set("windowStart", window), change.set("count", 1), change.set(INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt(new Date(window).toISOString()))],
    condition: when.or(when.notExists("windowStart"), when.lt("windowStart", window)),
  });
  if (started.applied) return true;
  // Another request started this window between the two writes: count this one in it, once.
  return increment();
}
