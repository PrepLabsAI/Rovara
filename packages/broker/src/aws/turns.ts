import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_LIST_MAX, ADMIN_TURN_FILTER_PAGES, AgentXNameSchema, AiToolTurnRecordSchema, TURN_EXPORT_PAGE, TURN_EXPORT_PARTITION, TurnRecordSchema,
  agentXError, parseSlackThreadSubject, type ExportedTurnRecord,
} from "@agentx/contracts";

export interface TurnRecordStartKey { pk: string; sk: string; exportPk: string; exportSk: string }

/** Spec 025 A8: the filters an admin read may ask for. */
export interface TurnFilter { origin?: "slack" | "ai_tool"; thread?: string; task?: string }

export interface TurnRecordSource {
  page(input: { since: string; until?: string; limit: number; nowSeconds: number; exclusiveStartKey?: TurnRecordStartKey; filter?: TurnFilter }): Promise<{
    items: Record<string, unknown>[];
    lastEvaluatedKey?: TurnRecordStartKey;
  }>;
}

type Client = Pick<DynamoDBDocumentClient, "send">;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const STORAGE_KEYS = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt"]);
const KEY_NAMES = ["exportPk", "exportSk", "pk", "sk"];
/** Far above any real key (a thread subject is at most 128 characters), far below abuse. */
const CURSOR_LIMIT = 1_024;
const KEY_PART_LIMIT = 256;
/** How many malformed keys and field names one log line lists; the count is always exact. */
const LOGGED_KEY_LIMIT = 10;
const CURSOR_INVALID = "cursor is invalid; start the export again without it";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The most JSON one export page carries. Lambda refuses a synchronous response over 6 MB, so a
 * page of 100 large records would fail every time; stop well short and hand out a cursor.
 */
export const TURN_EXPORT_PAGE_BYTES = 4_000_000;
/** Room for the response envelope around the turns: braces, the cursor and the request id. */
const PAGE_ENVELOPE_BYTES = 4_096;

export function dynamoTurnRecordSource(client: Client, tableName: string): TurnRecordSource {
  return {
    async page(input) {
      const filters = ["expiresAt > :now"];
      const values: Record<string, unknown> = { ":partition": TURN_EXPORT_PARTITION, ":since": input.since, ":now": input.nowSeconds };
      if (input.until !== undefined) values[":until"] = `${input.until}\uffff`;
      if (input.filter?.origin !== undefined) {
        // A Slack record written before spec 025 has no origin at all.
        filters.push(input.filter.origin === "slack" ? "(attribute_not_exists(origin) OR origin = :origin)" : "origin = :origin");
        values[":origin"] = input.filter.origin;
      }
      if (input.filter?.thread !== undefined) { filters.push("subject = :subject"); values[":subject"] = input.filter.thread; }
      // FR-037 and 25c's C13: AI-tool records and teammates' channel turns both carry taskId.
      if (input.filter?.task !== undefined) { filters.push("taskId = :task"); values[":task"] = input.filter.task; }
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: "byTime",
        KeyConditionExpression: input.until === undefined ? "exportPk = :partition AND exportSk >= :since" : "exportPk = :partition AND exportSk BETWEEN :since AND :until",
        // DynamoDB deletes expired items up to 48 hours late; never return one.
        FilterExpression: filters.join(" AND "),
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: input.limit,
        ...(input.exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: input.exclusiveStartKey }),
      }));
      if (response.LastEvaluatedKey === undefined) return { items: (response.Items ?? []) as Record<string, unknown>[] };
      const next = startKey(response.LastEvaluatedKey);
      // Dropping an unrecognised key would end the export early without a word; fail instead.
      if (next === undefined) throw new Error("byTime query returned an unrecognised LastEvaluatedKey");
      return { items: (response.Items ?? []) as Record<string, unknown>[], lastEvaluatedKey: next };
    },
  };
}

export function workspaceProjectReader(client: Client, stateTableName: string): (workspaceId: string) => Promise<string | undefined> {
  return async (workspaceId) => {
    const response = await client.send(new GetCommand({ TableName: stateTableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" } }));
    const projectName = (response.Item as { projectName?: unknown } | undefined)?.projectName;
    return typeof projectName === "string" ? projectName : undefined;
  };
}

/**
 * Pages turn records for `agentx admin turns export`, newest first; read-only. Records hold
 * redacted request and response text, so log lines carry keys, counts and error classes only.
 */
export class TurnRecordExport {
  constructor(private readonly options: {
    source: TurnRecordSource;
    projectOf: (workspaceId: string) => Promise<string | undefined>;
    now?: () => number;
    log?: (line: string) => void;
  }) {}

  async page(query: URLSearchParams): Promise<{ turns: ExportedTurnRecord[]; cursor?: string; skipped?: number }> {
    const rawSince = query.get("since");
    if (rawSince === null || !validTime(rawSince)) {
      throw agentXError("CONFIG_INVALID", "since must be an ISO 8601 time such as 2026-09-17T00:00:00.000Z");
    }
    const since = new Date(rawSince).toISOString();
    // Spec 025 A8: the admin filters. The CLI's export sends none of them and reads as before.
    const untilText = query.get("until");
    if (untilText !== null && !validTime(untilText)) throw agentXError("CONFIG_INVALID", "until must be an ISO 8601 time such as 2026-09-30T00:00:00.000Z");
    const until = untilText === null ? undefined : new Date(untilText).toISOString();
    if (until !== undefined && until < since) throw agentXError("CONFIG_INVALID", "until must not be before since; send an until at or after since");
    const filter = turnFilter(query);
    const wantedProject = query.get("project");
    if (wantedProject !== null && !AgentXNameSchema.safeParse(wantedProject).success) throw agentXError("CONFIG_INVALID", "project must be an AgentX project name such as payments; list them with agentx_admin_list_projects");
    const limitText = query.get("limit");
    if (limitText !== null && (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > ADMIN_LIST_MAX)) {
      throw agentXError("CONFIG_INVALID", `limit must be a whole number from 1 to ${ADMIN_LIST_MAX}`);
    }
    const limit = limitText === null ? TURN_EXPORT_PAGE : Number(limitText);
    const filtered = filter !== undefined || wantedProject !== null;
    const cursor = query.get("cursor");
    const exclusiveStartKey = cursor === null ? undefined : decodeCursor(cursor, since, until);
    const nowSeconds = Math.floor((this.options.now ?? Date.now)() / 1000);
    const log = this.options.log ?? ((line: string) => console.log(line));
    // invalidBefore: how many malformed items came before this record, so a page cut short by
    // size reports only the ones it passed; the rest are counted on the page that reaches them.
    const records: { record: ExportedTurnRecord; key: TurnRecordStartKey | undefined; invalidBefore: number }[] = [];
    const invalidKeys: string[] = [];
    const invalidFields = new Set<string>();
    let invalid = 0;
    // One lookup per distinct workspace, all of a batch at once, cached across pages.
    const projects = new Map<string, string | undefined>();
    let lookupFailed = false;
    const lookUp = async (batch: typeof records) => {
      const workspaceIds = [...new Set(batch.flatMap(({ record }) => record.workspaceId === undefined ? [] : [record.workspaceId]))]
        .filter((workspaceId) => !projects.has(workspaceId));
      const found = await Promise.all(workspaceIds.map(async (workspaceId) => [
        workspaceId,
        await this.options.projectOf(workspaceId).catch((error: unknown) => {
          lookupFailed = true;
          log(JSON.stringify({ component: "broker", event: "turn_record.project_unavailable", workspaceId, errorName: errorName(error) }));
          return undefined;
        }),
      ] as const));
      for (const [workspaceId, project] of found) projects.set(workspaceId, project);
      // Spec 025 R12: a project filter never drops a record whose project it could not learn.
      if (wantedProject !== null && lookupFailed) throw agentXError("RUNTIME_UNAVAILABLE", "could not look up the projects of some turn records; try again");
    };
    const projectOf = ({ record }: { record: ExportedTurnRecord }) => record.workspaceId === undefined ? undefined : projects.get(record.workspaceId);
    // A record with no workspace has no project, so a project filter drops it too.
    const matches = (entry: (typeof records)[number]) => wantedProject === null || projectOf(entry) === wantedProject;
    // Without a filter this reads once, exactly as before; with one it reads on until limit records
    // pass every filter, at most ADMIN_TURN_FILTER_PAGES index pages per call, then hands out a cursor.
    let lastEvaluatedKey: TurnRecordStartKey | undefined = exclusiveStartKey;
    let reads = 0;
    let matched = 0;
    do {
      let page: Awaited<ReturnType<TurnRecordSource["page"]>>;
      try {
        page = await this.options.source.page({
          since, ...(until === undefined ? {} : { until }), limit, nowSeconds,
          ...(lastEvaluatedKey === undefined ? {} : { exclusiveStartKey: lastEvaluatedKey }),
          ...(filter === undefined ? {} : { filter }),
        });
      } catch (error) {
        log(JSON.stringify({ component: "broker", event: "turn_record.read_failed", errorName: errorName(error) }));
        throw agentXError("RUNTIME_UNAVAILABLE", "could not read turn records; try again");
      }
      lastEvaluatedKey = page.lastEvaluatedKey;
      reads += 1;
      const pageRecords: typeof records = [];
      for (const item of page.items) {
        if (typeof item.expiresAt === "number" && item.expiresAt <= nowSeconds) continue;
        const schema = item.origin === "ai_tool" ? AiToolTurnRecordSchema : TurnRecordSchema;
        const parsed = schema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
        if (!parsed.success) {
          invalid += 1;
          if (invalidKeys.length < LOGGED_KEY_LIMIT) invalidKeys.push(typeof item.sk === "string" ? item.sk.slice(0, 160) : "unknown");
          // Top-level field names only: issue messages and nested paths can quote stored values.
          for (const issue of parsed.error.issues) {
            if (invalidFields.size >= LOGGED_KEY_LIMIT) break;
            const field = issue.path[0];
            invalidFields.add(typeof field === "string" && Object.hasOwn(schema.shape, field) ? field : "(root)");
          }
          continue;
        }
        pageRecords.push({ record: parsed.data, key: startKey(Object.fromEntries(KEY_NAMES.map((name) => [name, item[name]]))), invalidBefore: invalid });
      }
      records.push(...pageRecords);
      // Spec 025 R11: a project filter is matched page by page, so a page of other projects reads on.
      if (wantedProject !== null) await lookUp(pageRecords);
      matched += pageRecords.filter(matches).length;
    } while (filtered && lastEvaluatedKey !== undefined && matched < limit && reads < ADMIN_TURN_FILTER_PAGES);
    let next: string | undefined;
    if (lastEvaluatedKey !== undefined) {
      next = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64url");
      // A cursor the next call would refuse strands the caller mid-export; say so now instead.
      if (!acceptableCursor(next, since, until)) {
        log(JSON.stringify({ component: "broker", event: "turn_record.cursor_unusable" }));
        throw agentXError("RUNTIME_UNAVAILABLE", "could not continue the turn record export; try again");
      }
    }
    if (invalid > 0) {
      log(JSON.stringify({ component: "broker", event: "turn_record.invalid", count: invalid, keys: invalidKeys, fields: [...invalidFields] }));
    }
    // Without a project filter, the lookup happens once for the whole page, as before.
    if (wantedProject === null) await lookUp(records);
    let kept = wantedProject === null ? records : records.filter(matches);
    let skipped = invalid;
    if (kept.length > limit) {
      // Several filtered pages can carry more than limit; resume after the last record kept.
      const last = kept[limit - 1]?.key;
      next = last === undefined ? undefined : Buffer.from(JSON.stringify(last)).toString("base64url");
      if (next === undefined || !acceptableCursor(next, since, until)) {
        log(JSON.stringify({ component: "broker", event: "turn_record.cursor_unusable" }));
        throw agentXError("RUNTIME_UNAVAILABLE", "could not continue the turn record export; try again");
      }
      skipped = kept[limit]?.invalidBefore ?? invalid;
      kept = kept.slice(0, limit);
    }
    const turns: ExportedTurnRecord[] = [];
    let bytes = PAGE_ENVELOPE_BYTES;
    for (const [index, entry] of kept.entries()) {
      const project = projectOf(entry);
      const turn = project === undefined ? entry.record : { ...entry.record, project };
      bytes += Buffer.byteLength(JSON.stringify(turn)) + 1;
      // Always carry at least one record, so a page can never come back empty and stuck.
      if (bytes > TURN_EXPORT_PAGE_BYTES && turns.length > 0) {
        // Resume after the last record this page carries; the records left out come next time.
        const last = kept[index - 1]?.key;
        next = last === undefined ? undefined : Buffer.from(JSON.stringify(last)).toString("base64url");
        if (next === undefined || !acceptableCursor(next, since, until)) {
          log(JSON.stringify({ component: "broker", event: "turn_record.cursor_unusable" }));
          throw agentXError("RUNTIME_UNAVAILABLE", "could not continue the turn record export; try again");
        }
        skipped = kept[index]?.invalidBefore ?? invalid;
        break;
      }
      turns.push(turn);
    }
    return { turns, ...(next === undefined ? {} : { cursor: next }), ...(skipped > 0 ? { skipped } : {}) };
  }
}

/**
 * A cursor is the base64url JSON of the last key DynamoDB evaluated. DynamoDB applies the key
 * condition whatever the start key, but a forged key is refused here so a caller gets a clear
 * CONFIG_INVALID and never a start key outside the export partition or the since window.
 */
function decodeCursor(cursor: string, since: string, until: string | undefined): TurnRecordStartKey {
  const key = parseCursor(cursor, since, until);
  if (key === undefined) throw agentXError("CONFIG_INVALID", CURSOR_INVALID);
  return key;
}

function acceptableCursor(cursor: string, since: string, until: string | undefined): boolean {
  return parseCursor(cursor, since, until) !== undefined;
}

function parseCursor(cursor: string, since: string, until: string | undefined): TurnRecordStartKey | undefined {
  if (cursor.length === 0 || cursor.length > CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const key = startKey(value);
  if (key === undefined) return undefined;
  // The shapes turnRecordKeys and aiToolTurnRecordKeys write.
  if (key.exportPk !== TURN_EXPORT_PARTITION) return undefined;
  if (!(key.pk.startsWith("THREAD#") || key.pk.startsWith("TASK#")) || key.sk !== `TURN#${key.exportSk}`) return undefined;
  if ([key.pk, key.sk, key.exportSk].some((part) => part.length > KEY_PART_LIMIT)) return undefined;
  // The same string comparison the key condition uses.
  if (key.exportSk < since) return undefined;
  // Spec 025 A8: a cursor past until is outside the window the key condition reads.
  if (until !== undefined && key.exportSk > `${until}\uffff`) return undefined;
  return key;
}

/** Spec 025 A8: origin, thread and task, checked; undefined when none was asked for. */
function turnFilter(query: URLSearchParams): TurnFilter | undefined {
  const origin = query.get("origin");
  const thread = query.get("thread");
  const task = query.get("task");
  if (origin !== null && origin !== "slack" && origin !== "ai_tool") throw agentXError("CONFIG_INVALID", "origin must be slack or ai_tool");
  if (thread !== null) {
    try {
      parseSlackThreadSubject(thread);
    } catch {
      throw agentXError("CONFIG_INVALID", "thread must be a thread subject such as T0123456789/C0123456789/1695500000.000100");
    }
  }
  if (task !== null && !UUID.test(task)) throw agentXError("CONFIG_INVALID", "task must be a task ID such as 33333333-3333-4333-8333-333333333333");
  const filter: TurnFilter = { ...(origin === null ? {} : { origin }), ...(thread === null ? {} : { thread }), ...(task === null ? {} : { task }) };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function startKey(value: unknown): TurnRecordStartKey | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length !== KEY_NAMES.length || !entries.every(([name, child]) => KEY_NAMES.includes(name) && typeof child === "string")) return undefined;
  return value as TurnRecordStartKey;
}

/**
 * An ISO 8601 time that names a real instant as written. V8's Date.parse rolls impossible values
 * forward (2026-02-31 becomes March 3, T24:00 the next day), so the written calendar date must
 * exist and the hour must be 00 to 23.
 */
function validTime(value: string): boolean {
  const match = ISO_TIME.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day, hour] = match.slice(1, 5).map(Number) as [number, number, number, number];
  if (hour > 23) return false;
  const written = new Date(Date.UTC(year, month - 1, day));
  return written.getUTCFullYear() === year && written.getUTCMonth() === month - 1 && written.getUTCDate() === day;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 128) : "unknown";
}
