// Text a repository supplies as instructions (its AGENTS.md or CLAUDE.md) goes to the model as written.
// Characters a reader cannot see can carry instructions the reviewer of the file never sees, so they are
// removed once, where the file is loaded. Worker-local on purpose: nothing here changes a contract.

/**
 * Format characters (\p{Cf}: zero-width, bidirectional controls, Unicode tag characters U+E0000-E007F), control
 * characters other than newline and tab, and variation selectors (U+FE00-FE0F, U+E0100-E01EF), which can hide
 * text too and are not \p{Cf}.
 */
const HIDDEN_CHARACTERS = /[\p{Cf}\p{Cc}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** `text` without hidden characters, and how many were removed. Visible text, newlines and tabs are unchanged. */
export function inertContextText(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = text.replace(HIDDEN_CHARACTERS, (character) => {
    if (character === "\n" || character === "\t") return character;
    removed += 1;
    return "";
  });
  return { text: cleaned, removed };
}
