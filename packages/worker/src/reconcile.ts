import type { JournalRecord } from "./journal.js";
import type { OperationJournal } from "./journal.js";

export async function reconcileInterruptedOperations(journal: OperationJournal): Promise<JournalRecord[]> {
  const interrupted: JournalRecord[] = [];
  for (const record of await journal.list()) {
    if (record.status !== "RUNNING") continue;
    interrupted.push(
      await journal.transition(
        record.operationId,
        "INTERRUPTED",
        "worker process was replaced during an operation; side effects were not replayed",
      ),
    );
  }
  return interrupted;
}
