// Earned trust (lessons holistic review fix 5, DEC 231): a project starts in Suggest (a person approves every lesson). Once its people have approved about ten lessons with few drops, the lessons API OFFERS
// "Let low-risk lessons go live on trial?". Nothing changes by itself: a project or company admin must accept, and accepting is the same change as setting the mode to On ("auto"), where a low-risk lesson
// drafted from a member's own correction goes live on trial (Standard preset) and everything else still waits for a person. "Not now" hides the offer for a while.
//
//   - The tally reads the project's own lessons only (the company's partition, through the lesson store), over the last `TRIAL_OFFER_WINDOW_DAYS`: an APPROVAL is a lesson a person approved (an approval
//     whose mode is a person's, by a person, not the system or the repository edit) that is no longer waiting; a DROP is a lesson a person rejected. Counts only.
//   - Due when approvals >= `TRIAL_OFFER_APPROVALS` and drops are at most `TRIAL_OFFER_DROP_SHARE` of the decisions. Bounded: at most `TRIAL_OFFER_LESSONS_MAX` lessons are looked at; past it the
//     tally is not trusted and no offer is made (never a guess).
//   - "Not now" is one company-scoped row per project, kept `TRIAL_OFFER_SNOOZE_DAYS` (it names no person: the audit record says who). The company purge removes it with the company's partition.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

export const TRIAL_OFFER_APPROVALS = 10;
export const TRIAL_OFFER_DROP_SHARE = 0.2;
export const TRIAL_OFFER_WINDOW_DAYS = 90;
export const TRIAL_OFFER_SNOOZE_DAYS = 30;
/** The most lessons one tally looks at. */
export const TRIAL_OFFER_LESSONS_MAX = 5_000;
const DAY = 86_400_000;
/** Approval modes that are a person's own decision (`auto` and `trial` are the system's). */
const PERSON_MODES: ReadonlySet<string> = new Set(["one", "second_person", "sole_owner_exception"]);
/** The statuses of a lesson a person may have approved and that no longer waits. */
const DECIDED: readonly Lesson["status"][] = ["active", "stale", "retired", "expired", "rejected"];

export interface TrialOfferTally { approvals: number; drops: number; since: number }

const byPerson = (approval: Lesson["approvals"][number], since: number): boolean =>
  PERSON_MODES.has(approval.mode) && approval.at >= since && !approval.by.startsWith("system:");

/** The project's person decisions over the window, or undefined when they could not all be read (too many lessons, or the store failed). */
export async function tallyTrialOffer(store: Pick<LessonStore, "list">, key: ScopeKey, now: number): Promise<TrialOfferTally | undefined> {
  const since = now - TRIAL_OFFER_WINDOW_DAYS * DAY;
  let lessons: Lesson[];
  try { lessons = await store.list(key, { statuses: DECIDED }); } catch { return undefined; }
  if (lessons.length > TRIAL_OFFER_LESSONS_MAX) return undefined;
  let approvals = 0;
  let drops = 0;
  for (const lesson of lessons) {
    // The store is not trusted to filter: another project's or company's lesson is never counted.
    if (lesson.workspaceId !== key.workspaceId || lesson.project !== key.project) continue;
    if (lesson.status === "rejected") { if (lesson.updatedAt >= since) drops += 1; continue; }
    if (lesson.approvals.some((approval) => byPerson(approval, since))) approvals += 1;
  }
  return { approvals, drops, since };
}

/** Whether a tally earns the offer. */
export const trialOfferEarned = (tally: TrialOfferTally): boolean =>
  tally.approvals >= TRIAL_OFFER_APPROVALS && tally.drops <= TRIAL_OFFER_DROP_SHARE * (tally.approvals + tally.drops);

/** Whether a person said "not now" recently (the row is read, and its time checked, so an unswept row does not count). A row that cannot be read counts as snoozed: no offer while in doubt. */
export async function trialOfferSnoozed(documents: Pick<DocumentStore, "get">, companyId: OrgId, project: string, now: number): Promise<boolean> {
  try {
    const row = await documents.get({ pk: companyScoped(companyId, `LESSON_TRIAL_OFFER#${project}`), sk: "NOT_NOW" });
    return row !== undefined && typeof row["at"] === "number" && row["at"] > now - TRIAL_OFFER_SNOOZE_DAYS * DAY;
  } catch { return true; }
}

/** Records "not now" for the project. Throws when it could not be saved. */
export async function snoozeTrialOffer(documents: Pick<DocumentStore, "put" | "ttlAttribute">, companyId: OrgId, project: string, now: number): Promise<void> {
  await documents.put({ item: {
    pk: companyScoped(companyId, `LESSON_TRIAL_OFFER#${project}`), sk: "NOT_NOW", entityType: "LESSON_TRIAL_OFFER", at: now,
    ...(documents.ttlAttribute === undefined ? {} : { [documents.ttlAttribute]: Math.floor(now / 1000) + TRIAL_OFFER_SNOOZE_DAYS * 86_400 }),
  } });
}
