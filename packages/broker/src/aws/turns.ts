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
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const STORAGE_KEYS = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt"]);
const KEY_NAMES = ["exportPk", "exportSk", "pk", "sk"];
/** Far above any real key (a thread subject is at most 128 characters), far below abuse. */
const CURSOR_LIMIT = 1_024;
const KEY_PART_LIMIT = 256;
/** How many malformed keys and field names one log line lists; the count is always exact. */
const LOGGED_KEY_LIMIT = 10;
const CURSOR_INVALID = "cursor is invalid; start the export again without it";

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

  async page(query: URLSearchParams): Promise<{ turns: TurnRecord[]; cursor?: string }> {
    const rawSince = query.get("since");
    if (rawSince === null || !ISO_TIME.test(rawSince) || Number.isNaN(Date.parse(rawSince))) {
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
    const projects = new Map<string, Promise<string | undefined>>();
    const turns: TurnRecord[] = [];
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
      const workspaceId = parsed.data.workspaceId;
      let project: string | undefined;
      if (workspaceId !== undefined) {
        if (!projects.has(workspaceId)) {
          projects.set(workspaceId, this.options.projectOf(workspaceId).catch((error: unknown) => {
            log(JSON.stringify({ component: "broker", event: "turn_record.project_unavailable", workspaceId, errorName: errorName(error) }));
            return undefined;
          }));
        }
        project = await projects.get(workspaceId);
      }
      turns.push(project === undefined ? parsed.data : { ...parsed.data, project });
    }
    if (invalid > 0) {
      log(JSON.stringify({ component: "broker", event: "turn_record.invalid", count: invalid, keys: invalidKeys, fields: [...invalidFields] }));
    }
    return { turns, ...(next === undefined ? {} : { cursor: next }) };
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 128) : "unknown";
}
