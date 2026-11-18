// Real check on the customer's staging, RC2 (design real-check-security-design.md, 4.3 row 2): the two small readers the operation classifier needs, both strict and both failing closed.
//   - `parseGraphqlDocument`: a GraphQL document is a READ only when every operation in it is a `query` (or the anonymous `{ ... }` shorthand). A `mutation`, a `subscription`, a type-system definition, a document that
//     does not lex, one with unbalanced brackets or one with no operation at all is refused. The reader lexes strings, block strings and comments properly (a `mutation` inside one is text, not an operation) and
//     reads only the TOP LEVEL of the document: it never needs to understand a selection set, because nothing inside a `query` can start a mutation.
//   - `parseStrictJson`: JSON.parse, except that a repeated object key anywhere is a refusal. A body with two `query` members (or two `dryRun` members) is read one way by this check and another way by the server.
// Pure; nothing here imports a Node module. Every refusal is a fixed code, never the text that was read.

export const REAL_CHECK_GRAPHQL_LIMITS = { documentChars: 65_536, tokens: 20_000, depth: 64, jsonDepth: 32 } as const;

export type GraphqlRefusal = "unreadable" | "mutation" | "subscription" | "not_an_operation";
export type GraphqlVerdict = { ok: true; operations: number } | { ok: false; code: GraphqlRefusal };

interface Token {
  kind: "name" | "punct" | "number" | "string";
  value: string;
}

const PUNCT = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"]);
const NAME_START = /[_A-Za-z]/u;
const NAME_PART = /[_0-9A-Za-z]/u;
const DIGIT = /[0-9]/u;

/** Tokens of a GraphQL source, or undefined when it does not lex. Whitespace, commas, the byte-order mark and comments are skipped; a control character anywhere, an unknown character, an unterminated string and a malformed number are refusals. */
function lex(source: string): Token[] | undefined {
  if (source.length > REAL_CHECK_GRAPHQL_LIMITS.documentChars) return undefined;
  if (/(?![\t\n\r])\p{Cc}/u.test(source)) return undefined;
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "," || ch === "﻿") {
      i += 1;
    } else if (ch === "#") {
      while (i < n && source[i] !== "\n" && source[i] !== "\r") i += 1;
    } else if (ch === ".") {
      if (source.startsWith("...", i)) {
        tokens.push({ kind: "punct", value: "..." });
        i += 3;
      } else return undefined;
    } else if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
    } else if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(source[j] as string)) j += 1;
      tokens.push({ kind: "name", value: source.slice(i, j) });
      i = j;
    } else if (ch === "-" || DIGIT.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(i, i + 400));
      if (match === null) return undefined;
      const end = i + match[0].length;
      // A number may not run into a name, a dot or another digit.
      if (end < n && /[_A-Za-z.0-9]/u.test(source[end] as string)) return undefined;
      tokens.push({ kind: "number", value: match[0] });
      i = end;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) {
        let j = i + 3;
        let closed = false;
        while (j < n) {
          if (source.startsWith('\\"""', j)) j += 4;
          else if (source.startsWith('"""', j)) {
            closed = true;
            j += 3;
            break;
          } else j += 1;
        }
        if (!closed) return undefined;
        tokens.push({ kind: "string", value: "" });
        i = j;
      } else {
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const c = source[j] as string;
          if (c === "\n" || c === "\r") return undefined;
          if (c === "\\") j += 2;
          else if (c === '"') {
            closed = true;
            j += 1;
            break;
          } else j += 1;
        }
        if (!closed) return undefined;
        tokens.push({ kind: "string", value: "" });
        i = j;
      }
    } else return undefined;
    if (tokens.length > REAL_CHECK_GRAPHQL_LIMITS.tokens) return undefined;
  }
  return tokens;
}

const CLOSER: Readonly<Record<string, string>> = { "{": "}", "(": ")", "[": "]" };

/** The index just after the group that opens at `start` (a `{`, `(` or `[`), or undefined when brackets do not match or nest too deeply. */
function skipGroup(tokens: readonly Token[], start: number): number | undefined {
  const stack: string[] = [];
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== "punct") continue;
    const closer = CLOSER[token.value];
    if (closer !== undefined) {
      stack.push(closer);
      if (stack.length > REAL_CHECK_GRAPHQL_LIMITS.depth) return undefined;
    } else if (token.value === "}" || token.value === ")" || token.value === "]") {
      if (stack.pop() !== token.value) return undefined;
      if (stack.length === 0) return i + 1;
    }
  }
  return undefined;
}

const isPunct = (token: Token | undefined, value: string): boolean => token !== undefined && token.kind === "punct" && token.value === value;

/** Directives after a header: `@name` with optional `( ... )`. Returns the index after them, or undefined on a malformed one. */
function skipDirectives(tokens: readonly Token[], from: number): number | undefined {
  let i = from;
  while (isPunct(tokens[i], "@")) {
    i += 1;
    if (tokens[i]?.kind !== "name") return undefined;
    i += 1;
    if (isPunct(tokens[i], "(")) {
      const next = skipGroup(tokens, i);
      if (next === undefined) return undefined;
      i = next;
    }
  }
  return i;
}

/**
 * Whether a GraphQL document is read-only: at least one operation, and every operation a `query` (or the `{ ... }` shorthand). Fragment definitions are allowed. Anything else at the top level is refused: a
 * `mutation` (code `mutation`), a `subscription`, a type-system definition or an extension (`not_an_operation`), and a source that does not lex or whose brackets do not match (`unreadable`).
 */
export function parseGraphqlDocument(source: unknown): GraphqlVerdict {
  if (typeof source !== "string") return { ok: false, code: "unreadable" };
  const tokens = lex(source);
  if (tokens === undefined) return { ok: false, code: "unreadable" };
  let operations = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as Token;
    if (isPunct(token, "{")) {
      const next = skipGroup(tokens, i);
      if (next === undefined) return { ok: false, code: "unreadable" };
      operations += 1;
      i = next;
    } else if (token.kind === "name" && token.value === "query") {
      i += 1;
      if (tokens[i]?.kind === "name") i += 1;
      if (isPunct(tokens[i], "(")) {
        const next = skipGroup(tokens, i);
        if (next === undefined) return { ok: false, code: "unreadable" };
        i = next;
      }
      const afterDirectives = skipDirectives(tokens, i);
      if (afterDirectives === undefined || !isPunct(tokens[afterDirectives], "{")) return { ok: false, code: "unreadable" };
      const next = skipGroup(tokens, afterDirectives);
      if (next === undefined) return { ok: false, code: "unreadable" };
      operations += 1;
      i = next;
    } else if (token.kind === "name" && token.value === "mutation") {
      return { ok: false, code: "mutation" };
    } else if (token.kind === "name" && token.value === "subscription") {
      return { ok: false, code: "subscription" };
    } else if (token.kind === "name" && token.value === "fragment") {
      i += 1;
      if (tokens[i]?.kind !== "name") return { ok: false, code: "unreadable" };
      i += 1;
      if (tokens[i]?.kind !== "name" || tokens[i]?.value !== "on") return { ok: false, code: "unreadable" };
      i += 1;
      if (tokens[i]?.kind !== "name") return { ok: false, code: "unreadable" };
      i += 1;
      const afterDirectives = skipDirectives(tokens, i);
      if (afterDirectives === undefined || !isPunct(tokens[afterDirectives], "{")) return { ok: false, code: "unreadable" };
      const next = skipGroup(tokens, afterDirectives);
      if (next === undefined) return { ok: false, code: "unreadable" };
      i = next;
    } else if (token.kind === "name" || token.kind === "string") {
      // `type`, `schema`, `extend`, `directive`, `scalar`, ... or a description: a type-system document is not a read.
      return { ok: false, code: "not_an_operation" };
    } else return { ok: false, code: "unreadable" };
  }
  return operations > 0 ? { ok: true, operations } : { ok: false, code: "not_an_operation" };
}

// ---- strict JSON

const JSON_WS = new Set([" ", "\t", "\n", "\r"]);

/**
 * JSON.parse with one more refusal: an object that repeats a key (at any depth) is not read, because two readers can disagree on which copy wins. Also refuses nesting past 32, a trailing byte and anything JSON
 * itself refuses. Returns `{ ok: false }` instead of throwing, and never the text. A key named `__proto__` is an ordinary own member of the result.
 */
export function parseStrictJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof text !== "string" || text.length > 4_194_304) return { ok: false };
  let i = 0;
  const n = text.length;
  const fail = Symbol("fail");
  const skip = (): void => {
    while (i < n && JSON_WS.has(text[i] as string)) i += 1;
  };
  const string = (): string | typeof fail => {
    // text[i] is the opening quote.
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c < 0x20) return fail;
      if (c === 0x22) break;
      if (c === 0x5c) j += text[j + 1] === "u" ? 6 : 2;
      else j += 1;
    }
    if (j >= n) return fail;
    const raw = text.slice(i, j + 1);
    i = j + 1;
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" ? value : fail;
    } catch {
      return fail;
    }
  };
  const value = (depth: number): unknown => {
    if (depth > REAL_CHECK_GRAPHQL_LIMITS.jsonDepth) return fail;
    skip();
    const ch = text[i];
    if (ch === "{") {
      i += 1;
      const entries: Array<[string, unknown]> = [];
      const seen = new Set<string>();
      skip();
      if (text[i] === "}") {
        i += 1;
        return {};
      }
      for (;;) {
        skip();
        if (text[i] !== '"') return fail;
        const key = string();
        if (key === fail || seen.has(key)) return fail;
        seen.add(key);
        skip();
        if (text[i] !== ":") return fail;
        i += 1;
        const member = value(depth + 1);
        if (member === fail) return fail;
        entries.push([key, member]);
        skip();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return Object.fromEntries(entries);
        }
        return fail;
      }
    }
    if (ch === "[") {
      i += 1;
      const items: unknown[] = [];
      skip();
      if (text[i] === "]") {
        i += 1;
        return items;
      }
      for (;;) {
        const item = value(depth + 1);
        if (item === fail) return fail;
        items.push(item);
        skip();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return items;
        }
        return fail;
      }
    }
    if (ch === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(i, i + 400));
    if (literal === null) return fail;
    i += literal[0].length;
    return JSON.parse(literal[0]) as unknown;
  };
  const result = value(0);
  if (result === fail) return { ok: false };
  skip();
  return i === n ? { ok: true, value: result } : { ok: false };
}
