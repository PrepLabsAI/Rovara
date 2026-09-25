import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TURN_EXPORT_PAGE, TURN_EXPORT_PARTITION, TurnRecordSchema, agentXError, type TurnRecord } from "@agentx/contracts";

export interface TurnRecordStartKey { pk: string; sk: string; exportPk: string; exportSk: string }

export interface TurnRecordSource {
  page(input: { since: string; limit: number; nowSeconds: number; exclusiveStartKey?: TurnRecordStartKey }): Promise<{
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
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: "byTime",
        KeyConditionExpression: "exportPk = :partition AND exportSk >= :since",
        // DynamoDB deletes expired items up to 48 hours late; never return one.
        FilterExpression: "expiresAt > :now",
        ExpressionAttributeValues: { ":partition": TURN_EXPORT_PARTITION, ":since": input.since, ":now": input.nowSeconds },
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

  async page(query: URLSearchParams): Promise<{ turns: TurnRecord[]; cursor?: string; skipped?: number }> {
    const rawSince = query.get("since");
    if (rawSince === null || !validTime(rawSince)) {
      throw agentXError("CONFIG_INVALID", "since must be an ISO 8601 time such as 2026-09-17T00:00:00.000Z");
    }
    const since = new Date(rawSince).toISOString();
    const cursor = query.get("cursor");
    const exclusiveStartKey = cursor === null ? undefined : decodeCursor(cursor, since);
    const nowSeconds = Math.floor((this.options.now ?? Date.now)() / 1000);
    const log = this.options.log ?? ((line: string) => console.log(line));
    let page: Awaited<ReturnType<TurnRecordSource["page"]>>;
    try {
      page = await this.options.source.page({
        since, limit: TURN_EXPORT_PAGE, nowSeconds,
        ...(exclusiveStartKey === undefined ? {} : { exclusiveStartKey }),
      });
    } catch (error) {
      log(JSON.stringify({ component: "broker", event: "turn_record.read_failed", errorName: errorName(error) }));
      throw agentXError("RUNTIME_UNAVAILABLE", "could not read turn records; try again");
    }
    let next: string | undefined;
    if (page.lastEvaluatedKey !== undefined) {
      next = Buffer.from(JSON.stringify(page.lastEvaluatedKey)).toString("base64url");
      // A cursor the next call would refuse strands the caller mid-export; say so now instead.
      if (!acceptableCursor(next, since)) {
        log(JSON.stringify({ component: "broker", event: "turn_record.cursor_unusable" }));
        throw agentXError("RUNTIME_UNAVAILABLE", "could not continue the turn record export; try again");
      }
    }
    // invalidBefore: how many malformed items came before this record, so a page cut short by
    // size reports only the ones it passed; the rest are counted on the page that reaches them.
    const records: { record: TurnRecord; key: TurnRecordStartKey | undefined; invalidBefore: number }[] = [];
    const invalidKeys: string[] = [];
    const invalidFields = new Set<string>();
    let invalid = 0;
    for (const item of page.items) {
      if (typeof item.expiresAt === "number" && item.expiresAt <= nowSeconds) continue;
      const parsed = TurnRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
      if (!parsed.success) {
        invalid += 1;
        if (invalidKeys.length < LOGGED_KEY_LIMIT) invalidKeys.push(typeof item.sk === "string" ? item.sk.slice(0, 160) : "unknown");
        // Top-level field names only: issue messages and nested paths can quote stored values.
        for (const issue of parsed.error.issues) {
          if (invalidFields.size >= LOGGED_KEY_LIMIT) break;
          const field = issue.path[0];
          invalidFields.add(typeof field === "string" && TurnRecordSchema.shape[field as keyof typeof TurnRecordSchema.shape] !== undefined ? field : "(root)");
        }
        continue;
      }
      records.push({ record: parsed.data, key: startKey(Object.fromEntries(KEY_NAMES.map((name) => [name, item[name]]))), invalidBefore: invalid });
    }
    if (invalid > 0) {
      log(JSON.stringify({ component: "broker", event: "turn_record.invalid", count: invalid, keys: invalidKeys, fields: [...invalidFields] }));
    }
    // One lookup per distinct workspace on the page, all at once.
    const workspaceIds = [...new Set(records.flatMap(({ record }) => record.workspaceId === undefined ? [] : [record.workspaceId]))];
    const projects = new Map(await Promise.all(workspaceIds.map(async (workspaceId) => [
      workspaceId,
      await this.options.projectOf(workspaceId).catch((error: unknown) => {
        log(JSON.stringify({ component: "broker", event: "turn_record.project_unavailable", workspaceId, errorName: errorName(error) }));
        return undefined;
      }),
    ] as const)));
    const turns: TurnRecord[] = [];
    let skipped = invalid;
    let bytes = PAGE_ENVELOPE_BYTES;
    for (const [index, { record, key }] of records.entries()) {
      const project = record.workspaceId === undefined ? undefined : projects.get(record.workspaceId);
      const turn = project === undefined ? record : { ...record, project };
      bytes += Buffer.byteLength(JSON.stringify(turn)) + 1;
      // Always carry at least one record, so a page can never come back empty and stuck.
      if (bytes > TURN_EXPORT_PAGE_BYTES && turns.length > 0) {
        // Resume after the last record this page carries; the records left out come next time.
        const last = records[index - 1]?.key;
        next = last === undefined ? undefined : Buffer.from(JSON.stringify(last)).toString("base64url");
        if (next === undefined || !acceptableCursor(next, since)) {
          log(JSON.stringify({ component: "broker", event: "turn_record.cursor_unusable" }));
          throw agentXError("RUNTIME_UNAVAILABLE", "could not continue the turn record export; try again");
        }
        skipped = records[index]?.invalidBefore ?? invalid;
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
function decodeCursor(cursor: string, since: string): TurnRecordStartKey {
  const key = parseCursor(cursor, since);
  if (key === undefined) throw agentXError("CONFIG_INVALID", CURSOR_INVALID);
  return key;
}

function acceptableCursor(cursor: string, since: string): boolean {
  return parseCursor(cursor, since) !== undefined;
}

function parseCursor(cursor: string, since: string): TurnRecordStartKey | undefined {
  if (cursor.length === 0 || cursor.length > CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const key = startKey(value);
  if (key === undefined) return undefined;
  // The shape turnRecordKeys writes: THREAD#<subject>, TURN#<exportSk>, TURNS, <time>#<eventId>.
  if (key.exportPk !== TURN_EXPORT_PARTITION) return undefined;
  if (!key.pk.startsWith("THREAD#") || key.sk !== `TURN#${key.exportSk}`) return undefined;
  if ([key.pk, key.sk, key.exportSk].some((part) => part.length > KEY_PART_LIMIT)) return undefined;
  // The same string comparison the key condition uses.
  if (key.exportSk < since) return undefined;
  return key;
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
