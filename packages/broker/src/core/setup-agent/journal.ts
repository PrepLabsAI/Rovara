// Setup run journal, the broker's side: the commands a setup run ran, kept so the owner can watch the run live and read it afterwards, and as the evidence on the confirm step.
//   - an entry is READ AGAIN by the contract (`SetupJournalEntrySchema`), its command and output redacted once more and cut, and stored once: the first entry for a position stands, a repeat changes nothing;
//   - nothing the worker sends can name another run: the company, project and task come from the authenticated operation, never from the body;
//   - a run holds at most `SETUP_JOURNAL_MAX_ENTRIES` entries; entries are kept 31 days;
//   - the entry's `blockedHosts` are shown and never act: a name only becomes a host ask through `requestHostAsk`, and an ask grants nothing until the owner approves it.
// The task carries only a count (`setupAgentProgress`) for the live view.
import { SETUP_JOURNAL_MAX_ENTRIES, SETUP_JOURNAL_TAIL_BYTES, SetupJournalEntrySchema, change, redactText, when, type DocumentStore, type SetupJournalEntry } from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import { expiryOf, journalKey, setupPartition, type RunScope } from "./keys.js";

export interface JournalTable { store: Pick<DocumentStore, "get" | "put" | "update" | "query">; now: () => number }

/** The most entries one callback may carry. */
export const SETUP_JOURNAL_BATCH_MAX = 20;

const plainOneLine = (text: string, max: number): string => redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

/** The entry as the broker keeps it: the worker's words, redacted once more, cut, and read by the contract again. Undefined when it does not read. */
export function readJournalEntry(raw: unknown): SetupJournalEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const tail = typeof entry["tail"] === "string" ? redactText(entry["tail"]).replace(/[^\P{Cc}\n\t]/gu, "?") : entry["tail"];
  const parsed = SetupJournalEntrySchema.safeParse({
    ...entry,
    ...(typeof entry["command"] === "string" ? { command: plainOneLine(entry["command"], 2_000) || "(empty command)" } : {}),
    ...(typeof tail === "string" ? { tail: Buffer.byteLength(tail) > SETUP_JOURNAL_TAIL_BYTES ? Buffer.from(tail).subarray(-SETUP_JOURNAL_TAIL_BYTES).toString("utf8").replace(/^�+/u, "") : tail } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Stores the entries of a batch (at most `SETUP_JOURNAL_BATCH_MAX`; the rest are refused). An entry for a position that is stored already is left as it is. Answers how many were stored, repeated and refused.
 * The count on the task moves up to the highest position stored, never down; a failure to move it never fails the append.
 */
export async function appendSetupJournal(table: JournalTable, scope: RunScope, entries: readonly unknown[]): Promise<{ stored: number; repeated: number; refused: number }> {
  let stored = 0, repeated = 0, refused = 0, highest = 0;
  for (const raw of entries.slice(0, SETUP_JOURNAL_BATCH_MAX)) {
    const entry = readJournalEntry(raw);
    if (entry === undefined || entry.n > SETUP_JOURNAL_MAX_ENTRIES) { refused += 1; continue; }
    const written = await table.store.put({
      item: { ...journalKey(scope, entry.n), entityType: "SETUP_JOURNAL", orgId: scope.orgId, project: scope.project, taskId: scope.taskId, entry: JSON.parse(JSON.stringify(entry)) as never, ...expiryOf(table.now()) },
      condition: when.absent(),
    });
    if (written.applied) stored += 1; else repeated += 1;
    highest = Math.max(highest, entry.n);
  }
  refused += Math.max(0, entries.length - SETUP_JOURNAL_BATCH_MAX);
  if (highest > 0) {
    await table.store.update({
      key: taskKey(scope.taskId),
      ops: [change.set("setupAgentProgress", { commands: highest, at: new Date(table.now()).toISOString() })],
      condition: when.and(when.eq("purpose", "setup_agent"), when.or(when.notExists("setupAgentProgress"), when.lt(["setupAgentProgress", "commands"], highest))),
    }).catch(() => undefined);
  }
  return { stored, repeated, refused };
}

/** The run's entries in order, from position `after` (exclusive; default 0). A row that does not read back is skipped, never guessed at. At most `SETUP_JOURNAL_MAX_ENTRIES`. */
export async function readSetupJournal(table: Pick<JournalTable, "store">, scope: RunScope, after = 0): Promise<SetupJournalEntry[]> {
  const out: SetupJournalEntry[] = [];
  const pk = setupPartition(scope.orgId, scope.project);
  let cursor: string | undefined;
  for (let page = 0; page < 20 && out.length < SETUP_JOURNAL_MAX_ENTRIES; page += 1) {
    const result = await table.store.query({
      pk, sk: { op: "between", low: journalKey(scope, Math.max(1, after + 1)).sk, high: journalKey(scope, SETUP_JOURNAL_MAX_ENTRIES).sk }, ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of result.items) {
      if (item["taskId"] !== scope.taskId || item["orgId"] !== scope.orgId || item["project"] !== scope.project) continue;
      const entry = readJournalEntry(item["entry"]);
      if (entry !== undefined && entry.n > after) out.push(entry);
    }
    cursor = result.cursor;
    if (cursor === undefined) break;
  }
  return out.slice(0, SETUP_JOURNAL_MAX_ENTRIES);
}
