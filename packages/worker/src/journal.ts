import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
  result?: unknown;
}

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

  async get(operationId: string): Promise<JournalRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(operationId), "utf8")) as JournalRecord;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async transition(operationId: string, status: JournalStatus, error?: string, result?: unknown): Promise<JournalRecord> {
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
      ...(result === undefined ? {} : { result }),
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
