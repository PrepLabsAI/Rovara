import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkspaceClosePreflightResultSchema } from "./workspace.js";

export const CLOSE_RETENTION_FEATURE = "close.retention.v1";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const WorkspaceDataIdentitySchema = z.object({
  sessionGeneration: positive,
  instanceId: z.string().regex(/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u),
  volumeId: z.string().regex(/^vol-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u),
  dataGeneration: z.string().uuid(),
}).strict();
export const CloseRetentionSchema = z.object({
  inspectionOperationId: z.string().uuid(), inspectionFence: positive,
  retentionId: z.string().uuid(), contentDigest: digest, generation: WorkspaceDataIdentitySchema,
}).strict();
export const CloseRetentionMachineIdsSchema = z.array(z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u))
  .min(1).max(8).refine((ids) => new Set(ids).size === ids.length, "machine identities must be unique");
const effectId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
export const CloseRetainPayloadSchema = z.object({ schemaVersion: z.literal(1), action: z.literal("retain"), target: WorkspaceDataIdentitySchema }).strict();
export const CloseVerifyPayloadSchema = z.object({ schemaVersion: z.literal(1), action: z.literal("verify"), retention: CloseRetentionSchema, queryId: z.string().uuid() }).strict();
export const CloseDestroyPayloadSchema = z.object({ schemaVersion: z.literal(1), action: z.literal("destroy"), retention: CloseRetentionSchema, effectId, machineIds: CloseRetentionMachineIdsSchema }).strict();
export const CloseRetentionPayloadSchema = z.discriminatedUnion("action", [CloseRetainPayloadSchema, CloseVerifyPayloadSchema, CloseDestroyPayloadSchema]);
export const ClosePayloadSchema = z.union([z.object({}).strict(), CloseRetentionPayloadSchema]);
const identity = { schemaVersion: z.literal(1), workspaceId: z.string().uuid(), operationId: z.string().uuid(), fence: positive };
const inspection = WorkspaceClosePreflightResultSchema.safeExtend({ contentDigest: digest });
export const CloseRetentionReplySchema = z.union([
  z.object({ ...identity, action: z.literal("retain"), status: z.literal("retained"), retention: CloseRetentionSchema, inspection }).strict(),
  z.object({ ...identity, action: z.literal("verify"), status: z.literal("verified"), retention: CloseRetentionSchema, queryId: z.string().uuid(), verified: z.boolean() }).strict(),
  z.object({ ...identity, action: z.literal("destroy"), status: z.literal("destroy_authorized"), retention: CloseRetentionSchema, effectId, machineIds: CloseRetentionMachineIdsSchema }).strict(),
  z.object({ ...identity, action: z.literal("retain"), status: z.literal("pending"), target: WorkspaceDataIdentitySchema }).strict(),
  z.object({ ...identity, action: z.literal("destroy"), status: z.literal("pending"), retention: CloseRetentionSchema, effectId, machineIds: CloseRetentionMachineIdsSchema }).strict(),
  z.object({ ...identity, action: z.enum(["retain", "verify", "destroy"]), status: z.literal("unavailable"), reason: z.enum(["busy", "unsupported", "unproven", "mismatch"]) }).strict(),
]).superRefine((reply, context) => {
  if (reply.status === "retained" && (reply.inspection.contentDigest !== reply.retention.contentDigest || reply.operationId !== reply.retention.inspectionOperationId || reply.fence !== reply.retention.inspectionFence)) context.addIssue({ code: "custom", message: "retained reply must match its original command and content" });
});
export type WorkspaceDataIdentity = z.infer<typeof WorkspaceDataIdentitySchema>;
export type CloseRetention = z.infer<typeof CloseRetentionSchema>;
export type CloseRetentionPayload = z.infer<typeof CloseRetentionPayloadSchema>;
export type CloseRetentionReply = z.infer<typeof CloseRetentionReplySchema>;

/** Stable logical identity excludes renewed credentials and delivery timestamps. Sort object keys and machine sets. */
export function canonicalRetentionValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRetentionValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalRetentionValue(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface RetentionSignedInvocation {
  kind: string; workspaceId: string; operationId: string; fence: number; payload: unknown;
  supersedesRetention?: CloseRetention | undefined;
}
/** Only call on a strictly parsed invocation; this helper validates the retention selector too. */
export function retentionInvocationDigest(invocation: RetentionSignedInvocation): string {
  const supersedesRetention = invocation.supersedesRetention === undefined ? undefined : CloseRetentionSchema.parse(invocation.supersedesRetention);
  const payload = invocation.kind === "close" ? CloseRetentionPayloadSchema.parse(invocation.payload) : invocation.payload;
  const canonicalPayload = typeof payload === "object" && payload !== null && "machineIds" in payload
    ? { ...payload, machineIds: CloseRetentionMachineIdsSchema.parse(payload.machineIds).sort() } : payload;
  const selector = { kind: invocation.kind, workspaceId: invocation.workspaceId, operationId: invocation.operationId, fence: positive.parse(invocation.fence), payload: canonicalPayload,
    ...(supersedesRetention === undefined ? {} : { supersedesRetention }) };
  return createHash("sha256").update(canonicalRetentionValue(selector)).digest("hex");
}

export function needsRetentionBinding(invocation: RetentionSignedInvocation): boolean {
  return invocation.supersedesRetention !== undefined || (invocation.kind === "close" && CloseRetentionPayloadSchema.safeParse(invocation.payload).success);
}
