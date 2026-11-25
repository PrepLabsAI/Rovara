// The text of a markup resource for the trace scrub (trace-scrub.ts): what a reader sees, so a secret a page split with markup or invisible characters is whole again. One linear pass; no backtracking pattern
// runs over the blob (a resource may be 32 MB and is page-controlled).

/** A `<` that is not closed by a `>` within this many characters is text, not a tag. */
export const MARKUP_TAG_MAX = 4_096;
/** What shows nothing: soft hyphen, zero-width space, non-joiner, joiner, word joiner, byte-order mark. Built from code points so no invisible character sits in this file. */
const INVISIBLE_CHARACTERS = [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) => String.fromCodePoint(code)).join("");
/**
 * The invisible characters and their entity spellings, as a browser decodes them: named, decimal and hex (leading zeros allowed). `&shy`, `&#173` and `&#xAD` need no closing `;` (`&#173` ends at a non-digit,
 * `&#xAD` at a non-hex character, `&shy` anywhere, so `&shyness` is a soft hyphen and "ness"); the other names need it. Names are case-sensitive, as in a browser; `x` and the hex digits take either case.
 */
const INVISIBLE = new RegExp(`[${INVISIBLE_CHARACTERS}]|&(?:shy;?|(?:zwnj|zwj|ZeroWidthSpace|NoBreak);)|&#(?:[xX]0{0,8}(?:[aA][dD]|200[bBcCdD]|2060|[fF][eE][fF][fF])(?![0-9a-fA-F])|0{0,8}(?:173|820[345]|8288|65279)(?![0-9]));?`, "gu");

/** The first place `needle` occurs at or after `from`, or -1. Asked with a rising `from`, it searches again only once its last answer is behind, so all the questions of one pass cost one scan of the text. */
function finder(text: string, needle: string): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found === -1) return -1;
    if (found < from) found = text.indexOf(needle, from);
    return found;
  };
}

/** The searches of one pass, and how many characters its quote-aware tag scans may still read past a tag's first `>` (a share of the text's own length, so the whole pass stays linear). */
interface Finders { gt(from: number): number; commentEnd(from: number): number; budget: number }

/** Where the comment that opens at `at` ends (after its last character), or -1. `<!-->` and `<!--->` are whole comments, as the HTML parser reads them. */
function commentEnd(text: string, at: number, find: Finders): number {
  if (text.startsWith(">", at + 4)) return at + 5;
  if (text.startsWith("->", at + 4)) return at + 6;
  const close = find.commentEnd(at + 4);
  return close === -1 ? -1 : close + 3;
}

/** Where a scan of a tag's attributes is, as the HTML tokenizer names the states. */
type TagState = "name" | "before-attribute" | "attribute-name" | "after-attribute-name" | "before-value" | "unquoted-value" | "after-quoted-value";
type CharKind = "space" | "slash" | "equals" | "quote" | "other";
/** The state after each kind of character (a `>` ends the tag and a quoted value is skipped before this is asked). A quote opens a value only in "before-value", i.e. right after `=` and any spaces; anywhere else it is an ordinary character. */
const NEXT_STATE: Record<TagState, Record<CharKind, TagState>> = {
  "name": { space: "before-attribute", slash: "before-attribute", equals: "name", quote: "name", other: "name" },
  "before-attribute": { space: "before-attribute", slash: "before-attribute", equals: "attribute-name", quote: "attribute-name", other: "attribute-name" },
  "attribute-name": { space: "after-attribute-name", slash: "before-attribute", equals: "before-value", quote: "attribute-name", other: "attribute-name" },
  "after-attribute-name": { space: "after-attribute-name", slash: "before-attribute", equals: "before-value", quote: "attribute-name", other: "attribute-name" },
  "before-value": { space: "before-value", slash: "unquoted-value", equals: "unquoted-value", quote: "after-quoted-value", other: "unquoted-value" },
  "unquoted-value": { space: "before-attribute", slash: "unquoted-value", equals: "unquoted-value", quote: "unquoted-value", other: "unquoted-value" },
  "after-quoted-value": { space: "before-attribute", slash: "before-attribute", equals: "attribute-name", quote: "attribute-name", other: "attribute-name" },
};
/** The kind of a character as the attribute states tell them apart: the four spaces of HTML, `/`, `=`, a quote, or any other. */
function kindOf(code: number): CharKind {
  if (code === 32 || code === 9 || code === 10 || code === 12 || code === 13) return "space";
  if (code === 47) return "slash";
  if (code === 61) return "equals";
  return code === 34 || code === 39 ? "quote" : "other";
}
const GT = 62;

/**
 * Where a tag whose name starts at `from` ends when quotes are read as a browser reads them, or `first + 1` (its first `>`) when that end is not reached within MARKUP_TAG_MAX characters of `at` or the pass's
 * budget is spent. The characters up to `first` are never scanned again (the pass goes on after the tag), so only what is read past `first` is charged to the budget.
 */
function attributeAwareEnd(text: string, at: number, from: number, first: number, find: Finders): number {
  const limit = Math.min(text.length - 1, at + MARKUP_TAG_MAX);
  let state: TagState = "name";
  let quote = 0;
  for (let i = from; i <= limit; i += 1) {
    if (i > first && (find.budget -= 1) < 0) break;
    const code = text.charCodeAt(i);
    if (quote !== 0) { if (code === quote) quote = 0; continue; }
    if (code === GT) return i + 1;
    const kind = kindOf(code);
    if (state === "before-value" && kind === "quote") quote = code;
    state = NEXT_STATE[state][kind];
  }
  return first + 1;
}

/**
 * Where the tag that opens at `at` ends, or -1 when it is not a tag (a `<` that no letter, `/`, `!` or `?` follows) or has no `>` within MARKUP_TAG_MAX characters. A `<!...>`, `<?...>` and `</` + non-letter
 * ends at its first `>` whatever quotes it holds. In a start or end tag a quote opens a value only right after `=` (see NEXT_STATE), so `title=O'Brien` and `<b x'y>` hold no quote.
 */
function tagEnd(text: string, at: number, find: Finders): number {
  const next = text.charAt(at + 1);
  if (!/[A-Za-z/!?]/u.test(next)) return -1;
  const first = find.gt(at + 1);
  if (first === -1 || first - at > MARKUP_TAG_MAX) return -1;
  const letterAt = next === "/" ? at + 2 : at + 1;
  return /[A-Za-z]/u.test(text.charAt(letterAt)) ? attributeAwareEnd(text, at, letterAt, first, find) : first + 1;
}

/**
 * The text with comments and tags removed (React writes `a<!-- -->b`; a framework may put two spans side by side) and the invisible characters taken out. A tag runs to its `>` as a browser reads it (a `>` inside
 * a quoted attribute value does not end it; a quote that opens no value does not matter). A comment that is not closed, and a tag with no `>` within MARKUP_TAG_MAX characters, are text. A quoted value that
 * never closes ends its tag at the first `>`.
 */
export function markupTextOf(text: string | null): string {
  if (text === null) return "";
  const find: Finders = { gt: finder(text, ">"), commentEnd: finder(text, "-->"), budget: 16 * text.length + MARKUP_TAG_MAX };
  const pieces: string[] = [];
  let from = 0; // where the text not yet kept starts
  let scan = 0; // where the next `<` is looked for
  for (let at = text.indexOf("<", scan); at !== -1; at = text.indexOf("<", scan)) {
    const end = text.startsWith("<!--", at) ? commentEnd(text, at, find) : tagEnd(text, at, find);
    scan = end === -1 ? at + 1 : end;
    if (end === -1) continue;
    pieces.push(text.slice(from, at));
    from = end;
  }
  pieces.push(text.slice(from));
  return pieces.join("").replace(INVISIBLE, "");
}
