function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A copy of `value` with every object's keys in alphabetical order, at every level; undefined members are dropped. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** JSON text that does not depend on key order: keys in alphabetical order at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Whether two values hold the same JSON content whatever the order of their keys. A value read back from DynamoDB
 * does not keep a map's attribute order, so comparing it with a fresh value by plain JSON text is wrong.
 */
export function sameJsonContent(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
