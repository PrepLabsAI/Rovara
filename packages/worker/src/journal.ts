import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkerInvocationSchema, agentXError, type WorkerInvocation } from "@agentx/contracts";

export type JournalStatus = "ACCEPTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export interface JournalRecord {
  schemaVersion: 1;
  operationId: string;
  workspaceId: string;
  fence: number;
  payloadHash: string;
  status: JournalStatus;
  acceptedAt: string;
  updatedAt: string;
  error?: string;
}

/** The payload hash of a record written by a cancel that arrived before its operation (see `tombstone`): no invocation hashes to it. */
export const CANCELLED_BEFORE_ARRIVAL = "cancelled-before-arrival";
/** A cancel's record of an operation that never arrived is useful while that operation's delivery can still be on its way (its queue keeps a message for days at most). */
export const TOMBSTONE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export class OperationJournal {
  readonly directory: string;

  constructor(rootPath: string) {
    this.directory = resolve(rootPath, ".agentx/operations");
  }

  async accept(untrustedInvocation: WorkerInvocation): Promise<{ record: JournalRecord; duplicate: boolean }> {
    const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
    const hash = createHash("sha256").update(JSON.stringify(invocation)).digest("hex");
    await mkdir(this.directory, { recursive: true });
    const existing = await this.get(invocation.operationId);
    if (existing) {
      // A cancel got here first: the operation is answered as a duplicate that ended cancelled, and is not run.
      if (existing.payloadHash === CANCELLED_BEFORE_ARRIVAL) return { record: existing, duplicate: true };
      if (existing.payloadHash !== hash) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "operation was already journaled with another payload");
      }
      return { record: existing, duplicate: true };
    }
    const now = new Date().toISOString();
    const record: JournalRecord = {
      schemaVersion: 1,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
      fence: invocation.fence,
      payloadHash: hash,
      status: "ACCEPTED",
      acceptedAt: now,
      updatedAt: now,
    };
    try {
      await writeFile(this.path(invocation.operationId), `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { record, duplicate: false };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return this.accept(invocation);
      throw error;
    }
  }

  /**
   * 058-stop-close: a cancel for an operation this worker has never been sent. The stop is remembered as a finished, cancelled record, so that the operation, if its delivery was already on the
   * way, is refused when it arrives (`accept` answers it as a duplicate) instead of running after the person stopped it. Never replaces a record that exists.
   */
  async tombstone(input: { operationId: string; workspaceId: string; fence: number }): Promise<JournalRecord> {
    await mkdir(this.directory, { recursive: true });
    const now = new Date().toISOString();
    const record: JournalRecord = {
      schemaVersion: 1, operationId: input.operationId, workspaceId: input.workspaceId, fence: input.fence, payloadHash: CANCELLED_BEFORE_ARRIVAL,
      status: "CANCELLED", acceptedAt: now, updatedAt: now, error: "cancelled before it reached this worker",
    };
    await this.pruneTombstones().catch(() => undefined);
    try {
      await writeFile(this.path(input.operationId), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return record;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return (await this.get(input.operationId)) ?? record;
      throw error;
    }
  }

  /** Deletes the records of cancels that arrived before their operation and are older than `maxAgeMs`. Returns how many. Records of operations that ran are never touched. */
  async pruneTombstones(maxAgeMs: number = TOMBSTONE_MAX_AGE_MS, now: number = Date.now()): Promise<number> {
    let pruned = 0;
    for (const record of await this.list()) {
      if (record.payloadHash !== CANCELLED_BEFORE_ARRIVAL || now - Date.parse(record.acceptedAt) <= maxAgeMs) continue;
      try { await unlink(this.path(record.operationId)); pruned += 1; } catch (error) { if (!(isNodeError(error) && error.code === "ENOENT")) throw error; }
    }
    return pruned;
  }

  async get(operationId: string): Promise<JournalRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(operationId), "utf8")) as JournalRecord;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async transition(operationId: string, status: JournalStatus, error?: string): Promise<JournalRecord> {
    const current = await this.get(operationId);
    if (!current) throw agentXError("NOT_FOUND", "journal operation not found");
    const terminal = new Set<JournalStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
    if (terminal.has(current.status)) {
      if (current.status === status) return current;
      throw agentXError("IDEMPOTENCY_CONFLICT", "terminal journal result is immutable");
    }
    const next: JournalRecord = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    };
    const temporary = resolve(this.directory, `${operationId}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, this.path(operationId));
    return next;
  }

  async list(): Promise<JournalRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => /^[0-9a-f-]+\.json$/i.test(name));
    const records = await Promise.all(names.map(async (name) => this.get(name.slice(0, -5))));
    return records.filter((record): record is JournalRecord => record !== undefined);
  }

  private path(operationId: string): string {
    return resolve(this.directory, `${operationId}.json`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
