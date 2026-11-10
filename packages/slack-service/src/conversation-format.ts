import { splitSlackMessage } from "@agentx/contracts";
import { escapeText, slackReplyText } from "./slack-format.js";

/**
 * Spec 062 FR-040: how the processor's own words and the model's reply are written for one surface. The processor
 * composes every message through this, so Slack keeps its exact texts and a channel adapter gets plain text it formats
 * itself. Only Slack's format writes Slack markup.
 */
export interface ConversationFormat {
  readonly kind: "slack" | "plain";
  /** Makes text from a person, the model or a tool inert here: it can mention or link no one. */
  escape: (text: string) => string;
  /** The model's reply as this surface shows it. */
  reply: (text: string) => string;
  /** A long message in the pieces this surface can post. */
  split: (text: string) => string[];
  /** A person, addressed in the conversation; "" when the surface has no mentions. */
  mention: (userId: string) => string;
  /** The conversation, as the texts name it: "this thread" or "this conversation". */
  readonly here: string;
  /** How a person asks again: "mention me again" or "message me again". */
  readonly askAgain: string;
  /** How to approve and cancel a confirmation without its buttons. */
  readonly replyYes: string;
  readonly replyCancel: string;
  /** Where a new workspace starts: "a new Slack thread" or "a new conversation". */
  readonly fresh: string;
}

export const SLACK_FORMAT: ConversationFormat = {
  kind: "slack",
  escape: escapeText,
  reply: slackReplyText,
  split: splitSlackMessage,
  mention: (userId) => `<@${userId}>`,
  here: "this thread",
  askAgain: "mention me again",
  replyYes: "reply `@AgentX yes`",
  replyCancel: "reply `@AgentX cancel`",
  fresh: "a new Slack thread",
};

/** Plain text, for an adapter. Rovara's own confirmation summaries are stored entity-escaped, so they are unescaped. */
const unescape = (text: string) => text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");

/** A message cut to fit an adapter: the event sender cuts to each adapter's own limit too. */
const PLAIN_CHUNK = 4_000;

export const PLAIN_FORMAT: ConversationFormat = {
  kind: "plain",
  escape: unescape,
  reply: (text) => text.replace(/\\n/gu, "\n").trim(),
  split: (text) => {
    const chunks: string[] = [];
    let rest = text.trim();
    while (rest.length > PLAIN_CHUNK) {
      const cut = rest.lastIndexOf("\n", PLAIN_CHUNK) > PLAIN_CHUNK / 2 ? rest.lastIndexOf("\n", PLAIN_CHUNK) : PLAIN_CHUNK;
      chunks.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks.length === 0 ? ["(no reply)"] : chunks;
  },
  mention: () => "",
  here: "this conversation",
  askAgain: "message me again",
  replyYes: "reply `yes`",
  replyCancel: "reply `cancel`",
  fresh: "a new conversation",
};
