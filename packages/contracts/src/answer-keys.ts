// The smart Just answer's keys (lead 4, J1; L4-HC adds the start box's counter): small row families, both under the company's own partition, so the company purge removes them with no purge change.
//  - the per-person hourly counter: `ORG#<company>#ANSWER_RATE`, one row per person and hour. A person id is an id, never words.
//  - a thread's memory index: `ORG#<company>#WIKI#<project>` / `THREAD#<hash>`: the ids of the last few answer records of the thread (the words are in the answer records, which expire after 30 days and are
//    erased with their asker), and when the thread was last used. Keyed by company AND project, so a thread of one project is never read by another.
import { createHash } from "node:crypto";
import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { orgScoped } from "./company-scope.js";
import { wikiPartition, type WikiKey } from "./wiki-keys.js";

const PersonPart = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u);

/** The partition of the company's per-person answer counters. */
export const answerRatePartition = (orgId: OrgId): string => orgScoped(OrgIdSchema.parse(orgId), "ANSWER_RATE");
/** One person's counter for one hour (`windowStart` in milliseconds, a whole hour). */
export const answerRateKey = (orgId: OrgId, personId: string, windowStart: number): WikiKey => ({
  pk: answerRatePartition(orgId), sk: `PERSON#${PersonPart.parse(personId)}#${String(z.number().int().min(0).parse(windowStart))}`,
});

/** The partition of the company's per-person start box suggestion counters (L4-HC): `ORG#<company>#START_SUGGEST_RATE`, one row per project, person and hour. Ids only, never words. */
export const startSuggestRatePartition = (orgId: OrgId): string => orgScoped(OrgIdSchema.parse(orgId), "START_SUGGEST_RATE");
/** The sort-key prefix of one person's counters on one project (every hour of it): the company is the partition, the project and the person are both in the key. */
export const startSuggestRatePrefix = (project: string, personId: string): string => `PROJECT#${z.string().regex(AGENTX_NAME_PATTERN).parse(project)}#PERSON#${PersonPart.parse(personId)}#`;
/** One person's counter on one project for one hour (`windowStart` in milliseconds, a whole hour). */
export const startSuggestRateKey = (orgId: OrgId, project: string, personId: string, windowStart: number): WikiKey => ({
  pk: startSuggestRatePartition(orgId), sk: `${startSuggestRatePrefix(project, personId)}${String(z.number().int().min(0).parse(windowStart))}`,
});

/** The sort-key family of thread memory inside a project's wiki partition. */
export const ANSWER_THREAD_SK = "THREAD#";
/** A thread's row. `scope` keeps a private thread apart: a person's own thread id is hashed with the person, so another person who guesses the id reads a different (empty) thread. */
export function answerThreadKey(orgId: OrgId, project: string, threadId: string, scope: { personId: string } | "shared"): WikiKey {
  const hash = createHash("sha256").update(`answer-thread\0${scope === "shared" ? "" : PersonPart.parse(scope.personId)}\0${threadId}`, "utf8").digest("hex").slice(0, 32);
  return { pk: wikiPartition(orgId, project), sk: `${ANSWER_THREAD_SK}${hash}` };
}
/** The id of an answer record: the same company, project, person and request id give the same id, so a repeat is the same answer. */
export function answerIdFor(orgId: OrgId, project: string, personId: string, requestId: string): string {
  return `a${createHash("sha256").update(`answer\0${orgId}\0${project}\0${PersonPart.parse(personId)}\0${requestId}`, "utf8").digest("hex").slice(0, 31)}`;
}
