import { whole } from "./model-gateway-token.js";
import { CORRECTION_RUN_MAX } from "./price-constants.js";
export interface PendingPage<T> { items: T[]; cursor?: string }
export type PendingPosition = readonly [number, string];
/** Opaque keyset cursors, scoped to the index. No offsets that shift when earlier rows close. */
export function pendingStart(ids: readonly string[], position: (id: string) => PendingPosition, scope: string, cursor?: string): number {
  if (cursor === undefined) return 0;
  let parsed: unknown;
  try { if (typeof cursor !== "string" || cursor.length > 8192) throw new Error(); parsed = JSON.parse(cursor); } catch { throw new Error("pending unavailable"); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope || !whole(parsed[1]) || typeof parsed[2] !== "string" || parsed[2].length === 0 || parsed[2].length > 4096) throw new Error("pending unavailable");
  const target: PendingPosition = [parsed[1], parsed[2]];
  let low = 0; let high = ids.length;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (comparePosition(position(ids[mid]!), target) <= 0) low = mid + 1; else high = mid; }
  return low;
}
export function comparePosition(a: PendingPosition, b: PendingPosition): number { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); }
export function pendingPage<T>(ids: readonly string[], position: (id: string) => PendingPosition, read: (id: string) => T, scope: string, limit: number, cursor?: string, before = Infinity): PendingPage<T> {
  if (!whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
  const start = pendingStart(ids, position, scope, cursor); const selected: string[] = [];
  let at = start;
  while (at < ids.length && selected.length < limit && position(ids[at]!)[0] < before) selected.push(ids[at++]!);
  const last = selected.at(-1); const more = at < ids.length && position(ids[at]!)[0] < before;
  return { items: selected.map(read), ...(more && last !== undefined ? { cursor: JSON.stringify([scope, ...position(last)]) } : {}) };
}
