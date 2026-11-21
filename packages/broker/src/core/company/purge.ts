// Company purge (C112, plan row 13.5): what Code removes when an operator closes a company. Code purges the ENGINE data of one company; the company record, its members' sign-in and the
// hosted product's own tables are not Code's to remove here.
//
// The life of one purge (one state row per company, `COMPANY_PURGE` / <companyId>, install-wide so it outlives the purge):
//   1. `requestCompanyPurge` (operator only, the company must already be closed): records the purge as `scheduled`, due after the cooling-off delay, with the `company.purge_requested` audit event in
//      the same transaction. The same company asked again keeps the first request (nothing new is recorded).
//   2. `cancelCompanyPurge` (operator only): while the purge is `scheduled` and not yet due, it goes `cancelled` (with `company.purge_cancelled`); a later request schedules a new one (as it does
//      after a purge is done, for a company closed again).
//   3. `runCompanyPurge` / `resumeCompanyPurges`: once due (and the company still reads as closed), the purge runs in bounded passes that save their place after every page, so a crash, a fault or the
//      end of a call's time loses nothing and repeats nothing harmful (every step is idempotent). A pass walks the whole store (`scanPage`, a paged read outside the port) and, for each item:
//        - deletes it when it is the company's: a partition `ORG#<company>#...` or `WS#<company>#...` (the team record and lessons), another item of `ORG#<company>`, an item whose `companyId` /
//          `orgId` is the company (and neither names another), an item of an install-wide list whose key names the company as one `#` part, or an item outside any company partition whose `taskId`
//          or `workspaceId` names a task or workspace this purge proved the company's;
//        - proves a task or workspace partition (legacy or company-scoped) the company's by its META (`companyId`), records it, and later empties it: the stored files first (every version
//          under the workspace's `private/<owner>/<workspace>/` and the task's evidence prefixes, DEC 212), then every row, the META last and only while it still names the company;
//        - tombstones the company's audit rows (`ORG#<company>#AUDIT`): the row stays with its event id, time and company, and loses its actor, action, subject, details and digest, so the chain
//          keeps a place for it (the audit-retention rule). Known gap: the event id itself (also the sort key) can carry an action name and ids, and the laptop's append-only copy keeps whole events. The purge's own events (`company.purge_*`, `company.purged`) are kept whole: they are the record of the purge.
//      A pass that changed anything is followed by another from the start; the purge is `done` only after a whole pass found nothing left to do and read every row (a pass that met a row the store
//      could not read never ends the purge). The company is closed, so late writers are stragglers; a row written behind the walk's cursor during the last pass is the one case a pass can miss.
//      A due purge that finds the company open again is cancelled (with `company.purge_cancelled`), never held: a later close needs a new request and a new cooling-off.
//   4. `dryRunCompanyPurge` (operator only): the same walk, writing nothing to any company's data, answering counts by kind (never a key, an id or any content; its place between calls is an opaque handle).
//
// Kept on purpose: `ORG#<company>` / `META` (the closed company's marker), the audit chain's anchor (`ORG#<company>#AUDIT_COPY`), the purge's own rows, and people's sign-in rows (`DEVELOPER#<person>`
// other than their task list, `EMAIL#`, `SESSION#`, `REFRESH#`, `AUTHREQ#`, `CODE#`): a person may belong to other companies, and is removed by the member removal or the person erase.
// Never touched: another company's partitions, whatever their rows say, and any item whose `companyId` and `orgId` name two different companies (counted as `conflicting`).
//
// Reports are counts. Log lines and errors name no company content, person, task or key.
import { randomUUID } from "node:crypto";
import { AgentXError, OrgIdSchema, IMPLICIT_COMPANY_ID, agentXError, projectMetaKey, when, change, type AuditSink, type DocumentKey, type DocumentStore, type QueryPage, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { retireProjectIncarnation, projectMetaSnapshot } from "../project-incarnation.js";
import { evidencePrefixesOf } from "../proof/evidence-erase.js";
import { workspaceKey } from "../task-flow/keys.js";

// ---- ports ----

/** A paged walk over every item of the store, in a stable order, resumable from its cursor. Not part of the document-store port: only the company purge needs it. */
export interface StoreScan {
  /** `skipped`: rows of this page the store could not read and left out (the purge never ends while it meets one). */
  scanPage(request: { limit?: number; cursor?: string }): Promise<QueryPage & { skipped?: number }>;
}

/** The prefix delete the purge needs: every stored version under a prefix (`S3ObjectStorage.deleteEveryVersion` on a deployed install, the shape the person erase uses). */
export interface CompanyPurgeObjects {
  deleteEveryVersion(prefix: string, options: { stopAt?: number | undefined }): Promise<boolean | "out_of_time">;
}

export interface CompanyPurgeDeps {
  store: Pick<DocumentStore, "get" | "getMany" | "query" | "put" | "update" | "delete" | "transact" | "ttlAttribute"> & StoreScan;
  objects: CompanyPurgeObjects;
  /** The company's audit sink: the purge's own events commit with its state changes. */
  audit: Pick<AuditSink, "stage">;
  /**
   * Whether the company is closed, and WHICH close (`closeId`: an id or time that changes each time the company is closed). REQUIRED. A purge is requested only under a close, and runs only while
   * that same close holds: `{ closed: false }`, or another close, cancels a scheduled purge and holds a running one. A throw or any other answer is "unknown": nothing runs, nothing is cancelled.
   */
  companyClosure: (companyId: string) => Promise<CompanyClosure>;
  now: () => number;
  /** The cooling-off delay; default COMPANY_PURGE_COOLING_OFF_MS, never below COMPANY_PURGE_COOLING_OFF_MIN_MS nor above COMPANY_PURGE_COOLING_OFF_MAX_MS. */
  coolingOffMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export type CompanyClosure = { closed: true; closeId: string } | { closed: false };

/** Who asks: an operator of the install, never a company member. The host sets it from its own operator sign-in. */
export interface CompanyPurgeOperator {
  kind: "operator";
  operatorId: string;
}

// ---- limits and words ----

export const COMPANY_PURGE_COOLING_OFF_MS = 7 * 24 * 3_600_000;
export const COMPANY_PURGE_COOLING_OFF_MIN_MS = 24 * 3_600_000;
export const COMPANY_PURGE_COOLING_OFF_MAX_MS = 90 * 24 * 3_600_000;
/** The most milliseconds one call works by default. */
export const COMPANY_PURGE_BUDGET_MS = 4_000;
/** The most milliseconds any one call may be given, whatever its caller asks (a file delete is bounded only by time). */
export const COMPANY_PURGE_BUDGET_MAX_MS = 15 * 60_000;
/** A caller's budget within [0, COMPANY_PURGE_BUDGET_MAX_MS]; anything that is not a finite number is the default. */
const budgetOf = (asked: unknown): number => (typeof asked === "number" && Number.isFinite(asked) ? Math.min(COMPANY_PURGE_BUDGET_MAX_MS, Math.max(0, asked)) : COMPANY_PURGE_BUDGET_MS);
/** The most items one call reads (scanned rows plus partition rows), whatever its time. */
export const COMPANY_PURGE_ITEMS_PER_CALL = 5_000;
/** Rows read at a time (the store's `getMany` takes at most 100 keys). */
const PAGE = 100;
/** Distinct kinds a report names; the rest are counted as `other`. */
const KINDS_MAX = 200;
/** How long a run holds the purge beyond its own budget, so a crashed run does not hold it for ever. */
const LEASE_GRACE_MS = 60_000;

export const PURGE_OPERATOR_ONLY = "Only an operator of this install can purge a company.";
export const PURGE_COMPANY_OPEN = "The company is not closed. Close it first; its data is purged only after it is closed.";
export const PURGE_CLOSED_UNKNOWN = "Whether the company is closed could not be read just now. Nothing was scheduled; try again.";
export const PURGE_EARLIER_CLOSE = "A purge is scheduled for an earlier close of this company and will cancel itself when it is due. Cancel it, then ask again.";
export const PURGE_NOT_CANCELLABLE = "The purge can no longer be cancelled: its cooling-off time is over or it has started.";
export const PURGE_NOT_FOUND = "There is no purge scheduled for that company.";
const PURGE_NOT_RECORDED = "The purge could not be recorded just now. Send the same request again.";
const PURGE_RUN_FAILED = "The purge could not go on just now; it continues from where it stopped on its next run.";
export const PURGE_DRY_RUN_HANDLE = "That dry-run handle is not valid or has expired. Start the dry run again.";
export const PURGE_NEW_REQUEST_ID = "That request id was used for an earlier purge of this company. Use a new request id.";

const OPERATOR_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

// ---- keys ----

/** The state rows' partition (install-wide: a company partition would be purged with the company). */
export const COMPANY_PURGE_PK = "COMPANY_PURGE";
const PURGE_OWNED = "COMPANY_PURGE";
export const companyPurgeKey = (companyId: string): DocumentKey => ({ pk: COMPANY_PURGE_PK, sk: companyOf(companyId) });
/** The partitions this purge proved the company's and still has to empty. */
const partsPk = (companyId: string): string => `COMPANY_PURGE_PART#${companyId}`;
/** The task and workspace ids this purge proved the company's (`task#<id>`, `ws#<id>`), so a row elsewhere that names one goes too. Deleted when the purge is done. */
const marksPk = (companyId: string): string => `COMPANY_PURGE_MARK#${companyId}`;
/** A dry run's place between calls, kept here under a random handle: the store's own cursor names a key, so it is never handed out. */
const dryRunPk = (companyId: string): string => `COMPANY_PURGE_DRYRUN#${companyId}`;
/** How long a dry run's handle can be used. */
const DRY_RUN_HANDLE_MS = 3_600_000;

function companyOf(companyId: unknown): string {
  const parsed = OrgIdSchema.safeParse(companyId);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "That is not a company id.");
  return parsed.data;
}

function operatorOf(by: unknown): string {
  const operator = by as Partial<CompanyPurgeOperator> | null | undefined;
  if (operator === null || typeof operator !== "object" || operator.kind !== "operator" || typeof operator.operatorId !== "string" || !OPERATOR_ID.test(operator.operatorId)) throw agentXError("FORBIDDEN", PURGE_OPERATOR_ONLY);
  return operator.operatorId;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** A wiring that forgot the closed check fails loudly, before anything is read (it never reads as "unknown"). */
function assertWired(deps: Pick<CompanyPurgeDeps, "companyClosure">): void {
  if (typeof deps.companyClosure !== "function") throw new Error("the company-closed check is not wired");
}

const CLOSE_ID = /^[A-Za-z0-9_.:-]{1,100}$/u;
/** The company's close as the host reads it: `closeId` when closed, `open`, or `unknown` (a throw or an answer of any other shape). */
async function closureOf(deps: Pick<CompanyPurgeDeps, "companyClosure">, companyId: string): Promise<{ closeId: string } | "open" | "unknown"> {
  if (typeof deps.companyClosure !== "function") throw new Error("the company-closed check is not wired");
  let answer: unknown;
  try { answer = await deps.companyClosure(companyId); } catch { return "unknown"; }
  if (answer === null || typeof answer !== "object") return "unknown";
  const { closed, closeId } = answer as { closed?: unknown; closeId?: unknown };
  if (closed === false) return "open";
  if (closed === true && typeof closeId === "string" && CLOSE_ID.test(closeId)) return { closeId };
  return "unknown";
}

function coolingOff(deps: Pick<CompanyPurgeDeps, "coolingOffMs">): number {
  const asked = deps.coolingOffMs ?? COMPANY_PURGE_COOLING_OFF_MS;
  if (typeof asked !== "number" || !Number.isFinite(asked)) return COMPANY_PURGE_COOLING_OFF_MS;
  return Math.min(COMPANY_PURGE_COOLING_OFF_MAX_MS, Math.max(COMPANY_PURGE_COOLING_OFF_MIN_MS, asked));
}

// ---- the state row ----

export type CompanyPurgeStatus = "scheduled" | "cancelled" | "running" | "done";

export interface CompanyPurgeCounts {
  /** Rows deleted. */
  deleted: number;
  /** Audit rows reduced to a tombstone. */
  tombstoned: number;
  /** Task and workspace partitions proved the company's and emptied (or being emptied). */
  partitions: number;
  /** File prefixes emptied in every version. */
  prefixes: number;
  /** File prefixes that could not be named safely (an owner or workspace id that is not a plain id): never deleted, and counted so the receipt says so. */
  refused: number;
  /** Rows whose `companyId` and `orgId` name two companies, met on the first pass: never touched. */
  conflicting: number;
  /** Rows the store could not read (left out of a page), met on the last pass: while any is met, the purge never ends. */
  unreadable: number;
  /** Whole passes over the store. */
  passes: number;
}

const zeroCounts = (): CompanyPurgeCounts => ({ deleted: 0, tombstoned: 0, partitions: 0, prefixes: 0, refused: 0, conflicting: 0, unreadable: 0, passes: 0 });

export interface CompanyPurgeState {
  companyId: string;
  status: CompanyPurgeStatus;
  requestId: string;
  requestedBy: string;
  requestedAt: string;
  dueAt: string;
  cancelledAt?: string;
  startedAt?: string;
  doneAt?: string;
  counts: CompanyPurgeCounts;
}

interface Row extends CompanyPurgeState {
  dueAtMs: number;
  /** The close the purge was requested under. */
  closeId: string;
  cursor?: string;
  acted: boolean;
  /** Rows the store could not read were met on this pass. */
  blocked: boolean;
  runId?: string;
  leaseUntil?: number;
}

const STATUSES: readonly CompanyPurgeStatus[] = ["scheduled", "cancelled", "running", "done"];

function rowOf(item: StoredDocument | undefined): Row | undefined | "unreadable" {
  if (item === undefined) return undefined;
  const status = item["status"];
  const counts = item["counts"] as Record<string, unknown> | undefined;
  const text = (name: string): string | undefined => (typeof item[name] === "string" ? (item[name]) : undefined);
  if (typeof status !== "string" || !STATUSES.includes(status as CompanyPurgeStatus) || typeof item["dueAtMs"] !== "number" || text("companyId") === undefined || text("requestId") === undefined
    || text("requestedBy") === undefined || text("requestedAt") === undefined || text("dueAt") === undefined || text("closeId") === undefined || counts === null || typeof counts !== "object") return "unreadable";
  const readCounts = zeroCounts();
  for (const name of Object.keys(readCounts) as (keyof CompanyPurgeCounts)[]) {
    const value = counts[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "unreadable";
    readCounts[name] = value;
  }
  if (item["cursor"] !== undefined && typeof item["cursor"] !== "string") return "unreadable";
  return {
    companyId: text("companyId")!, status: status as CompanyPurgeStatus, requestId: text("requestId")!, requestedBy: text("requestedBy")!, requestedAt: text("requestedAt")!, dueAt: text("dueAt")!,
    ...(text("cancelledAt") === undefined ? {} : { cancelledAt: text("cancelledAt")! }), ...(text("startedAt") === undefined ? {} : { startedAt: text("startedAt")! }),
    ...(text("doneAt") === undefined ? {} : { doneAt: text("doneAt")! }), counts: readCounts, dueAtMs: item["dueAtMs"], closeId: text("closeId")!,
    ...(typeof item["cursor"] === "string" ? { cursor: item["cursor"] } : {}), acted: item["acted"] === true, blocked: item["blocked"] === true,
    ...(typeof item["runId"] === "string" ? { runId: item["runId"] } : {}), ...(typeof item["leaseUntil"] === "number" ? { leaseUntil: item["leaseUntil"] } : {}),
  };
}

const publicState = (row: Row): CompanyPurgeState => ({
  companyId: row.companyId, status: row.status, requestId: row.requestId, requestedBy: row.requestedBy, requestedAt: row.requestedAt, dueAt: row.dueAt,
  ...(row.cancelledAt === undefined ? {} : { cancelledAt: row.cancelledAt }), ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
  ...(row.doneAt === undefined ? {} : { doneAt: row.doneAt }), counts: { ...row.counts },
});

async function readRow(deps: Pick<CompanyPurgeDeps, "store">, companyId: string): Promise<Row | undefined> {
  const row = rowOf(await deps.store.get(companyPurgeKey(companyId)));
  if (row === "unreadable") throw agentXError("RUNTIME_UNAVAILABLE", "The purge record could not be read.");
  return row;
}

const auditOf = (deps: Pick<CompanyPurgeDeps, "audit">, input: { companyId: string; eventId: string; at: string; operatorId?: string; action: string; details?: Record<string, number | string> }): readonly TransactItem[] =>
  deps.audit.stage({
    eventId: input.eventId, companyId: input.companyId, at: input.at, actor: input.operatorId === undefined ? { type: "system", id: "rovara" } : { type: "system", id: `operator:${input.operatorId}` },
    action: input.action, subject: { type: "company", id: input.companyId }, ...(input.details === undefined ? {} : { details: input.details }),
  });

// ---- request, cancel, read ----

export interface CompanyPurgeRequestInput {
  companyId: string;
  by: CompanyPurgeOperator;
  /** A UUID that names this request (for the audit event). */
  requestId: string;
}

/** Schedules the purge of a closed company, due after the cooling-off delay. Repeatable: a company whose purge is already scheduled, running or done keeps it (`alreadyRequested`). */
export async function requestCompanyPurge(deps: CompanyPurgeDeps, input: CompanyPurgeRequestInput): Promise<CompanyPurgeState & { alreadyRequested: boolean }> {
  const operatorId = operatorOf(input.by);
  const companyId = companyOf(input.companyId);
  if (typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) throw agentXError("CONFIG_INVALID", "The request id is not valid.");
  assertWired(deps);
  return await fixedWords(async () => {
  const existing = await readRow(deps, companyId);
  // A scheduled or running purge is kept; a cancelled one, or one that is done (the company was closed again), gives way to a new request.
  const replaceable = (row: Row | undefined): boolean => row === undefined || row.status === "cancelled" || row.status === "done";
  if (!replaceable(existing)) {
    // A scheduled purge tied to an earlier close would cancel itself when due: the operator is told, rather than answered "already requested".
    if (existing!.status === "scheduled") {
      const now = await closureOf(deps, companyId);
      if (now === "open" || (typeof now === "object" && now.closeId !== existing!.closeId)) throw agentXError("FORBIDDEN", PURGE_EARLIER_CLOSE);
    }
    return { ...publicState(existing!), alreadyRequested: true };
  }
  // A new purge needs a new request id (its audit event is named by it).
  if (existing !== undefined && existing.requestId === input.requestId) throw agentXError("CONFIG_INVALID", PURGE_NEW_REQUEST_ID);
  const closure = await closureOf(deps, companyId);
  if (closure === "unknown") throw agentXError("RUNTIME_UNAVAILABLE", PURGE_CLOSED_UNKNOWN);
  if (closure === "open") throw agentXError("FORBIDDEN", PURGE_COMPANY_OPEN);
  // Marks, recorded partitions and dry-run handles an earlier purge of this company could not clear never carry into this one.
  if (existing !== undefined && !(await clearMarks(deps, companyId, COMPANY_PURGE_ITEMS_PER_CALL))) throw agentXError("RUNTIME_UNAVAILABLE", PURGE_NOT_RECORDED);
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const dueAtMs = nowMs + coolingOff(deps);
  const item: StoredDocument = {
    ...companyPurgeKey(companyId), entityType: "COMPANY_PURGE", companyId, status: "scheduled", requestId: input.requestId, requestedBy: operatorId, requestedAt: at,
    dueAt: new Date(dueAtMs).toISOString(), dueAtMs, closeId: closure.closeId, acted: false, blocked: false, counts: { ...zeroCounts() },
  };
  const steps: TransactItem[] = [
    // A new purge only where none is, or over a cancelled one (never over one that is scheduled, running or done).
    { kind: "put", item: { ...item }, condition: existing === undefined ? when.absent() : when.and(when.eq("status", existing.status), when.eq("requestId", existing.requestId)) },
    ...auditOf(deps, { companyId, eventId: `company-purge:${companyId}:${input.requestId}:requested`, at, operatorId, action: "company.purge_requested", details: { dueAt: item["dueAt"] as string } }),
  ];
  const committed = await deps.store.transact(steps);
  if (!committed.applied) {
    const now = await readRow(deps, companyId);
    if (!replaceable(now)) return { ...publicState(now!), alreadyRequested: true };
    throw agentXError("RUNTIME_UNAVAILABLE", PURGE_NOT_RECORDED);
  }
  return { ...publicState(rowOf(item) as Row), alreadyRequested: false };
  });
}

/**
 * Cancels a scheduled purge inside its cooling-off time, or a running purge that is HELD (its company is open again, or closed again under another close: what was deleted stays deleted). Refused
 * (fixed words) for a scheduled purge past its due time, a running purge whose close still holds (or cannot be read), and a done one; a cancelled one answers as it is.
 */
export async function cancelCompanyPurge(deps: CompanyPurgeDeps, input: { companyId: string; by: CompanyPurgeOperator }): Promise<CompanyPurgeState> {
  const operatorId = operatorOf(input.by);
  const companyId = companyOf(input.companyId);
  assertWired(deps);
  return await fixedWords(async () => {
    const existing = await readRow(deps, companyId);
    if (existing === undefined) throw agentXError("NOT_FOUND", PURGE_NOT_FOUND);
    if (existing.status === "cancelled") return publicState(existing);
    const nowMs = deps.now();
    let condition;
    if (existing.status === "scheduled") {
      if (nowMs >= existing.dueAtMs) throw agentXError("FORBIDDEN", PURGE_NOT_CANCELLABLE);
      condition = when.and(when.eq("status", "scheduled"), when.eq("requestId", existing.requestId), when.gt("dueAtMs", nowMs));
    } else if (existing.status === "running") {
      const closure = await closureOf(deps, companyId);
      if (closure === "unknown" || (typeof closure === "object" && closure.closeId === existing.closeId)) throw agentXError("FORBIDDEN", PURGE_NOT_CANCELLABLE);
      condition = when.and(when.eq("status", "running"), when.eq("requestId", existing.requestId));
    } else {
      throw agentXError("FORBIDDEN", PURGE_NOT_CANCELLABLE);
    }
    const at = new Date(nowMs).toISOString();
    const committed = await deps.store.transact([
      { kind: "update", key: companyPurgeKey(companyId), ops: [change.set("status", "cancelled"), change.set("cancelledAt", at), change.set("cancelledBy", operatorId), change.remove("runId"), change.remove("leaseUntil")], condition },
      ...auditOf(deps, { companyId, eventId: `company-purge:${companyId}:${existing.requestId}:cancelled`, at, operatorId, action: "company.purge_cancelled" }),
    ]);
    if (!committed.applied) throw agentXError("FORBIDDEN", PURGE_NOT_CANCELLABLE);
    return { ...publicState(existing), status: "cancelled", cancelledAt: at };
  });
}

/** Runs `work`; a fault that is not one of the purge's own refusals becomes fixed words (a store's error text can carry a key). */
async function fixedWords<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", PURGE_NOT_RECORDED);
  }
}

/** The purge of a company as it stands, or undefined when none was ever requested. */
export async function companyPurgeState(deps: Pick<CompanyPurgeDeps, "store">, companyId: string): Promise<CompanyPurgeState | undefined> {
  const row = await readRow(deps, companyOf(companyId));
  return row === undefined ? undefined : publicState(row);
}

// ---- what an item is to the purge ----

type Verdict =
  | { act: "keep" }
  | { act: "conflicting" }
  | { act: "delete"; kind: string }
  | { act: "retire-project"; project: string; meta: boolean; kind: string }
  | { act: "tombstone" }
  | { act: "prove"; what: "task" | "ws"; id: string; kind: string }
  | { act: "ref"; refs: string[]; kind: string };

/** A person's own partitions (sign-in, and their install-wide counters and rates, which a company's rows must never move). */
const PEOPLE_PARTITIONS = ["EMAIL#", "SESSION#", "REFRESH#", "AUTHREQ#", "CODE#", "DEVELOPER_LIMIT#", "ASKRATE#"];
const PURGE_EVENTS = new Set(["company.purge_requested", "company.purge_cancelled", "company.purge_started", "company.purged"]);

const KIND = /^[A-Z][A-Z0-9_]*$/u;
/** The kind of a row for a report: never an id (only upper-case key words). */
function kindOf(pk: string, companyId: string): string {
  const scoped = `ORG#${companyId}#`;
  if (pk.startsWith(scoped)) {
    const part = (pk.slice(scoped.length).split("#")[0] ?? "").slice(0, 40);
    return KIND.test(part) ? `company:${part}` : "company:other";
  }
  if (pk === `ORG#${companyId}`) return "company";
  if (pk.startsWith(`WS#${companyId}#`)) return "team-record";
  const head = (pk.split("#")[0] ?? "").slice(0, 40);
  return KIND.test(head) ? head : "other";
}

/** Whether a row's own company fields name this company, another one, or none. */
function companyFieldsOf(item: StoredDocument, companyId: string): "this" | "other" | "conflicting" | "none" {
  const named = [item["companyId"], item["orgId"]].filter((value): value is string => typeof value === "string");
  if (named.length === 0) return "none";
  const mine = named.filter((value) => value === companyId).length;
  if (mine === named.length) return "this";
  return mine === 0 ? "other" : "conflicting";
}

function projectRetirementVerdict(pk: string, sk: string, companyId: string, fields: ReturnType<typeof companyFieldsOf>): Verdict | undefined {
  // Identity is permanent. Retire it before any canonical content row can disappear.
  const projectPrefix = `ORG#${companyId}#PROJECT#`;
  const canonicalProject = pk.startsWith(projectPrefix) ? pk.slice(projectPrefix.length)
    : pk === `ORG#${companyId}#PROJECT_CATALOG` && sk.startsWith("PROJECT#") ? sk.slice("PROJECT#".length)
      : (fields === "this" || (companyId === IMPLICIT_COMPANY_ID && fields === "none")) && pk.startsWith("PROJECT#") ? pk.slice("PROJECT#".length) : undefined;
  if (canonicalProject !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(canonicalProject)) {
    if (fields === "other" || fields === "conflicting") return { act: "conflicting" };
    return { act: "retire-project", project: canonicalProject, meta: sk === "META", kind: kindOf(pk, companyId) };
  }
  return undefined;
}

function verdictOf(item: StoredDocument, companyId: string): Verdict {
  const { pk, sk } = item;
  if (typeof pk !== "string" || typeof sk !== "string") return { act: "keep" };
  if (pk.startsWith(PURGE_OWNED)) return { act: "keep" };
  const fields = companyFieldsOf(item, companyId);
  return projectRetirementVerdict(pk, sk, companyId, fields) ?? contentVerdict(item, companyId, fields);
}

/** Classify content only after permanent project identities have been handled. */
function contentVerdict(item: StoredDocument, companyId: string, fields: ReturnType<typeof companyFieldsOf>): Verdict {
  const { pk, sk } = item;
  // The company's own partitions.
  if (pk === `ORG#${companyId}`) return sk === "META" ? { act: "keep" } : { act: "delete", kind: "company" };
  if (pk === `ORG#${companyId}#AUDIT`) {
    if (item["tombstone"] === true || (typeof item["action"] === "string" && PURGE_EVENTS.has(item["action"]))) return { act: "keep" };
    return { act: "tombstone" };
  }
  if (pk === `ORG#${companyId}#AUDIT_COPY`) return { act: "keep" };
  // Preserve the scoped workspace META until its file prefix has been recorded and drained.
  if (sk === "META") {
    const id = pk.slice(pk.lastIndexOf("#") + 1);
    if (PLAIN.test(id) && pk === workspaceKey(companyId, id).pk) return { act: "prove", what: "ws", id, kind: "WORKSPACE" };
  }
  if (pk.startsWith(`ORG#${companyId}#`) || pk.startsWith(`WS#${companyId}#`)) return { act: "delete", kind: kindOf(pk, companyId) };
  // Another company's partitions are never touched, whatever their rows say.
  if (pk.startsWith("ORG#") || pk.startsWith("WS#")) return { act: "keep" };
  // People's sign-in rows (a person may belong to other companies); their task list rows carry the company and go.
  if (pk.startsWith("DEVELOPER#") && !sk.startsWith("TASK#")) return { act: "keep" };
  if (PEOPLE_PARTITIONS.some((prefix) => pk.startsWith(prefix))) return { act: "keep" };
  if (fields === "conflicting") return { act: "conflicting" };
  if (fields === "other") return { act: "keep" };
  if (fields === "this") {
    if (sk === "META" && pk.startsWith("DEVTASK#")) return { act: "prove", what: "task", id: pk.slice("DEVTASK#".length), kind: "DEVTASK" };
    if (sk === "META" && pk.startsWith("WORKSPACE#")) return { act: "prove", what: "ws", id: pk.slice("WORKSPACE#".length), kind: "WORKSPACE" };
    return { act: "delete", kind: kindOf(pk, companyId) };
  }
  // An install-wide list whose key names the company as one `#` part (`OPEN_AGENT_SESSIONS` / `<company>#...`, `EGRESS_DOMAINS` / `ORG#<company>#...`, `CORE_ENGINE_IN_USE` / `ORG#<company>`).
  if (pk.split("#").includes(companyId) || sk.split("#").includes(companyId)) return { act: "delete", kind: kindOf(pk, companyId) };
  // A row that names a task or workspace by id, or sits in the partition of one (a row written there after its META was deleted): it goes when this purge proved that task or workspace the company's.
  const refs: string[] = [];
  const parts = pk.split("#");
  if (parts.length === 2 && parts[0] === "DEVTASK" && PLAIN.test(parts[1]!)) refs.push(`task#${parts[1]!}`);
  if (parts.length === 2 && parts[0] === "WORKSPACE" && PLAIN.test(parts[1]!)) refs.push(`ws#${parts[1]!}`);
  if (parts.length === 3 && parts[0] === "IDEMPOTENCY" && PLAIN.test(parts[2]!)) refs.push(`ws#${parts[2]!}`);
  if (typeof item["taskId"] === "string" && PLAIN.test(item["taskId"])) refs.push(`task#${item["taskId"]}`);
  if (typeof item["workspaceId"] === "string" && PLAIN.test(item["workspaceId"])) refs.push(`ws#${item["workspaceId"]}`);
  if (refs.length > 0) return { act: "ref", refs: [...new Set(refs)], kind: kindOf(pk, companyId) };
  return { act: "keep" };
}

/** The file prefixes of a proved task or workspace (every version under each goes), or undefined when an id is not a plain id (nothing is deleted then). */
function prefixesOf(what: "task" | "ws", id: string, meta: StoredDocument): string[] | undefined {
  const ownerKey = meta["ownerKey"];
  if (what === "ws") {
    if (typeof ownerKey !== "string" || !PLAIN.test(ownerKey) || !PLAIN.test(id)) return undefined;
    return [`private/${ownerKey}/${id}/`];
  }
  const workspaceId = meta["workspaceId"];
  if (typeof ownerKey !== "string" || typeof workspaceId !== "string") return undefined;
  return evidencePrefixesOf({ ownerKey, workspaceId, taskId: id });
}

/** The partitions that hang off a proved partition and carry no company of their own (a workspace's accepted-request partition). */
function sidePartitionsOf(what: "task" | "ws", id: string, meta: StoredDocument): string[] {
  const ownerKey = meta["ownerKey"];
  if (what === "ws" && typeof ownerKey === "string" && PLAIN.test(ownerKey) && PLAIN.test(id)) return [`IDEMPOTENCY#${ownerKey}#${id}`];
  return [];
}

/** The company-level file prefixes (the test services' fixtures). */
const companyPrefixesOf = (companyId: string): string[] => [`private/${companyId}/fixtures/`];

// ---- the dry run ----

export interface CompanyPurgeDryRun {
  /** Rows that would be deleted, by kind (an id never appears). Rows inside a task or workspace partition are counted under `partitions`, not here. */
  rows: Record<string, number>;
  /** Audit rows that would be reduced to a tombstone. */
  tombstones: number;
  /** Task and workspace partitions that would be emptied, each with every row and its files. */
  partitions: { task: number; ws: number };
  /** File prefixes that would be emptied in every version (the company's fixtures counted once). */
  prefixes: number;
  refused: number;
  conflicting: number;
  /** Rows elsewhere that name a task or workspace proved in this call (a row read before its task's META is not counted). */
  references: number;
  /** True when the whole store was read; otherwise pass `cursor` back to go on. */
  complete: boolean;
  /** An opaque handle (a random id, good for an hour, used once): the walk's real place is kept by the purge, never handed out (a store cursor names a key). */
  cursor?: string;
}

/** Walks the store, writing nothing to any company's data, and answers what the purge would remove, in counts. Bounded by time and items; resumable with its handle. Operator only. */
export async function dryRunCompanyPurge(deps: Pick<CompanyPurgeDeps, "store" | "now">, input: { companyId: string; by: CompanyPurgeOperator; cursor?: string; budgetMs?: number }): Promise<CompanyPurgeDryRun> {
  operatorOf(input.by);
  const companyId = companyOf(input.companyId);
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !REQUEST_ID.test(input.cursor))) throw agentXError("CONFIG_INVALID", PURGE_DRY_RUN_HANDLE);
  return await fixedWords(async () => {
  // A handle is used once: its row is read and deleted; an unknown or expired one is refused.
  let storeCursor: string | undefined;
  if (input.cursor !== undefined) {
    const key = { pk: dryRunPk(companyId), sk: input.cursor };
    // Read and removed in one conditional step: of two calls with the same handle, only one gets it.
    const used = await deps.store.delete({ key, condition: when.present(), return: "old" });
    const saved = used.applied ? used.item : undefined;
    if (saved === undefined || typeof saved["cursor"] !== "string" || typeof saved["expiresAtMs"] !== "number" || saved["expiresAtMs"] <= deps.now()) throw agentXError("CONFIG_INVALID", PURGE_DRY_RUN_HANDLE);
    storeCursor = saved["cursor"];
  }
  const stopAt = deps.now() + budgetOf(input.budgetMs);
  const report: CompanyPurgeDryRun = { rows: {}, tombstones: 0, partitions: { task: 0, ws: 0 }, prefixes: input.cursor === undefined ? companyPrefixesOf(companyId).length : 0, refused: 0, conflicting: 0, references: 0, complete: false };
  const proved = new Set<string>();
  let cursor = storeCursor;
  let read = 0;
  const kinds = new Set<string>();
  const add = (kind: string): void => {
    const name = kinds.has(kind) || kinds.size < KINDS_MAX ? kind : "other";
    kinds.add(name);
    report.rows[name] = (report.rows[name] ?? 0) + 1;
  };
  for (;;) {
    // At least one page is read per call, whatever its time.
    if (read > 0 && (deps.now() >= stopAt || read >= COMPANY_PURGE_ITEMS_PER_CALL)) break;
    const page = await deps.store.scanPage({ limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    read += Math.max(1, page.items.length);
    for (const item of page.items) {
      const verdict = verdictOf(item, companyId);
      switch (verdict.act) {
        case "delete": add(verdict.kind); break;
        case "retire-project": add(verdict.kind); break;
        case "tombstone": report.tombstones += 1; break;
        case "conflicting": report.conflicting += 1; break;
        case "prove": {
          if (item["entityType"] === "WORKSPACE_COMPANY_POINTER") { add("WORKSPACE_COMPANY_POINTER"); break; }
          report.partitions[verdict.what] += 1;
          proved.add(`${verdict.what}#${verdict.id}`);
          const prefixes = prefixesOf(verdict.what, verdict.id, item);
          if (prefixes === undefined) report.refused += 1; else report.prefixes += prefixes.length;
          break;
        }
        case "ref": if (verdict.refs.some((ref) => proved.has(ref))) report.references += 1; break;
        default: break;
      }
    }
    if (page.cursor === undefined) { report.complete = true; return report; }
    cursor = page.cursor;
  }
  if (cursor === undefined) return report;
  const handle = randomUUID();
  const expiresAtMs = deps.now() + DRY_RUN_HANDLE_MS;
  // The store's own expiry removes a handle nobody came back for (seconds since the epoch); the time is checked on use as well.
  const ttl = deps.store.ttlAttribute;
  await deps.store.put({ item: { pk: dryRunPk(companyId), sk: handle, entityType: "COMPANY_PURGE_DRYRUN", cursor, expiresAtMs, ...(ttl === undefined || ["pk", "sk", "cursor", "expiresAtMs", "entityType"].includes(ttl) ? {} : { [ttl]: Math.ceil(expiresAtMs / 1_000) }) } });
  return { ...report, cursor: handle };
  });
}

// ---- the run ----

export interface CompanyPurgeProgress {
  companyId: string;
  /**
   * `waiting`: not due yet (or another run holds it); `cancelled`: due, but the company is open again, so the purge was cancelled; `not_closed`: started, and the company does not read as closed now,
   * so nothing ran; `working`: ran and has more to do; `done`; `idle`: nothing to run.
   */
  outcome: "waiting" | "cancelled" | "not_closed" | "working" | "done" | "idle";
  counts?: CompanyPurgeCounts;
}

interface Run {
  deps: CompanyPurgeDeps;
  companyId: string;
  runId: string;
  row: Row;
  stopAt: number;
  read: number;
  /** What the purge had done when this call began (see `outOfTime`). */
  startDone: number;
  log: (entry: Record<string, unknown>) => void;
}

const doneSoFar = (counts: CompanyPurgeCounts): number => counts.deleted + counts.tombstoned + counts.partitions + counts.prefixes;
/** Whether the call must stop: at its item limit always; at its time only once it has done something (a write, or a page read), so even a call with no time left moves the purge on. */
const outOfTime = (run: Run): boolean => run.read >= COMPANY_PURGE_ITEMS_PER_CALL || ((doneSoFar(run.row.counts) > run.startDone || run.read >= PAGE) && run.deps.now() >= run.stopAt);

/** Saves the run's place (cursor, counts, whether the pass acted) under its lease. Throws when the lease is lost: another run took over. */
async function save(run: Run, extra: { ops?: ReturnType<typeof change.set>[]; cursor?: string | null; release?: boolean } = {}): Promise<void> {
  const { row } = run;
  const ops = [change.set("counts", { ...row.counts }), change.set("acted", row.acted), change.set("blocked", row.blocked), ...(extra.ops ?? [])];
  // A call that ends normally lets go of the purge, so the next scheduled run need not wait out the lease.
  if (extra.release === true) ops.push(change.remove("leaseUntil"));
  if (extra.cursor === null) ops.push(change.remove("cursor"));
  else if (extra.cursor !== undefined) ops.push(change.set("cursor", extra.cursor));
  const saved = await run.deps.store.update({ key: companyPurgeKey(run.companyId), ops, condition: when.and(when.eq("status", "running"), when.eq("runId", run.runId)) });
  if (!saved.applied) throw new Error("the purge lease was lost");
}

/** Records a proved partition (its files and the partitions hanging off it) and the id, so the partition is emptied and rows elsewhere that name the id go too. */
async function prove(run: Run, verdict: Extract<Verdict, { act: "prove" }>, meta: StoredDocument): Promise<void> {
  // A discovery row has no workspace content. Queue the scoped partition, never the pointer's partition.
  let alreadyDrained = false;
  if (meta["entityType"] === "WORKSPACE_COMPANY_POINTER") {
    const scopedKey = workspaceKey(run.companyId, verdict.id);
    const scoped = await run.deps.store.get(scopedKey);
    if (metaStatus(scoped, run.companyId) === "foreign") return;
    alreadyDrained = scoped === undefined;
    meta = scoped ?? { ...scopedKey, companyId: run.companyId };
  }
  const prefixes = alreadyDrained ? [] : prefixesOf(verdict.what, verdict.id, meta);
  const sides = sidePartitionsOf(verdict.what, verdict.id, meta);
  await run.deps.store.put({ item: { pk: marksPk(run.companyId), sk: `${verdict.what}#${verdict.id}`, entityType: "COMPANY_PURGE_MARK" } });
  const put = await run.deps.store.put({
    item: { pk: partsPk(run.companyId), sk: meta.pk, entityType: "COMPANY_PURGE_PART", what: verdict.what, prefixes: prefixes ?? [], sides, refused: prefixes === undefined },
    condition: when.absent(),
  });
  if (put.applied) {
    run.row.counts.partitions += 1;
    if (prefixes === undefined) run.row.counts.refused += 1;
    run.row.acted = true;
  }
}

/** Deletes every row of a partition; `meta` (the proving row) last and only while it still names the company. True when the partition is empty. */
/** The META of a proved partition still names this company and no other (`companyId` this company and `orgId` absent or the same, or no `companyId` and `orgId` this company). */
const stillOursCondition = (companyId: string) => when.or(
  when.and(when.eq("companyId", companyId), when.or(when.notExists("orgId"), when.eq("orgId", companyId))),
  when.and(when.notExists("companyId"), when.eq("orgId", companyId)),
);
/** The same test on a META read: `ours`, `gone` (deleted already, by this purge's last step), or `foreign` (it names another company now). */
function metaStatus(meta: StoredDocument | undefined, companyId: string): "ours" | "gone" | "foreign" {
  if (meta === undefined) return "gone";
  const companyField = meta["companyId"];
  const orgField = meta["orgId"];
  if (companyField === companyId && (orgField === undefined || orgField === companyId)) return "ours";
  if (companyField === undefined && orgField === companyId) return "ours";
  return "foreign";
}

async function emptyPartition(run: Run, pk: string, proven: boolean): Promise<boolean | "foreign"> {
  // Walks the partition page by page (a page may be empty and still carry a cursor), and walks it again while a walk deleted anything. A proved partition's META is read before every page:
  // a partition whose META has come to name another company is left as it is from then on.
  for (;;) {
    let cursor: string | undefined;
    let deleted = 0;
    do {
      if (outOfTime(run)) return false;
      if (proven && metaStatus(await run.deps.store.get({ pk, sk: "META" }), run.companyId) === "foreign") return "foreign";
      const page = await run.deps.store.query({ pk, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
      run.read += Math.max(1, page.items.length);
      for (const row of page.items.filter((each) => !(proven && each.sk === "META"))) {
        await run.deps.store.delete({ key: { pk: row.pk, sk: row.sk } });
        run.row.counts.deleted += 1;
        run.row.acted = true;
        deleted += 1;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    if (deleted === 0) break;
  }
  if (!proven) return true;
  const removed = await run.deps.store.delete({ key: { pk, sk: "META" }, condition: stillOursCondition(run.companyId) });
  if (removed.applied) { run.row.counts.deleted += 1; run.row.acted = true; }
  return true;
}

/** Empties the recorded partitions: files first, then the partitions hanging off it, then its rows. True when none is left. */
async function drainParts(run: Run): Promise<boolean> {
  for (;;) {
    if (outOfTime(run)) return false;
    const page = await run.deps.store.query({ pk: partsPk(run.companyId), limit: PAGE });
    run.read += Math.max(1, page.items.length);
    if (page.items.length === 0) return true;
    for (const part of page.items) {
      if (outOfTime(run)) return false;
      const prefixes = Array.isArray(part["prefixes"]) ? part["prefixes"].filter((value): value is string => typeof value === "string") : [];
      const sides = Array.isArray(part["sides"]) ? part["sides"].filter((value): value is string => typeof value === "string") : [];
      // The META is checked BEFORE any file or row of the partition goes: one that names another company now drops the record and touches nothing.
      if (metaStatus(await run.deps.store.get({ pk: part.sk, sk: "META" }), run.companyId) === "foreign") {
        run.log({ event: "company_purge.partition_foreign" });
        await run.deps.store.delete({ key: { pk: part.pk, sk: part.sk } });
        continue;
      }
      for (const prefix of prefixes) {
        let outcome: boolean | "out_of_time";
        try { outcome = await run.deps.objects.deleteEveryVersion(prefix, { stopAt: run.stopAt }); } catch (error) { run.log({ event: "company_purge.files_failed", error: errorName(error) }); return false; }
        if (outcome === "out_of_time") return false;
        if (outcome !== true) { run.log({ event: "company_purge.files_left" }); return false; }
      }
      for (const side of sides) if ((await emptyPartition(run, side, false)) !== true) return false;
      const emptied = await emptyPartition(run, part.sk, true);
      if (emptied === "foreign") {
        // Its META names another company now: nothing more of it is touched, and the record goes.
        run.log({ event: "company_purge.partition_foreign" });
        await run.deps.store.delete({ key: { pk: part.pk, sk: part.sk } });
        continue;
      }
      if (!emptied) return false;
      if (part["what"] === "ws") {
        const workspaceId = part.sk.slice(part.sk.lastIndexOf("#") + 1);
        if (part.sk === workspaceKey(run.companyId, workspaceId).pk) {
          const removed = await run.deps.store.delete({
            key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
            condition: when.and(when.eq("entityType", "WORKSPACE_COMPANY_POINTER"), when.eq("companyId", run.companyId)),
          });
          if (removed.applied) { run.row.counts.deleted += 1; run.row.acted = true; }
        }
      }
      run.row.counts.prefixes += prefixes.length;
      await run.deps.store.delete({ key: { pk: part.pk, sk: part.sk } });
      run.row.acted = true;
    }
  }
}

/** Reduces an audit row to its tombstone: its event id, time and company stay; its actor, action, subject, details and digest go. */
async function tombstone(run: Run, row: StoredDocument): Promise<void> {
  const digest = row["digest"];
  const ops = [
    change.set("tombstone", true), change.set("tombstonedAt", new Date(run.deps.now()).toISOString()),
    // The digest goes too (it is taken from the content): without it the sink's "same facts" test fails, so a retry of the old event is refused.
    ...(typeof digest === "string" ? [change.remove("digest")] : []),
    ...["actor", "action", "subject", "details"].filter((name) => row[name] !== undefined).map((name) => change.remove(name)),
  ];
  const written = await run.deps.store.update({ key: { pk: row.pk, sk: row.sk }, ops, condition: typeof digest === "string" ? when.eq("digest", digest) : when.notExists("digest") });
  if (written.applied) { run.row.counts.tombstoned += 1; run.row.acted = true; }
}

/** Retire first, then delete content only while that same tombstone still holds. */
async function retireProjectRow(run: Run, item: StoredDocument, verdict: Extract<Verdict, { act: "retire-project" }>): Promise<void> {
  if (await retireProjectIncarnation(run.deps.store, run.companyId, verdict.project)) { run.row.counts.tombstoned += 1; run.row.acted = true; }
  if (!verdict.meta) {
    const key = projectMetaKey(run.companyId, verdict.project), meta = await run.deps.store.get(key);
    if (meta?.["status"] !== "deleted") { run.row.acted = true; return; }
    const removed = await run.deps.store.transact([
      { kind: "check", key, condition: projectMetaSnapshot(meta) },
      { kind: "delete", key: { pk: item.pk, sk: item.sk }, condition: projectMetaSnapshot(item) },
    ]);
    if (removed.applied) { run.row.counts.deleted += 1; run.row.acted = true; }
    else run.row.acted = true; // A concurrent writer requires another bounded pass.
  }
}

/** One page of the pass: acts on each row it reads. */
async function actOnPage(run: Run, items: readonly StoredDocument[]): Promise<void> {
  const refs: Array<{ item: StoredDocument; refs: string[] }> = [];
  for (const item of items) {
    const verdict = verdictOf(item, run.companyId);
    switch (verdict.act) {
      case "retire-project": {
        await retireProjectRow(run, item, verdict);
        break;
      }
      case "delete":
        await run.deps.store.delete({ key: { pk: item.pk, sk: item.sk } });
        run.row.counts.deleted += 1;
        run.row.acted = true;
        break;
      case "tombstone": await tombstone(run, item); break;
      case "prove": await prove(run, verdict, item); break;
      // Counted on the first pass only (every pass meets the same row again).
      case "conflicting": if (run.row.counts.passes <= 1) { run.row.counts.conflicting += 1; run.log({ event: "company_purge.conflicting_row" }); } break;
      case "ref": refs.push({ item, refs: verdict.refs }); break;
      default: break;
    }
  }
  if (refs.length === 0) return;
  const wanted = [...new Set(refs.flatMap((entry) => entry.refs))];
  const marked = new Set<string>();
  for (let at = 0; at < wanted.length; at += PAGE) {
    const slice = wanted.slice(at, at + PAGE);
    const found = await run.deps.store.getMany(slice.map((sk) => ({ pk: marksPk(run.companyId), sk })));
    slice.forEach((sk, index) => { if (found[index] !== undefined) marked.add(sk); });
  }
  // A marked task or workspace whose META has come to name another company no longer counts: rows that name it are left.
  for (const ref of [...marked]) {
    const [what, id] = ref.split("#") as [string, string];
    const metaPk = what === "task" ? `DEVTASK#${id}` : `WORKSPACE#${id}`;
    if (metaStatus(await run.deps.store.get({ pk: metaPk, sk: "META" }), run.companyId) === "foreign") marked.delete(ref);
  }
  for (const entry of refs) {
    if (!entry.refs.some((ref) => marked.has(ref))) continue;
    await run.deps.store.delete({ key: { pk: entry.item.pk, sk: entry.item.sk } });
    run.row.counts.deleted += 1;
    run.row.acted = true;
  }
}

/** Deletes the purge's marks, recorded partitions and dry-run handles of the company, at most `limit` rows. True when none is left. A new request clears them first: what they named is proved again. */
async function clearMarks(deps: Pick<CompanyPurgeDeps, "store">, companyId: string, limit: number): Promise<boolean> {
  let removed = 0;
  for (const pk of [marksPk(companyId), partsPk(companyId), dryRunPk(companyId)]) {
    for (;;) {
      const page = await deps.store.query({ pk, limit: PAGE });
      if (page.items.length === 0) break;
      for (const row of page.items) {
        if (removed >= limit) return false;
        await deps.store.delete({ key: { pk: row.pk, sk: row.sk } });
        removed += 1;
      }
    }
  }
  return true;
}

/**
 * Runs one company's purge for at most `budgetMs` (and COMPANY_PURGE_ITEMS_PER_CALL items). Does nothing before it is due, while another run holds it, or while the company does not read as closed.
 * Never reports `done` unless a whole pass over the store found nothing left to do and every recorded partition is empty. A fault is thrown after the place is saved: the next run goes on from it.
 */
export async function runCompanyPurge(deps: CompanyPurgeDeps, companyId: string, budgetMs = COMPANY_PURGE_BUDGET_MS): Promise<CompanyPurgeProgress> {
  const company = companyOf(companyId);
  const log = deps.log ?? (() => undefined);
  assertWired(deps);
  let existing: Row | undefined;
  let runId: string;
  let stopAt: number;
  try {
    existing = await readRow(deps, company);
    if (existing === undefined || existing.status === "cancelled") return { companyId: company, outcome: "idle" };
    if (existing.status === "done") return { companyId: company, outcome: "done", counts: { ...existing.counts } };
    const startMs = deps.now();
    if (startMs < existing.dueAtMs) return { companyId: company, outcome: "waiting" };
    const closure = await closureOf(deps, company);
    if (closure === "unknown") { log({ event: "company_purge.closure_unknown" }); return { companyId: company, outcome: "waiting" }; }
    if (closure === "open" || closure.closeId !== existing.closeId) {
      log({ event: "company_purge.not_closed" });
      // A started purge is held (an operator may cancel it); a due one that has not started is cancelled, never kept for a later close (which needs its own request and cooling-off).
      if (existing.status !== "scheduled") return { companyId: company, outcome: "not_closed" };
      const at = new Date(startMs).toISOString();
      const cancelled = await deps.store.transact([
        { kind: "update", key: companyPurgeKey(company), ops: [change.set("status", "cancelled"), change.set("cancelledAt", at), change.set("cancelledBy", "rovara")], condition: when.and(when.eq("status", "scheduled"), when.eq("requestId", existing.requestId)) },
        ...auditOf(deps, { companyId: company, eventId: `company-purge:${company}:${existing.requestId}:cancelled`, at, action: "company.purge_cancelled", details: { reason: closure === "open" ? "company_open" : "closed_again" } }),
      ]);
      return { companyId: company, outcome: cancelled.applied ? "cancelled" : "waiting" };
    }
    stopAt = startMs + budgetOf(budgetMs);
    runId = randomUUID();
    const leaseUntil = stopAt + LEASE_GRACE_MS;
    // Take the purge: a scheduled one starts (with its audit event); a running one is taken only when no other run holds it. Either way the run works from the row AS TAKEN (re-read after the
    // take), never from the copy read before it: another run may have moved on in between.
    if (existing.status === "scheduled") {
      const at = new Date(startMs).toISOString();
      const started = await deps.store.transact([
        { kind: "update", key: companyPurgeKey(company), ops: [change.set("status", "running"), change.set("startedAt", at), change.set("runId", runId), change.set("leaseUntil", leaseUntil)], condition: when.and(when.eq("status", "scheduled"), when.eq("requestId", existing.requestId), when.lte("dueAtMs", startMs)) },
        ...auditOf(deps, { companyId: company, eventId: `company-purge:${company}:${existing.requestId}:started`, at, action: "company.purge_started" }),
      ]);
      if (!started.applied) return { companyId: company, outcome: "waiting" };
    } else {
      const taken = await deps.store.update({ key: companyPurgeKey(company), ops: [change.set("runId", runId), change.set("leaseUntil", leaseUntil)], condition: when.and(when.eq("status", "running"), when.eq("requestId", existing.requestId), when.or(when.notExists("leaseUntil"), when.lt("leaseUntil", startMs))) });
      if (!taken.applied) return { companyId: company, outcome: "waiting" };
    }
    const taken = await readRow(deps, company);
    if (taken === undefined || taken.status !== "running" || taken.runId !== runId) return { companyId: company, outcome: "waiting" };
    existing = taken;
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    log({ event: "company_purge.run_failed", error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", PURGE_RUN_FAILED);
  }
  const run: Run = { deps, companyId: company, runId, row: existing, stopAt, read: 0, startDone: doneSoFar(existing.counts), log };
  /** Ends the call normally with more to do: saves the place and lets go of the purge. */
  const pause = async (cursor?: null): Promise<CompanyPurgeProgress> => {
    await save(run, { release: true, ...(cursor === null ? { cursor: null } : {}) });
    return { companyId: company, outcome: "working", counts: { ...run.row.counts } };
  };
  try {
    if (run.row.counts.passes === 0 && run.row.cursor === undefined) {
      for (const prefix of companyPrefixesOf(company)) {
        const outcome = await deps.objects.deleteEveryVersion(prefix, { stopAt });
        if (outcome !== true) return await pause();
      }
      run.row.counts.prefixes += companyPrefixesOf(company).length;
      run.row.counts.passes = 1;
      await save(run);
    }
    for (;;) {
      if (!(await drainParts(run))) return await pause();
      if (outOfTime(run)) return await pause();
      // A pass starts: what it meets of unreadable rows is its own.
      if (run.row.cursor === undefined) { run.row.blocked = false; run.row.counts.unreadable = 0; }
      const page = await deps.store.scanPage({ limit: PAGE, ...(run.row.cursor === undefined ? {} : { cursor: run.row.cursor }) });
      run.read += Math.max(1, page.items.length);
      const skipped = page.skipped;
      if (skipped !== undefined && (typeof skipped !== "number" || !Number.isSafeInteger(skipped) || skipped !== 0)) {
        run.row.blocked = true;
        run.row.counts.unreadable += typeof skipped === "number" && Number.isSafeInteger(skipped) && skipped > 0 ? skipped : 1;
      }
      await actOnPage(run, page.items);
      if (page.cursor !== undefined) {
        run.row.cursor = page.cursor;
        await save(run, { cursor: page.cursor });
        continue;
      }
      // The end of a pass. One that acted (deleted, tombstoned, proved or emptied anything) is followed by another from the start; one that met an unreadable row ends the call and is
      // followed by another later (never done); only a pass that read every row and found nothing left ends the purge.
      delete run.row.cursor;
      if (run.row.acted) {
        run.row.acted = false;
        run.row.counts.passes += 1;
        await save(run, { cursor: null });
        continue;
      }
      if (run.row.blocked) {
        log({ event: "company_purge.unreadable_rows", count: run.row.counts.unreadable });
        run.row.counts.passes += 1;
        return await pause(null);
      }
      const doneAt = new Date(deps.now()).toISOString();
      const counts = { ...run.row.counts };
      const finished = await deps.store.transact([
        { kind: "update", key: companyPurgeKey(company), ops: [change.set("status", "done"), change.set("doneAt", doneAt), change.set("counts", counts), change.set("acted", false), change.set("blocked", false), change.remove("cursor"), change.remove("runId"), change.remove("leaseUntil")], condition: when.and(when.eq("status", "running"), when.eq("runId", runId)) },
        ...auditOf(deps, { companyId: company, eventId: `company-purge:${company}:${existing.requestId}:done`, at: doneAt, action: "company.purged", details: { deleted: counts.deleted, tombstoned: counts.tombstoned, partitions: counts.partitions, prefixes: counts.prefixes, refused: counts.refused, conflicting: counts.conflicting, passes: counts.passes } }),
      ]);
      if (!finished.applied) throw new Error("the purge lease was lost");
      // The marks go only once the purge is done (a pass never runs without them). What one call cannot clear is left for the next request of this company, which clears them first.
      try { await clearMarks(deps, company, COMPANY_PURGE_ITEMS_PER_CALL); } catch (error) { log({ event: "company_purge.marks_left", error: errorName(error) }); }
      return { companyId: company, outcome: "done", counts };
    }
  } catch (error) {
    log({ event: "company_purge.run_failed", error: errorName(error) });
    try { await save(run); } catch { /* the place saved last stands; the work done since is repeated harmlessly */ }
    throw agentXError("RUNTIME_UNAVAILABLE", PURGE_RUN_FAILED);
  }
}

/** The scheduled run: goes through the purges that are due or running (the oldest due first), each isolated, within one budget. */
export async function resumeCompanyPurges(deps: CompanyPurgeDeps, budgetMs: number): Promise<CompanyPurgeProgress[]> {
  const ends = deps.now() + budgetOf(budgetMs);
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.query({ pk: COMPANY_PURGE_PK, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const row = rowOf(item);
      if (row !== undefined && row !== "unreadable" && (row.status === "running" || (row.status === "scheduled" && row.dueAtMs <= deps.now()))) rows.push(row);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && rows.length < 1_000);
  rows.sort((a, b) => a.dueAtMs - b.dueAtMs);
  const out: CompanyPurgeProgress[] = [];
  for (const row of rows) {
    const left = ends - deps.now();
    if (left <= 0) { out.push({ companyId: row.companyId, outcome: "waiting" }); continue; }
    try {
      out.push(await runCompanyPurge(deps, row.companyId, left));
    } catch (error) {
      deps.log?.({ event: "company_purge.resume_failed", error: errorName(error) });
      out.push({ companyId: row.companyId, outcome: "working" });
    }
  }
  return out;
}

/** The purge's prefix delete over an object storage that keeps no versions (the laptop's folder store). A deployed install passes the bucket's own version delete instead. */
export function unversionedPurgeObjects(objects: { deletePrefix(prefix: string): Promise<boolean> }): CompanyPurgeObjects {
  return { deleteEveryVersion: async (prefix) => await objects.deletePrefix(prefix) };
}
