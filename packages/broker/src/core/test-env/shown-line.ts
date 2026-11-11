// One plain line of text for a person. Text that comes from a repository or a person is never trusted to be safe to show: control and format characters (bidi overrides, zero-width, escape) are shown as [U+XXXX],
// never rendered, and a long line is cut with an ellipsis.
export function shownLine(text: string, max = 600): string {
  const visible = text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => `[U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
  return visible.length > max ? `${visible.slice(0, max - 1)}\u2026` : visible;
}
