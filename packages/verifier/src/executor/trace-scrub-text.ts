// Text helpers of the trace scrub (trace-scrub.ts): the spellings a JSON encoder may write a secret in, and the text a DOM snapshot shows.

/** The spellings of a secret in JSON from an encoder that escapes `& < > +` as `\uXXXX` (Go's encoding/json, .NET): both hex cases. Empty when the secret has none of those characters. */
export function htmlSafeJsonSpellings(secret: string): string[] {
  if (!/[&<>+]/u.test(secret)) return [];
  const escape = (hex: (code: string) => string) => JSON.stringify(secret).slice(1, -1).replace(/[&<>+]/gu, (char) => `\\u${hex(char.charCodeAt(0).toString(16).padStart(4, "0"))}`);
  return [escape((code) => code), escape((code) => code.toUpperCase())];
}

/**
 * The text a DOM snapshot shows, in order, with no tag names or attributes between the pieces (a secret a page rendered across sibling nodes is whole here, not in the line's JSON). A snapshot node is a
 * string (text) or `[tag, attributes, ...children]`; a node that is a reference to an earlier snapshot is a number pair and holds no text.
 */
export function snapshotTextOf(event: unknown): string {
  const html = event !== null && typeof event === "object" ? (event as { snapshot?: { html?: unknown } }).snapshot?.html : undefined;
  const pieces: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") pieces.push(node);
    else if (Array.isArray(node) && typeof node[0] === "string") for (const child of node.slice(2)) walk(child);
  };
  walk(html);
  return pieces.join("");
}
