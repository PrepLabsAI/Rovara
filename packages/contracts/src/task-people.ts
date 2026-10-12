import { z } from "zod";

export const TaskPeopleRoleSchema = z.enum(["owner", "commenter", "viewer", "denied"]);
export type TaskPeopleRole = z.infer<typeof TaskPeopleRoleSchema>;

export const TaskPeopleViewSchema = z.object({
  revision: z.number().int().positive(),
  orphaned: z.boolean(),
  people: z.array(z.object({
    personId: z.string().uuid(),
    name: z.string().min(1).max(80),
    role: TaskPeopleRoleSchema,
    you: z.boolean(),
    effectiveRole: z.enum(["owner", "commenter", "viewer"]).nullable(),
  }).strict()).max(100),
  canManage: z.boolean(),
  canTakeOwnership: z.boolean(),
  addPeopleUrl: z.string().url().optional(),
}).strict();
export type TaskPeopleView = z.infer<typeof TaskPeopleViewSchema>;

export const TaskPeopleRoleRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  personId: z.string().uuid(),
  role: TaskPeopleRoleSchema,
}).strict();
export type TaskPeopleRoleRequest = z.infer<typeof TaskPeopleRoleRequestSchema>;

export const TaskPeopleTakeOwnershipRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
}).strict();
export type TaskPeopleTakeOwnershipRequest = z.infer<typeof TaskPeopleTakeOwnershipRequestSchema>;

export const TaskPeopleChangeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PENDING"), requestId: z.string().uuid(), confirmationUrl: z.string().url(), expiresAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("COMMITTED"), view: TaskPeopleViewSchema }).strict(),
]);
export type TaskPeopleChangeResult = z.infer<typeof TaskPeopleChangeResultSchema>;

/** Strict REST transport envelope. The outer requestId is HTTP trace metadata, never proposal identity. */
export const TaskPeopleViewResponseSchema = z.object({
  view: TaskPeopleViewSchema,
  requestId: z.string(),
}).strict();
export type TaskPeopleViewResponse = z.infer<typeof TaskPeopleViewResponseSchema>;

/** Strict REST transport envelope that preserves the change's own proposal requestId. */
export const TaskPeopleChangeResponseSchema = z.object({
  change: TaskPeopleChangeResultSchema,
  requestId: z.string(),
}).strict();
export type TaskPeopleChangeResponse = z.infer<typeof TaskPeopleChangeResponseSchema>;

export const TaskPeopleProposalSchema = z.object({
  requestId: z.string().uuid(),
  taskId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  personId: z.string().uuid().optional(),
  role: TaskPeopleRoleSchema.optional(),
  kind: z.enum(["role", "takeOwnership"]),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.kind === "role" && (value.personId === undefined || value.role === undefined)) context.addIssue({ code: "custom", message: "role proposals require a person and role" });
  if (value.kind === "takeOwnership" && (value.personId !== undefined || value.role !== undefined)) context.addIssue({ code: "custom", message: "take-ownership proposals cannot name a person or role" });
});
export type TaskPeopleProposal = z.infer<typeof TaskPeopleProposalSchema>;
