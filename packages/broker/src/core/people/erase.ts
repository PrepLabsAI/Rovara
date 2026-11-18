// Person erase (row 13.1; ported from the earlier hosted line's person erase, DEC 212): what Code removes when a company erases one person, company-scoped.
//
// One call, in this order, repeatable with the same request:
//   1. The receipt and the audit record, in ONE transaction: the receipt row (`ORG#<company>#PERSON_ERASED#<person>`, written once, so a repeat keeps the first time and records nothing again), the
//      `person.erased` event through the audit sink's `stage`, and the pending walk of the person's evidence (only absent fields are set, so a saved cursor is never overwritten). The erase is recorded or it
//      does not happen: a sink that stages nothing still writes the receipt, a transaction that fails writes nothing.
//   2. The person's chat links in this company (both rows of each link; the actor row only while it still names this person), their notification settings and their last-sent row, and their GitHub account link
//      (L4-GH: both rows; the account row only while it still names this person).
//   3. The learning data (`eraseLearning`, REQUIRED: a wiring that forgets it fails, it never reads as "nothing to erase").
//   3b. The project wiki (`eraseWiki`, REQUIRED the same way; lead 4 W2, wiki review fix 7): the person's notes and saved answer records go, their "Mark wrong" reasons are removed.
//   4. The evidence of the person's tasks in this company: the person's task index (`DEVELOPER#<person>` / `TASK#...`, the tasks they started) -> each task's record -> its owner key and workspace ->
//      the two evidence prefixes (`evidencePrefixesOf`) -> EVERY stored version under them (DEC 212: current objects, non-current versions and delete markers, `deleteEveryVersion`).
//
// Rules held here:
//  - Company-scoped. Every key written is under the company (or names the company). The person's task index is theirs across companies, so an index row of another company (the repo's company rule,
//    `rowInCompany`: `companyId` or `orgId`, none = the implicit company) is passed over uncounted and its record is never fetched; the record's own company is checked again.
//    A record that names no owner key or workspace is skipped. Nothing is deleted outside the two prefixes of a task of this company.
//  - Bounded and resumable. The walk stops at its deadline, checked before every page, every task and inside every prefix delete. The pending row holds the index sort key the walk has gone past
//    (`cursor`) and the index rows of tasks whose erase failed (`retry`, at most PERSON_ERASE_RETRY_MAX): a failing task never holds the cursor. A walk that reached the end of the index with nothing
//    left to retry deletes its pending row; one that stopped early, has a retry left or met a fault is never reported done (`evidence: "owed"`). `resumePersonErases` finishes owed walks (the same
//    request repeated does too).
//  - A record the store could not read is not "missing": it is a failure kept for retry. A task whose ids are not plain ids can never name a prefix: counted `refused`, not retried.
//  - Not erased here (follow-ups, listed in the port's notes): the name and words kept on task records and pointers (developerName, title, the first prompt, thread notes), the task index rows, the
//    diagnosis-by-person index, the attention email's reverse index (notify/person-index.ts: expires in 90 days, unused once not a member), session followers and presence, and limit, rate and idempotency rows (no personal content). The route erases only a person already removed from the company, so their
//    sign-in, sessions and script tokens are refused by membership.
//  - Reports are counts. Log lines and errors name no person, task or key (a fault's text may carry a key).
import { ActorRefSchema, OrgIdSchema, agentXError, orgChannelLinkKey, orgScoped, when, type AuditSink, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { channelLinksPartition } from "../channel/links.js";
import { evidencePrefixesOf } from "../proof/evidence-erase.js";
import { taskKey } from "../../developer/task-records.js";
import { rowInCompany } from "../../developer/company-rows.js";
import { prefsKey } from "../notify/prefs.js";
import { unlinkGithubAccount } from "./github-links.js";
import { notifySentKey } from "../notify/attention.js"; import { eraseInboxRows } from "../notify/inbox-rows.js";

/** A person id as a key part: letters, digits, `_`, `.` and `-`, never `#`, `|`, a space or a newline. */
const PERSON_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
export const isErasablePersonId = (value: unknown): value is string => typeof value === "string" && PERSON_ID.test(value);
/** The request id that makes a call repeatable (a UUID). */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The prefix delete the walk needs: every version under a prefix (`S3ObjectStorage.deleteEveryVersion` on a deployed install; the folder store's `deletePrefix` on a laptop, which keeps no versions). */
export interface PersonEraseObjects {
  deleteEveryVersion(prefix: string, options: { stopAt?: number | undefined }): Promise<boolean | "out_of_time">;
}

export interface PersonEraseDeps {
  store: Pick<DocumentStore, "get" | "getMany" | "query" | "put" | "delete" | "transact">;
  objects: PersonEraseObjects;
  /** The company's audit sink: the `person.erased` record commits with the receipt. */
  audit: Pick<AuditSink, "stage">;
  /** Clears the person's learning data in every project of the company. REQUIRED; rejects if it could not. A test with none passes `noLearningToErase`. */
  eraseLearning: (companyId: string, personId: string) => Promise<unknown>;
  /** Clears the person's words from the project wiki in every project of the company (notes, "Mark wrong" reasons, saved answer records). REQUIRED; rejects if it could not. A test with none passes `noWikiToErase`. */
  eraseWiki: (companyId: string, personId: string) => Promise<unknown>;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

/** For a test or an install with no learning data: the hook that erases nothing. */
export const noLearningToErase = async (): Promise<void> => undefined;
/** For a test or an install with no wiki: the hook that erases nothing. */
export const noWikiToErase = async (): Promise<void> => undefined;

export interface PersonEraseInput {
  companyId: string;
  personId: string;
  /** The person who erased (a member of the company; the route checked their role and a fresh step-up). */
  by: string;
  requestId: string;
  /** The most milliseconds this call gives the evidence walk. Default PERSON_ERASE_BUDGET_MS. */
  budgetMs?: number;
}

export interface PersonEraseReceipt {
  personId: string;
  erasedAt: string;
  alreadyErased: boolean;
  /** `done`: no evidence of the person's tasks in this company is left in any version. `owed`: the walk is recorded; repeating the request continues it from where it stopped. */
  evidence: "done" | "owed";
  counts: PersonEraseCounts;
}

export interface PersonEraseCounts {
  links: number;
  tasks: number;
  erased: number;
  skipped: number;
  refused: number;
  incomplete: number;
}

export const PERSON_ERASE_BUDGET_MS = 4_000;
export const PERSON_ERASE_RETRY_MAX = 100;
/** Index rows read, and records fetched, at a time (the store's `getMany` takes at most 100 keys). */
const PAGE = 100;
/** What one walk gets of a scheduled resume at most, so several people are served each run. */
export const PERSON_ERASE_RESUME_SHARE_MS = 500;

export const personErasedKey = (companyId: string, personId: string): DocumentKey => ({ pk: orgScoped(OrgIdSchema.parse(companyId), `PERSON_ERASED#${checkedPerson(personId)}`), sk: "META" });
export const personErasePendingPartition = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), "PERSON_ERASE_PENDING");
const pendingKey = (companyId: string, personId: string): DocumentKey => ({ pk: personErasePendingPartition(companyId), sk: checkedPerson(personId) });

function checkedPerson(personId: string): string {
  if (!isErasablePersonId(personId)) throw agentXError("CONFIG_INVALID", "That is not a person's id.");
  return personId;
}

interface WalkState { cursor?: string; retry: string[]; scanned: boolean }
function stateOf(item: StoredDocument | undefined): WalkState | "unreadable" {
  if (item === undefined) return { retry: [], scanned: false };
  const cursor = item["cursor"];
  const retry = item["retry"] ?? [];
  if ((cursor !== undefined && typeof cursor !== "string") || !Array.isArray(retry) || !retry.every((row) => typeof row === "string")) return "unreadable";
  return { ...(cursor === undefined ? {} : { cursor }), retry, scanned: item["scanned"] === true };
}
const pendingItem = (companyId: string, personId: string, state: WalkState | undefined, triedAt?: number): StoredDocument => ({
  ...pendingKey(companyId, personId), entityType: "PERSON_ERASE_PENDING", companyId, personId,
  ...(state?.cursor === undefined ? {} : { cursor: state.cursor }),
  ...(state === undefined || state.retry.length === 0 ? {} : { retry: [...state.retry] }),
  ...(state?.scanned === true ? { scanned: true } : {}),
  ...(triedAt === undefined ? {} : { triedAt }),
});

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/**
 * Erases one person in one company (see the file's head). Throws (fixed words) when the receipt cannot be written, the chat links or the learning data could not be cleared: the request is then
 * repeated, and a repeat records nothing new. An evidence walk that did not finish is not an error: the receipt says `owed` and the walk is recorded.
 */
export async function erasePerson(deps: PersonEraseDeps, input: PersonEraseInput): Promise<PersonEraseReceipt> {
  const companyId = OrgIdSchema.parse(input.companyId);
  const personId = checkedPerson(input.personId);
  if (!isErasablePersonId(input.by)) throw agentXError("CONFIG_INVALID", "That is not a person's id.");
  if (typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) throw agentXError("CONFIG_INVALID", "The request id is not valid.");
  if (typeof deps.eraseLearning !== "function") throw new Error("the learning erase hook is not wired");
  if (typeof deps.eraseWiki !== "function") throw new Error("the wiki erase hook is not wired");
  const log = deps.log ?? (() => undefined);
  const started = deps.now();
  const erasedAt = new Date(started).toISOString();

  // ---- 1. the receipt, the audit record and the owed walk, together
  const receiptKey = personErasedKey(companyId, personId);
  const audit = deps.audit.stage({
    eventId: `person-erase:${companyId}:${personId}`, companyId, at: erasedAt, actor: { type: "person", id: input.by }, action: "person.erased",
    subject: { type: "person", id: personId }, details: { requestId: input.requestId },
  });
  const items: TransactItem[] = [
    { kind: "put", item: { ...receiptKey, entityType: "PERSON_ERASED", companyId, personId, erasedAt, by: input.by, requestId: input.requestId }, condition: when.absent() },
    ...audit,
    // The walk is owed from the same moment: created if absent, and an earlier pass's cursor and retries are kept (only absent fields are set).
    { kind: "update", key: pendingKey(companyId, personId), ops: [{ op: "setIfAbsent", path: ["entityType"], value: "PERSON_ERASE_PENDING" }, { op: "setIfAbsent", path: ["companyId"], value: companyId }, { op: "setIfAbsent", path: ["personId"], value: personId }] },
  ];
  let alreadyErased = false;
  let firstAt = erasedAt;
  const committed = await deps.store.transact(items);
  if (!committed.applied) {
    if (!committed.failed.includes(0)) throw agentXError("RUNTIME_UNAVAILABLE", "The erase could not be recorded just now. Send the same request again.");
    const existing = await deps.store.get(receiptKey);
    if (existing === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The erase could not be recorded just now. Send the same request again.");
    alreadyErased = true;
    if (typeof existing["erasedAt"] === "string") firstAt = existing["erasedAt"];
  }
  // A repeat (the receipt's transaction refused on step 0) still makes sure the walk is owed; an earlier pass's cursor is kept.
  if (alreadyErased) await deps.store.put({ item: pendingItem(companyId, personId, undefined), condition: when.absent() });

  // ---- 2. chat links
  let links: number;
  try {
    links = await eraseChatLinks(deps.store, companyId, personId);
    // Their notification settings (contact targets, time zone, unsubscribe) and what was last sent to them, in this company.
    await deps.store.delete({ key: prefsKey(companyId, personId) });
    await deps.store.delete({ key: notifySentKey(companyId, personId) }); await eraseInboxRows(deps.store, companyId, personId);
    await unlinkGithubAccount(deps.store, companyId, personId);
  } catch (error) {
    log({ event: "person_erase.links_failed", level: "error", error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", "The person is erased, but their chat links or notification settings could not be removed just now. Send the same request again.");
  }

  // ---- 3. learning data
  try {
    await deps.eraseLearning(companyId, personId);
  } catch (error) {
    log({ event: "person_erase.learning_failed", level: "error", error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", "The person is erased, but their suggested-rule data could not be cleared just now. Send the same request again.");
  }

  // ---- 3b. the project wiki
  try {
    await deps.eraseWiki(companyId, personId);
  } catch (error) {
    log({ event: "person_erase.wiki_failed", level: "error", error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", "The person is erased, but their notes in the project wiki could not be cleared just now. Send the same request again.");
  }

  // ---- 4. evidence
  const budget = input.budgetMs ?? PERSON_ERASE_BUDGET_MS;
  const walk = await walkPersonEvidence(deps, companyId, personId, started + Math.max(0, budget));
  return { personId, erasedAt: firstAt, alreadyErased, evidence: walk.complete ? "done" : "owed", counts: { links, ...walk.counts } };
}

/**
 * Deletes the person's chat links in this company: each link's actor row while it still names this person (a later link of the same account to someone else is theirs and is left), then their own
 * list row. Answers how many list rows were removed. A list row whose actor does not parse is still removed (it can name no actor row).
 */
async function eraseChatLinks(store: PersonEraseDeps["store"], companyId: string, personId: string): Promise<number> {
  const orgId = OrgIdSchema.parse(companyId);
  const pk = channelLinksPartition(orgId, personId);
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of page.items) {
      const actor = ActorRefSchema.safeParse(row["actor"]);
      if (actor.success) await store.delete({ key: orgChannelLinkKey(orgId, actor.data), condition: when.eq("developerId", personId) });
      await store.delete({ key: { pk: row.pk, sk: row.sk } });
      removed += 1;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return removed;
}

interface WalkReport { complete: boolean; counts: Omit<PersonEraseCounts, "links"> }

/**
 * Walks the person's task index in this company from the saved cursor until the deadline, erasing every version of each task's evidence, then retries the failed tasks. Saves the cursor and the
 * retries in the pending row, or deletes it when the whole index is done with nothing left. Never throws for a task's failure (it is kept for retry); throws only when the pending row is unreadable
 * or cannot be written.
 */
export async function walkPersonEvidence(deps: Pick<PersonEraseDeps, "store" | "objects" | "now" | "log">, companyId: string, personId: string, stopAt: number): Promise<WalkReport> {
  const log = deps.log ?? (() => undefined);
  const counts = { tasks: 0, erased: 0, skipped: 0, refused: 0, incomplete: 0 };
  const read = stateOf(await deps.store.get(pendingKey(companyId, personId)));
  if (read === "unreadable") throw new Error("the pending erase row could not be read");
  const state: WalkState = { ...read, retry: [...read.retry] };
  const outOfTime = (): boolean => deps.now() >= stopAt;
  let stopped = false;

  /** One index row: erased (true), nothing to do (skipped/refused: "skip"), or failed (false). */
  const eraseRow = async (row: StoredDocument | undefined, record: StoredDocument | undefined | "unreadable"): Promise<true | false | "skip"> => {
    const taskId = row?.["taskId"];
    if (typeof taskId !== "string") { counts.skipped += 1; return "skip"; }
    if (record === "unreadable") return false;
    if (record === undefined || !rowInCompany(record, companyId)) { counts.skipped += 1; return "skip"; }
    const ownerKey = record["ownerKey"];
    const workspaceId = record["workspaceId"];
    if (typeof ownerKey !== "string" || typeof workspaceId !== "string") { counts.skipped += 1; return "skip"; }
    const prefixes = evidencePrefixesOf({ ownerKey, workspaceId, taskId });
    if (prefixes === undefined) { counts.refused += 1; return "skip"; }
    try {
      for (const prefix of prefixes) {
        const outcome = await deps.objects.deleteEveryVersion(prefix, { stopAt });
        if (outcome !== true) return false;
      }
    } catch (error) {
      log({ event: "person_erase.task_failed", error: errorName(error) });
      return false;
    }
    counts.erased += 1;
    return true;
  };

  const recordsOf = async (rows: readonly StoredDocument[]): Promise<(StoredDocument | undefined | "unreadable")[]> => {
    const ids = rows.map((row) => row["taskId"]);
    const keys = ids.filter((id): id is string => typeof id === "string").map((id) => taskKey(id));
    let found: (StoredDocument | undefined)[];
    try { found = keys.length === 0 ? [] : await deps.store.getMany(keys); } catch { return rows.map(() => "unreadable" as const); }
    let at = 0;
    return ids.map((id) => (typeof id === "string" ? found[at++] : undefined));
  };

  // ---- first the tasks that failed in an earlier run (so a full retry list can never stall the walk), then the main walk from the cursor
  const indexPk = `DEVELOPER#${personId}`;
  if (state.retry.length > 0) {
    const keep: string[] = [];
    for (const sk of state.retry) {
      if (outOfTime()) { keep.push(sk); stopped = true; continue; }
      const row = await deps.store.get({ pk: indexPk, sk });
      if (row === undefined || !rowInCompany(row, companyId)) continue;
      const [record] = await recordsOf([row]);
      if ((await eraseRow(row, record)) === false) { keep.push(sk); counts.incomplete += 1; }
    }
    state.retry = keep;
  }
  /** The store's own cursor, for a page that came back empty but not finished; reset once a page holds rows (the range then restarts after `state.cursor`). */
  let pageCursor: string | undefined;
  while (!state.scanned && !stopped) {
    if (outOfTime()) { stopped = true; break; }
    const page = await deps.store.query({
      pk: indexPk, sk: state.cursor === undefined ? { op: "beginsWith", prefix: "TASK#" } : { op: "between", low: `${state.cursor}\u0000`, high: "TASK#\uffff" }, limit: PAGE,
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
    });
    const all = page.items.filter((row) => typeof row.sk === "string" && row.sk.startsWith("TASK#"));
    if (all.length === 0) {
      if (page.cursor === undefined) { state.scanned = true; break; }
      pageCursor = page.cursor;
      continue;
    }
    pageCursor = undefined;
    // The index is the person's across companies: a row of another company is passed over unread and uncounted (its record is never fetched). The record's own company is checked again below.
    const rows = all.filter((row) => rowInCompany(row, companyId));
    const records = await recordsOf(rows);
    let at = 0;
    for (const row of all) {
      if (outOfTime()) { stopped = true; break; }
      if (!rowInCompany(row, companyId)) { state.cursor = row.sk; continue; }
      const record = records[at++];
      counts.tasks += 1;
      const outcome = await eraseRow(row, record);
      if (outcome === false) {
        if (state.retry.length >= PERSON_ERASE_RETRY_MAX) { stopped = true; counts.incomplete += 1; log({ event: "person_erase.retry_full" }); break; }
        if (!state.retry.includes(row.sk)) state.retry.push(row.sk);
        counts.incomplete += 1;
      }
      state.cursor = row.sk;
    }
    if (page.cursor === undefined && !stopped && all.length < PAGE) state.scanned = true;
  }

  const complete = state.scanned && state.retry.length === 0 && !stopped;
  if (complete) await deps.store.delete({ key: pendingKey(companyId, personId) });
  else await deps.store.put({ item: pendingItem(companyId, personId, state, deps.now()) });
  if (counts.skipped + counts.refused + counts.incomplete > 0) log({ event: "person_erase.walk", ...counts, complete });
  return { complete, counts };
}

/**
 * The scheduled run: finishes the owed walks of one company, oldest try first, each with a small share of the budget. Answers how many finished and how many are still owed.
 * With `eraseLearning` (a deployed install's lessons and team record erase), each owed person's learning data is erased again first (it is idempotent): a request whose learning step
 * failed after its receipt was written is finished here too. When it fails, that person's walk is not run, so the pending row stays and the next run tries both again. `eraseWiki` is run the same way.
 */
export async function resumePersonErases(deps: Pick<PersonEraseDeps, "store" | "objects" | "now" | "log"> & Partial<Pick<PersonEraseDeps, "eraseLearning" | "eraseWiki">>, companyId: string, budgetMs: number): Promise<{ finished: number; owed: number }> {
  const company = OrgIdSchema.parse(companyId);
  const ends = deps.now() + Math.max(0, budgetMs);
  const pending: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.query({ pk: personErasePendingPartition(company), limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    pending.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined && pending.length < 1_000);
  pending.sort((a, b) => (typeof a["triedAt"] === "number" ? a["triedAt"] : -1) - (typeof b["triedAt"] === "number" ? b["triedAt"] : -1));
  let finished = 0;
  let owed = 0;
  for (const row of pending) {
    const personId = row.sk;
    if (!isErasablePersonId(personId) || deps.now() >= ends) { owed += 1; continue; }
    try {
      if (deps.eraseLearning !== undefined) await deps.eraseLearning(company, personId);
      if (deps.eraseWiki !== undefined) await deps.eraseWiki(company, personId);
      const report = await walkPersonEvidence(deps, company, personId, Math.min(ends, deps.now() + PERSON_ERASE_RESUME_SHARE_MS));
      if (report.complete) finished += 1; else owed += 1;
    } catch (error) {
      owed += 1;
      deps.log?.({ event: "person_erase.resume_failed", error: errorName(error) });
    }
  }
  return { finished, owed };
}

/**
 * The walk's prefix delete over an object storage that keeps no versions (the laptop's folder store): its `deletePrefix` removes everything under the prefix. A deployed install passes the bucket's
 * own version delete (`S3ObjectStorage.deleteEveryVersion`) instead, never this.
 */
export function unversionedEraseObjects(objects: { deletePrefix(prefix: string): Promise<boolean> }): PersonEraseObjects {
  return { deleteEveryVersion: async (prefix) => await objects.deletePrefix(prefix) };
}
