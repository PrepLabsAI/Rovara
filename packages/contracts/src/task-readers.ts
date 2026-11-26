// Spec 067: task readers. A task's owner shares it read-only with another member of its company, by developer ID (a project grant is not needed); the
// reader then reads the task page as the one read rule's table says (core/task-flow/read-rule.ts), and comments.
import { z } from "zod";

/** The most readers one task has. */
export const TASK_READERS_MAX = 50;

/** What a reader may do. One value for now; commenter can be added without a new route. */
export const TaskReaderRoleSchema = z.enum(["viewer"]);
export type TaskReaderRole = z.infer<typeof TaskReaderRoleSchema>;

const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** `PUT /v1/dev/tasks/{taskId}/readers/{developerId}`. */
export const TaskReaderPutRequestSchema = z.object({ requestId: z.string().uuid(), role: TaskReaderRoleSchema }).strict();
export type TaskReaderPutRequest = z.infer<typeof TaskReaderPutRequestSchema>;

/** One reader as the owner sees them. `name` is the person's name now; `projectMember` says whether they hold a grant on the project now; it does not decide whether they read (a share needs the company, not the project). */
export const TaskReaderSchema = z.object({
  developerId: DeveloperIdSchema,
  name: z.string().min(1).max(200),
  role: TaskReaderRoleSchema,
  projectMember: z.boolean(),
  grantedAt: z.string().datetime(),
}).strict();
export type TaskReader = z.infer<typeof TaskReaderSchema>;

/** `GET /v1/dev/tasks/{taskId}/readers`, oldest grant first. */
export const TaskReadersResponseSchema = z.object({ readers: z.array(TaskReaderSchema).max(TASK_READERS_MAX) }).strict();
export type TaskReadersResponse = z.infer<typeof TaskReadersResponseSchema>;

/** The PUT's answer: the reader, and whether they were one already. */
export const TaskReaderPutResponseSchema = z.object({ reader: TaskReaderSchema, already: z.boolean() }).strict();
export type TaskReaderPutResponse = z.infer<typeof TaskReaderPutResponseSchema>;

/** `DELETE /v1/dev/tasks/{taskId}/readers/{developerId}`: whether a reader was removed (false when they weren't one). */
export const TaskReaderDeleteResponseSchema = z.object({ developerId: DeveloperIdSchema, removed: z.boolean() }).strict();
export type TaskReaderDeleteResponse = z.infer<typeof TaskReaderDeleteResponseSchema>;
