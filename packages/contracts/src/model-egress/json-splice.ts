// TE-F1a: editing a JSON request body IN PLACE, as text. The proxy sets a maximum output on a request that names none, and must not change anything else about the bytes the client sent: big integers, number spelling (`1.0`, `1E2`,
// `-0`), key order, white space and duplicate or odd keys all stay exactly as they were. So the body is never parsed and written back; a small scanner finds the spans of a top-level object's members and the edit replaces one span
// or appends one member before the closing brace. Pure: no I/O.

export interface JsonMember {
  /** The decoded key. */
  readonly key: string;
  /** Where the value starts and ends (end exclusive), in the text. */
  readonly start: number;
  readonly end: number;
}

export interface JsonObjectSpan {
  readonly members: readonly JsonMember[];
  /** The index of the object's closing brace. */
  readonly close: number;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const skipSpace = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && WHITESPACE.has(text.charAt(index))) index += 1;
  return index;
};

/** The end (exclusive) of a string literal that starts at `from` (a quote), or -1. */
function stringEnd(text: string, from: number): number {
  let index = from + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") index += 2;
    else if (char === '"') return index + 1;
    else index += 1;
  }
  return -1;
}

/** The end (exclusive) of the JSON value that starts at `from`, or -1. Objects and arrays are skipped by depth, with strings read whole. */
function valueEnd(text: string, from: number): number {
  const first = text.charAt(from);
  if (first === '"') return stringEnd(text, from);
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = from;
    while (index < text.length) {
      const char = text.charAt(index);
      if (char === '"') {
        index = stringEnd(text, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return -1;
  }
  let index = from;
  while (index < text.length && !WHITESPACE.has(text.charAt(index)) && ![",", "}", "]"].includes(text.charAt(index))) index += 1;
  return index === from ? -1 : index;
}

/**
 * The members of the JSON object whose `{` is at `from`, in order (a duplicate key appears once per occurrence), and the index of its closing brace. Undefined when the text there is not a well-formed object. The caller has
 * already checked that the whole body is valid JSON (`JSON.parse`), so this scanner only has to be exact about spans.
 */
export function scanJsonObject(text: string, from: number): JsonObjectSpan | undefined {
  if (text.charAt(from) !== "{") return undefined;
  const members: JsonMember[] = [];
  let index = skipSpace(text, from + 1);
  if (text.charAt(index) === "}") return { members, close: index };
  for (;;) {
    if (text.charAt(index) !== '"') return undefined;
    const keyEnd = stringEnd(text, index);
    if (keyEnd < 0) return undefined;
    let key: string;
    try {
      key = JSON.parse(text.slice(index, keyEnd)) as string;
    } catch {
      return undefined;
    }
    index = skipSpace(text, keyEnd);
    if (text.charAt(index) !== ":") return undefined;
    index = skipSpace(text, index + 1);
    const end = valueEnd(text, index);
    if (end < 0) return undefined;
    members.push({ key, start: index, end });
    index = skipSpace(text, end);
    if (text.charAt(index) === ",") {
      index = skipSpace(text, index + 1);
      continue;
    }
    return text.charAt(index) === "}" ? { members, close: index } : undefined;
  }
}

export interface JsonEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The text with every edit applied, from the last position to the first so no edit moves another. Edits must not overlap. */
export function applyJsonEdits(text: string, edits: readonly JsonEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** The edit that appends `"key":value` as the last member of an object (a comma first when it has members). `valueText` is JSON text. */
export const appendMember = (object: JsonObjectSpan, key: string, valueText: string): JsonEdit => ({
  start: object.close,
  end: object.close,
  text: `${object.members.length > 0 ? "," : ""}${JSON.stringify(key)}:${valueText}`,
});
