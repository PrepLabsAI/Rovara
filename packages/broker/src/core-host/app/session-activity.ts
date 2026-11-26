// #1548: `GET /v1/app/sessions/<id>/activity?after=<cursor>&limit=<n>`, what `rovara session watch` and the web app poll to show a running task's agent at work.
// The worker saves each event of a step as it happens (services/callbacks.ts `recordEvents`): one row per event, in the task's workspace partition, `EVENT#<operation>#<sequence>`, kept 14 days.
// This reads them back for the task's steps in the order they started, after the cursor, and answers the page contracts' session-activity.ts defines. Who may read is the session route's
// check (anyone who can see the task); the task and its workspace are the session's own, never the request's.
// The worker redacted each event before it sent it. Usage and result events are bookkeeping (usage carries money) and are never answered, though the cursor moves past them.
import {
  SESSION_ACTIVITY_OPERATIONS_MAX, SESSION_ACTIVITY_PAGE_MAX, SessionActivityEventSchema, SessionActivityOperationSchema, agentXError,
  type DocumentStore, type SessionActivityEvent, type SessionActivityOperation, type SessionActivityPage, type StoredDocument,
} from "@agentx/contracts";
import { OPERATION_SK_PREFIX, operationEventPrefix } from "../../core/task-flow/keys.js";
import { locateWorkspace } from "../../core/task-flow/workspace-location.js";

/** The most bytes of events one page carries (an event is at most 64 KB; an answer must stay well under the 6 MB a Lambda may return). A page always carries at least one event when there is one. */
export const SESSION_ACTIVITY_PAGE_MAX_BYTES = 1_000_000;
const DEFAULT_LIMIT = 100;
const HIDDEN_TYPES: ReadonlySet<string> = new Set(["usage", "result"]);
/** The most pages of operation rows read for one task: far more than any task has, so the read always ends. */
const OPERATION_PAGES_MAX = 10;

type Store = Pick<DocumentStore, "get" | "query">;
interface Position { operationId: string; sequence: number }

export function encodeActivityCursor(position: Position): string {
  return Buffer.from(JSON.stringify([position.operationId, position.sequence]), "utf8").toString("base64url");
}

/** The position a cursor names; none for no cursor. A cursor this route did not make is refused. */
export function decodeActivityCursor(value: string | null): Position | undefined {
  if (value === null || value === "") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { parsed = undefined; }
  const [operationId, sequence] = Array.isArray(parsed) ? (parsed as unknown[]) : [];
  if (typeof operationId !== "string" || operationId === "" || operationId.length > 128 || !Number.isInteger(sequence) || (sequence as number) < 0) {
    throw agentXError("CONFIG_INVALID", "the activity cursor is not valid");
  }
  return { operationId, sequence: sequence as number };
}

function limitOf(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_ACTIVITY_PAGE_MAX) throw agentXError("CONFIG_INVALID", `limit must be from 1 through ${SESSION_ACTIVITY_PAGE_MAX}`);
  return limit;
}

function operationOf(row: StoredDocument): SessionActivityOperation[] {
  if (row["entityType"] !== "OPERATION") return [];
  const step = row["programStepId"];
  const parsed = SessionActivityOperationSchema.safeParse({ operationId: row["id"], kind: row["kind"], ...(typeof step === "string" && step !== "" ? { step } : {}), status: row["status"], createdAt: row["createdAt"] });
  return parsed.success ? [parsed.data] : [];
}

/** The task's steps, in the order they started. */
async function operationsOf(store: Store, pk: string): Promise<SessionActivityOperation[]> {
  const operations: SessionActivityOperation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < OPERATION_PAGES_MAX; page += 1) {
    const read = await store.query({ pk, sk: { op: "beginsWith", prefix: OPERATION_SK_PREFIX }, ...(cursor === undefined ? {} : { cursor }) });
    operations.push(...read.items.flatMap(operationOf));
    cursor = read.cursor;
    if (cursor === undefined) break;
  }
  operations.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
  return operations.slice(0, SESSION_ACTIVITY_OPERATIONS_MAX);
}

const sequenceKey = (operationId: string, sequence: number): string => `${operationEventPrefix(operationId)}${String(sequence).padStart(10, "0")}`;

function eventOf(row: StoredDocument, operationId: string): SessionActivityEvent | undefined {
  const parsed = SessionActivityEventSchema.safeParse({ operationId, sequence: row["sequence"], type: row["type"], timestamp: row["timestamp"], payload: row["payload"] });
  return parsed.success ? parsed.data : undefined;
}

interface Page { events: SessionActivityEvent[]; bytes: number; limit: number; position: Position | undefined; full: boolean }

/** Takes one saved row onto the page, or marks the page full. The position moves past a row that is not answered (bookkeeping, or one that does not parse). */
function take(page: Page, row: StoredDocument, operationId: string): void {
  const sequence = row["sequence"];
  if (typeof sequence !== "number") return;
  const event = typeof row["type"] !== "string" || HIDDEN_TYPES.has(row["type"]) ? undefined : eventOf(row, operationId);
  if (event !== undefined) {
    const bytes = JSON.stringify(event).length;
    if (page.events.length > 0 && page.bytes + bytes > SESSION_ACTIVITY_PAGE_MAX_BYTES) { page.full = true; return; }
    page.events.push(event);
    page.bytes += bytes;
  }
  page.position = { operationId, sequence };
  if (page.events.length >= page.limit) page.full = true;
}

/** One step's events after `from`, onto the page until it is full. */
async function readOperation(store: Store, pk: string, operationId: string, from: number, page: Page): Promise<void> {
  let cursor: string | undefined;
  do {
    const read = await store.query({ pk, sk: { op: "between", low: sequenceKey(operationId, from + 1), high: `${operationEventPrefix(operationId)}￿` }, limit: page.limit - page.events.length, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of read.items) {
      take(page, row, operationId);
      if (page.full) return;
    }
    cursor = read.cursor;
  } while (cursor !== undefined);
}

export interface SessionActivityRead {
  workspaceId: string;
  /** Whether the session has ended: then no more is coming. */
  ended: boolean;
  after: string | null;
  limit: string | null;
}

/** The page of the task's activity after the cursor. A task with no workspace yet, or a cursor past the end, answers an empty page with the same cursor. */
export async function readSessionActivity(deps: { store: Store; companyId: string }, input: SessionActivityRead): Promise<SessionActivityPage> {
  const after = decodeActivityCursor(input.after);
  const limit = limitOf(input.limit);
  const pk = (await locateWorkspace(deps, input.workspaceId))?.workspaceKey.pk;
  const operations = pk === undefined ? [] : await operationsOf(deps.store, pk);
  const start = after === undefined ? 0 : operations.findIndex((operation) => operation.operationId === after.operationId);
  if (start < 0) throw agentXError("CONFIG_INVALID", "the activity cursor is not valid");
  if (pk === undefined) return { operations, events: [], active: !input.ended };
  const page: Page = { events: [], bytes: 0, limit, position: after, full: false };
  for (const operation of operations.slice(start)) {
    await readOperation(deps.store, pk, operation.operationId, page.position?.operationId === operation.operationId ? page.position.sequence : 0, page);
    if (page.full) break;
  }
  return { operations, events: page.events, ...(page.position === undefined ? {} : { cursor: encodeActivityCursor(page.position) }), active: !input.ended };
}
