// Lead 4 L4-SRC-SL: Slack thread replies as a lessons source (the owner's privacy decision, DEC 254zzz3/4). What a finished task's own Slack thread taught, read ONCE when the task ends, as spans of kind `slack_reply`.
//
// The rules, each one a fixed check in code (a reply that fails any of them is dropped before anything about it is kept):
//   1. WHICH PLACE   only the thread Rovara's task started in (the record written when the work started there), and only while its space is bound to the task's project. A direct message, a group direct message
//                    and a space shared with another organisation (Slack Connect) are never read, bound or not. The reader answers these facts; this file refuses on any of them (fail closed).
//   2. WHICH WORDS   only replies inside that thread (never the thread's first message, never the rest of the space), plain messages only (no join, topic or file notices), at most `MAX_REPLIES_READ` of them in one read.
//   3. WHOSE WORDS   a person: an app, a bot, a message without a person, and a person of another organisation are dropped; Rovara's own messages are apps and are dropped. The Slack account must be linked to a person of
//                    the company who has a role on the project NOW (a guest or an outsider is not a member), who is not erased, and who has not switched "Don't learn from my Slack messages" on (read NOW, per person).
//   4. WHAT COUNTS  the free correction filter (`correction-filter.ts`: praise, nits and bare questions are not corrections), nothing that reads as quoted or forwarded, and the words are cleaned (secrets, hidden characters,
//                    mentions) and cut short. No model reads a message that fails any of this.
//   5. PAUSE         the project's "Slack threads" row paused (`kind:slack_reply`, the same key "Where Rovara learns from" writes) means STOP: the thread is not even asked for.
//   6. STORAGE       nothing of a message is stored by this file. A span lives in the task's reflection call; a lesson built from it keeps its own short sentence, the person's id (so their erase reaches it) and a pointer
//                    (`slack:<team>/<channel>#<ts>`: team, channel and the reply's time) from which the thread's link is made.
// A span is a member's, weak evidence: it never counts as a member correction (so a lesson from it never goes live on trial) and never auto-applies (`process.ts`); a lesson cites it only after it is seen twice (`earnedAttention`).
import type { OrgId } from "@agentx/contracts";
import { neutralizeSlackMentions } from "../core/sessions/slack-mentions.js";
import { looksLikeCorrection } from "./correction-filter.js";
import { cleanForLearning, looksQuoted } from "./guards.js";
import type { EvidenceSpan } from "./reflect-input.js";
import type { Audience, TrustClass } from "./types.js";

/** The pause key of the "Slack threads" source (the key `learning-sources.ts` writes for a paused kind). */
export const SLACK_PAUSE_KEY = "kind:slack_reply";
/** The most replies one task's read turns into spans (the newest ones): one total limit. */
export const MAX_SLACK_REPLY_SPANS = 10;
/** The most replies one read looks at (the first ones of the thread), whatever the thread holds. */
export const MAX_REPLIES_READ = 200;
/** The most different people one read looks up: the rest of a crowded thread is not read. */
export const MAX_PEOPLE_PER_READ = 25;
/** The whole read, the thread and every person's check together, gives up after this long and teaches nothing from Slack. */
export const SLACK_READ_DEADLINE_MS = 15_000;
/** A reply's words are kept in the reflection call up to this many characters. */
export const SLACK_REPLY_MAX_CHARS = 500;

/** One reply of the task's thread as the reader hands it on (in memory only). */
export interface SlackReplyFact {
  /** The reply's own time id (Slack's `ts`). */
  id: string;
  text: string;
  /** An app or a bot wrote it. */
  bot: boolean;
  /** A person of another organisation wrote it. */
  external: boolean;
  /** A plain message (no notice, no edit marker). */
  plain: boolean;
  /** The person of the company the writer's Slack account is linked to; absent for an account nobody linked. */
  person?: string | undefined;
}

/** The thread of one task, with the facts the rules need. */
export interface SlackThreadFacts {
  /** The space as a place: `slack:<team>/<channel>`. */
  place: string;
  /** The space is bound to the task's project (the reader checked the binding, the company of the team and the thread's own record). */
  boundToProject: boolean;
  private: boolean;
  shared: boolean;
  direct: boolean;
  messages: readonly SlackReplyFact[];
  /** The thread had more replies than one read takes: these are the first ones. */
  truncated?: boolean;
}

/** Reads a task's own thread once. Undefined: the task has no thread. A throw: nothing is learned from Slack for this task. */
export interface SlackThreadReader {
  read(input: { companyId: OrgId; project: string; taskId: string }): Promise<SlackThreadFacts | undefined>;
}

export interface SlackLessonSourceOptions {
  reader: SlackThreadReader;
  /** The person's class now: member (a role on the project), outsider, or undefined (erased). A throw reads as undefined. */
  standingOf(person: string, project: string): Promise<TrustClass | undefined>;
  /** Whether the person switched "Don't learn from my Slack messages" on. A throw reads as ON (fail closed). */
  optedOut(person: string): Promise<boolean>;
  /** Whether the project's "Slack threads" source is paused. A throw reads as paused (fail closed). */
  paused(project: string): Promise<boolean>;
  now(): number;
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
}

const noteOf = (place: string, id: string): string => `${place}#${id}`.slice(0, 100);

/** The audience of a space's words: the project's for a public space; for a private one, the space's own readers (no one is named, so only a record of the space's readers can ever open them: DEC 34). */
export function slackAudienceOf(facts: Pick<SlackThreadFacts, "place" | "private">, at: string): Audience {
  return facts.private
    ? { kind: "restricted", acl: { source: "slack", scope: facts.place, capturedAt: at, liveCheck: "none" } }
    : { kind: "project" };
}

/**
 * The `slack_reply` spans of one finished task. Never throws: a reader that fails, a pause or a store that cannot answer gives no span (and the task's ordinary reflection goes on without Slack).
 * Reads the project's pause FIRST: while paused nothing is asked of Slack at all.
 */
export async function slackReplySpans(options: SlackLessonSourceOptions, input: { companyId: OrgId; project: string; taskId: string }): Promise<EvidenceSpan[]> {
  const log = (event: string, fields: Record<string, string | number> = {}): void => options.log?.(event, fields);
  try {
    let paused = true;
    try { paused = await options.paused(input.project); } catch { paused = true; }
    if (paused) { log("learning.slack_not_read", { reason: "paused" }); return []; }

    const deadlineAt = Date.now() + SLACK_READ_DEADLINE_MS;
    const facts = await options.reader.read(input);
    if (facts === undefined) return [];
    if (facts.truncated === true) log("learning.slack_truncated", { replies: facts.messages.length });
    // The place's own rules, before any word is looked at.
    if (facts.boundToProject !== true || facts.direct !== false || facts.shared !== false || typeof facts.private !== "boolean") { log("learning.slack_not_read", { reason: "place" }); return []; }

    const audience = slackAudienceOf(facts, new Date(options.now()).toISOString());
    const standings = new Map<string, TrustClass | undefined>();
    const optOuts = new Map<string, boolean>();
    const standing = async (person: string): Promise<TrustClass | undefined> => {
      // A thread with more different people than a read looks up: the rest are not read (never guessed).
      if (!standings.has(person) && standings.size >= MAX_PEOPLE_PER_READ) return undefined;
      if (!standings.has(person)) {
        let answer: TrustClass | undefined;
        try { answer = await options.standingOf(person, input.project); } catch { answer = undefined; }
        standings.set(person, answer);
      }
      return standings.get(person);
    };
    const out = async (person: string): Promise<boolean> => {
      if (!optOuts.has(person)) {
        let answer: boolean;
        try { answer = (await options.optedOut(person)) !== false; } catch { answer = true; }
        optOuts.set(person, answer);
      }
      return optOuts.get(person) === true;
    };

    const spans: EvidenceSpan[] = [];
    // Newest first, so the most recent corrections are the ones kept when there are more than the limit; the spans are put back in thread order below.
    for (const message of facts.messages.slice(0, MAX_REPLIES_READ).reverse()) {
      if (spans.length >= MAX_SLACK_REPLY_SPANS) break;
      if (Date.now() >= deadlineAt) { log("learning.slack_not_read", { reason: "deadline" }); return []; }
      if (message.bot !== false || message.external !== false || message.plain !== true) continue;
      const person = message.person;
      if (person === undefined || person === "") continue;
      // Who they are is judged before their words are looked at: an erased person, an outsider and a person who opted out are never read.
      if ((await standing(person)) !== "member") continue;
      if (await out(person)) continue;
      const clean = cleanForLearning(neutralizeSlackMentions(message.text), SLACK_REPLY_MAX_CHARS);
      if (clean === "" || looksQuoted(message.text) || !looksLikeCorrection(clean)) continue;
      spans.push({
        kind: "slack_reply", text: clean, trust: "member", authorId: person, eventId: noteOf(facts.place, message.id),
        sourceKey: `slack:${facts.place.split("/").at(-1) ?? "channel"}`, audience, scopes: [facts.place],
      });
    }
    return spans.reverse();
  } catch {
    log("learning.slack_not_read", { reason: "unavailable" });
    return [];
  }
}
