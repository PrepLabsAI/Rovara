// Learning v2: the identifier tokens of some lines of code, without comments and without the inside of string literals. The broker\'s code-facts port uses this on
// the cited lines at the cited commit, so the words a tier-0 lesson may repeat come from CODE, never from a comment, a docstring or a string any contributor could
// write. Deliberately simple and conservative (it covers C-style, hash and SQL comments, quotes and backticks); anything it cannot tell it drops.

/** Identifier tokens in order of appearance, deduplicated, bounded. */
export function identifiersOf(lines: readonly string[], maxTokens = 400): string[] {
  const out = new Set<string>();
  let inBlock = false;
  for (const raw of lines) {
    let line = "";
    let i = 0;
    let quote: string | undefined;
    while (i < raw.length) {
      const c = raw[i]!;
      const two = raw.slice(i, i + 2);
      if (inBlock) { if (two === "*/") { inBlock = false; i += 2; } else i += 1; continue; }
      if (quote !== undefined) { if (c === "\\") i += 2; else { if (c === quote) quote = undefined; i += 1; } continue; }
      if (two === "/*") { inBlock = true; i += 2; continue; }
      if (two === "//" || c === "#" || two === "--") break;
      if (c === "\"" || c === "'" || c === "`") { quote = c; line += " "; i += 1; continue; }
      line += c;
      i += 1;
    }
    for (const token of line.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? []) {
      if (token.length <= 60) out.add(token);
      if (out.size >= maxTokens) return [...out];
    }
  }
  return [...out];
}
