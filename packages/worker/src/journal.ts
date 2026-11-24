import { CloseJournalStateSchema, type CloseJournalState } from "./close-retention-storage.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CloseRetentionSchema, type CloseRetention, CloseRetentionPayloadSchema, needsRetentionBinding, retentionInvocationDigest, canonicalRetentionValue, WorkerInvocationSchema, agentXError, type WorkerInvocation } from "@agentx/contracts";

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
  closeRetention?: CloseJournalState;
  supersedesRetention?: CloseRetention;
}

/** The payload hash of a record written by a cancel that arrived before its operation (see `tombstone`): no invocation hashes to it. */
export const CANCELLED_BEFORE_ARRIVAL = "cancelled-before-arrival";
/** A cancel's record of an operation that never arrived is useful while that operation's delivery can still be on its way (its queue keeps a message for days at most). */
export const TOMBSTONE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

// A workspace has one worker process. Share the append/raise queue across journal
// instances in that process; only the high-water value lives beyond a restart.
const fenceQueues = new Map<string, Promise<void>>();

export class OperationJournal {
  readonly directory: string;

  constructor(rootPath: string, controlRoot?: string) {
    this.directory = resolve(controlRoot ?? rootPath, ".agentx/operations");
  }

  async accept(untrustedInvocation: WorkerInvocation): Promise<{ record: JournalRecord; duplicate: boolean }> {
    const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
    return this.withFenceLock(invocation.workspaceId, async () => {
      // Recheck under the same lock as the append and destructive raise. The
      // HTTP admission check alone would leave a check-then-write gap.
      await this.checkFence(invocation);
      const passedIntent = await this.checkRetention(invocation);
      // Going past a never-answered intent raises the fence in the same lock: the old command can no longer seal under this work.
      if (passedIntent) await this.persistFence(invocation.workspaceId, invocation.fence);
      return this.append(invocation);
    });
  }

  /** Admission also covers live invocations, which never append an operation. */
  async assertFence(input: Pick<WorkerInvocation, "workspaceId" | "fence">): Promise<void> {
    await this.withFenceLock(input.workspaceId, async () => { await this.checkFence(input); await this.checkRetention(input); });
  }

  private async checkFence(input: Pick<WorkerInvocation, "workspaceId" | "fence">): Promise<void> {
    if (input.fence < await this.highWater(input.workspaceId)) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "invocation fence is below the workspace high-water mark");
    }
  }

  /** A replayed raise is harmless; the durable barrier is never rolled back. */
  async raiseFence(workspaceId: string, fence: number): Promise<void> {
    await this.withFenceLock(workspaceId, () => this.persistFence(workspaceId, fence));
  }

  private async append(invocation: WorkerInvocation): Promise<{ record: JournalRecord; duplicate: boolean }> {
    const hash = needsRetentionBinding(invocation) ? retentionInvocationDigest(invocation) : createHash("sha256").update(JSON.stringify(invocation)).digest("hex");
    await mkdir(this.directory, { recursive: true });
    const existing = await this.get(invocation.operationId);
    if (existing) return existingAppend(existing, hash);
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
      ...(invocation.supersedesRetention === undefined ? {} : { supersedesRetention: invocation.supersedesRetention }),
    };
    const retention = initialRetention(invocation, hash);
    if (retention !== undefined) record.closeRetention = retention;
    // Until the record is synced, the raise is provisional. Every admission and
    // raise shares this lock, so failed-append recovery cannot undo an observed
    // or committed raise. A crash keeps the conservative barrier on disk.
    const previous = await this.highWater(invocation.workspaceId);
    const raising = (invocation.kind === "close" || invocation.kind === "cancel") && invocation.fence > previous;
    try {
      if (raising) await this.persistFence(invocation.workspaceId, invocation.fence);
      await this.writeRecord(record);
      return { record, duplicate: false };
    } catch (error) {
      // writeRecord removes only its own failed/partial record and syncs that
      // removal first. If cleanup fails, keep the higher barrier (fail closed).
      if (raising && !(error instanceof JournalCleanupError)) await this.restoreFence(invocation.workspaceId, previous);
      if (isNodeError(error) && error.code === "EEXIST") return this.append(invocation);
      throw error;
    }
  }

  private async writeRecord(record: JournalRecord): Promise<void> {
    const path = this.path(record.operationId);
    const file = await open(path, "wx", 0o600);
    try {
      try {
        await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await this.syncDirectory(this.directory);
    } catch (error) {
      try {
        await unlink(path);
        await this.syncDirectory(this.directory);
      } catch (cleanupError) { throw new JournalCleanupError("failed to remove an uncommitted journal record", { cause: cleanupError }); }
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
      const record = JSON.parse(await readFile(this.path(operationId), "utf8")) as JournalRecord;
      if (record.closeRetention !== undefined) {
        record.closeRetention = CloseJournalStateSchema.parse(record.closeRetention);
        validateCloseRecord(record, record.closeRetention);
      }
      return record;
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

  /** Read-only enumeration: proof queries never create the journal directory. */
  async readRecords(): Promise<JournalRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if (isNodeError(error) && error.code === "ENOENT") return []; throw error; }
    const records = await Promise.all(names.filter((name) => /^[0-9a-f-]+\.json$/iu.test(name)).map((name) => this.get(name.slice(0, -5))));
    return records.filter((record): record is JournalRecord => record !== undefined);
  }

  /** The host ownership lock must enclose this durable state transition and its kernel effect. */
  async saveRetention(operationId: string, state: CloseJournalState): Promise<void> {
    const parsed = CloseJournalStateSchema.parse(state);
    const record = await this.get(operationId);
    if (record === undefined) throw agentXError("NOT_FOUND", "retention operation not found");
    const previous = record.closeRetention;
    if (previous !== undefined && (previous.commandHash !== parsed.commandHash || canonicalRetentionValue(previous.generation) !== canonicalRetentionValue(parsed.generation))) throw agentXError("IDEMPOTENCY_CONFLICT", "retention identity is immutable");
    if (previous?.terminalReply !== undefined && canonicalRetentionValue(previous.terminalReply) !== canonicalRetentionValue(parsed.terminalReply)) throw agentXError("IDEMPOTENCY_CONFLICT", "retention result is immutable");
    const temporary = resolve(this.directory, `${operationId}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify({ ...record, closeRetention: parsed })}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.path(operationId));
    await this.syncDirectory(this.directory);
  }

  /** Throws when retained data holds the workspace; true when it went past a never-answered intent (see `supersededByNewerFence`). */
  private async checkRetention(input: Pick<WorkerInvocation, "workspaceId" | "fence">): Promise<boolean> {
    let passedIntent = false;
    for (const record of await this.readRecords()) {
      if (record.workspaceId !== input.workspaceId || record.closeRetention === undefined || record.closeRetention.supersededBy !== undefined) continue;
      // Even the same fence cannot write after an intent. Only the originating close command may replay.
      if (matchesRetainedCommand(input, record) || matchesSuccessor(input, record)) continue;
      if (supersededByNewerFence(input, record)) { passedIntent = true; continue; }
      throw agentXError("IDEMPOTENCY_CONFLICT", "workspace data is held by a retained inspection");
    }
    return passedIntent;
  }

  private path(operationId: string): string {
    return resolve(this.directory, `${operationId}.json`);
  }

  private async highWater(workspaceId: string): Promise<number> {
    try {
      const value: unknown = JSON.parse(await readFile(resolve(this.directory, "fences", `${workspaceId}.json`), "utf8"));
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw agentXError("CONFIG_INVALID", "workspace high-water mark is invalid");
      }
      return value;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return 0;
      throw error;
    }
  }

  private async persistFence(workspaceId: string, fence: number): Promise<void> {
    if (!Number.isSafeInteger(fence) || fence < 1) throw agentXError("CONFIG_INVALID", "workspace fence is invalid");
    if (fence <= await this.highWater(workspaceId)) return;
    await this.writeFence(workspaceId, fence);
  }

  /** Only used under the lock after a failed append has been removed durably. */
  private async restoreFence(workspaceId: string, previous: number): Promise<void> {
    if (previous > 0) await this.writeFence(workspaceId, previous);
    else {
      await unlink(resolve(this.directory, "fences", `${workspaceId}.json`));
      await this.syncDirectory(resolve(this.directory, "fences"));
    }
  }

  private async writeFence(workspaceId: string, fence: number): Promise<void> {
    const directory = resolve(this.directory, "fences");
    await mkdir(directory, { recursive: true });
    const temporary = resolve(directory, `${workspaceId}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${fence}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, resolve(directory, `${workspaceId}.json`));
      await this.syncDirectory(directory);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
      });
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }

  private async withFenceLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const key = resolve(this.directory, workspaceId);
    const previous = fenceQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    fenceQueues.set(key, current);
    await previous;
    try { return await action(); } finally {
      release();
      if (fenceQueues.get(key) === current) fenceQueues.delete(key);
    }
  }
}

class JournalCleanupError extends Error {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function initialRetention(invocation: WorkerInvocation, hash: string): CloseJournalState | undefined {
  if (invocation.kind !== "close") return undefined;
  const command = CloseRetentionPayloadSchema.safeParse(invocation.payload);
  if (!command.success || command.data.action === "verify") return undefined;
  return { schemaVersion: 1, commandHash: hash, command: command.data, phase: "intent",
    generation: command.data.action === "retain" ? command.data.target : command.data.retention.generation };
}

function matchesRetainedCommand(input: Pick<WorkerInvocation, "workspaceId" | "fence">, record: JournalRecord): boolean {
  if (!("kind" in input) || input.kind !== "close") return false;
  if ("operationId" in input && input.operationId === record.operationId) return true;
  if (!("payload" in input)) return false;
  const command = CloseRetentionPayloadSchema.safeParse(input.payload);
  const reply = record.closeRetention?.terminalReply;
  return command.success && command.data.action === "destroy" && reply?.status === "retained" && canonicalRetentionValue(command.data.retention) === canonicalRetentionValue(reply.retention) && input.fence >= record.fence;
}

function existingAppend(record: JournalRecord, hash: string): { record: JournalRecord; duplicate: boolean } {
  if (record.payloadHash !== CANCELLED_BEFORE_ARRIVAL && record.payloadHash !== hash) throw agentXError("IDEMPOTENCY_CONFLICT", "operation was already journaled with another payload");
  return { record, duplicate: true };
}

/**
 * A close command that was journaled but never sealed and never answered (phase `intent`, no seal, no reply: the worker said `unavailable`, or died first) holds nothing: no retained reply exists, so no broker can
 * hold a digest of it, and the volume was never made read-only. Work at a NEWER fence goes past it (it raised the fence, so the old command can no longer seal). A sealed retention, answered or not, is never
 * passed this way: it is released only by the step that names it (`matchesSuccessor`).
 */
function supersededByNewerFence(input: Pick<WorkerInvocation, "fence">, record: JournalRecord): boolean {
  const state = record.closeRetention;
  return state !== undefined && state.phase === "intent" && state.seal === undefined && state.terminalReply === undefined && input.fence > record.fence;
}

function matchesSuccessor(input: Pick<WorkerInvocation, "workspaceId" | "fence">, record: JournalRecord): boolean {
  if (!("supersedesRetention" in input) || input.fence <= record.fence || record.closeRetention?.phase !== "sealed") return false;
  const selector = CloseRetentionSchema.safeParse(input.supersedesRetention), reply = record.closeRetention.terminalReply;
  return selector.success && reply?.status === "retained" && canonicalRetentionValue(selector.data) === canonicalRetentionValue(reply.retention);
}

function invalidRetention(): never { throw agentXError("CONFIG_INVALID", "stored retention command is inconsistent"); }
function validateCloseRecord(record: JournalRecord, state: CloseJournalState): void {
  if (record.schemaVersion !== 1 || state.command.action === "verify" || !["ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(record.status)) invalidRetention();
  const invocation = WorkerInvocationSchema.parse({ protocolVersion: 1, kind: "close", workspaceId: record.workspaceId, operationId: record.operationId, fence: record.fence, projectRevision: 1, callbackCapability: "v".repeat(32), payload: state.command });
  if (retentionInvocationDigest(invocation) !== state.commandHash || record.payloadHash !== state.commandHash) invalidRetention();
  const generation = state.command.action === "retain" ? state.command.target : state.command.retention.generation;
  if (canonicalRetentionValue(generation) !== canonicalRetentionValue(state.generation)) invalidRetention();
  validateStoredReply(record, state);
}
function validateStoredReply(record: JournalRecord, state: CloseJournalState): void {
  const reply = state.terminalReply;
  if (reply === undefined) return;
  if (reply.workspaceId !== record.workspaceId || reply.operationId !== record.operationId || reply.fence !== record.fence) invalidRetention();
  if (reply.status === "retained") {
    if (state.phase !== "sealed" || state.command.action !== "retain" || state.seal === undefined || canonicalRetentionValue(reply.retention.generation) !== canonicalRetentionValue(state.generation)) invalidRetention();
    return;
  }
  if (reply.status !== "destroy_authorized" || state.phase !== "destroy-authorized" || state.command.action !== "destroy") invalidRetention();
  const command = state.command;
  if (canonicalRetentionValue(reply.retention) !== canonicalRetentionValue(command.retention) || reply.effectId !== command.effectId || canonicalRetentionValue([...reply.machineIds].sort()) !== canonicalRetentionValue([...command.machineIds].sort())) invalidRetention();
}
