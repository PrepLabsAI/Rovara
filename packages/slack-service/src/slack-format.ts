/**
 * Converts an orchestrator reply (Markdown-style model output) to Slack mrkdwn before it is posted.
 * Code spans and fenced blocks keep their content; only Slack's three control characters are
 * escaped there, which Slack displays as the original characters. Everywhere else: literal "\n"
 * sequences become line breaks, Markdown links and bare URLs become one Slack link each, **bold**
 * and headings become Slack bold, and any other "<", ">" or "&" is escaped, so text such as
 * "<!channel>" is shown and never notifies anyone.
 */
export function slackReplyText(text: string): string {
  const hasRealNewline = text.includes("\n");
  let result = "";
  let last = 0;
  for (const match of text.matchAll(CODE)) {
    result += prose(text.slice(last, match.index), atLineStart(text, last), hasRealNewline) + code(match[0]);
    last = match.index + match[0].length;
  }
  return result + prose(text.slice(last), atLineStart(text, last), hasRealNewline);
}

// A fenced block runs to its closing fence, or to the end of the text when it is never closed.
// Inline code stays on one line.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/gu;
// A backslash followed by n (optionally \r\n), unless the backslash is itself escaped.
const LITERAL_LINE_BREAK = /(?<!\\)(?:\\r)?\\n/gu;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu;
const BOLD = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/gu;
// Tried in this order at each position: a Markdown link (label, URL), a link or mention already
// in Slack format, a bare URL. A raw "<" or ">" is not a URL character, so it ends a URL.
// The markdown link label allows one level of nested brackets.
const TOKEN = new RegExp([
  String.raw`\[((?:[^\[\]\n]|\[[^\]]*\])*)\]\(\s*<?((?:https?:\/\/|mailto:)[^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+"[^"\n]*")?\s*\)`,
  String.raw`<(?:(?:https?:\/\/|mailto:)[^\s<>|]+(?:\|[^<>\n]*)?|[@#][UWC][A-Z0-9]{2,31}(?:\|[^<>\n]*)?)>`,
  String.raw`https?:\/\/[^\s<>]+`,
].join("|"), "gu");

function atLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

function prose(text: string, startsLine: boolean, hasRealNewline: boolean): string {
  let shaped = text;
  if (!hasRealNewline) {
    shaped = shaped.replace(LITERAL_LINE_BREAK, "\n");
  }
  shaped = shaped
    .replace(HEADING, (_line, title: string) => `*${title.replace(/\*\*/gu, "")}*`)
    .replace(BOLD, "*$1*");
  let result = "";
  let last = 0;
  for (const match of shaped.matchAll(TOKEN)) {
    const [whole, label, markdownUrl] = match;
    let consumed = whole;
    let replacement: string;
    if (markdownUrl !== undefined) {
      replacement = link(markdownUrl, (label ?? "").trim().replace(/^<(.*)>$/u, "$1").trim());
    } else if (whole.startsWith("<")) {
      replacement = whole;
    } else {
      consumed = trimUrl(whole);
      replacement = link(consumed, "");
    }
    result += escapeText(shaped.slice(last, match.index)) + replacement;
    last = match.index + consumed.length;
  }
  result += escapeText(shaped.slice(last));
  // Keep a Markdown quote marker ("> " at the start of a line), which Slack also shows as a quote.
  return result.replace(/\n&gt; /gu, "\n> ").replace(/^&gt; /u, startsLine ? "> " : "&gt; ");
}

function code(block: string): string {
  // Slack shows a fence's language tag as a line of text, so drop it; the code itself is untouched.
  return escapeText(block.replace(/^```[A-Za-z0-9_+#.-]{1,20}\n/u, "```\n"));
}

function link(url: string, label: string): string {
  const target = url
    .replace(/&(?!(?:amp|lt|gt);)/gu, "&amp;")
    .replace(/\|/gu, "%7C")
    .replace(/</gu, "%3C")
    .replace(/>/gu, "%3E");
  return label === "" || label === url ? `<${target}>` : `<${target}|${escapeText(label)}>`;
}

/** Drops trailing punctuation from a bare URL, keeping a closing parenthesis the URL opened. */
function trimUrl(url: string): string {
  // Count parentheses once to track balance as we decrement
  let openCount = 0;
  let closeCount = 0;
  for (const char of url) {
    if (char === "(") openCount++;
    else if (char === ")") closeCount++;
  }

  let end = url.length;
  while (end > 0) {
    const character = url[end - 1]!;
    const unbalancedParenthesis = character === ")" && openCount < closeCount;
    if (!".,;:!?'\"]*_".includes(character) && !unbalancedParenthesis) break;
    if (character === "(") openCount--;
    else if (character === ")") closeCount--;
    end -= 1;
  }
  return url.slice(0, end);
}

/** Escapes Slack's control characters, leaving an existing &amp;, &lt; or &gt; as it is. */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:amp|lt|gt);)/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}
