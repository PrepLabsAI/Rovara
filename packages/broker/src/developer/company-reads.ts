// Lanes AU and EV: the two company reads on the developer API, for a company administrator:
//   GET /v1/dev/client/company/audit/records   the engine audit records (the audit read of the Cloud-to-Code contract)
//   GET /v1/dev/client/company/events          the work events and usage, polled with a cursor
// Who may read: a signed-in company administrator (today a Rovara administrator; the named scope waits for the scope table, see the todo tests). Which company: the caller's own, resolved from membership by the
// host (`companyOf`), never from a token claim or a query parameter. With no resolver the install is one company, the implicit one, as it is today. A resolver that answers nothing, a bad value or throws is a
// refusal to sign in again, never a fall back to the implicit company. Both reads only read.
import {
  COMPANY_AUDIT_RECORDS_PATH, COMPANY_EVENTS_PATH, IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError,
  type CompanyAuditResponse, type CompanyEventsResponse, type DocumentStore,
} from "@agentx/contracts";
import { readCompanyAudit } from "../core/audit-read/index.js";
import { readCompanyEvents } from "../core/work-events/read.js";

export interface CompanyReadsConfiguration {
  /** The company's rows. Only `query` is used: nothing here writes. */
  store: Pick<DocumentStore, "query">;
  /** The company the caller belongs to, from membership. Absent: the install is one company (the implicit one). Undefined or a throw: the caller is refused. */
  companyOf?: (developerId: string) => Promise<string | undefined>;
  /** The display name of a person, for the audit list; absent, a failure or an unusable answer shows the person's id. */
  personName?: (developerId: string, companyId: string) => Promise<string | undefined>;
}
export interface CompanyReadCaller { developerId: string; administrator: boolean }

export const COMPANY_READ_FORBIDDEN = "only a company administrator can read this";
export const COMPANY_READ_REFUSED = "sign in again to read the company's records";
const QUERY_REFUSED = "the query is not valid";
const AUDIT_KEYS = new Set(["from", "to", "project", "person", "action", "limit", "cursor"]);
const EVENT_KEYS = new Set(["from", "to", "kinds", "project", "taskId", "person", "limit", "cursor"]);
const LIMIT = /^[1-9][0-9]{0,3}$/u;
const NAME_MAX = 200;

/** The query string as a plain object: each parameter once, non-empty, named in `allowed`. Numbers and the `kinds` list are made here; every value is then checked by the reader's own schema. */
function queryOf(url: URL, allowed: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) {
    if (!allowed.has(name) || name in out || value === "") throw agentXError("CONFIG_INVALID", QUERY_REFUSED);
    out[name] = name === "limit" ? (LIMIT.test(value) ? Number(value) : value) : name === "kinds" ? value.split(",") : value;
  }
  return out;
}

async function companyOfCaller(config: CompanyReadsConfiguration, caller: CompanyReadCaller): Promise<string> {
  if (config.companyOf === undefined) return IMPLICIT_COMPANY_ID;
  let company: unknown;
  try {
    company = await config.companyOf(caller.developerId);
  } catch {
    throw agentXError("AUTH_REQUIRED", COMPANY_READ_REFUSED);
  }
  if (typeof company !== "string" || !OrgIdSchema.safeParse(company).success) throw agentXError("AUTH_REQUIRED", COMPANY_READ_REFUSED);
  return company;
}

async function withNames(config: CompanyReadsConfiguration, company: string, page: CompanyAuditResponse): Promise<CompanyAuditResponse> {
  const lookup = config.personName;
  if (lookup === undefined) return page;
  // One lookup for each person on the page (at most the page's size), a failure shows the id.
  const ids = [...new Set(page.records.filter((record) => record.actor.type === "person").map((record) => record.actor.developerId))];
  const names = new Map<string, string>();
  await Promise.all(ids.map(async (id) => {
    try {
      const name = await lookup(id, company);
      if (typeof name === "string" && name.trim() !== "") names.set(id, name.trim().slice(0, NAME_MAX));
    } catch { /* the id stays */ }
  }));
  return { ...page, records: page.records.map((record) => (record.actor.type === "person" && names.has(record.actor.developerId) ? { ...record, actor: { ...record.actor, name: names.get(record.actor.developerId)! } } : record)) };
}

/** Serves one of the two reads (GET only; the caller dispatches the method). */
export async function routeCompanyReads(config: CompanyReadsConfiguration, caller: CompanyReadCaller, url: URL, now: number = Date.now()): Promise<CompanyAuditResponse | CompanyEventsResponse> {
  const audit = url.pathname === COMPANY_AUDIT_RECORDS_PATH;
  if (!audit && url.pathname !== COMPANY_EVENTS_PATH) throw agentXError("NOT_FOUND", "route not found");
  if (caller.administrator !== true) throw agentXError("FORBIDDEN", COMPANY_READ_FORBIDDEN);
  const company = await companyOfCaller(config, caller);
  const query = queryOf(url, audit ? AUDIT_KEYS : EVENT_KEYS);
  return audit ? withNames(config, company, await readCompanyAudit(config.store, company, query)) : readCompanyEvents(config.store, company, query, now);
}
