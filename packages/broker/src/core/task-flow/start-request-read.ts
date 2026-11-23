import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentXNameSchema, DeveloperSignInMethodSchema, OrgIdSchema, agentXError, StartDeveloperTaskRequestSchema } from "@agentx/contracts";
import { startIdempotencyKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { taskKey } from "./keys.js";

const RequestId = StartDeveloperTaskRequestSchema.shape.requestId;
const Mark = z.object({ pk: z.string(), sk: z.string(), entityType: z.literal("IDEMPOTENCY"), taskId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
// Core has no persisted full-task Zod schema. Validate the owning record's required fields before using it.
const Task = z.object({ pk: z.string(), sk: z.literal("META"), entityType: z.literal("DEVELOPER_TASK"), taskId: z.uuid(), companyId: OrgIdSchema,
  developerId: z.string().regex(/^[a-f0-9]{64}$/), provider: DeveloperSignInMethodSchema, developerName: z.string(), client: z.string(), project: AgentXNameSchema,
  title: z.string(), workspaceId: z.uuid(), ownerKey: z.string().min(1), conversationId: z.uuid(), startingRevision: z.number().int().positive(),
  charge: z.object({ member: z.object({ pk: z.string().min(1), sk: z.string().min(1) }), organization: z.object({ pk: z.string().min(1), sk: z.string().min(1) }) }), shared: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).passthrough();
export const startReadUnavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Start status is unavailable.");
export const startReadNotFound = () => agentXError("TASK_NOT_FOUND", "That task is unavailable.");

interface StartRequestReadDependencies {
  get(key: { pk: string; sk: string }): Promise<unknown>;
  /** Fresh authentication and company membership, including the final pass. */
  company(): Promise<string>;
  coreStamp(taskId: string, companyId: string): Promise<unknown>;
  authority(task: DeveloperTaskRecord): Promise<unknown>;
  check(): void;
  now(): number;
}

/** Reads only the original person's mark and its one core task. No task/runtime factory. */
export async function readStartRequest(deps: StartRequestReadDependencies, personId: string, requestId: string) {
  RequestId.parse(requestId);
  const companyId = await deps.company();
  const key = startIdempotencyKey(personId, requestId);
  const raw = await deps.get(key);
  if (raw === undefined) {
    if (await deps.company() !== companyId) throw startReadNotFound();
    deps.check();
    return { requestId, operation: "start" as const, checkedAt: new Date(deps.now()).toISOString(), outcome: "unknown" as const };
  }
  const mark = Mark.parse(raw);
  if (mark.pk !== key.pk || mark.sk !== key.sk) throw startReadUnavailable();
  const stamp = await deps.coreStamp(mark.taskId, companyId);
  const readTask = async () => {
    const item = await deps.get(taskKey(mark.taskId));
    if (item === undefined) throw startReadNotFound();
    // Company mismatch is masked, even when the rest of a foreign record is malformed.
    if (typeof item === "object" && item !== null && "companyId" in item && item.companyId !== companyId) throw startReadNotFound();
    const task = Task.parse(item);
    if (task.taskId !== mark.taskId || task.pk !== taskKey(mark.taskId).pk) throw startReadUnavailable();
    if (task.companyId !== companyId) throw startReadNotFound();
    return task as unknown as DeveloperTaskRecord;
  };
  const task = await readTask();
  const authority = await deps.authority(task);
  const finalMark = await deps.get(key);
  const finalStamp = await deps.coreStamp(mark.taskId, companyId);
  const finalTask = await readTask();
  if (!isDeepStrictEqual(raw, finalMark) || !isDeepStrictEqual(stamp, finalStamp) || !isDeepStrictEqual(task, finalTask)) throw startReadUnavailable();
  if (await deps.company() !== companyId) throw startReadNotFound();
  const finalAuthority = await deps.authority(finalTask);
  if (!isDeepStrictEqual(authority, finalAuthority)) throw startReadUnavailable();
  // Session/client/company standing is the final proof, after all People/project awaits.
  if (await deps.company() !== companyId) throw startReadNotFound();
  deps.check();
  return { requestId, operation: "start" as const, checkedAt: new Date(deps.now()).toISOString(), outcome: "confirmed" as const,
    task: { taskId: task.taskId, project: task.project, createdAt: task.createdAt } };
}
