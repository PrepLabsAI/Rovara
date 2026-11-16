import { createHash } from "node:crypto";

// Transform values only; keep field names (including __proto__) intact.
function mapStrings<T>(value: T, transform: (text: string) => string): T {
  return JSON.parse(JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"(:)?/g, (lexeme: string, colon: string | undefined) =>
    colon === undefined ? JSON.stringify(transform(JSON.parse(lexeme) as string)) : lexeme)) as T;
}

// Shared by the T1 golden recorder and comparator. Only local JSON captures.
export function normalizeT1Golden<T>(value: T): T {
  const text = JSON.stringify(value);
  // Otherwise an invalid runtime hash could impersonate a recorded reference.
  if (/<hex[0-9]+#[0-9]+>/.test(text)) throw new Error("unsupported golden capture");
  const references = new Map<string, number>();
  // Include hashes embedded in partition keys and JSON strings. Length is part
  // of the marker, so a malformed digest cannot compare equal to a valid one.
  return mapStrings(value, (text) => text.replace(/[0-9a-f]{40,}/g, (raw) => {
    if (!references.has(raw)) references.set(raw, references.size + 1);
    return `<hex${raw.length}#${references.get(raw)!}>`;
  }));
}

// Legacy replay must store real-shaped hashes, including every embedded use
// of a reference. These synthetic values are created only at runtime.
export function materializeT1Golden<T>(value: T): T {
  return mapStrings(value, (text) => text.replace(/<hex([0-9]+)#[0-9]+>/g, (token, length: string) =>
    createHash("sha512").update(token).digest("hex").repeat(Math.ceil(Number(length) / 128)).slice(0, Number(length))));
}
