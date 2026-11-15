// Earned trust (lessons holistic review fix 5, DEC 231): a project starts in Suggest (a person approves every lesson). Once its people have approved about ten lessons with few drops, the lessons API OFFERS
// "Let low-risk lessons go live on trial?". Nothing changes by itself: a project or company admin must accept, and accepting is the same change as setting the mode to On ("auto"), where a low-risk lesson
// drafted from a member's own correction goes live on trial (Standard preset) and everything else still waits for a person. "Not now" hides the offer for a while.
//
//   - The tally reads the project's own lessons only (the company's partition, through the lesson store), over the last `TRIAL_OFFER_WINDOW_DAYS`: an APPROVAL is a lesson a person approved (an approval
//     whose mode is a person's, by a person, not the system or the repository edit) that is no longer waiting; a DROP is a lesson a person rejected. Counts only.
//   - Due when approvals >= `TRIAL_OFFER_APPROVALS` and drops are at most `TRIAL_OFFER_DROP_SHARE` of the decisions. Bounded: one page of at most `TRIAL_OFFER_LESSONS_MAX` lessons is read; a project with
//     more gets no offer (never a guess). Offered only where accepting would really start trials (`trialWouldStart`).
//   - "Not now" is one company-scoped row per project, kept `TRIAL_OFFER_SNOOZE_DAYS` (it names no person: the audit record says who). The company purge removes it with the company's partition.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { LearningSettings, ResolvedLearning } from "./policy.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

export const TRIAL_OFFER_APPROVALS = 10;
export const TRIAL_OFFER_DROP_SHARE = 0.2;
export const TRIAL_OFFER_WINDOW_DAYS = 90;
export const TRIAL_OFFER_SNOOZE_DAYS = 30;
/** The most lessons one tally looks at: the hosted store's own bound on a project's set (`MAX_SET_MEMBERS`), so a whole hosted project is always read in one page. */
export const TRIAL_OFFER_LESSONS_MAX = 2_000;
const DAY = 86_400_000;
/** Approval modes that are a person's own decision (`auto` and `trial` are the system's). */
const PERSON_MODES: ReadonlySet<string> = new Set(["one", "second_person", "sole_owner_exception"]);
/** The statuses of a lesson a person may have approved and that no longer waits. */
const DECIDED: readonly Lesson["status"][] = ["active", "stale", "retired", "expired", "rejected"];

export interface TrialOfferTally { approvals: number; drops: number; since: number }

const byPerson = (approval: Lesson["approvals"][number], since: number): boolean =>
  PERSON_MODES.has(approval.mode) && approval.at >= since && !approval.by.startsWith("system:");

/**
 * The project's person decisions over the window, or undefined when they could not all be read (more than `TRIAL_OFFER_LESSONS_MAX` lessons in the project's set, or the store failed). One page of the set
 * is read, so at most that many lessons are ever loaded.
 *   - approval: a lesson a person approved in the window that is still kept (active, stale, or faded by itself);
 *   - drop: a lesson a person rejected in the window after it waited for a person (`pendingExpiresAt` set: the system's own refusals never wait for anyone and are not counted), or one a person approved
 *     that was retired since (someone, or its harm marks, took it back).
 */
export async function tallyTrialOffer(store: Pick<LessonStore, "listPage">, key: ScopeKey, now: number): Promise<TrialOfferTally | undefined> {
  const since = now - TRIAL_OFFER_WINDOW_DAYS * DAY;
  let lessons: Lesson[];
  try {
    const page = await store.listPage(key, { statuses: DECIDED, limit: TRIAL_OFFER_LESSONS_MAX });
    if (page.next !== undefined) return undefined;
    lessons = page.lessons;
  } catch { return undefined; }
  if (lessons.length > TRIAL_OFFER_LESSONS_MAX) return undefined;
  let approvals = 0;
  let drops = 0;
  for (const lesson of lessons) {
    // The store is not trusted to filter: another project's or company's lesson is never counted.
    if (lesson.workspaceId !== key.workspaceId || lesson.project !== key.project) continue;
    if (lesson.status === "rejected") { if (lesson.updatedAt >= since && lesson.pendingExpiresAt !== undefined) drops += 1; continue; }
    if (!lesson.approvals.some((approval) => byPerson(approval, since))) continue;
    if (lesson.status === "retired") drops += 1; else approvals += 1;
  }
  return { approvals, drops, since };
}

/**
 * Whether accepting would really let low-risk lessons go live ON TRIAL (`resolveLearning`'s `trialAllowed` once the mode is On), and nothing more: Standard preset, no company approval floor, no required
 * group, no two-person rule, and tier 0 not set to go live by itself (that would be automatic go-live, not a trial). Otherwise there is nothing to offer.
 */
export function trialWouldStart(settings: Pick<LearningSettings, "companyApproval" | "tier0Approval" | "approval">, resolved: Pick<ResolvedLearning, "preset" | "requiredGroups" | "approval">): boolean {
  return resolved.preset === "standard" && settings.companyApproval === undefined && resolved.requiredGroups.length === 0
    && resolved.approval.tier0 !== "two" && resolved.approval.tier1 !== "two"
    && resolved.approval.tier0 !== "auto" && settings.tier0Approval !== "auto" && settings.approval?.tier0 !== "auto";
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
