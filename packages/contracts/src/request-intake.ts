// Smart intake: the free, channel-neutral first look at a plain request, before any model is asked. A message that is
// only small talk (a greeting, thanks, or "what can you do?") gets a fixed friendly reply: no model call, no spend, no
// card, nothing started. Anything else, however short, goes on to the classifier as before. The text is untrusted user
// content: it is only matched against a fixed vocabulary, never echoed back, and it can never start or change anything.
// Shared by every channel's intake (today the Slack service's routing); provider-neutral by design (decision 51).

export type SmallTalkKind = "greeting" | "thanks" | "help";

/** Only messages this short are read as small talk; anything longer goes to the classifier. */
export const SMALL_TALK_MAX_CHARS = 80;

const APOS = "['’]?";
const GREETING = `(?:hi|hii+|hello+|hey+|hiya|howdy|yo|hola|greetings|gm|good\\s+(?:morning|afternoon|evening|day))`;
const HOW_ARE_YOU = `(?:how\\s+are\\s+you(?:\\s+doing)?(?:\\s+today)?|how${APOS}s\\s+it\\s+going|what${APOS}s\\s+up|sup)`;
const THANKS = `(?:thanks|thank\\s+you|thx|tysm|ty|cheers|much\\s+appreciated|appreciate\\s+it|many\\s+thanks)(?:\\s+(?:so\\s+much|a\\s+lot|a\\s+ton))?`;
const HELP = `(?:help|what\\s+can\\s+you\\s+do|what\\s+do\\s+you\\s+do|who\\s+are\\s+you|how\\s+do\\s+i\\s+use\\s+you|how\\s+does\\s+this\\s+work)`;
/** Who a greeting may name: a group, or the assistant itself. Never a word that could be a request. */
const ADDRESSEE = `(?:there|team|all|everyone|everybody|folks|friend|buddy|bot|rovara|agentx)`;
/** Words that only soften small talk; on their own they are not small talk. */
const FILLER = `(?:ok|okay|great|awesome|nice|perfect|cool|got\\s+it|again|and)`;

const SEGMENTS: ReadonlyArray<readonly [SmallTalkKind | "filler", RegExp]> = [
  ["help", new RegExp(`^${HELP}(?=\\s|$)`)],
  ["greeting", new RegExp(`^${HOW_ARE_YOU}(?=\\s|$)`)],
  ["thanks", new RegExp(`^${THANKS}(?:\\s+${ADDRESSEE})?(?=\\s|$)`)],
  ["greeting", new RegExp(`^${GREETING}(?:\\s+${ADDRESSEE})?(?=\\s|$)`)],
  ["filler", new RegExp(`^${FILLER}(?=\\s|$)`)],
];

/** The message as words: no Slack mentions, links, emoji or punctuation; lower case; single spaces. */
function normalized(text: string): string {
  return text
    .replace(/<[@#!][^>]*>/g, " ")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, " ")
    .replace(/[!?.,;~…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * What small talk `text` is, or undefined when it is anything else. The whole message must be made of small-talk
 * phrases ("hi", "hello team", "thanks!", "hey, what can you do?"); a single other word ("hi, fix the README") makes it
 * a request, which the classifier sorts. Asking what the assistant can do wins over a greeting, and a greeting over thanks.
 */
export function smallTalkOf(text: string): SmallTalkKind | undefined {
  if (text.length > SMALL_TALK_MAX_CHARS) return undefined;
  let rest = normalized(text);
  if (rest === "") return undefined;
  const seen = new Set<SmallTalkKind>();
  while (rest !== "") {
    let matched = false;
    for (const [kind, pattern] of SEGMENTS) {
      const match = pattern.exec(rest);
      if (match === null) continue;
      if (kind !== "filler") seen.add(kind);
      rest = rest.slice(match[0].length).trimStart();
      matched = true;
      break;
    }
    if (!matched) return undefined;
  }
  if (seen.has("help")) return "help";
  if (seen.has("greeting")) return "greeting";
  if (seen.has("thanks")) return "thanks";
  return undefined;
}

const WHAT_I_DO = [
  "• *Ask me anything* about this project's code, a task or its status, and I'll answer here without changing any code.",
  "• *Ask for a change* (a fix, a test, a feature) and I'll suggest Quick (plan → code → checks → draft PR) or Full (requirements and design first). Nothing changes until you say start.",
  "To choose yourself, start your message with `chat:`, `quick:` or `full:`.",
].join("\n");

/** The fixed reply to small talk. It never quotes the message. */
export function smallTalkReply(kind: SmallTalkKind): string {
  if (kind === "thanks") return "You're welcome! Mention me any time with a question or a change you'd like.";
  if (kind === "help") return `Here's what I can do:\n${WHAT_I_DO}`;
  return `Hi! I can help in two ways:\n${WHAT_I_DO}`;
}
