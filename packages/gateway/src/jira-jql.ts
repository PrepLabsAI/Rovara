export type JqlLimit = { jql: string } | { refused: string };
export const MAX_JQL_LENGTH = 8_192;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

/** JQL separates tokens with ASCII whitespace only; `\s` would also match NBSP and friends. */
const SPACE = /[ \t\r\n]/;
const SPECIAL = /[()"'\\]/;
/** C0 and C1 controls, DEL, line and paragraph separators, bidi overrides and isolates, BOM. */
const FORMAT = /[\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/;
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || FORMAT.test(char);
}
/** The only characters an opening quote may follow: ASCII whitespace, `(`, `,` and operator characters. */
const BEFORE_QUOTE = /[ \t\r\n(,=~!<>]/;
/** The only characters a closing quote may precede: ASCII whitespace, `)`, `,` and operator characters. */
const AFTER_QUOTE = /[ \t\r\n),=~!<>]/;
const ORDER_FIELD = /^[\p{L}\p{N}_.[\]]+/u;
const RESERVED = new Set(["and", "or", "not", "order", "by", "asc", "desc", "in", "is", "was", "changed", "empty", "null"]);

/** True when an unquoted, depth-0 `ORDER BY` starts at `index`, as a whole word. */
function startsOrderBy(jql: string, index: number): boolean {
  const before = index === 0 ? " " : jql[index - 1]!;
  if (!SPACE.test(before) && before !== "(" && before !== ")") return false;
  return /^order[ \t\r\n]+by(?=[ \t\r\n(]|$)/i.test(jql.slice(index));
}

/** A non-ASCII character that Unicode compatibility folding turns into a JQL special character. */
function isLookAlike(char: string): boolean {
  return char.charCodeAt(0) > 0x7f && SPECIAL.test(char.normalize("NFKC"));
}

/**
 * Checks an `ORDER BY` clause is only `field [ASC|DESC] (, field [ASC|DESC])*`, where a field is a
 * name or a quoted string. Nothing outside the project group may carry boolean logic.
 */
function isFieldList(clause: string): boolean {
  let rest = clause.replace(/^order[ \t\r\n]+by/i, "");
  const skipSpace = () => { rest = rest.replace(/^[ \t\r\n]+/, ""); };
  for (;;) {
    skipSpace();
    const quoted = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(rest);
    const name = quoted ? undefined : ORDER_FIELD.exec(rest);
    if (quoted) rest = rest.slice(quoted[0].length);
    else if (name && !RESERVED.has(name[0].toLowerCase())) rest = rest.slice(name[0].length);
    else return false;
    skipSpace();
    const direction = /^(asc|desc)(?![\p{L}\p{N}_.[\]])/iu.exec(rest);
    if (direction) { rest = rest.slice(direction[0].length); skipSpace(); }
    if (rest === "") return true;
    if (!rest.startsWith(",")) return false;
    rest = rest.slice(1);
  }
}

/**
 * Wraps JQL as `project = "KEY" AND (<jql>)`, keeping a trailing top-level ORDER BY outside the
 * parentheses. Tracks quotes (with backslash escapes inside them) and parenthesis depth so model
 * text can never close the group early. Refuses rather than guesses on anything it cannot track:
 * control characters, Unicode look-alikes of `( ) " ' \`, comment markers, a quote touching anything
 * but whitespace, a bracket, a comma or an operator (fail closed), and any ORDER BY clause that is
 * more than a list of fields.
 */
export function limitJqlToProject(jql: string, projectKey: string): JqlLimit {
  if (!PROJECT_KEY.test(projectKey)) return { refused: "invalid project key" };
  if (jql.length > MAX_JQL_LENGTH) return { refused: `JQL is longer than ${MAX_JQL_LENGTH} characters` };
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let orderAt: number | undefined;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index]!;
    const unquotedSpace = !quote && (char === " " || char === "\t" || char === "\r" || char === "\n");
    if (!unquotedSpace && isControl(char)) return { refused: "a control character" };
    if (isLookAlike(char)) return { refused: "a look-alike of a JQL special character" };
    if (quote) {
      if (char === "\\") {
        const escaped = jql[index + 1];
        if (escaped !== undefined && isControl(escaped)) return { refused: "a control character" };
        if (escaped !== undefined && isLookAlike(escaped)) return { refused: "a look-alike of a JQL special character" };
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        const after = jql[index + 1];
        if (after !== undefined && !AFTER_QUOTE.test(after)) return { refused: "a quote joined to a word" };
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (index > 0 && !BEFORE_QUOTE.test(jql[index - 1]!)) return { refused: "a quote joined to a word" };
      quote = char;
      continue;
    }
    if (char === "\\") return { refused: "a backslash outside a quoted string" };
    const pair = jql.slice(index, index + 2);
    if (pair === "/*" || pair === "*/" || pair === "//" || pair === "--") return { refused: "a comment marker" };
    if (char === "(") {
      if (orderAt !== undefined) return { refused: "parentheses after ORDER BY" };
      depth += 1;
    } else if (char === ")") {
      if (orderAt !== undefined) return { refused: "parentheses after ORDER BY" };
      depth -= 1;
      if (depth < 0) return { refused: "unbalanced parentheses" };
    } else if ((char === "o" || char === "O") && startsOrderBy(jql, index)) {
      if (depth !== 0) return { refused: "ORDER BY inside parentheses" };
      if (orderAt !== undefined) return { refused: "more than one ORDER BY" };
      orderAt = index;
    }
  }
  if (quote) return { refused: "an unterminated quoted string" };
  if (depth !== 0) return { refused: "unbalanced parentheses" };
  const where = (orderAt === undefined ? jql : jql.slice(0, orderAt)).trim();
  const clause = orderAt === undefined ? "" : jql.slice(orderAt).trim();
  if (clause && !isFieldList(clause)) return { refused: "an ORDER BY clause that is not a list of fields" };
  const limit = `project = "${projectKey}"`;
  const order = clause ? ` ${clause}` : "";
  return { jql: where ? `${limit} AND (${where})${order}` : `${limit}${order}` };
}
