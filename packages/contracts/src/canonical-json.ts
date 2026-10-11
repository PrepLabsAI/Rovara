/**
 * A copy of `value` with every object's keys in alphabetical order, at every level; undefined members are dropped.
 * Only plain JSON is accepted: an object whose prototype is not Object.prototype or null (a Date, a Map, a class
 * instance) throws, because its keys do not say what it holds and two different ones would read as the same.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON accepts plain JSON values only");
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sortKeys(record[key])]));
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
