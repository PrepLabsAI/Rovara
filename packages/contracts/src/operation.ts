import { Buffer } from "node:buffer";
import { z } from "zod";

export const OperationKindSchema = z.enum(["prepare", "task", "resume", "stop", "cancel"]);
export const OperationStatusSchema = z.enum([
  "ACCEPTED",
  "DISPATCHING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

export const OperationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    conversationId: z.string().uuid(),
    prompt: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, "prompt exceeds 65536 UTF-8 bytes"),
  })
  .strict();

export const OperationSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    kind: OperationKindSchema,
    requestId: z.string().uuid(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: OperationStatusSchema,
    fence: z.number().int().positive(),
    heartbeatAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    result: z.unknown().optional(),
    error: z.string().max(16_384).optional(),
  })
  .strict();

export const TERMINAL_OPERATION_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
] as const);

export type Operation = z.infer<typeof OperationSchema>;
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
