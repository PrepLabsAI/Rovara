// Learning v2 (L1/L4): the one text-hygiene function for lesson text, shared by the broker (before a model reads a span, before a lesson is stored)
// and the worker (before a lesson is rendered into a stage's prompt). It removes what hides text from a reviewer (zero-width and bidi controls,
// tag characters), markup that imitates a prompt boundary (`<system>`, `<<team-lessons>>`) and control characters. Pure; no I/O.

/** Zero-width, bidi, byte-order, soft-hyphen, word-joiner and Unicode tag characters (U+E0000-U+E007F), plus C0/C1 controls except tab and newline. */
// eslint-disable-next-line no-misleading-character-class, no-control-regex
const HIDDEN = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Removes hidden and control characters. */
export function stripLessonHiddenCharacters(text: string): string {
  return text.normalize("NFKC").replace(HIDDEN, "");
}

/**
 * Makes text inert as a prompt boundary: drops any `<...>` tag, turns the `<<` and `>>` delimiters this feature uses into plain parentheses, and collapses
 * runs of blank lines. Applied again at render time, so a lesson stored by an older build cannot close the lessons block.
 */
export function neutraliseMarkup(text: string): string {
  return text
    .replace(/<<+|>>+/gu, (match) => (match.startsWith("<") ? "(" : ")"))
    .replace(/<\/?[A-Za-z!?][^<>\n]{0,200}>/gu, "")
    .replace(/\n{3,}/gu, "\n\n");
}

/** Look-alike letters (Cyrillic, Greek, fullwidth after NFKC) that people use to dodge a word list, mapped to the Latin letter they imitate. */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u051B": "q",
  "\u04BB": "h", "\u0432": "b", "\u043A": "k", "\u043C": "m", "\u043D": "h", "\u0442": "t", "\u0433": "r",
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M", "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0406": "I", "\u0408": "J", "\u0405": "S",
  "\u03B1": "a", "\u03BF": "o", "\u03BD": "v", "\u03C1": "p", "\u03B9": "i", "\u03BA": "k", "\u03C4": "t", "\u03C5": "u", "\u03B5": "e", "\u03C7": "x", "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u039F": "O", "\u03A1": "P", "\u03A4": "T",
  "\u0585": "o", "\u057D": "u", "\u0578": "n", "\u0570": "h", "\u0581": "g", "\u0566": "q", "\u0561": "a", "\u0563": "q", "\u0573": "t",
  "\u0131": "i", "\u0269": "i", "\u0261": "g", "\u1D00": "a", "\u2113": "l",
};
/** Text folded for matching word lists: hidden characters out, NFKC, combining marks out, look-alikes to Latin. Never used for storage or display. */
export function foldForMatching(text: string): string {
  let out = "";
  // Decompose and drop combining marks (an accent over a letter must not hide a word), then map look-alikes.
  for (const ch of stripLessonHiddenCharacters(text).normalize("NFD").replace(/\p{M}/gu, "")) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/** Hidden characters out, then markup out, then trimmed and cut to `maxChars` (code points). */
export function cleanLessonText(text: string, maxChars: number): string {
  // U+2028 / U+2029 are line breaks to a reader and to a regex `\s` but not to a split on "\n": they become ordinary newlines here, so every later "one line" step sees them.
  const cleaned = neutraliseMarkup(stripLessonHiddenCharacters(text).replace(/[\u2028\u2029]/gu, "\n")).trim();
  const points = [...cleaned];
  return points.length <= maxChars ? cleaned : points.slice(0, maxChars).join("").trimEnd();
}
