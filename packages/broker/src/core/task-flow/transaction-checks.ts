import { when, type DocumentKey, type TransactItem } from "@agentx/contracts";

const keyOf = (item: TransactItem): DocumentKey => item.kind === "put" ? item.item : item.key;

/** Multiple readers may hold the same row: all their conditions must survive on one physical action. */
export function combinedChecks(items: readonly TransactItem[]): TransactItem[] {
  const result: TransactItem[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const index = result.findIndex((previous) => { const other = keyOf(previous); return key.pk === other.pk && key.sk === other.sk && (item.kind === "check" || previous.kind === "check"); });
    if (index < 0) { result.push(item); continue; }
    const previous = result[index]!;
    const action = item.kind === "check" ? previous : item;
    const conditions = [previous.condition, item.condition].filter((condition) => condition !== undefined);
    result[index] = { ...action, condition: when.and(...conditions) };
  }
  return result;
}

