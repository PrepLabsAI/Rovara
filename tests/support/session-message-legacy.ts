import { z } from "zod";

// Frozen deployed shape: adding a receipt state/field or emitting the new sibling breaks it.
export const legacyMessageSchema = z.object({
  messageId: z.string(), sessionId: z.string(), kind: z.enum(["comment", "steer"]), source: z.enum(["app", "slack", "linear", "page"]),
  author: z.object({ developerId: z.string(), name: z.string() }).strict(), text: z.string(), createdAt: z.string(), editedAt: z.string().optional(), deletedAt: z.string().optional(), rev: z.number(),
  delivery: z.object({ state: z.enum(["queued", "delivered", "not_delivered"]), at: z.string(), reason: z.string().optional() }).strict().optional(),
}).strict();

