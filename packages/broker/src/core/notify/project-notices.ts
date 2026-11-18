// L4-U5b: the project notices in a person's own inbox: "Setup needs repair" (`setup_broken`) and "Nightly upkeep is paused" (`upkeep_paused`). They are about a project, not a task, so the session inbox (`inbox.ts`) never lists
// them; an admin who is told by neither chat nor email still finds them here (Cloud shows them in the admin inbox).
//
// A row is never shown on its own say-so, exactly as at delivery (`deliverAttention`): the row is the caller's own (the partition is the company's and the person's, built from the caller's live membership), its subject
// names the project, the person must STILL administer the project now (a project admin, or a company owner or admin, read live), and a setup notice shows only while the setup it names is STILL broken (the re-check's own
// key, read now). A person who stopped administering, a break that was fixed, or a row of anything else reads as nothing: no words, no count, no hint that a row exists. What is shown is fixed words and the project's name;
// no task, no cost, no repository text beyond the check's own redacted failing step that the page already shows.
import { UPKEEP_NOTICE_WORDS, upkeepSubjectOf, type DocumentStore, type StoredDocument } from "@agentx/contracts";
import { setupAdminNoticeWords } from "../setup-agent/recheck-rows.js";
import { setupBrokenSubjectOf } from "../setup-agent/broken-notice.js";
import { oneLine } from "./attention.js";
import { PROJECT_NOTICE_PREFIX, inboxPartition, isProjectNoticeKind, projectNoticeKey, type ProjectNoticeKind } from "./inbox-rows.js";

/** The most raw rows read, and the most checked (each check is a live read of the person's standing), for one person in one request. */
export const PROJECT_NOTICES_ROWS_MAX = 200;
export const PROJECT_NOTICES_CHECK_MAX = 50;
const ROWS_PAGE = 100;
const PROJECT_MAX = 100;

export interface ProjectNoticeItem {
  /** `<kind>.<atMs>.<project>`: names no person. */
  id: string;
  kind: ProjectNoticeKind;
  project: string;
  /** Fixed words (the project's name is not in them). */
  status: string;
  /** When the notice was written (an ISO time). */
  at: string;
}
export interface ProjectNoticePage { items: ProjectNoticeItem[] }

export interface ProjectNoticeDeps {
  store: Pick<DocumentStore, "query">;
  now: () => number;
  /** Whether the person still administers the project now (a project admin, or a company owner or admin), read live. A throw or anything but `true` is no. */
  administers(orgId: string, developerId: string, project: string): Promise<boolean>;
  /** The project's open repair card now, or undefined when the setup is no longer broken. Absent: no setup notice is shown. */
  setupRead?(orgId: string, project: string): Promise<{ key: string; failedStep: string; fixReady: boolean } | undefined>;
}
/** The caller: their company is the live membership's, their id the verified person's. */
export interface ProjectNoticePerson { companyId: string; developerId: string }

interface Row { kind: ProjectNoticeKind; subjectId: string; at: string; atMs: number; order: string }

function rowOf(item: StoredDocument, who: ProjectNoticePerson, nowSeconds: number): Row | undefined {
  const { orgId, developerId, subjectId, kind, at, atMs } = item;
  if (orgId !== who.companyId || developerId !== who.developerId || typeof subjectId !== "string" || !isProjectNoticeKind(kind) || typeof at !== "string" || typeof atMs !== "number" || !Number.isSafeInteger(atMs)) return undefined;
  // The row sits where this code puts it, for its own subject and kind (a row at any other place is not one this code wrote).
  if (item.sk !== projectNoticeKey(who.companyId, who.developerId, subjectId, kind).sk) return undefined;
  const expires = item["expiresAtSec"];
  if (typeof expires !== "number" || expires <= nowSeconds) return undefined;
  return { kind, subjectId, at, atMs, order: item.sk };
}

/** The person's project notices, newest first. Only rows that still hold against the project now are shown. */
export async function listProjectNotices(deps: ProjectNoticeDeps, who: ProjectNoticePerson): Promise<ProjectNoticePage> {
  const nowSeconds = Math.floor(deps.now() / 1000);
  const rows: Row[] = [];
  let cursor: string | undefined;
  let read = 0;
  do {
    const page = await deps.store.query({ pk: inboxPartition(who.companyId, who.developerId), sk: { op: "beginsWith", prefix: PROJECT_NOTICE_PREFIX }, limit: ROWS_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      read += 1;
      const row = rowOf(item, who, nowSeconds);
      if (row !== undefined) rows.push(row);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && read < PROJECT_NOTICES_ROWS_MAX);
  rows.sort((a, b) => (a.atMs !== b.atMs ? b.atMs - a.atMs : a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
  const items: ProjectNoticeItem[] = [];
  let checked = 0;
  for (const row of rows) {
    if (checked >= PROJECT_NOTICES_CHECK_MAX) break;
    checked += 1;
    const item = await checkedItem(deps, who, row);
    if (item !== undefined) items.push(item);
  }
  return { items };
}

async function checkedItem(deps: ProjectNoticeDeps, who: ProjectNoticePerson, row: Row): Promise<ProjectNoticeItem | undefined> {
  try {
    if (row.kind === "upkeep_paused") {
      const subject = upkeepSubjectOf(row.subjectId);
      if (subject === undefined || (await deps.administers(who.companyId, who.developerId, subject.project)) !== true) return undefined;
      return { id: `${row.kind}.${String(row.atMs)}.${subject.project}`, kind: row.kind, project: oneLine(subject.project, PROJECT_MAX), status: UPKEEP_NOTICE_WORDS[subject.reason], at: row.at };
    }
    const subject = setupBrokenSubjectOf(row.subjectId);
    if (subject === undefined || deps.setupRead === undefined || (await deps.administers(who.companyId, who.developerId, subject.project)) !== true) return undefined;
    const open = await deps.setupRead(who.companyId, subject.project);
    // Still broken, and still THIS break (the re-check's own key starts with the prefix the notice was made from).
    if (open === undefined || !open.key.startsWith(subject.prefix)) return undefined;
    return { id: `${row.kind}.${String(row.atMs)}.${subject.project}`, kind: row.kind, project: oneLine(subject.project, PROJECT_MAX), status: oneLine(setupAdminNoticeWords(open.failedStep, open.fixReady), 400), at: row.at };
  } catch {
    // A read that failed is "not shown", never a guess.
    return undefined;
  }
}
