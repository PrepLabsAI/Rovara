// Untrusted text (thread replies, page comments, review findings) made safe to quote inside a model prompt's tags.

const ANGLE_OPEN = /[<＜‹〈⟨❮﹤]|&(?:lt|#0*60|#x0*3c);/giu;
const ANGLE_CLOSE = /[>＞›〉⟩❯﹥]|&(?:gt|#0*62|#x0*3e);/giu;

/**
 * A reply's text made inert for a prompt. Slack delivers a typed <, > and & as &lt;, &gt; and &amp;, and a model
 * reads those as markup, so they are decoded first (repeatedly, for text that was encoded more than once). Then
 * every angle bracket, entity or lookalike becomes one plain safe pair, ‹ and ›, so nothing in a reply can open or
 * close a tag, or pass for text that was already neutralised.
 */
export function inertReplyText(text: string): string {
  let decoded = text;
  for (let round = 0; round < 4; round += 1) {
    const next = decoded.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(ANGLE_OPEN, "‹").replace(ANGLE_CLOSE, "›");
}
