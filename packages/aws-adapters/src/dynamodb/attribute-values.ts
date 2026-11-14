// Convergence lane A1: JSON documents to DynamoDB attribute values and back.
//
// The mapping is the one the hosted product's DynamoDB document client writes by default, so a row written through this adapter is
// byte-for-byte the row the existing broker writes and reads (no data moves): text is `S`, a number is `N` (JavaScript's own
// `String(number)`), `true`/`false` is `BOOL`, `null` is `NULL`, an array is `L` and an object is `M`. Sets (`SS`, `NS`, `BS`) and
// bytes (`B`) have no JSON form; the port keeps the store small (owner decision 60, S2), so a row holding one is refused on read
// rather than silently changed into a list that a later write would store in a different type.
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DocumentStoreError, type JsonValue, type StoredDocument } from "@agentx/contracts";

/** An attribute value as the wire and the stream carry it: exactly one member set. */
export type WireValue = AttributeValue;
export type WireItem = Record<string, WireValue>;

/** Raised for a stored value the port cannot represent (a set, bytes, or a number JavaScript cannot hold). */
export class UnrepresentableValueError extends DocumentStoreError {
  constructor(readonly where: string, readonly found: string) {
    super("invalid_request", `${where} holds a DynamoDB ${found}, which the document store port does not represent (decision 60: one row per item instead of sets; text instead of bytes)`);
    this.name = "UnrepresentableValueError";
  }
}

export function toWire(value: JsonValue): WireValue {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toWire) };
  const map: WireItem = {};
  for (const [name, entry] of Object.entries(value)) map[name] = toWire(entry);
  return { M: map };
}

export function toWireItem(document: StoredDocument): WireItem {
  const item: WireItem = {};
  for (const [name, entry] of Object.entries(document)) item[name] = toWire(entry);
  return item;
}

export function fromWire(value: WireValue, where = "the item"): JsonValue {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) {
    const number = Number(value.N);
    // DynamoDB keeps 38 significant digits and JavaScript about 17. This reader takes any finite number as the nearest double. The hosted
    // broker's document client does not: it reads a number whose size is past 2^53 - 1 as a BigInt, or throws. So the store refuses to
    // write one by default (`DynamoDocumentStoreOptions.cloudReadableNumbers`), and a row it wrote stays readable by the hosted broker.
    if (!Number.isFinite(number)) throw new UnrepresentableValueError(where, "number JavaScript cannot hold");
    return number;
  }
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.L !== undefined) return value.L.map((entry, index) => fromWire(entry, `${where}[${index}]`));
  if (value.M !== undefined) {
    const map: { [key: string]: JsonValue } = {};
    for (const [name, entry] of Object.entries(value.M)) map[name] = fromWire(entry, `${where}.${name}`);
    return map;
  }
  if (value.SS !== undefined) throw new UnrepresentableValueError(where, "string set");
  if (value.NS !== undefined) throw new UnrepresentableValueError(where, "number set");
  if (value.BS !== undefined) throw new UnrepresentableValueError(where, "binary set");
  if (value.B !== undefined) throw new UnrepresentableValueError(where, "binary value");
  throw new UnrepresentableValueError(where, "value of an unknown type");
}

export function fromWireItem(item: WireItem): StoredDocument {
  const document: { [key: string]: JsonValue } = {};
  for (const [name, entry] of Object.entries(item)) document[name] = fromWire(entry, name);
  if (typeof document.pk !== "string" || typeof document.sk !== "string") throw new DocumentStoreError("unavailable", "a stored item has no text pk and sk");
  return document as StoredDocument;
}

/** True when the text holds a UTF-16 surrogate that is not part of a pair. DynamoDB stores UTF-8, which cannot hold one. */
export function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

/** Refuses a lone surrogate anywhere in a value: in text and in attribute names. */
export function assertWellFormedText(value: JsonValue, where: string): void {
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new DocumentStoreError("invalid_request", `${where} holds an unpaired surrogate, which DynamoDB cannot store`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertWellFormedText(entry, `${where}[${index}]`));
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (hasLoneSurrogate(name)) throw new DocumentStoreError("invalid_request", `${where} has an attribute name with an unpaired surrogate`);
    assertWellFormedText(entry, `${where}.${name}`);
  }
}

/** The largest number the hosted broker's document client reads as a JavaScript number (past it: a BigInt, or an error). */
export const CLOUD_READABLE_NUMBER_MAX = Number.MAX_SAFE_INTEGER;

/** Refuses a number whose size is past 2^53 - 1 anywhere in a value (`1e21` and `1e100` included), so the hosted broker can read it. */
export function assertCloudReadableNumbers(value: JsonValue, where: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > CLOUD_READABLE_NUMBER_MAX) throw new DocumentStoreError("invalid_request", `${where} is a number past 2^53 - 1, which the hosted broker cannot read back as a number`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCloudReadableNumbers(entry, `${where}[${index}]`));
    return;
  }
  for (const [name, entry] of Object.entries(value)) assertCloudReadableNumbers(entry, `${where}.${name}`);
}
