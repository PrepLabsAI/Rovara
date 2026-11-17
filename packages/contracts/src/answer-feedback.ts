// Answers feed the wiki (lead 4, J5; DEC 254zi): what an answer teaches the wiki, with NO new stored data class. Gaps are READ from the answer records J1 already writes (30 days, erased with the asker),
// and "Not right" is one extra flag on the same record.
//
//   GET  /v1/app/projects/{project}/wiki/gaps                          "Questions the wiki could not answer" (maintainers only): questions answered partly or not at all, and
//                                                                      answers the code had to carry because the wiki showed nothing, grouped by topic
//   POST /v1/app/projects/{project}/answers/{answerId}/not-right       {}   the asker presses "Not right" on an answer: the wiki claims the answer rested on are queued for a re-check
//                                                                      at the next refresh (marked "may be out of date"; NOT hidden, because we do not know which one is wrong)
//
// Rules (the code says how each is kept): the company and the caller come from live membership, never a body; no asker is ever named (a gap shows how many different people asked, not who); an answer
// record that expires or is erased with its asker takes its gap with it; every list is bounded.
import { z } from "zod";
import { WikiIdSchema } from "./wiki-store.js";

export const ANSWER_FEEDBACK_LIMITS = {
  /** The most answer records one gap list reads (when a project has more, the list covers part of them and `more` says so). */
  recordsScanned: 500,
  /** The most topics one list holds. */
  gaps: 50,
  /** The most words of a question that make its topic, and the longest topic shown, in characters. */
  topicWords: 8,
  topicChars: 160,
  /** The most wiki claims one "Not right" press queues. */
  claimsPerPress: 12,
  /** Lines around a cited line that still count as "the claim's place" when matching an answer's source to a claim. */
  lineSlack: 3,
} as const;

export const ANSWER_GAP_KINDS = ["not_found", "partly", "wiki_empty", "not_right"] as const;
export type AnswerGapKind = (typeof ANSWER_GAP_KINDS)[number];

export const AnswerGapSchema = z.object({
  /** A question of this topic as it was asked last (the asker's words, made short; never the asker's name). Only maintainers read it. */
  topic: z.string().min(1).max(ANSWER_FEEDBACK_LIMITS.topicChars),
  /** The worst thing that happened on this topic: not found, partly answered, a person pressed "Not right", or the wiki had nothing and the code carried the answer. */
  kind: z.enum(ANSWER_GAP_KINDS),
  /** How many different people asked it (never who). */
  people: z.number().int().min(1),
  questions: z.number().int().min(1),
  lastAskedAt: z.string(),
}).strict();
export type AnswerGap = z.infer<typeof AnswerGapSchema>;

export const AnswerGapsResponseSchema = z.object({
  project: z.string(),
  items: z.array(AnswerGapSchema).max(ANSWER_FEEDBACK_LIMITS.gaps),
  /** True when more records or topics existed than one list holds. */
  more: z.boolean(),
}).strict();
export type AnswerGapsResponse = z.infer<typeof AnswerGapsResponseSchema>;

export const NotRightBodySchema = z.object({}).strict();
/** `queued`: claims were marked for the next refresh. `noted`: the answer rested on no wiki claim, so only the gap list changes. `already`: the same person pressed it before. */
export const NotRightResponseSchema = z.object({ answerId: WikiIdSchema, state: z.enum(["queued", "noted", "already"]), claims: z.number().int().min(0) }).strict();
export type NotRightResponse = z.infer<typeof NotRightResponseSchema>;

export const ANSWER_FEEDBACK_WORDS = {
  notYours: "That answer is not there.",
  needsMaintainer: "Only a project maintainer, or an owner or admin of the company, can see that list.",
  unavailable: "That could not be saved. Try again.",
} as const;
