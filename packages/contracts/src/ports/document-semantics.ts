// Port lane W0: the rules of the document store, as plain functions.
//
// Every adapter must give the same answers, so the rules are written once. The in-memory fake uses these functions, and a SQLite
// adapter may too (read the document inside its own transaction, call these, write the result). A DynamoDB adapter translates
// conditions and updates into its expression language and is held to the same answers by the conformance suite.
import {
  DOCUMENT_STORE_LIMITS,
  DocumentStoreError,
  type AttributePath,
  type Condition,
  type DocumentKey,
  type IndexDefinition,
  type IndexSortRange,
  type SortKeyRange,
  type StoredDocument,
  type TransactItem,
  type UpdateOp,
} from "./document-store.js";
import type { JsonValue } from "./json.js";

const invalid = (message: string): DocumentStoreError => new DocumentStoreError("invalid_request", message);

/** Orders two strings by Unicode code point, which is the same as UTF-8 byte order and SQLite's BINARY collation. */
export function compareText(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Orders two numbers, or two strings; undefined for any other pair (different types do not compare). */
export function compareScalars(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return compareText(a, b);
  return undefined;
}

export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function isMap(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a path, or undefined. A document that is absent holds nothing. */
export function valueAt(document: StoredDocument | undefined, path: AttributePath): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const part of path) {
    if (!isMap(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Whether a condition holds for a document (undefined: the item does not exist). See `Condition` for the rules. */
export function evaluateCondition(document: StoredDocument | undefined, condition: Condition): boolean {
  switch (condition.op) {
    case "exists":
      return valueAt(document, condition.path) !== undefined;
    case "notExists":
      return valueAt(document, condition.path) === undefined;
    case "eq": {
      const found = valueAt(document, condition.path);
      return found !== undefined && deepEqual(found, condition.value);
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const order = compareScalars(valueAt(document, condition.path), condition.value);
      if (order === undefined) return false;
      return condition.op === "lt" ? order < 0 : condition.op === "lte" ? order <= 0 : condition.op === "gt" ? order > 0 : order >= 0;
    }
    case "beginsWith": {
      const found = valueAt(document, condition.path);
      return typeof found === "string" && found.startsWith(condition.prefix);
    }
    case "and":
      return condition.conditions.every((inner) => evaluateCondition(document, inner));
    case "or":
      return condition.conditions.some((inner) => evaluateCondition(document, inner));
    case "not":
      return !evaluateCondition(document, condition.condition);
  }
}

/** Whether a sort key is in a range. */
export function sortKeyInRange(sortKey: string, range: SortKeyRange | undefined): boolean {
  if (range === undefined) return true;
  switch (range.op) {
    case "eq": return compareText(sortKey, range.value) === 0;
    case "beginsWith": return sortKey.startsWith(range.prefix);
    case "between": return compareText(sortKey, range.low) >= 0 && compareText(sortKey, range.high) <= 0;
    case "lt": return compareText(sortKey, range.value) < 0;
    case "lte": return compareText(sortKey, range.value) <= 0;
    case "gt": return compareText(sortKey, range.value) > 0;
    case "gte": return compareText(sortKey, range.value) >= 0;
  }
}

/** Whether an index sort value is in a range (a value of a different type than the bound is outside it). */
export function indexSortInRange(value: string | number, range: IndexSortRange | undefined): boolean {
  if (range === undefined) return true;
  const order = (bound: string | number) => compareScalars(value, bound);
  switch (range.op) {
    case "eq": return order(range.value) === 0;
    case "between": { const low = order(range.low); const high = order(range.high); return low !== undefined && high !== undefined && low >= 0 && high <= 0; }
    case "lt": { const o = order(range.value); return o !== undefined && o < 0; }
    case "lte": { const o = order(range.value); return o !== undefined && o <= 0; }
    case "gt": { const o = order(range.value); return o !== undefined && o > 0; }
    case "gte": { const o = order(range.value); return o !== undefined && o >= 0; }
  }
}

/** Where a document sits in an index: its partition value and sort value, or undefined when it is not in the index. */
export function indexPlacement(index: IndexDefinition, document: StoredDocument): { partition: string; sort: string | number | undefined } | undefined {
  const partition = document[index.partitionAttribute];
  if (typeof partition !== "string") return undefined;
  if (index.sortAttribute === undefined) return { partition, sort: undefined };
  const sort = document[index.sortAttribute];
  return typeof sort === "string" || typeof sort === "number" ? { partition, sort } : undefined;
}

// ---- Validation ----

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export function assertValidKey(key: DocumentKey): void {
  for (const part of ["pk", "sk"] as const) {
    const value = (key as Partial<DocumentKey>)[part];
    if (typeof value !== "string" || value === "") throw invalid(`${part} must be a non-empty string`);
    if (utf8Length(value) > DOCUMENT_STORE_LIMITS.maxKeyBytes) throw invalid(`${part} is longer than ${DOCUMENT_STORE_LIMITS.maxKeyBytes} bytes`);
  }
}

function assertValidJson(value: unknown, depth: number, where: string): void {
  if (depth > DOCUMENT_STORE_LIMITS.maxDepth) throw invalid(`${where} is nested deeper than ${DOCUMENT_STORE_LIMITS.maxDepth} levels`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${where} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertValidJson(entry, depth + 1, `${where}[${index}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [name, entry] of Object.entries(value)) {
      if (name === "") throw invalid(`${where} has an attribute with an empty name`);
      assertValidJson(entry, depth + 1, `${where}.${name}`);
    }
    return;
  }
  throw invalid(`${where} is not plain JSON (undefined, a function, a date or a class instance)`);
}

/** Checks the key, that the value is plain JSON within the depth limit, and the size limit. */
export function assertValidDocument(document: StoredDocument): void {
  assertValidKey(document);
  assertValidJson(document, 0, "the document");
  if (utf8Length(JSON.stringify(document)) > DOCUMENT_STORE_LIMITS.maxDocumentBytes) throw invalid(`the document is larger than ${DOCUMENT_STORE_LIMITS.maxDocumentBytes} bytes`);
}

function assertValidPath(path: AttributePath): void {
  if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string" || part === "")) throw invalid("an attribute path has one or more non-empty parts");
}

export function assertValidOps(ops: readonly UpdateOp[]): void {
  if (ops.length === 0) throw invalid("an update has at least one change");
  for (const op of ops) {
    assertValidPath(op.path);
    if (op.path[0] === "pk" || op.path[0] === "sk") throw invalid("the key attributes cannot be changed");
    if (op.op === "set" || op.op === "setIfAbsent") assertValidJson(op.value, 1, "the new value");
    if (op.op === "add" && !Number.isFinite(op.amount)) throw invalid("add needs a finite number");
  }
}

/** Checks a transaction: size, no repeated key, valid steps. */
export function assertValidTransaction(items: readonly TransactItem[]): void {
  if (items.length === 0) throw invalid("a transaction has at least one step");
  if (items.length > DOCUMENT_STORE_LIMITS.maxTransactItems) throw invalid(`a transaction has at most ${DOCUMENT_STORE_LIMITS.maxTransactItems} steps`);
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.kind === "put" ? item.item : item.key;
    if (item.kind === "put") assertValidDocument(item.item);
    else assertValidKey(item.key);
    if (item.kind === "update") assertValidOps(item.ops);
    const id = `${key.pk}\u0000${key.sk}`;
    if (seen.has(id)) throw invalid("two steps of one transaction name the same key");
    seen.add(id);
  }
}

// ---- Applying an update ----

/** The document after applying `ops` to `document` (undefined: create it from `key`). Throws `invalid_request` for a bad path or type. */
export function applyUpdateOps(document: StoredDocument | undefined, key: DocumentKey, ops: readonly UpdateOp[]): StoredDocument {
  assertValidOps(ops);
  const next = structuredClone(document ?? { pk: key.pk, sk: key.sk });
  for (const op of ops) {
    const parents = op.path.slice(0, -1);
    const last = op.path[op.path.length - 1]!;
    let holder: JsonValue | undefined = next;
    for (const part of parents) {
      holder = isMap(holder) && Object.hasOwn(holder, part) ? holder[part] : undefined;
    }
    if (!isMap(holder)) {
      if (op.op === "remove") continue;
      throw invalid("the parent of that path does not exist or is not a map");
    }
    const current = Object.hasOwn(holder, last) ? holder[last] : undefined;
    switch (op.op) {
      case "set": holder[last] = structuredClone(op.value); break;
      case "setIfAbsent": if (current === undefined) holder[last] = structuredClone(op.value); break;
      case "remove": delete holder[last]; break;
      case "add":
        if (current !== undefined && typeof current !== "number") throw invalid("add needs a number");
        holder[last] = (current ?? 0) + op.amount;
        break;
    }
  }
  assertValidDocument(next);
  return next;
}
