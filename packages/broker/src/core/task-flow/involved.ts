// Web task channel (C5): the "involved" index and the read side of "tasks I'm involved in".
//
// A person who was ADDED to someone else's task (a co-owner, a commenter, a viewer) must find it. When People adds a person it writes one involved row for them (`writeInvolvedRow`, called by
// the add path of C4, not wired here) and deletes it when the person is denied or removed (`deleteInvolvedRow`). The row is only a pointer: it carries ids and the task's creation time, never a
// title, a project or a status, so a stale row cannot show anything.
//
// The read (`GET /v1/dev/tasks?involved=1`) trusts nothing the row says. For every row it reads the live task and asks the live task access (the rule the core's own task read uses for this caller,
// People roles included) whether this caller may see it now; a person who lost access, was denied, or whose row is stale sees nothing of that task and the row is skipped, never shown. The company comes
// from the flow's own company (live membership upstream), never from a row, and a row that names another company's task, or another person, is skipped.
import { IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError, companyScoped, type DeveloperTaskListItem, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { DeveloperTaskStatusSchema } from "@agentx/contracts";
import { taskIndexKey } from "../../developer/task-records.js";
import { developerTaskListItem } from "../../local/app/task-view.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { readTask } from "./reads.js";

export const INVOLVED_ENTITY = "TASK_INVOLVED";
const ROW_SK_PREFIX = "TASK#";

const PERSON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const ROW_SK = /^TASK#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/** What a row needs: the company, the person it is for, the task, and the task's creation time (it orders the list, newest first, and must match the live task). */
export interface InvolvedRowInput {
  companyId: string;
  personId: string;
  taskId: string;
  createdAt: string;
}

const invalidRow = () => agentXError("CONFIG_INVALID", "the involved task row is not valid");

function checked(input: InvolvedRowInput): InvolvedRowInput {
  if (input === null || typeof input !== "object" || !OrgIdSchema.safeParse(input.companyId).success || typeof input.personId !== "string" || !PERSON_ID.test(input.personId)
    || typeof input.taskId !== "string" || !TASK_ID.test(input.taskId) || typeof input.createdAt !== "string" || !ISO_INSTANT.test(input.createdAt)) throw invalidRow();
  return input;
}

/** One company's involved rows of one person. Company-scoped: the same person in two companies has two partitions. */
export function involvedPartition(companyId: string, personId: string): string {
  if (!OrgIdSchema.safeParse(companyId).success || typeof personId !== "string" || !PERSON_ID.test(personId)) throw invalidRow();
  return companyScoped(companyId, `INVOLVED#${personId}`);
}

/** The key of one involved row: `<company>#INVOLVED#<person>` / `TASK#<createdAt>#<taskId>` (the shape of the task index, `DEVELOPER#<person>` / `TASK#<createdAt>#<taskId>`, in the company's partition). */
export function involvedRowKey(input: InvolvedRowInput): DocumentKey {
  const row = checked(input);
  return { pk: involvedPartition(row.companyId, row.personId), sk: `${ROW_SK_PREFIX}${row.createdAt}#${row.taskId}` };
}

/** The involved row as a transaction step (a plain put, so adding the same person twice leaves one row). For C4's add path to put in its own transaction. */
export function involvedRowPut(input: InvolvedRowInput, addedAt: string): Extract<TransactItem, { kind: "put" }> {
  const row = checked(input);
  if (typeof addedAt !== "string" || !ISO_INSTANT.test(addedAt)) throw invalidRow();
  return { kind: "put", item: { ...involvedRowKey(row), entityType: INVOLVED_ENTITY, companyId: row.companyId, personId: row.personId, taskId: row.taskId, createdAt: row.createdAt, addedAt } };
}

/** The involved row's delete as a transaction step (deleting a row that is not there is a no-op). For C4's deny path. */
export function involvedRowDelete(input: InvolvedRowInput): Extract<TransactItem, { kind: "delete" }> {
  return { kind: "delete", key: involvedRowKey(input) };
}

/** Writes the person's involved row for the task. Idempotent: a second call leaves one row. Not wired into People yet (C4 calls it when it adds a person). */
export async function writeInvolvedRow(deps: { store: Pick<DocumentStore, "put">; now?: () => Date }, input: InvolvedRowInput): Promise<void> {
  const step = involvedRowPut(input, (deps.now?.() ?? new Date()).toISOString());
  await deps.store.put({ item: step.item });
}

/** Deletes the person's involved row for the task. Idempotent: no row is no error. Not wired into People yet (C4 calls it when it denies or removes a person). */
export async function deleteInvolvedRow(deps: { store: Pick<DocumentStore, "delete"> }, input: InvolvedRowInput): Promise<void> {
  await deps.store.delete({ key: involvedRowKey(input) });
}

// ---- the read

export const INVOLVED_LIST_DEFAULT = 20;
export const INVOLVED_LIST_MAX = 50;
/** At most this many involved rows are examined (each costs a task read and an access check) in one call, whatever the page asks. */
export const INVOLVED_EXAMINE_MAX = 100;
const PAGE_ROWS_MAX = 50;
const CURSOR_MAX = 400;

export interface InvolvedListOptions { limit?: number; cursor?: string }

export interface InvolvedList {
  /** Always true: an older Code answers `?involved=1` with the ordinary list, so a client shows these tasks only when this says they are the involved ones. */
  involved: true;
  tasks: DeveloperTaskListItem[];
  nextCursor?: string;
}

const encodeCursor = (sk: string): string => Buffer.from(JSON.stringify({ sk }), "utf8").toString("base64url");

function decodeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const invalid = () => agentXError("CONFIG_INVALID", "cursor is not valid; list the tasks again without a cursor");
  if (typeof value !== "string" || value.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw invalid(); }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw invalid();
  const fields = decoded as Record<string, unknown>;
  if (Object.keys(fields).length !== 1 || typeof fields["sk"] !== "string" || !ROW_SK.test(fields["sk"])) throw invalid();
  return fields["sk"];
}

/** The `limit` and `cursor` of a list request's query, checked. Anything out of range or malformed is a fixed refusal. */
export function involvedListOptions(params: URLSearchParams): InvolvedListOptions {
  const rawLimit = params.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^[0-9]{1,6}$/u.test(rawLimit)) throw agentXError("CONFIG_INVALID", `limit must be a whole number from 1 to ${INVOLVED_LIST_MAX}`);
    limit = Number(rawLimit);
    if (limit < 1 || limit > INVOLVED_LIST_MAX) throw agentXError("CONFIG_INVALID", `limit must be a whole number from 1 to ${INVOLVED_LIST_MAX}`);
  }
  const cursor = params.get("cursor");
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === null ? {} : { cursor }) };
}

/** Whether a request's query asks for the involved list: exactly `involved=1`. Anything else is the ordinary list, unchanged. */
export const wantsInvolved = (params: URLSearchParams): boolean => params.get("involved") === "1";

/** A row of the caller's partition, if it is what a writer makes: of this company, for this person, naming the task its own key names. */
function rowOf(item: StoredDocument, pk: string, companyId: string, personId: string): { taskId: string; createdAt: string; sk: string } | undefined {
  const sk = item["sk"];
  const match = typeof sk === "string" ? ROW_SK.exec(sk) : null;
  if (match === null || item["pk"] !== pk || item["entityType"] !== INVOLVED_ENTITY) return undefined;
  if (item["companyId"] !== companyId || item["personId"] !== personId || item["taskId"] !== match[2] || item["createdAt"] !== match[1]) return undefined;
  return { taskId: match[2]!, createdAt: match[1]!, sk: sk as string };
}

/**
 * The tasks the caller was added to, newest first: one bounded page. Every row is re-checked against the live task: the task must exist, belong to this company and be the one the row's creation time
 * names, the caller must not be its owner (those are in the ordinary list), and the live task access must let the caller see it (`access.canAct`, the rule of the core's task read). Rows that fail are
 * skipped, never shown. Items have the ordinary list's shape, read from the task, never from the row.
 */
export async function listInvolvedTasks(deps: TaskFlowDeps, caller: TaskCaller, options: InvolvedListOptions = {}): Promise<InvolvedList> {
  const empty: InvolvedList = { involved: true, tasks: [] };
  const personId = caller.principal.personId;
  if (!OrgIdSchema.safeParse(deps.companyId).success || caller.principal.companyId !== deps.companyId || typeof personId !== "string" || !PERSON_ID.test(personId)) return empty;
  const requested = options.limit ?? INVOLVED_LIST_DEFAULT;
  if (!Number.isSafeInteger(requested) || requested < 1) throw agentXError("CONFIG_INVALID", "list limit is invalid");
  const limit = Math.min(requested, INVOLVED_LIST_MAX);
  const after = decodeCursor(options.cursor);
  const pk = involvedPartition(deps.companyId, personId);
  const tasks: DeveloperTaskListItem[] = [];
  const range = after === undefined ? { op: "beginsWith" as const, prefix: ROW_SK_PREFIX } : { op: "lt" as const, value: after };
  let examined = 0;
  let lastSk: string | undefined;
  let cursor: string | undefined;
  let more = false;
  // One page chain over the caller's own partition. The continuation across calls is the last examined row's sort key (checked above), so a client can only start from a row of its own partition.
  // At most ten page reads and INVOLVED_EXAMINE_MAX rows per call; a page cut short by a bound always carries a continuation when rows may remain.
  for (let reads = 0; reads < 10; reads++) {
    const page = await deps.store.query({ pk, sk: range, descending: true, limit: Math.min(PAGE_ROWS_MAX, INVOLVED_EXAMINE_MAX - examined), ...(cursor === undefined ? {} : { cursor }) });
    let stopped = false;
    for (const [position, item] of page.items.entries()) {
      examined += 1;
      // Only a sort key a writer could have made can be a continuation (a malformed one is skipped below and never becomes a cursor the next call would refuse).
      if (typeof item["sk"] === "string" && ROW_SK.test(item["sk"])) lastSk = item["sk"];
      const shown = await visibleTask(deps, caller, pk, item);
      if (shown !== undefined) tasks.push(shown);
      if (tasks.length >= limit || examined >= INVOLVED_EXAMINE_MAX) {
        more = position < page.items.length - 1 || page.cursor !== undefined;
        stopped = true;
        break;
      }
    }
    cursor = page.cursor;
    if (stopped || cursor === undefined) break;
    more = true;
  }
  if (!more) return { involved: true, tasks };
  const resume = lastSk ?? after;
  // Rows may remain but nothing was read that a client could continue from: never a silently short list.
  if (resume === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the involved tasks could not be listed right now; try again");
  return { involved: true, tasks, nextCursor: encodeCursor(resume) };
}

async function visibleTask(deps: TaskFlowDeps, caller: TaskCaller, pk: string, item: StoredDocument): Promise<DeveloperTaskListItem | undefined> {
  const row = rowOf(item, pk, deps.companyId, caller.principal.personId);
  if (row === undefined) return undefined;
  const task = await readTask(deps, row.taskId);
  if (task === undefined || task.companyId !== deps.companyId || task.createdAt !== row.createdAt || task.developerId === caller.principal.personId) return undefined;
  if (!(await deps.access.canAct(caller.principal, task))) return undefined;
  // The status as the task's owner's index row says (the core keeps it), read for this company's task only; an index row that does not read leaves the task out.
  const index = await deps.store.get(taskIndexKey(task.developerId, task.createdAt, task.taskId));
  const status = DeveloperTaskStatusSchema.safeParse(index?.["status"]);
  if (index === undefined || !status.success || index["taskId"] !== task.taskId || (index["orgId"] ?? IMPLICIT_COMPANY_ID) !== deps.companyId || typeof index["updatedAt"] !== "string") return undefined;
  return developerTaskListItem({ taskId: task.taskId, title: task.title, project: task.project, status: status.data, shared: task.shared, createdAt: task.createdAt, updatedAt: index["updatedAt"] });
}
