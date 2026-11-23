import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CloseRetentionPayloadSchema, CloseRetentionReplySchema, WorkspaceDataIdentitySchema, type WorkspaceDataIdentity } from "@agentx/contracts";

export const CloseSealSchema = z.object({ filesystemId: z.string().uuid(), backingId: z.string().regex(/^\d+:\d+$/u), deviceId: z.string().regex(/^\d+:\d+$/u) }).strict();
export const CloseJournalStateSchema = z.object({
  schemaVersion: z.literal(1), commandHash: z.string().regex(/^[a-f0-9]{64}$/u), generation: WorkspaceDataIdentitySchema,
  command: CloseRetentionPayloadSchema, phase: z.enum(["intent", "sealed", "destroy-authorized"]),
  seal: CloseSealSchema.optional(), terminalReply: CloseRetentionReplySchema.optional(), supersededBy: z.string().uuid().optional(),
}).strict();
export type CloseSeal = z.infer<typeof CloseSealSchema>;
export type CloseJournalState = z.infer<typeof CloseJournalStateSchema>;

/** The host owns the lock and kernel operations. A verifier opens an existing shared lock only. */
export interface CloseRetentionStorage {
  identity(): Promise<WorkspaceDataIdentity>;
  withOwnership<T>(mode: "read" | "write", work: () => Promise<T>): Promise<T>;
  seal(operationId: string): Promise<CloseSeal>;
  verify(operationId: string, seal: CloseSeal): Promise<boolean>;
  successor?(operationId: string): Promise<WorkspaceDataIdentity>;
}

interface HostChannel { mode: "read" | "write"; request(action: string, operationId?: string): Promise<unknown> }
/** Only the trusted worker receives the host socket; task containers receive the data mount alone. */
export class HostCloseRetentionStorage implements CloseRetentionStorage {
  private readonly channel = new AsyncLocalStorage<HostChannel>();
  async identity(): Promise<WorkspaceDataIdentity> {
    const value = JSON.parse(await readFile("/run/agentx-close-retention/current.json", "utf8")) as { schemaVersion?: number; generation?: unknown };
    if (value.schemaVersion !== 1) throw new Error("unsupported workspace layout");
    return WorkspaceDataIdentitySchema.parse(value.generation);
  }
  async withOwnership<T>(mode: "read" | "write", work: () => Promise<T>): Promise<T> {
    const existing = this.channel.getStore();
    if (existing !== undefined) {
      if (mode === "write" && existing.mode !== "write") throw new Error("read-only ownership cannot be upgraded");
      return work();
    }
    const socket = createConnection("/run/agentx-close-retention/control.sock");
    socket.setTimeout(120_000, () => socket.destroy(new Error("ownership helper timed out")));
    const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const request = async (action: string, operationId?: string): Promise<unknown> => {
      socket.write(`${JSON.stringify({ action, ...(operationId === undefined ? {} : { operationId }) })}\n`);
      const line = await lines.next();
      if (line.done || line.value.length > 16_384) throw new Error("ownership helper did not answer");
      const reply = JSON.parse(line.value) as { ok?: boolean; result?: unknown };
      if (reply.ok !== true) throw new Error("ownership helper refused");
      return reply.result;
    };
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      await request(mode === "read" ? "lock-read" : "lock-write");
      return await this.channel.run({ mode, request }, work);
    } finally { socket.destroy(); await lines.return?.(); }
  }
  async seal(operationId: string): Promise<CloseSeal> { return CloseSealSchema.parse(await this.request("seal", operationId)); }
  async verify(operationId: string, seal: CloseSeal): Promise<boolean> {
    const result = CloseSealSchema.safeParse(await this.request("verify", operationId));
    return result.success && result.data.filesystemId === seal.filesystemId && result.data.backingId === seal.backingId && result.data.deviceId === seal.deviceId;
  }
  async successor(operationId: string): Promise<WorkspaceDataIdentity> { return WorkspaceDataIdentitySchema.parse(await this.request("successor", operationId)); }
  private async request(action: string, operationId: string): Promise<unknown> {
    const channel = this.channel.getStore();
    if (channel === undefined) throw new Error("host ownership is required");
    return channel.request(action, z.string().uuid().parse(operationId));
  }
}
