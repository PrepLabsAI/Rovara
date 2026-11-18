// The cost report's task read (lead 4, slice A2): `GET /v1/app/org/report/tasks`. One row per task that STARTED in the range, oldest start first, for a company owner or admin of THAT company (the route
// checks the role; this file checks the company again on every row it reads).
//
// How a row is made: the stored row (`task-row.ts`) gives project, title, origin and start; an unsettled task is folded again from its own record and its `pr_ready` / `merged` milestone rows
// (a settled one is served from the row); the cost is read from the cost ledger's `TOTAL` row for the task (`taskCostFromTotal`); the feature is the task's current assignment, resolved through any
// merge (`resolveFeature`). A row is built field by field and parsed with the contract's strict schema, so nothing else can leave. Cost is whole millionths (never a float); a figure that is not a whole
// number makes the row unreadable (counted, left out) instead of a wrong total. No row names a person.
//
// Bounded: one call looks at most `REPORT_SCAN_MAX` stored rows and returns at most the page limit; the cursor is bound to the company and the filters (`company-read-cursor.ts`).
import {
  AgentXError, OrgIdSchema, REPORT_PAGE_DEFAULT, REPORT_QUERY_REFUSED, REPORT_SCAN_MAX, REPORT_SK, REPORT_TASK_POSITION, ReportTaskRowSchema, ReportTasksQuerySchema, agentXError, taskPagePath, change, reportPartition,
  reportTaskFeatureKey, when,
  type DocumentKey, type DocumentStore, type OrgId, type ReportTaskRow, type ReportTasksResponse, type StoredDocument,
} from "@agentx/contracts";
import { rowBelongsToCompany } from "../company-read-rows.js";
import { decodeCursor, encodeCursor, filterDigest } from "../company-read-cursor.js";
import { costPartition, taskCostFromTotal } from "../cost/ledger.js";
import { loadFeatures, resolveFeature, taskFeatureOf, type FeatureRecord, type TaskFeatureRecord } from "./feature-store.js";
import { foldTask, milestoneFactsOf, settles, storedRowOf, type StoredReportRow, type TaskFacts } from "./task-row.js";
import { readTaskTimes } from "./times.js";

const GET_MANY = 100;
const MILESTONE_ROWS = 50;
/** How many tasks have their milestones read at once. */
const MILESTONE_PARALLEL = 8;

export type ReportReadStore = Pick<DocumentStore, "get" | "getMany" | "query" | "update" | "transact">;
const costKey = (orgId: OrgId, taskId: string): DocumentKey => ({ pk: costPartition(orgId, taskId), sk: "TOTAL" });
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Rovara can't read the report right now. Try again.");

async function getManyAll(store: Pick<DocumentStore, "getMany">, keys: readonly DocumentKey[]): Promise<Map<string, StoredDocument | undefined>> {
  const out = new Map<string, StoredDocument | undefined>();
  const unique = [...new Map(keys.map((key) => [`${key.pk}\u0000${key.sk}`, key])).values()];
  for (let at = 0; at < unique.length; at += GET_MANY) {
    const batch = unique.slice(at, at + GET_MANY);
    const rows = await store.getMany(batch);
    batch.forEach((key, index) => out.set(`${key.pk}\u0000${key.sk}`, rows[index]));
  }
  return out;
}
const pick = (map: ReadonlyMap<string, StoredDocument | undefined>, key: DocumentKey): StoredDocument | undefined => map.get(`${key.pk}\u0000${key.sk}`);

export const taskRecordKey = (taskId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: "META" });

/** One call's counters, never content. */
interface Counters { skipped: number; unreadable: number }

/** The task's `pr_ready` and `merged` milestone rows (what this company wrote). A read that fails is a failed read: no guess. */
async function milestoneRowsOf(store: Pick<DocumentStore, "query">, taskId: string): Promise<StoredDocument[]> {
  const [ready, merged] = await Promise.all(["pr_ready", "merged"].map((kind) => store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: `CODE_MILESTONE#${kind}#` }, limit: MILESTONE_ROWS })));
  return [...(ready?.items ?? []), ...(merged?.items ?? [])];
}

interface Folded { row: StoredReportRow; facts: TaskFacts }

/** Folds every unsettled row from its task record and milestones; a settled row is its own facts. A row whose task is missing is unreadable; one whose task is another company's is skipped. */
async function foldRows(store: ReportReadStore, companyId: OrgId, rows: readonly StoredReportRow[], counters: Counters, now: number): Promise<Folded[]> {
  const unsettled = rows.filter((row) => row.settledAt === undefined);
  const metas = await getManyAll(store, unsettled.map((row) => taskRecordKey(row.taskId)));
  const folded = new Map<string, TaskFacts>();
  const todo: Array<{ row: StoredReportRow; meta: StoredDocument }> = [];
  for (const row of unsettled) {
    const meta = pick(metas, taskRecordKey(row.taskId));
    if (meta === undefined) { counters.unreadable += 1; continue; }
    if (!rowBelongsToCompany(meta, companyId) || meta["taskId"] !== row.taskId) { counters.skipped += 1; continue; }
    todo.push({ row, meta });
  }
  for (let at = 0; at < todo.length; at += MILESTONE_PARALLEL) {
    await Promise.all(todo.slice(at, at + MILESTONE_PARALLEL).map(async ({ row, meta }) => {
      const base = foldTask(meta, milestoneFactsOf(await milestoneRowsOf(store, row.taskId), companyId, row.taskId));
      // Slice A4: the time split and send-backs, from the task's own work events (absent when they do not cover it from its start).
      const events = await readTaskTimes(store, { taskId: row.taskId, project: row.project, orgId: companyId }, row.startedAt, base.endedAt, now);
      counters.skipped += events.skipped;
      const facts: TaskFacts = events.times === undefined ? base : { ...base, times: events.times };
      folded.set(row.taskId, facts);
      await settleRow(store, row, facts, now);
    }));
  }
  const out: Folded[] = [];
  for (const row of rows) {
    if (row.settledAt !== undefined) out.push({ row, facts: { state: row.state, ...(row.path === undefined ? {} : { path: row.path }), ...(row.firstPrAt === undefined ? {} : { firstPrAt: row.firstPrAt }), ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }), prsOpened: row.prsOpened, prsMerged: row.prsMerged, prLinks: row.prLinks, ...(row.times === undefined ? {} : { times: row.times }) } });
    else if (folded.has(row.taskId)) out.push({ row, facts: folded.get(row.taskId)! });
  }
  return out;
}

/** Writes what a fold found back into the row (and settles it when the task is final). Best effort: a write that fails or loses a race changes nothing the reader sees. */
async function settleRow(store: Pick<DocumentStore, "update">, row: StoredReportRow, facts: TaskFacts, now: number): Promise<void> {
  const settled = settles(facts, now);
  const same = row.state === facts.state && row.path === facts.path && row.firstPrAt === facts.firstPrAt && row.endedAt === facts.endedAt && row.prsOpened === facts.prsOpened && row.prsMerged === facts.prsMerged
    && row.prLinks.length === facts.prLinks.length && row.prLinks.every((link, index) => link === facts.prLinks[index]);
  if (same && !settled) return;
  const optional = (name: string, value: string | undefined) => (value === undefined ? change.remove(name) : change.set(name, value));
  try {
    await store.update({
      key: row.key,
      ops: [
        change.set("state", facts.state), optional("path", facts.path), optional("firstPrAt", facts.firstPrAt), optional("endedAt", facts.endedAt), change.set("prsOpened", facts.prsOpened), change.set("prsMerged", facts.prsMerged),
        change.set("prLinks", facts.prLinks), ...(settled && facts.times !== undefined ? [change.set("times", { ...facts.times })] : []), ...(settled ? [change.set("settledAt", new Date(now).toISOString())] : []), change.set("version", row.version + 1),
      ],
      condition: when.and(when.present(), when.eq("version", row.version), when.notExists("settledAt")),
    });
  } catch { /* the fold is the answer; the next read writes it */ }
}

/** The whole numbers of a ledger total, or undefined when a figure is not one (the row is then unreadable, never a wrong total). */
function costOf(total: StoredDocument | undefined, taskId: string): { micros: number; currency?: string; unpriced: number } | undefined {
  if (total === undefined) return { micros: 0, unpriced: 0 };
  for (const name of ["micros", "entries", "unpricedEntries"]) {
    const value = total[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return undefined;
  }
  if (total["currency"] !== undefined && (typeof total["currency"] !== "string" || total["currency"] === "")) return undefined;
  const cost = taskCostFromTotal(taskId, total);
  return { micros: cost.micros, ...(cost.currency === undefined ? {} : { currency: cost.currency }), unpriced: cost.unpricedEntries };
}

function featureOfAssignment(assignment: TaskFeatureRecord | undefined, features: ReadonlyMap<string, FeatureRecord>): { id: string; source: TaskFeatureRecord["source"] } | undefined {
  if (assignment === undefined || assignment.featureId === null) return undefined;
  const resolved = resolveFeature(features, assignment.featureId);
  return resolved === undefined ? undefined : { id: resolved.id, source: assignment.source };
}

/** One page of the company's task rows. `query` is checked here (an unknown field, a wrong type or an out-of-range value is a refusal with fixed words). `now` is epoch milliseconds. */
export async function readCompanyReportTasks(store: ReportReadStore, companyId: string, query: unknown, now: number = Date.now()): Promise<ReportTasksResponse> {
  const company = OrgIdSchema.safeParse(companyId);
  if (!company.success) throw agentXError("CONFIG_INVALID", "the company is not valid");
  const orgId = company.data;
  const parsed = ReportTasksQuerySchema.safeParse(query);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", REPORT_QUERY_REFUSED);
  const filters = parsed.data;
  if ((filters.cursor === undefined) === (filters.from === undefined)) throw agentXError("CONFIG_INVALID", REPORT_QUERY_REFUSED);
  const limit = filters.limit ?? REPORT_PAGE_DEFAULT;
  const to = filters.to ?? new Date(now).toISOString();
  const digest = filterDigest({ project: filters.project, origin: filters.origin, state: filters.state, path: filters.path, to: filters.to });
  const startPosition = filters.cursor === undefined ? undefined : decodeCursor("p", filters.cursor, orgId, digest, (position) => REPORT_TASK_POSITION.test(position));
  const startAt = startPosition === undefined ? filters.from! : startPosition.slice(0, startPosition.indexOf("#"));
  if (Date.parse(startAt) > Date.parse(to)) {
    // Nothing yet between the position and `to`: the same position again.
    if (filters.cursor === undefined) throw agentXError("CONFIG_INVALID", REPORT_QUERY_REFUSED);
    return { tasks: [], next: encodeCursor("p", orgId, digest, startPosition!), hasMore: false, skipped: 0, unreadable: 0 };
  }

  const counters: Counters = { skipped: 0, unreadable: 0 };
  // The task rows are one contiguous run of the partition's sort keys (`TASK#<start>#<id>`); the read is bounded on both sides by the range, so it never reaches the other row families (`TASKFEAT#...`).
  const sk = { op: "between" as const, low: `${REPORT_SK.task}${startPosition ?? filters.from!}`, high: `${REPORT_SK.task}${to}#\uffff` };
  const pageSize = Math.max(1, Math.min(100, limit));
  const readsMax = Math.ceil(REPORT_SCAN_MAX / pageSize) + 5;
  const tasks: Array<{ row: ReportTaskRow; position: string }> = [];
  let featureMap: Map<string, FeatureRecord> | undefined;
  // The position a cursor made from nothing read points at: before every real row from `from` on (a cursor must always be one `decodeCursor` accepts).
  let last = startPosition ?? `${filters.from!}#00000000-0000-0000-0000-000000000000`;
  let hasMore = false;
  let scanned = 0;
  let storeCursor: string | undefined;

  scan: for (let reads = 0; ; reads += 1) {
    if (reads >= readsMax) { hasMore = true; break; }
    let page;
    try {
      page = await store.query({ pk: reportPartition(orgId), sk, limit: pageSize, ...(storeCursor === undefined ? {} : { cursor: storeCursor }) });
    } catch { throw unavailable(); }
    storeCursor = page.cursor;
    const candidates: Array<{ stored: StoredReportRow; position: string }> = [];
    let ended = false;
    let pageLast = last;
    for (const raw of page.items) {
      const position = raw.sk.slice(REPORT_SK.task.length);
      // The position the cursor names was the last row of the page before: it is not read again.
      if (position === startPosition) continue;
      if (scanned >= REPORT_SCAN_MAX) { hasMore = true; ended = true; break; }
      scanned += 1;
      // A key a cursor could not carry is counted as unreadable and is never a position to resume from.
      if (!REPORT_TASK_POSITION.test(position)) { counters.unreadable += 1; continue; }
      // Time order: the first row that started after `to` ends the read for good.
      if (Date.parse(position.slice(0, position.indexOf("#"))) > Date.parse(to)) { ended = true; break; }
      pageLast = position;
      if (!rowBelongsToCompany(raw, orgId)) { counters.skipped += 1; continue; }
      const stored = storedRowOf(raw, orgId);
      if (stored === undefined) { counters.unreadable += 1; continue; }
      if (filters.project !== undefined && stored.project !== filters.project) continue;
      if (filters.origin !== undefined && stored.origin !== filters.origin) continue;
      candidates.push({ stored, position });
    }
    if (candidates.length > 0) {
      let folded: Folded[];
      let costs: Map<string, StoredDocument | undefined>;
      let assignments: Map<string, StoredDocument | undefined>;
      try {
        folded = await foldRows(store, orgId, candidates.map(({ stored }) => stored), counters, now);
        costs = await getManyAll(store, folded.map(({ row }) => costKey(orgId, row.taskId)));
        assignments = await getManyAll(store, folded.map(({ row }) => reportTaskFeatureKey(orgId, row.taskId)));
        featureMap ??= await loadFeatures(store, orgId);
      } catch (error) {
        if (error instanceof AgentXError) throw error;
        throw unavailable();
      }
      const positionOf = new Map(candidates.map(({ stored, position }) => [stored.taskId, position]));
      for (const { row, facts } of folded) {
        if (filters.state !== undefined && facts.state !== filters.state) continue;
        if (filters.path !== undefined && facts.path !== filters.path) continue;
        const total = pick(costs, costKey(orgId, row.taskId));
        if (total !== undefined && !rowBelongsToCompany(total, orgId)) { counters.skipped += 1; continue; }
        const cost = costOf(total, row.taskId);
        if (cost === undefined) { counters.unreadable += 1; continue; }
        const feature = featureOfAssignment(taskFeatureOf(pick(assignments, reportTaskFeatureKey(orgId, row.taskId)), orgId), featureMap);
        const built = ReportTaskRowSchema.safeParse({
          taskId: row.taskId, project: row.project, title: row.title, taskPage: taskPagePath(row.taskId), origin: row.origin, ...(facts.path === undefined ? {} : { path: facts.path }), state: facts.state,
          ...(feature === undefined ? {} : { feature }), startedAt: row.startedAt, ...(facts.firstPrAt === undefined ? {} : { firstPrAt: facts.firstPrAt }), ...(facts.endedAt === undefined ? {} : { endedAt: facts.endedAt }),
          prsOpened: facts.prsOpened, prsMerged: facts.prsMerged, prLinks: facts.prLinks, costMicros: cost.micros, ...(cost.currency === undefined ? {} : { currency: cost.currency }), unpricedCalls: cost.unpriced,
          // Slice A4: all six numbers or none (absent is "not known", never zero), and `timesComplete` only with them.
          ...(facts.times === undefined ? {} : {
            workingMs: facts.times.workingMs, waitingPeopleMs: { decisionsMs: facts.times.decisionsMs, prReviewMs: facts.times.prReviewMs }, waitingSystemMs: facts.times.waitingSystemMs,
            sendBacksRovara: facts.times.sendBacksRovara, sendBacksPeople: facts.times.sendBacksPeople, timesComplete: true,
          }),
        });
        if (!built.success) { counters.unreadable += 1; continue; }
        tasks.push({ row: built.data, position: positionOf.get(row.taskId)! });
      }
    }
    last = pageLast;
    if (tasks.length >= limit) {
      // More than a page's worth may have been folded: keep the first `limit` and resume right after the last one kept.
      const kept = tasks.slice(0, limit);
      const overshoot = tasks.length > limit;
      tasks.length = 0;
      tasks.push(...kept);
      if (overshoot) last = kept[kept.length - 1]!.position;
      hasMore = overshoot || storeCursor !== undefined || hasMore;
      break scan;
    }
    if (ended) break scan;
    if (storeCursor === undefined) break scan;
  }
  return { tasks: tasks.map(({ row }) => row), next: encodeCursor("p", orgId, digest, last), hasMore, skipped: counters.skipped, unreadable: counters.unreadable };
}
