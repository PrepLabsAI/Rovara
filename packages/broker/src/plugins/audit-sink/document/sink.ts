// Port lane P6 (item L2, review H1/M2): Code's default `audit-sink`. The audit record COMMITS WITH THE CHANGE, as the port says (`audit-sink.ts`): `stage` returns an `update` step (sets each field only if absent) for the caller's own
// document-store transaction, an `AUDIT#` row in the same store. So a change that is refused, lost to a competing writer, or interrupted before its transaction commits leaves NO row, and
// a change that commits always leaves one. The "audit before add" rule holds because the record and the add are one atomic step.
//
// The row's key is the event id, and the step's condition is "absent, or the same facts": a retry of a committed event is harmless, and the same event id used for DIFFERENT facts makes the step
// fail (the caller's transaction is refused; it is never silently dropped). The facts exclude the time, so a retry at a later moment is the same record.
// Moved out of the retired `@agentx/local-adapters` (issue #1538): the hosted product registers this sink.
import { AuditLogError, auditRow, change, when, type AuditEvent, type AuditSink, type DocumentStore, type StoredDocument, type TransactItem, type UpdateOp } from "@agentx/contracts";

/**
 * The write for an event's row: an update that sets each field only when it is not there yet, under "absent, or the same facts". A new row is created whole; a same-facts retry changes nothing, so the row
 * keeps the time of the FIRST commit (a plain `put` would overwrite it).
 */
function auditWrite(item: StoredDocument): { key: { pk: string; sk: string }; ops: UpdateOp[]; condition: ReturnType<typeof when.or> } {
  const { pk, sk, ...fields } = item;
  return {
    key: { pk, sk },
    ops: Object.entries(fields).map(([name, value]) => change.setIfAbsent(name, value)),
    condition: when.or(when.absent(), when.eq("digest", item.digest as string)),
  };
}

export interface DocumentAuditSinkOptions {
  /** The store the rows go to; asked when `record` is called, so the registry's `storage` adapter (which may be a plug-in loaded later) is the one used. */
  store: () => Pick<DocumentStore, "update" | "get">;
}

export class DocumentAuditSink implements AuditSink {
  readonly #options: DocumentAuditSinkOptions;

  constructor(options: DocumentAuditSinkOptions) {
    this.#options = options;
  }

  stage(event: AuditEvent): readonly TransactItem[] {
    return [{ kind: "update", ...auditWrite(auditRow(event)) }];
  }

  async record(event: AuditEvent): Promise<void> {
    const write = auditWrite(auditRow(event));
    const store = this.#options.store();
    let result;
    try {
      result = await store.update(write);
    } catch (error) {
      throw new AuditLogError("the audit record could not be written", { cause: error });
    }
    if (!result.applied) throw new AuditLogError("the audit event id is already used for other facts");
  }
}
