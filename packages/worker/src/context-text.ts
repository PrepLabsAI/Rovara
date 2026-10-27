// Text a repository supplies as instructions (its AGENTS.md or CLAUDE.md) goes to the model as written.
// Characters a reader cannot see can carry instructions the reviewer of the file never sees, so they are
// removed once, where the file is loaded. Worker-local on purpose: nothing here changes a contract.

/**
 * Format characters (\p{Cf}: zero-width, bidirectional controls, Unicode tag characters U+E0000-E007F), control
 * characters other than newline and tab, the default-ignorable code points that are not \p{Cf} (U+034F, the Hangul
 * fillers U+115F, U+1160, U+3164, U+FFA0, U+17B4-17B5, the Mongolian selectors U+180B-180D and U+180F), private-use,
 * unassigned and lone-surrogate code points, and variation selectors (U+FE00-FE0F, U+E0100-E01EF), which can hide
 * text too. A character a future Unicode version assigns is removed until Node's tables learn it.
 */
const HIDDEN_CHARACTERS = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/**
 * `text` without hidden characters, and how many were removed. Visible text, newlines and tabs are unchanged. A leading
 * byte-order mark is dropped, and CRLF and a lone CR become a newline: file conventions, not counted.
 */
export function inertContextText(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n?/gu, "\n").replace(HIDDEN_CHARACTERS, (character) => {
    if (character === "\n" || character === "\t") return character;
    removed += 1;
    return "";
  });
  return { text: cleaned, removed };
}
