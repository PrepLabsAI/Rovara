// Predicates for the persisted facts shown by a close preview. Unrelated usage, comments and followers are intentionally outside the binding.
import { when, type Condition, type JsonValue, type StoredDocument, type TransactItem } from "@agentx/contracts";

export function closeFacts(document: StoredDocument | undefined, paths: readonly string[]): Condition {
  if (document === undefined) return when.absent();
  return when.and(when.present(), ...paths.map((path) => {
    let value: JsonValue | undefined = document;
    for (const part of path.split(".")) value = value !== null && typeof value === "object" && !Array.isArray(value) ? value[part] : undefined;
    return value === undefined ? when.notExists(path) : when.eq(path, value);
  }));
}

/** DynamoDB forbids a separate Check and Update for one key. Fold access/preview checks into its existing write. */
export function mergeCloseConditions(items: readonly TransactItem[]): TransactItem[] {
  const merged = new Map<string, TransactItem>();
  for (const item of items) {
    const key = item.kind === "put" ? item.item : item.key, name = JSON.stringify([key.pk, key.sk]);
    const prior = merged.get(name);
    if (prior === undefined) { merged.set(name, item); continue; }
    if (prior.kind !== "check" && item.kind !== "check") throw new Error("close plan has overlapping writes");
    const write = item.kind === "check" ? prior : item;
    const conditions = [prior.condition, item.condition].filter((c): c is Condition => c !== undefined);
    merged.set(name, { ...write, condition: when.and(...conditions) });
  }
  return [...merged.values()];
}
