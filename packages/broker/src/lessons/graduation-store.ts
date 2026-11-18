// The small rows graduation and tidy keep (lessons phase 4), all in Rovara's own store, one partition per company and project (`LESSON_GRAD#<project>` under the company's partition; nothing here reads another company's
// or project's):
//   card#<week>       the ONE "Make this permanent?" card of a week: the lesson it names and whether it is still open. Written once per week (a conditional put on an absent key), so two readers never make two cards.
//   snooze#<lesson>   "Not now": the lesson is not offered again until the time on the row.
//   draft#<id>        a draft check task: what a person may start ("Add a check for ..."). It is text. Nothing in Rovara starts it; a person does, on their own.
//   tidy#<period>     the Tidy card of a 30-day period: the least-used lessons it named and whether it is still open.
// Every read is shaped before it is used; a row that is not shaped like its kind is unreadable (a thrown `GraduationUnreadable`), never read as "nothing there".
import { companyScoped, when, type DocumentKey, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createHash } from "node:crypto";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Weeks count from a Monday (the epoch began on a Thursday, so the first Monday is day 4). */
export const weekOf = (now: number): number => Math.floor((now - 4 * DAY_MS) / WEEK_MS);
export const TIDY_PERIOD_MS = 30 * DAY_MS;
export const tidyPeriodOf = (now: number): number => Math.floor(now / TIDY_PERIOD_MS);
/** "Not now" keeps a lesson off the card for this long. */
export const CARD_SNOOZE_MS = 60 * DAY_MS;
export const SNOOZES_MAX = 200;
export const DRAFTS_MAX = 50;
export const DRAFT_REQUEST_MAX = 1_200;

export class GraduationUnreadable extends Error { constructor() { super("the graduation rows cannot be read"); this.name = "GraduationUnreadable"; } }

type Store = Pick<DocumentStore, "get" | "put" | "query">;
const pk = (companyId: OrgId, project: string): string => companyScoped(companyId, `LESSON_GRAD#${project}`);
const key = (companyId: OrgId, project: string, sk: string): DocumentKey => ({ pk: pk(companyId, project), sk });
const LESSON_ID = /^[A-Za-z0-9_-]{4,64}$/u;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isLessonId = (value: unknown): value is string => typeof value === "string" && LESSON_ID.test(value);

async function getRow(store: Pick<DocumentStore, "get">, k: DocumentKey): Promise<StoredDocument | undefined> {
  try { return await store.get(k); } catch { throw new GraduationUnreadable(); }
}

// ---- the weekly card

export type CardState = "open" | "done" | "later";
export interface CardRow { week: number; lessonId: string; state: CardState; at: number }
const cardOf = (row: StoredDocument | undefined): CardRow | undefined => {
  if (row === undefined) return undefined;
  if (row["entityType"] !== "LESSON_GRAD_CARD" || !isInt(row["week"]) || !isLessonId(row["lessonId"]) || !isInt(row["at"]) || (row["state"] !== "open" && row["state"] !== "done" && row["state"] !== "later")) throw new GraduationUnreadable();
  return { week: row["week"], lessonId: row["lessonId"], state: row["state"], at: row["at"] };
};
export async function readCard(store: Pick<DocumentStore, "get">, companyId: OrgId, project: string, week: number): Promise<CardRow | undefined> {
  return cardOf(await getRow(store, key(companyId, project, `card#${String(week)}`)));
}
/** Names this week's card, once: the first writer wins and everyone after reads that card. */
export async function openCard(store: Store, companyId: OrgId, project: string, week: number, lessonId: string, now: number): Promise<CardRow> {
  const item: StoredDocument = { ...key(companyId, project, `card#${String(week)}`), entityType: "LESSON_GRAD_CARD", week, lessonId, state: "open", at: now };
  let written: { applied: boolean };
  try { written = await store.put({ item, condition: when.absent() }); } catch { throw new GraduationUnreadable(); }
  if (written.applied) return { week, lessonId, state: "open", at: now };
  const existing = await readCard(store, companyId, project, week);
  if (existing === undefined) throw new GraduationUnreadable();
  return existing;
}
/** Closes the week's card, only while it is still the open card for this lesson. */
export async function closeCard(store: Store, companyId: OrgId, project: string, week: number, lessonId: string, state: "done" | "later", now: number): Promise<boolean> {
  const row = await readCard(store, companyId, project, week);
  if (row === undefined || row.lessonId !== lessonId || row.state !== "open") return false;
  try {
    const written = await store.put({ item: { ...key(companyId, project, `card#${String(week)}`), entityType: "LESSON_GRAD_CARD", week, lessonId, state, at: now }, condition: when.and(when.eq("state", "open"), when.eq("lessonId", lessonId)) });
    return written.applied;
  } catch { throw new GraduationUnreadable(); }
}

// ---- "Not now"

export async function snooze(store: Store & Pick<DocumentStore, "delete">, companyId: OrgId, project: string, lessonId: string, until: number, now = 0): Promise<void> {
  // Expired snoozes are swept as new ones are written, so the rows never pile up past what a read accepts.
  try {
    const page = await store.query({ pk: pk(companyId, project), sk: { op: "beginsWith", prefix: "snooze#" }, limit: SNOOZES_MAX });
    for (const row of page.items) if (typeof row["until"] === "number" && row["until"] <= now && typeof row["sk"] === "string") await store.delete({ key: { pk: pk(companyId, project), sk: row["sk"] } });
  } catch { throw new GraduationUnreadable(); }
  try { await store.put({ item: { ...key(companyId, project, `snooze#${lessonId}`), entityType: "LESSON_GRAD_SNOOZE", lessonId, until } }); } catch { throw new GraduationUnreadable(); }
}
/** The lessons that are snoozed now. At most `SNOOZES_MAX` rows are read; a project with more is read as unreadable (the card is not offered), never as "none snoozed". */
export async function snoozedNow(store: Pick<DocumentStore, "query">, companyId: OrgId, project: string, now: number): Promise<Set<string>> {
  let page: Awaited<ReturnType<DocumentStore["query"]>>;
  try { page = await store.query({ pk: pk(companyId, project), sk: { op: "beginsWith", prefix: "snooze#" }, limit: SNOOZES_MAX }); } catch { throw new GraduationUnreadable(); }
  if (page.cursor !== undefined) throw new GraduationUnreadable();
  const out = new Set<string>();
  for (const row of page.items) {
    if (row["entityType"] !== "LESSON_GRAD_SNOOZE" || !isLessonId(row["lessonId"]) || !isInt(row["until"]) || row["sk"] !== `snooze#${row["lessonId"]}`) throw new GraduationUnreadable();
    if (row["until"] > now) out.add(row["lessonId"]);
  }
  return out;
}

// ---- one target per lesson

/** Claims a lesson for ONE target before anything is made: the first claim stands, a repeat of the same target goes on, a different target is refused. Two people choosing two targets never make both. */
export async function claimGraduation(store: Store, companyId: OrgId, project: string, lessonId: string, target: string, now: number): Promise<"claimed" | "other_target"> {
  const k = key(companyId, project, `claim#${lessonId}`);
  let written: { applied: boolean };
  try { written = await store.put({ item: { ...k, entityType: "LESSON_GRAD_CLAIM", lessonId, target, at: now }, condition: when.absent() }); } catch { throw new GraduationUnreadable(); }
  if (written.applied) return "claimed";
  const row = await getRow(store, k);
  if (row === undefined || row["entityType"] !== "LESSON_GRAD_CLAIM" || typeof row["target"] !== "string") throw new GraduationUnreadable();
  return row["target"] === target ? "claimed" : "other_target";
}
/** Lets a lesson be claimed again (its rule was retired, or its draft dismissed). */
export async function releaseClaim(store: Pick<DocumentStore, "delete">, companyId: OrgId, project: string, lessonId: string): Promise<void> {
  try { await store.delete({ key: key(companyId, project, `claim#${lessonId}`) }); } catch { throw new GraduationUnreadable(); }
}

// ---- draft check tasks

export type DraftStatus = "draft" | "started" | "dismissed";
export interface CheckDraft { id: string; lessonId: string; title: string; request: string; paths: string[]; status: DraftStatus; createdAt: number; startedTaskId?: string }
/** The draft a lesson makes: stable, so a retry finds it. */
export const draftIdFor = (companyId: string, project: string, lessonId: string): string => `chk_${createHash("sha256").update(`check-draft\u0000${companyId}\u0000${project}\u0000${lessonId}`).digest("hex").slice(0, 16)}`;
const DRAFT_ID = /^chk_[0-9a-f]{16}$/u;
export const isDraftId = (value: unknown): value is string => typeof value === "string" && DRAFT_ID.test(value);
const draftOf = (row: StoredDocument): CheckDraft => {
  const id = row["id"], lessonId = row["lessonId"], title = row["title"], request = row["request"], paths = row["paths"], status = row["status"], createdAt = row["createdAt"], task = row["startedTaskId"];
  if (row["entityType"] !== "LESSON_CHECK_DRAFT" || !isDraftId(id) || row["sk"] !== `draft#${id}` || !isLessonId(lessonId) || typeof title !== "string" || title.length > 200 || typeof request !== "string" || request.length > DRAFT_REQUEST_MAX
    || !Array.isArray(paths) || paths.length > 20 || paths.some((p) => typeof p !== "string" || p.length > 200) || (status !== "draft" && status !== "started" && status !== "dismissed") || !isInt(createdAt)
    || (task !== undefined && (typeof task !== "string" || task.length > 100)) || (status === "started") !== (task !== undefined)) throw new GraduationUnreadable();
  return { id, lessonId, title, request, paths: paths as string[], status, createdAt, ...(task === undefined ? {} : { startedTaskId: task }) };
};
export async function putCheckDraft(store: Store & Pick<DocumentStore, "delete">, companyId: OrgId, project: string, draft: Omit<CheckDraft, "status" | "startedTaskId">): Promise<{ draft: CheckDraft; already: boolean }> {
  // Finished drafts (started or dropped) are swept as new ones are made, oldest first, so the list never outgrows what a read accepts; a project with that many OPEN drafts must settle some first.
  try {
    const page = await store.query({ pk: pk(companyId, project), sk: { op: "beginsWith", prefix: "draft#" }, limit: DRAFTS_MAX });
    let rows = page.items.length;
    const finished = page.items.filter((row) => row["status"] !== "draft" && typeof row["sk"] === "string").sort((a, b) => Number(a["createdAt"]) - Number(b["createdAt"]));
    for (const row of finished) { if (rows < DRAFTS_MAX - 5) break; await store.delete({ key: { pk: pk(companyId, project), sk: row["sk"] } }); rows -= 1; }
    if (rows >= DRAFTS_MAX - 1 && page.items.every((row) => row["sk"] !== `draft#${draft.id}`)) throw new GraduationUnreadable();
  } catch { throw new GraduationUnreadable(); }
  const item: StoredDocument = { ...key(companyId, project, `draft#${draft.id}`), entityType: "LESSON_CHECK_DRAFT", id: draft.id, lessonId: draft.lessonId, title: draft.title, request: draft.request, paths: draft.paths, status: "draft", createdAt: draft.createdAt };
  let written: { applied: boolean };
  try { written = await store.put({ item, condition: when.absent() }); } catch { throw new GraduationUnreadable(); }
  if (written.applied) return { draft: { ...draft, status: "draft" }, already: false };
  const existing = await getCheckDraft(store, companyId, project, draft.id);
  if (existing === undefined) throw new GraduationUnreadable();
  return { draft: existing, already: true };
}
export async function getCheckDraft(store: Pick<DocumentStore, "get">, companyId: OrgId, project: string, id: string): Promise<CheckDraft | undefined> {
  const row = await getRow(store, key(companyId, project, `draft#${id}`));
  return row === undefined ? undefined : draftOf(row);
}
export async function listCheckDrafts(store: Pick<DocumentStore, "query">, companyId: OrgId, project: string): Promise<CheckDraft[]> {
  let page: Awaited<ReturnType<DocumentStore["query"]>>;
  try { page = await store.query({ pk: pk(companyId, project), sk: { op: "beginsWith", prefix: "draft#" }, limit: DRAFTS_MAX }); } catch { throw new GraduationUnreadable(); }
  // More drafts than one page holds is unreadable, never a silent subset.
  if (page.cursor !== undefined) throw new GraduationUnreadable();
  return page.items.map(draftOf).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
/** A draft moves from `draft` to `started` (with the task a person started) or `dismissed`, once. */
export async function moveCheckDraft(store: Store, companyId: OrgId, project: string, id: string, to: { status: "started"; taskId: string } | { status: "dismissed" }): Promise<"moved" | "not_found" | "not_open"> {
  const draft = await getCheckDraft(store, companyId, project, id);
  if (draft === undefined) return "not_found";
  if (draft.status !== "draft") return "not_open";
  const item: StoredDocument = { ...key(companyId, project, `draft#${id}`), entityType: "LESSON_CHECK_DRAFT", id, lessonId: draft.lessonId, title: draft.title, request: draft.request, paths: draft.paths, status: to.status, createdAt: draft.createdAt, ...(to.status === "started" ? { startedTaskId: to.taskId } : {}) };
  try { return (await store.put({ item, condition: when.eq("status", "draft") })).applied ? "moved" : "not_open"; } catch { throw new GraduationUnreadable(); }
}

/** Blanks a draft's words (the lesson it came from is gone for good) and drops it if it was still open; its row and status are kept. Idempotent. */
export async function blankCheckDraft(store: Store, companyId: OrgId, project: string, id: string): Promise<void> {
  const draft = await getCheckDraft(store, companyId, project, id);
  if (draft === undefined || (draft.title === "Removed." && draft.request === "Removed.")) return;
  const status = draft.status === "draft" ? "dismissed" : draft.status;
  const item: StoredDocument = { ...key(companyId, project, `draft#${id}`), entityType: "LESSON_CHECK_DRAFT", id, lessonId: draft.lessonId, title: "Removed.", request: "Removed.", paths: [], status, createdAt: draft.createdAt, ...(draft.startedTaskId === undefined ? {} : { startedTaskId: draft.startedTaskId }) };
  try { await store.put({ item }); } catch { throw new GraduationUnreadable(); }
}

// ---- the Tidy card

export type TidyState = "open" | "done" | "later";
export interface TidyRow { period: number; ids: string[]; state: TidyState; at: number }
const tidyOf = (row: StoredDocument | undefined): TidyRow | undefined => {
  if (row === undefined) return undefined;
  const ids = row["ids"];
  if (row["entityType"] !== "LESSON_GRAD_TIDY" || !isInt(row["period"]) || !Array.isArray(ids) || ids.length > 10 || !ids.every(isLessonId) || !isInt(row["at"]) || (row["state"] !== "open" && row["state"] !== "done" && row["state"] !== "later")) throw new GraduationUnreadable();
  return { period: row["period"], ids: ids, state: row["state"], at: row["at"] };
};
export async function readTidy(store: Pick<DocumentStore, "get">, companyId: OrgId, project: string, period: number): Promise<TidyRow | undefined> {
  return tidyOf(await getRow(store, key(companyId, project, `tidy#${String(period)}`)));
}
export async function openTidy(store: Store, companyId: OrgId, project: string, period: number, ids: readonly string[], now: number): Promise<TidyRow> {
  const item: StoredDocument = { ...key(companyId, project, `tidy#${String(period)}`), entityType: "LESSON_GRAD_TIDY", period, ids: [...ids], state: "open", at: now };
  let written: { applied: boolean };
  try { written = await store.put({ item, condition: when.absent() }); } catch { throw new GraduationUnreadable(); }
  if (written.applied) return { period, ids: [...ids], state: "open", at: now };
  const existing = await readTidy(store, companyId, project, period);
  if (existing === undefined) throw new GraduationUnreadable();
  return existing;
}
export async function closeTidy(store: Store, companyId: OrgId, project: string, period: number, state: "done" | "later", now: number): Promise<boolean> {
  const row = await readTidy(store, companyId, project, period);
  if (row === undefined || row.state !== "open") return false;
  try {
    return (await store.put({ item: { ...key(companyId, project, `tidy#${String(period)}`), entityType: "LESSON_GRAD_TIDY", period, ids: row.ids, state, at: now }, condition: when.eq("state", "open") })).applied;
  } catch { throw new GraduationUnreadable(); }
}
