// The text of a markup resource for the trace scrub (trace-scrub.ts): what a reader sees, so a secret a page split with markup or invisible characters is whole again. One linear pass; no backtracking pattern
// runs over the blob (a resource may be 32 MB and is page-controlled).

/** A `<` that is not closed by a `>` within this many characters is text, not a tag. */
export const MARKUP_TAG_MAX = 4_096;
/** What shows nothing: soft hyphen, zero-width space, non-joiner, joiner, word joiner, byte-order mark. Built from code points so no invisible character sits in this file. */
const INVISIBLE_CHARACTERS = [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) => String.fromCodePoint(code)).join("");
/** The invisible characters and their entity spellings (named, decimal and hex, with leading zeros). */
const INVISIBLE = new RegExp(`[${INVISIBLE_CHARACTERS}]|&(?:shy|zwnj|zwj|ZeroWidthSpace|NoBreak);|&#(?:x0{0,8}(?:ad|200[bcd]|2060|feff)|0{0,8}(?:173|820[345]|8288|65279));`, "giu");

/** The first place `needle` occurs at or after `from`, or -1. Asked with a rising `from`, it searches again only once its last answer is behind, so all the questions of one pass cost one scan of the text. */
function finder(text: string, needle: string): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found === -1) return -1;
    if (found < from) found = text.indexOf(needle, from);
    return found;
  };
}

interface Finders { gt(from: number): number; commentEnd(from: number): number }

/** Where the comment that opens at `at` ends (after its last character), or -1. `<!-->` and `<!--->` are whole comments, as the HTML parser reads them. */
function commentEnd(text: string, at: number, find: Finders): number {
  if (text.startsWith(">", at + 4)) return at + 5;
  if (text.startsWith("->", at + 4)) return at + 6;
  const close = find.commentEnd(at + 4);
  return close === -1 ? -1 : close + 3;
}

/** Where the tag that opens at `at` ends, or -1 when it is not a tag (a `<` that no letter, `/`, `!` or `?` follows) or is not closed within the cap. */
function tagEnd(text: string, at: number, find: Finders): number {
  if (!/[A-Za-z/!?]/u.test(text.charAt(at + 1))) return -1;
  const close = find.gt(at + 1);
  return close === -1 || close - at > MARKUP_TAG_MAX ? -1 : close + 1;
}

/**
 * The text with comments and tags removed (React writes `a<!-- -->b`; a framework may put two spans side by side) and the invisible characters taken out. A tag runs to the next `>` (a `>` inside a quoted
 * attribute value ends it early, which only leaves attribute text in the result). A comment that is not closed, and a tag not closed within MARKUP_TAG_MAX characters, are text.
 */
export function markupTextOf(text: string | null): string {
  if (text === null) return "";
  const find: Finders = { gt: finder(text, ">"), commentEnd: finder(text, "-->") };
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
