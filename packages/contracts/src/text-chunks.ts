/**
 * A text in chunks of at most `limit` characters, each ending at a line break whenever one fits, so a line (a check's
 * command, say) is never split; only a single line too long for one chunk is split, at a safe place.
 */
export function splitTextAtLines(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const lineBreak = remaining.lastIndexOf("\n", limit);
    const splitAt = lineBreak > 0 ? lineBreak : safeSplit(remaining, limit);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Where to split one over-long line at or before `limit`: never inside an escaped character ("&lt;") and, when it can,
 * not inside a code span (before its opening backtick instead).
 */
function safeSplit(line: string, limit: number): number {
  let splitAt = limit;
  const amp = line.lastIndexOf("&", splitAt - 1);
  if (amp >= 0 && amp > splitAt - 10 && /^&[A-Za-z#0-9]{1,8};/.test(line.slice(amp)) && line.indexOf(";", amp) >= splitAt) splitAt = amp;
  const ticks = (line.slice(0, splitAt).match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const opening = line.lastIndexOf("`", splitAt - 1);
    if (opening > 0) splitAt = opening;
  }
  return splitAt > 0 ? splitAt : limit;
}
