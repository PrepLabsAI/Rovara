// What an answer teaches the wiki (lead 4, J5): the gap list and "Not right". No new stored data class:
//  - GAPS are read from the answer records J1 already writes (30 days, erased with their asker): an answer that was partly given or not found, one the code had to carry because no wiki page was read, and
//    one a person pressed "Not right" on. Questions are grouped by topic (the same few words in any order are one topic); a topic shows how many DIFFERENT people asked, never who, so one person cannot
//    inflate it. An expired or erased record takes its gap with it. The list is bounded (records read, topics shown).
//  - "NOT RIGHT" is the asker's own press on their own answer. It is a soft signal: the wiki claims the answer rested on (a claim whose cited place is one of the answer's sources, on a page the answer read)
//    are marked "may be out of date", so the next refresh (W4: pages with changed claims) writes them again. They are NOT hidden from agents, because we do not know which claim is wrong; a hidden claim
//    is the work of "Mark wrong" (a contributor's decision) or of Code failing to find a claim's quote (J1's flag).
import {
  ANSWER_FEEDBACK_LIMITS, type AnswerGap, type AnswerGapKind, type AnswerGapsResponse, type NotRightResponse, type WikiAnswerRecord, type WikiStore,
} from "@agentx/contracts";
import { plainLine } from "./frame.js";

// ---- Topics ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const STOP = new Set(["the", "and", "for", "are", "was", "were", "how", "what", "why", "when", "where", "which", "who", "does", "did", "can", "could", "would", "should", "this", "that", "these", "those", "with", "from",
  "into", "about", "there", "their", "have", "has", "had", "you", "your", "our", "its", "not", "but", "any", "all", "use", "used", "using", "work", "works", "get", "gets", "please", "tell", "explain", "show", "they", "them", "then", "than", "also", "just", "doing", "being", "been", "will", "shall", "may", "might"]);
const URL = /\bhttps?:\/\/\S+/giu;
const EMAIL = /\S+@\S+\.\S+/gu;
const MENTION = /<@[^>]*>|@[\p{L}\p{N}_.-]+/gu;

/** The few words that make a question's topic, in the order first used. No names of people are looked for: the topic only ever reaches maintainers, and it goes when its answer record does. */
export function topicWords(question: string): string[] {
  const folded = question.normalize("NFKC").toLowerCase().replace(URL, " ").replace(EMAIL, " ").replace(MENTION, " ");
  const words: string[] = [];
  for (const raw of folded.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3 || raw.length > 32 || STOP.has(raw) || /\d{4,}/u.test(raw)) continue;
    // A plural is the same topic as its singular.
    const word = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!words.includes(word)) words.push(word);
    if (words.length >= ANSWER_FEEDBACK_LIMITS.topicWords) break;
  }
  return words;
}
/** The grouping key of a topic: its words, in any order. */
export const topicKey = (question: string): string => [...topicWords(question)].sort().join(" ");

// ---- The gap list ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const RANK: Record<AnswerGapKind, number> = { not_right: 0, not_found: 1, partly: 2, wiki_empty: 3 };

/** What a record says about the wiki, if anything: undefined when the answer was whole and the wiki carried it. */
export function gapKindOf(record: WikiAnswerRecord): AnswerGapKind | undefined {
  if (record.notRight === true) return "not_right";
  if (record.outcome === "dont_know") return "not_found";
  if (record.outcome === "partly") return "partly";
  // Answered from the code with sources, and no wiki page was read.
  if (record.outcome === "answered" && record.sources.length > 0 && record.pagesRead.length === 0) return "wiki_empty";
  return undefined;
}

export async function listGaps(wiki: Pick<WikiStore, "listAnswers">, project: string): Promise<AnswerGapsResponse> {
  const { records, more: moreRecords } = await wiki.listAnswers(project, ANSWER_FEEDBACK_LIMITS.recordsScanned);
  const groups = new Map<string, { kind: AnswerGapKind; askers: Set<string>; questions: number; last: WikiAnswerRecord }>();
  for (const record of records) {
    const kind = gapKindOf(record);
    if (kind === undefined) continue;
    const key = topicKey(record.question);
    // A question with no topic words ("why?") is no use to a maintainer.
    if (key === "") continue;
    const group = groups.get(key);
    if (group === undefined) { groups.set(key, { kind, askers: new Set([record.askedBy]), questions: 1, last: record }); continue; }
    group.askers.add(record.askedBy);
    group.questions += 1;
    if (RANK[kind] < RANK[group.kind]) group.kind = kind;
    if (record.createdAt > group.last.createdAt) group.last = record;
  }
  const items: AnswerGap[] = [...groups.values()].map((group) => ({
    topic: plainLine(group.last.question, ANSWER_FEEDBACK_LIMITS.topicChars) || "A question", kind: group.kind, people: group.askers.size, questions: group.questions, lastAskedAt: group.last.createdAt,
  }));
  items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.people - a.people || b.lastAskedAt.localeCompare(a.lastAskedAt) || a.topic.localeCompare(b.topic));
  return { project, items: items.slice(0, ANSWER_FEEDBACK_LIMITS.gaps), more: moreRecords || items.length > ANSWER_FEEDBACK_LIMITS.gaps };
}

// ---- Not right -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The asker presses "Not right". Undefined: there is no such answer for this person (another person's, expired, erased, or another project's: all the same). The claims go first and the record last, so a
 * fault in between lets the person press again (marking a claim twice changes nothing).
 */
export async function pressNotRight(wiki: Pick<WikiStore, "readAnswer" | "readPage" | "markClaims" | "markAnswerNotRight">, input: { project: string; answerId: string; personId: string }): Promise<NotRightResponse | undefined> {
  const record = await wiki.readAnswer(input.project, input.answerId);
  if (record === undefined || record.askedBy !== input.personId) return undefined;
  if (record.notRight === true) return { answerId: input.answerId, state: "already", claims: 0 };
  let queued = 0;
  for (const pageId of record.pagesRead.slice(0, 20)) {
    if (queued >= ANSWER_FEEDBACK_LIMITS.claimsPerPress) break;
    const read = await wiki.readPage(input.project, pageId, "person");
    if (read === undefined) continue;
    const changes = read.page.claims
      .filter((claim) => claim.source === "found" && claim.citations.some((citation) => record.sources.some((source) => source.repo === citation.repo && source.path === citation.path
        && source.line >= citation.line - ANSWER_FEEDBACK_LIMITS.lineSlack && source.line <= (citation.lineEnd ?? citation.line) + ANSWER_FEEDBACK_LIMITS.lineSlack)))
      .slice(0, ANSWER_FEEDBACK_LIMITS.claimsPerPress - queued)
      .map((claim) => ({ claimId: claim.claimId, source: "changed" as const }));
    if (changes.length === 0) continue;
    queued += await wiki.markClaims(input.project, pageId, changes);
  }
  const marked = await wiki.markAnswerNotRight(input.project, input.answerId, input.personId);
  if (marked === undefined) return undefined;
  if (marked === "already") return { answerId: input.answerId, state: "already", claims: 0 };
  return { answerId: input.answerId, state: queued > 0 ? "queued" : "noted", claims: queued };
}
