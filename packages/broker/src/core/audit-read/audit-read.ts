// Lane AU: the engine audit read. A company's audit records are the `AUDIT` rows of its own partition (`ORG#<company>#AUDIT`, written by Code's audit sink: `DocumentAuditSink`), one row per engine action, keyed by the
// event's id. This reads them for the company administrator of THAT company: filtered by time, project, person and action, a bounded page at a time. It is append-only from the API's side: the store it takes
// has `query` and nothing else. Each row is checked against the company again on the row itself (`rowBelongsToCompany`); rows that fail are counted as skipped, never shown.
//
// Order. The rows are in the store's key order (the event id), which is not time order, and no index by time exists for them yet. So one call reads the partition in key order, at most
// COMPANY_AUDIT_SCAN_MAX rows, keeps the rows that match, and answers them newest first WITHIN the page; `next` carries the position to go on from. A page may therefore be short (or empty) while `next` is present: ask
// again until it is absent. (A time index is a deferred item; see the DEFERRED register.)
import {
  AuditViaSchema, COMPANY_AUDIT_PAGE_DEFAULT, COMPANY_AUDIT_SCAN_MAX, CompanyAuditQuerySchema, OrgIdSchema, agentXError, companyScoped,
  type CompanyAuditQuery, type CompanyAuditResponse, type DocumentStore, type EngineAuditRecord, type StoredDocument,
} from "@agentx/contracts";
import { rowBelongsToCompany } from "../company-read-rows.js";
import { decodeCursor, encodeCursor, filterDigest } from "../company-read-cursor.js";

export { COMPANY_AUDIT_SCAN_MAX };

/** The most rows asked of the store in one query. */
const QUERY_ROWS = 300;
const ROW_KEY_PREFIX = "EVENT#";
/** The most store queries one call makes: enough for the row cap, plus slack for pages a store ends early. Past it the call stops and says where to go on. */
const QUERIES_MAX = Math.ceil(COMPANY_AUDIT_SCAN_MAX / QUERY_ROWS) + 20;
const KEY_MAX = 400;
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);

interface Shown { record: EngineAuditRecord; atMs: number; project?: string }
const SIGN_IN_ACTION = /^signin\.(?:succeeded|refused)$/u;
const SIGN_IN_METHODS = new Set(["web", "slack", "github", "cli", "invite"]);
const SIGN_IN_CAUSES = new Set(["not_invited", "member_elsewhere", "member_revoked", "person_revoked", "company_signin_mismatch", "sign_in_failed"]);

/** The record a row holds, or undefined for a row that is not a readable audit row. */
function recordOfRow(row: StoredDocument): Shown | undefined {
  if (row["entityType"] !== "AUDIT") return undefined;
  const eventId = text(row["eventId"], 256);
  const at = text(row["at"], 64);
  const action = text(row["action"], 128);
  const actor = row["actor"] as { type?: unknown; id?: unknown } | null | undefined;
  const actorId = text(actor?.id, 256);
  if (eventId === undefined || at === undefined || action === undefined || actorId === undefined) return undefined;
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return undefined;
  if (actor?.type !== "person" && actor?.type !== "agent" && actor?.type !== "system") return undefined;
  const subjectRow = row["subject"] as { type?: unknown; id?: unknown } | null | undefined;
  const subjectType = text(subjectRow?.type, 64);
  const subjectId = text(subjectRow?.id, 256);
  const details = row["details"] !== null && typeof row["details"] === "object" && !Array.isArray(row["details"]) ? row["details"] as Record<string, unknown> : undefined;
  const via = AuditViaSchema.safeParse(details?.["via"]);
  const detailsProject = text(details?.["project"], 128);
  const project = subjectType === "project" && subjectId !== undefined ? subjectId : detailsProject;
  const outcome = /(?:^|[._-])refused$/u.test(action) ? "refused" : "ok";
  const method = details?.["method"];
  const cause = details?.["cause"];
  const signIn = SIGN_IN_ACTION.test(action);
  if (signIn && (typeof method !== "string" || !SIGN_IN_METHODS.has(method))) return undefined;
  if (signIn && outcomeForSignIn(action) === "refused" && (typeof cause !== "string" || !SIGN_IN_CAUSES.has(cause))) return undefined;
  if (signIn && outcomeForSignIn(action) === "ok" && cause !== undefined) return undefined;
  return {
    atMs,
    ...(project === undefined ? {} : { project }),
    record: {
      eventId, at, actor: { developerId: actorId, name: actorId, type: actor.type },
      action, subject: subjectType !== undefined && subjectId !== undefined ? `${subjectType}:${subjectId}` : "", outcome,
      ...(via.success ? { via: via.data } : {}),
      ...(signIn ? { method: method as EngineAuditRecord["method"] } : {}),
      ...(signIn && cause !== undefined ? { cause: cause as EngineAuditRecord["cause"] } : {}),
    },
  };
}

function outcomeForSignIn(action: string): "ok" | "refused" { return action === "signin.refused" ? "refused" : "ok"; }

function matches(shown: Shown, query: CompanyAuditQuery, fromMs: number | undefined, toMs: number | undefined): boolean {
  const signIn = SIGN_IN_ACTION.test(shown.record.action);
  if (query.kind === "sign-in" ? !signIn : signIn) return false;
  if (fromMs !== undefined && shown.atMs < fromMs) return false;
  if (toMs !== undefined && shown.atMs > toMs) return false;
  if (query.person !== undefined && shown.record.actor.developerId !== query.person) return false;
  if (query.project !== undefined && shown.project !== query.project) return false;
  if (query.action !== undefined) {
    const wanted = query.action;
    if (wanted.endsWith(".*") ? !shown.record.action.startsWith(wanted.slice(0, -1)) : shown.record.action !== wanted) return false;
  }
  return true;
}

/**
 * One page of a company's audit records. `query` is checked here (not only by the caller): an unknown field, a wrong type or an out-of-range value is a CONFIG_INVALID with fixed words. A store failure is
 * AUDIT_UNAVAILABLE with fixed words and no cause. `store` needs only `query`.
 */
export async function readCompanyAudit(store: Pick<DocumentStore, "query">, companyId: string, query: unknown): Promise<CompanyAuditResponse> {
  if (!OrgIdSchema.safeParse(companyId).success) throw agentXError("CONFIG_INVALID", "the company is not valid");
  const parsed = CompanyAuditQuerySchema.safeParse(query);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the audit query is not valid");
  const filters = parsed.data;
  const fromMs = filters.from === undefined ? undefined : Date.parse(filters.from);
  const toMs = filters.to === undefined ? undefined : Date.parse(filters.to);
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw agentXError("AUDIT_RANGE_INVALID", "the time range is not valid");
  const limit = filters.limit ?? COMPANY_AUDIT_PAGE_DEFAULT;
  const digest = filterDigest({ from: fromMs, to: toMs, project: filters.project, person: filters.person, action: filters.action, kind: filters.kind });
  const after = filters.cursor === undefined ? undefined : decodeCursor("k", filters.cursor, companyId, digest, (position) => position.startsWith(ROW_KEY_PREFIX));
  const pk = companyScoped(companyId, "AUDIT");

  const shown: Shown[] = [];
  let skipped = 0;
  let scanned = 0;
  let lastKey = after;
  let more = false;
  let storeCursor: string | undefined;
  let queries = 0;
  scan: for (;;) {
    if (queries >= QUERIES_MAX) {
      more = true;
      break;
    }
    queries += 1;
    let page;
    try {
      page = await store.query({
        pk, limit: Math.min(QUERY_ROWS, COMPANY_AUDIT_SCAN_MAX - scanned),
        ...(after === undefined ? {} : { sk: { op: "gt" as const, value: after } }),
        ...(storeCursor === undefined ? {} : { cursor: storeCursor }),
      });
    } catch {
      throw agentXError("AUDIT_UNAVAILABLE", "the audit records could not be read");
    }
    for (const [index, row] of page.items.entries()) {
      scanned += 1;
      // A key a cursor could not carry is never a position to resume from.
      const resumable = row.sk.startsWith(ROW_KEY_PREFIX) && row.sk.length <= KEY_MAX;
      if (resumable) lastKey = row.sk;
      const record = resumable && rowBelongsToCompany(row, companyId) ? recordOfRow(row) : undefined;
      if (record === undefined) skipped += 1;
      else if (matches(record, filters, fromMs, toMs)) shown.push(record);
      if (shown.length >= limit) {
        more = index < page.items.length - 1 || page.cursor !== undefined;
        break scan;
      }
    }
    storeCursor = page.cursor;
    if (storeCursor === undefined) break;
    if (scanned >= COMPANY_AUDIT_SCAN_MAX) {
      more = true;
      break;
    }
  }
  shown.sort((a, b) => (a.atMs === b.atMs ? (a.record.eventId < b.record.eventId ? -1 : 1) : b.atMs - a.atMs));
  return {
    records: shown.map((one) => one.record),
    ...(more && lastKey !== undefined ? { next: encodeCursor("k", companyId, digest, lastKey) } : {}),
    skipped,
  };
}
