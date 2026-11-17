// The task log's rows, on the document store port: one item per entry in the task's own partition (`DEVTASK#<task>` / `TASKLOG#<entry key>`), so the log follows the task's retention and erase and is written in the
// transaction of the change that caused each entry (`taskLogItems`). An entry's key is made from what happened, so a repeat of the event is the same row. A reader reads the company's own rows only (the row names its
// company and a row of another company, or one that no longer parses, is not read).
import {
  INDEX_EXPIRY_ATTRIBUTE, TASK_LOG_ENTRIES_MAX, TASK_LOG_SORT_PREFIX, TaskLogEntrySchema, queryAll, taskLogKey, when,
  type DocumentStore, type OrgId, type StoredDocument, type TaskLogEntry, type TransactItem,
} from "@agentx/contracts";

/** A log entry is kept this long after it happened (the store's expiry), as long as the ticket updates' own rows. */
export const TASK_LOG_KEPT_SECONDS = 400 * 86_400;

function rowOf(orgId: OrgId, taskId: string, entry: TaskLogEntry): StoredDocument {
  const parsed = TaskLogEntrySchema.parse(entry);
  return JSON.parse(JSON.stringify({
    ...taskLogKey(taskId, parsed.key), entityType: "TASK_LOG", orgId, taskId, entry: parsed, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(parsed.at) / 1000) + TASK_LOG_KEPT_SECONDS,
  })) as StoredDocument;
}

/**
 * The items that record these entries: add them to the transaction of the change that caused them. A put with no condition, so an entry that is already there (the same event again) is written over by itself and
 * never makes the owner's own change fail; the key and everything in the entry are made from the event, so the row does not change.
 */
export function taskLogItems(input: { orgId: OrgId; taskId: string; entries: readonly TaskLogEntry[] }): TransactItem[] {
  return input.entries.map((entry) => ({ kind: "put" as const, item: rowOf(input.orgId, input.taskId, entry) }));
}

/** Records entries on their own (a milestone's handler, after the commit): each is written once, and one that is there already is left as it was. Returns how many were new. */
export async function appendTaskLog(store: Pick<DocumentStore, "put">, input: { orgId: OrgId; taskId: string; entries: readonly TaskLogEntry[] }): Promise<number> {
  let written = 0;
  for (const entry of input.entries) {
    if ((await store.put({ item: rowOf(input.orgId, input.taskId, entry), condition: when.absent() })).applied) written += 1;
  }
  return written;
}

/** Entries at the same instant keep the order things happen in: a milestone, the plan's summary, a question, its answer, a decision, the pull request. Then by key, so the order is the same on every read. */
const KIND_RANK: Readonly<Record<TaskLogEntry["kind"], number>> = { status: 0, plan_summary: 1, question: 2, answer: 3, approval: 4, pr: 5 };
const byTime = (a: TaskLogEntry, b: TaskLogEntry): number => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.kind !== b.kind ? KIND_RANK[a.kind] - KIND_RANK[b.kind] : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The task's log, oldest first, at most `TASK_LOG_ENTRIES_MAX` entries. Only this company's rows, only entries that parse. */
export async function readTaskLog(store: Pick<DocumentStore, "query">, orgId: OrgId, taskId: string): Promise<TaskLogEntry[]> {
  const rows = await queryAll(store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: TASK_LOG_SORT_PREFIX } });
  const entries: TaskLogEntry[] = [];
  for (const row of rows) {
    if (row["orgId"] !== orgId || row["taskId"] !== taskId) continue;
    const parsed = TaskLogEntrySchema.safeParse(row["entry"]);
    if (parsed.success && `${TASK_LOG_SORT_PREFIX}${parsed.data.key}` === row.sk) entries.push(parsed.data);
  }
  return entries.sort(byTime).slice(0, TASK_LOG_ENTRIES_MAX);
}
