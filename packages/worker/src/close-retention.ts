import { randomUUID } from "node:crypto";
import { AgentXError, CloseRetentionPayloadSchema, CloseRetentionReplySchema, WorkspaceClosePreflightResultSchema, agentXError, canonicalRetentionValue, type CloseRetention, type CloseRetentionPayload, type CloseRetentionReply, type WorkerInvocation, type WorkspaceClosePreflightResult } from "@agentx/contracts";
import type { JournalRecord, OperationJournal } from "./journal.js";
import type { CloseJournalState, CloseRetentionStorage } from "./close-retention-storage.js";

const replyIdentity = (invocation: WorkerInvocation) => ({ schemaVersion: 1 as const, workspaceId: invocation.workspaceId, operationId: invocation.operationId, fence: invocation.fence });

/** State-machine groundwork. Hosted installation must supply the real host ownership/sealing port before advertising capability. */
export class CloseRetentionExecutor {
  constructor(private readonly journal: OperationJournal, private readonly storage: CloseRetentionStorage,
    private readonly inspect: () => Promise<WorkspaceClosePreflightResult>, private readonly otherOperationActive: () => boolean) {}

  async admitWriter(invocation: WorkerInvocation): Promise<{ record: JournalRecord; duplicate: boolean }> {
    return this.storage.withOwnership("write", async () => {
      const accepted = await this.journal.accept(invocation), selector = invocation.supersedesRetention;
      if (selector !== undefined) await this.acquireSuccessor(invocation, selector);
      return accepted;
    });
  }
  private async acquireSuccessor(invocation: WorkerInvocation, selector: CloseRetention): Promise<void> {
    const original = await this.journal.get(selector.inspectionOperationId);
    if (original?.closeRetention === undefined || this.storage.successor === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "successor authority is unavailable");
    if (original.closeRetention.supersededBy !== undefined && original.closeRetention.supersededBy !== invocation.operationId) throw agentXError("IDEMPOTENCY_CONFLICT", "another successor owns the workspace");
    await this.journal.raiseFence(invocation.workspaceId, invocation.fence);
    await this.storage.successor(invocation.operationId);
    await this.journal.saveRetention(original.operationId, { ...original.closeRetention, supersededBy: invocation.operationId });
  }

  async answer(invocation: WorkerInvocation): Promise<CloseRetentionReply> {
    if (invocation.kind !== "close") throw agentXError("CONFIG_INVALID", "retention requires a close command");
    const command = CloseRetentionPayloadSchema.parse(invocation.payload);
    if (command.action === "verify") {
      // No accept, status update, inspector, lazy mkdir or repair on this path.
      const verified = await this.storage.withOwnership("read", () => this.matches(invocation.workspaceId, command.retention)).catch(() => false);
      return CloseRetentionReplySchema.parse({ ...replyIdentity(invocation), action: "verify", status: "verified", retention: command.retention, queryId: command.queryId, verified });
    }
    return this.storage.withOwnership("write", () => this.mutate(invocation, command));
  }

  private async mutate(invocation: WorkerInvocation, command: Exclude<CloseRetentionPayload, { action: "verify" }>): Promise<CloseRetentionReply> {
    const accepted = await this.journal.accept(invocation), state = accepted.record.closeRetention;
    if (state === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "legacy journal results are not retained inspections");
    const unavailable = (reason: "busy" | "unproven" | "mismatch"): CloseRetentionReply => ({ ...replyIdentity(invocation), action: command.action, status: "unavailable", reason });
    try {
      if (canonicalRetentionValue(await this.storage.identity()) !== canonicalRetentionValue(state.generation)) return unavailable("mismatch");
      if (state.terminalReply !== undefined) return await this.replay(invocation.workspaceId, state) ?? unavailable("unproven");
      if (accepted.record.status === "SUCCEEDED") return unavailable("unproven");
      if (await this.busy(invocation)) return unavailable("busy");
      return command.action === "destroy" ? await this.authorizeDestroy(invocation, command, state) : await this.retain(invocation, state);
    } catch (error) {
      if (error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT") throw error;
      return unavailable("unproven");
    }
  }

  private async replay(workspaceId: string, state: CloseJournalState): Promise<CloseRetentionReply | undefined> {
    const reply = state.terminalReply;
    if (reply?.status !== "retained" && reply?.status !== "destroy_authorized") return undefined;
    return await this.matches(workspaceId, reply.retention) ? reply : undefined;
  }

  private async busy(invocation: WorkerInvocation): Promise<boolean> {
    return this.otherOperationActive() || (await this.journal.readRecords()).some((record) => record.workspaceId === invocation.workspaceId && record.operationId !== invocation.operationId && (record.status === "ACCEPTED" || record.status === "RUNNING") && record.closeRetention === undefined);
  }

  private async authorizeDestroy(invocation: WorkerInvocation, command: Extract<CloseRetentionPayload, { action: "destroy" }>, state: CloseJournalState): Promise<CloseRetentionReply> {
    if (!await this.matches(invocation.workspaceId, command.retention)) return { ...replyIdentity(invocation), action: "destroy", status: "unavailable", reason: "unproven" };
    const reply = CloseRetentionReplySchema.parse({ ...replyIdentity(invocation), action: "destroy", status: "destroy_authorized", retention: command.retention, effectId: command.effectId, machineIds: [...command.machineIds].sort() });
    await this.journal.saveRetention(invocation.operationId, { ...state, phase: "destroy-authorized", terminalReply: reply });
    await this.journal.transition(invocation.operationId, "SUCCEEDED");
    return reply;
  }

  private async retain(invocation: WorkerInvocation, state: CloseJournalState): Promise<CloseRetentionReply> {
    const seal = state.seal ?? await this.storage.seal(invocation.operationId);
    const unavailable: CloseRetentionReply = { ...replyIdentity(invocation), action: "retain", status: "unavailable", reason: "unproven" };
    if (!await this.storage.verify(invocation.operationId, seal)) return unavailable;
    await this.journal.saveRetention(invocation.operationId, { ...state, phase: "sealed", seal });
    const inspection = WorkspaceClosePreflightResultSchema.parse(await this.inspect());
    if (inspection.contentDigest === undefined) return unavailable;
    const retention = { inspectionOperationId: invocation.operationId, inspectionFence: invocation.fence, retentionId: randomUUID(), contentDigest: inspection.contentDigest, generation: state.generation };
    const reply = CloseRetentionReplySchema.parse({ ...replyIdentity(invocation), action: "retain", status: "retained", retention, inspection });
    await this.journal.saveRetention(invocation.operationId, { ...state, phase: "sealed", seal, terminalReply: reply });
    await this.journal.transition(invocation.operationId, "SUCCEEDED");
    return reply;
  }

  private async matches(workspaceId: string, retention: CloseRetention): Promise<boolean> {
    const original: JournalRecord | undefined = await this.journal.get(retention.inspectionOperationId);
    const state = original?.closeRetention;
    if (original?.workspaceId !== workspaceId || original.fence !== retention.inspectionFence || state?.phase !== "sealed" || state.supersededBy !== undefined || state.seal === undefined || state.terminalReply?.status !== "retained") return false;
    if (canonicalRetentionValue(state.terminalReply.retention) !== canonicalRetentionValue(retention)) return false;
    if (canonicalRetentionValue(await this.storage.identity()) !== canonicalRetentionValue(retention.generation)) return false;
    return this.storage.verify(original.operationId, state.seal);
  }
}
