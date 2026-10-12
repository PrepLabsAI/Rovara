import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@agentx/contracts";
import type { DurableOutboxRecord } from "./lambda.js";
import { taskOpen } from "../developer/task-access.js";
import { resolveTaskDispatchPeople, type CheckTaskPerson } from "../developer/task-people.js";
import { taskKey, taskOwnerKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { ProjectAuthorityWitness } from "../developer/task-project-access.js";
import type { TaskAuthorityAdmission } from "./task-authority-admission.js";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export interface TaskDispatchAccessDependencies {
  documentClient: { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> };
  tableName: string;
  checkTaskPerson?: CheckTaskPerson;
  /** One admission shared by every read, owner, and optimistic retry for this guard. */
  admission?: TaskAuthorityAdmission;
  /** Lambda context time remaining; pause writes must retain their independent reserve. */
  remainingTimeMs?: () => number;
  /** Production People composition requires one fresh State authority witness in the final fence. */
  stateAuthorityWitnessForOwnerActor?: (task: DeveloperTaskRecord, ownerActorId: string) => Promise<(ProjectAuthorityWitness & { taskId: string; developerId: string; project: string }) | undefined>;
}

export type TaskDispatchGuard = (record: DurableOutboxRecord) => Promise<"ALLOWED" | "PARKED">;

type PauseReason = "OWNERLESS" | "PROOF_UNAVAILABLE";

const outboxKey = (outboxId: string) => ({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX" });
const pauseKey = (outboxId: string) => ({ pk: `OUTBOX#${outboxId}`, sk: "TASK_ACCESS_PAUSE" });
const taskPauseKey = (taskId: string, outboxId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `TASK_ACCESS_PAUSE#${outboxId}` });

async function get<T>(deps: TaskDispatchAccessDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

function conditional(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}

async function park(
  deps: TaskDispatchAccessDependencies,
  record: DurableOutboxRecord,
  pointer: DeveloperTaskPointerRecord,
  task: DeveloperTaskRecord,
  peopleRevision: number,
  reason: PauseReason,
): Promise<void> {
  const createdAt = new Date().toISOString();
  const pause = {
    entityType: "TASK_ACCESS_PAUSE", schemaVersion: 1, taskId: task.taskId, outboxId: record.id,
    operationId: record.operationId, workspaceId: record.workspaceId, peopleRevision, reason, createdAt,
    workflowRevision: task.workflow?.revision, workflowStage: task.workflow?.stage, workflowState: task.workflow?.state,
  } as const;
  const items: TransactItem[] = [
    { Update: {
      TableName: deps.tableName, Key: outboxKey(record.id), UpdateExpression: "SET #status = :waiting, taskAccessPausedAt = :now",
      ConditionExpression: "operationId = :operationId AND workspaceId = :workspaceId AND (#status = :queued OR #status = :pending)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":waiting": "WAITING_FOR_TASK_ACCESS", ":queued": "QUEUED", ":pending": "PENDING", ":operationId": record.operationId, ":workspaceId": record.workspaceId, ":now": createdAt },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskPointerKey(record.workspaceId),
      ConditionExpression: "taskId = :taskId", ExpressionAttributeValues: { ":taskId": task.taskId },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      ConditionExpression: "workspaceId = :workspaceId AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":workspaceId": record.workspaceId },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" },
      ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": peopleRevision },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
      ConditionExpression: "fence = :fence AND (#status = :accepted OR #status = :dispatching)", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":fence": record.invocation.fence, ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING" },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
      ConditionExpression: "fence = :fence AND activeOperationId = :operationId",
      ExpressionAttributeValues: { ":fence": record.invocation.fence, ":operationId": record.operationId },
    } },
    { Put: { TableName: deps.tableName, Item: { ...pauseKey(record.id), ...pause }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...taskPauseKey(task.taskId, record.id), ...pause }, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (!conditional(error)) throw error;
    const stored = await get<{ status?: string; operationId?: string }>(deps, outboxKey(record.id));
    const prior = await get<{ operationId?: string }>(deps, pauseKey(record.id));
    if (stored?.status === "WAITING_FOR_TASK_ACCESS" && stored.operationId === record.operationId && prior?.operationId === record.operationId) return;
    throw error;
  }
  void pointer;
}

async function allowedStillCurrent(
  deps: TaskDispatchAccessDependencies,
  record: DurableOutboxRecord,
  pointer: DeveloperTaskPointerRecord,
  task: DeveloperTaskRecord,
  peopleRevision: number | undefined,
  authorityWitness?: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string },
): Promise<boolean> {
  const workflow = task.workflow;
  const taskCondition = workflow === undefined
    ? { ConditionExpression: "workspaceId = :workspaceId AND attribute_not_exists(closedAt) AND attribute_not_exists(workflow)",
      ExpressionAttributeValues: { ":workspaceId": record.workspaceId } }
    : { ConditionExpression: "workspaceId = :workspaceId AND attribute_not_exists(closedAt) AND workflow.#revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND workflow.#stage <> :closed AND workflow.#stage <> :merged AND workflow.#state <> :complete",
      ExpressionAttributeNames: { "#revision": "revision", "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workspaceId": record.workspaceId, ":revision": workflow.revision, ":stage": workflow.stage, ":state": workflow.state,
        ":closed": "CLOSED", ":merged": "MERGED", ":complete": "COMPLETE" } };
  const peopleCondition = peopleRevision === undefined
    ? { ConditionExpression: "attribute_not_exists(pk)" }
    : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": peopleRevision } };
  const checks: TransactItem[] = [
      { ConditionCheck: { TableName: deps.tableName, Key: taskPointerKey(record.workspaceId), ConditionExpression: "taskId = :taskId", ExpressionAttributeValues: { ":taskId": pointer.taskId } } },
      { ConditionCheck: { TableName: deps.tableName, Key: taskKey(task.taskId), ...taskCondition } },
      { ConditionCheck: { TableName: deps.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, ...peopleCondition } },
      { ConditionCheck: { TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
        ConditionExpression: "fence = :fence AND (#status = :accepted OR #status = :dispatching)", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":fence": record.invocation.fence, ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING" } } },
      { ConditionCheck: { TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
        ConditionExpression: "fence = :fence AND activeOperationId = :operationId", ExpressionAttributeValues: { ":fence": record.invocation.fence, ":operationId": record.operationId } } },
  ];
  if (authorityWitness !== undefined) {
    const witness = authorityWitness;
    const expectedRevisionSk = `REV#${String(witness.projectRevision.revision).padStart(12, "0")}`;
    if (witness.taskId !== task.taskId || witness.project !== task.project || witness.projectRevision.pk !== `PROJECT#${task.project}`
      || witness.projectRevision.sk !== expectedRevisionSk || !Number.isSafeInteger(witness.projectRevision.revision)
      || witness.projectRevision.revision < 0 || (witness.access !== "granted" && witness.access !== "channel")) return false;
    const definitionNames = { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" };
    const definitionValues = { ":revision": witness.projectRevision.revision } as Record<string, unknown>;
    const definitionPolicy = witness.projectRevision.developerTasksPresent
      ? "#definition.#revision = :revision AND #definition.#developerTasks = :developerTasks"
      : "#definition.#revision = :revision AND attribute_not_exists(#definition.#developerTasks)";
    if (witness.projectRevision.developerTasksPresent) definitionValues[":developerTasks"] = witness.projectRevision.developerTasks;
    checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: witness.projectRevision.pk, sk: witness.projectRevision.sk },
      ConditionExpression: definitionPolicy, ExpressionAttributeNames: definitionNames, ExpressionAttributeValues: definitionValues } });
    if (witness.access === "granted") {
      const membership = witness.membership;
      if (membership === undefined || membership.pk !== `MEMBER#${witness.developerId}` || membership.sk !== `PROJECT#${task.project}`
        || membership.projectName !== task.project || membership.role !== "developer") return false;
      checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: membership.pk, sk: membership.sk },
        ConditionExpression: "projectName = :project AND #role = :developer", ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: { ":project": task.project, ":developer": "developer" } } });
    } else {
      const binding = witness.binding;
      if (binding === undefined || binding.pk !== `SLACK_BINDING#${binding.teamId}` || binding.sk !== `CHANNEL#${binding.channelId}`
        || binding.projectName !== task.project || typeof binding.updatedAt !== "string" || binding.updatedAt.length === 0) return false;
      checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: binding.pk, sk: binding.sk },
        ConditionExpression: "teamId = :teamId AND channelId = :channelId AND projectName = :projectName AND updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":teamId": binding.teamId, ":channelId": binding.channelId, ":projectName": task.project, ":updatedAt": binding.updatedAt } } });
    }
  }
  const unique = new Map<string, TransactItem>();
  for (const check of checks) {
    const condition = Object.values(check)[0] as { Key?: { pk?: unknown; sk?: unknown } } | undefined;
    if (condition?.Key === undefined) return false;
    const key = `${String(condition.Key.pk)}\0${String(condition.Key.sk)}`;
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(check)) return false;
    unique.set(key, check);
  }
  if (unique.size >= 100) return false;
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...unique.values()] }));
    return true;
  } catch (error) {
    if (conditional(error)) return false;
    throw error;
  }
}

/**
 * Strongly resolves workspace→task→PEOPLE. Legacy work with no pointer or PEOPLE remains allowed.
 * PEOPLE work is allowed only with a freshly qualified effective owner; every other result is
 * durably parked while preserving the original operation, invocation and charge.
 */
export async function guardTaskDispatch(deps: TaskDispatchAccessDependencies, record: DurableOutboxRecord): Promise<"ALLOWED" | "PARKED"> {
  // Terminal cleanup is independent of owner availability. It must be able to release compute,
  // workspace slots and charge after the last owner departs.
  if (record.invocation.kind === "close" || record.invocation.kind === "cancel") return "ALLOWED";
  const guardDeps: TaskDispatchAccessDependencies = deps.admission === undefined ? deps : {
    ...deps,
    documentClient: {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof GetCommand || command instanceof QueryCommand) {
          const abortSignal = deps.admission!.admitStateRead();
          const response = await deps.documentClient.send(command, { abortSignal });
          deps.admission!.assertOpen();
          return response;
        }
        if (command instanceof TransactWriteCommand && deps.remainingTimeMs !== undefined) {
          const remaining = deps.remainingTimeMs();
          if (remaining <= TASK_PAUSE_RESERVE_MS) throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
          return deps.documentClient.send(command, { abortSignal: AbortSignal.timeout(remaining) });
        }
        return deps.documentClient.send(command);
      },
    },
  };
  deps.admission?.assertOpen();
  const stored = await get<{ status?: string }>(guardDeps, outboxKey(record.id));
  if (stored?.status === "WAITING_FOR_TASK_ACCESS") return "PARKED";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pointer = await get<DeveloperTaskPointerRecord>(guardDeps, taskPointerKey(record.workspaceId));
    if (pointer === undefined) {
      deps.admission?.assertOpen();
      return "ALLOWED";
    }
    const task = await get<DeveloperTaskRecord>(guardDeps, taskKey(pointer.taskId));
    // A PARKED answer acknowledges the SQS message, so it is returned only after a durable pause
    // exists. Broken task state is retried instead of silently dropping the invocation.
    if (task === undefined || task.workspaceId !== record.workspaceId) {
      throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch state could not be verified");
    }
    if (!taskOpen(task) || task.workflow?.state === "COMPLETE") {
      throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch is no longer open");
    }
    const access = await resolveTaskDispatchPeople(guardDeps, task);
    if (access === undefined || access.status === "ALLOWED") {
      let witness: (ProjectAuthorityWitness & { taskId: string; developerId: string; project: string }) | undefined;
      if (access?.status === "ALLOWED" && deps.stateAuthorityWitnessForOwnerActor !== undefined) {
        const ownerActorId = access.ownerActorIds[0];
        if (ownerActorId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch authority witness is unavailable");
        try {
          witness = await deps.stateAuthorityWitnessForOwnerActor(task, ownerActorId);
        } catch {
          if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) {
            throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
          }
          await park(guardDeps, record, pointer, task, access.peopleRevision, "PROOF_UNAVAILABLE");
          return "PARKED";
        }
        if (witness === undefined) continue;
        if (taskOwnerKey(witness.developerId, task.taskId) !== ownerActorId) throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch authority witness is unavailable");
      }
      if (await allowedStillCurrent(guardDeps, record, pointer, task, access?.peopleRevision, witness)) {
        deps.admission?.assertOpen();
        return "ALLOWED";
      }
      continue;
    }
    if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) {
      throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
    }
    await park(guardDeps, record, pointer, task, access.peopleRevision, access.status === "OWNERLESS" ? "OWNERLESS" : "PROOF_UNAVAILABLE");
    return "PARKED";
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch access changed while it was being verified");
}

const TASK_PAUSE_RESERVE_MS = 2_000;

interface PausedTaskDispatch {
  taskId: string;
  outboxId: string;
  operationId: string;
  workspaceId: string;
  peopleRevision: number;
  workflowRevision?: number;
  workflowStage?: string;
  workflowState?: string;
}

/**
 * Explicit current-owner redrive for the one parked operation. It changes only the original
 * outbox back to PENDING, so the publisher requeues the exact invocation without a new charge.
 * Merely taking ownership, session readiness, and recovery sweeps never call this function.
 */
export async function resumeTaskDispatch(
  deps: TaskDispatchAccessDependencies & { now(): number },
  input: { task: DeveloperTaskRecord; peopleRevision: number; actorId: string; requestId: string; payloadHash: string; reauthorize?(): Promise<void> },
): Promise<boolean> {
  const auditKey = { pk: `DEVTASK#${input.task.taskId}`, sk: `TASK_ACCESS_RETRY#${input.requestId}` };
  const priorAudit = await get<{ actorId?: string; operationId?: string; payloadHash?: string }>(deps, auditKey);
  if (priorAudit !== undefined) {
    if (priorAudit.actorId !== input.actorId || priorAudit.payloadHash !== input.payloadHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry request ID was already used");
    }
    await input.reauthorize?.();
    return true;
  }
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :pause)",
    ExpressionAttributeValues: { ":pk": `DEVTASK#${input.task.taskId}`, ":pause": "TASK_ACCESS_PAUSE#" }, ConsistentRead: true,
  })) as { Items?: PausedTaskDispatch[] };
  const workspace = await get<{ activeOperationId?: string }>(deps, { pk: `WORKSPACE#${input.task.workspaceId}`, sk: "META" });
  const pauses = (response.Items ?? []).filter((pause) => pause.taskId === input.task.taskId && pause.workspaceId === input.task.workspaceId
    && pause.operationId === workspace?.activeOperationId);
  if (pauses.length === 0) return false;
  const pause = pauses.length === 1 ? pauses[0]! : undefined;
  const workflow = input.task.workflow;
  if (pause === undefined || pause.peopleRevision > input.peopleRevision || workflow === undefined
    || pause.workflowRevision !== workflow.revision || pause.workflowStage !== workflow.stage || pause.workflowState !== workflow.state) return false;
  const outbox = await get<DurableOutboxRecord>(deps, outboxKey(pause.outboxId));
  if (outbox?.status !== "WAITING_FOR_TASK_ACCESS" || outbox.operationId !== pause.operationId || outbox.workspaceId !== pause.workspaceId) return false;
  const at = new Date(deps.now()).toISOString();
  const items: TransactItem[] = [
    { Update: {
      TableName: deps.tableName, Key: outboxKey(pause.outboxId), UpdateExpression: "SET #status = :pending REMOVE taskAccessPausedAt",
      ConditionExpression: "#status = :waiting AND operationId = :operationId AND workspaceId = :workspaceId",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
        ":pending": "PENDING", ":waiting": "WAITING_FOR_TASK_ACCESS", ":operationId": pause.operationId, ":workspaceId": pause.workspaceId,
      },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(input.task.taskId),
      ConditionExpression: "workflow.#revision = :workflowRevision AND workflow.#stage = :workflowStage AND workflow.#state = :workflowState AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#revision": "revision", "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
        ":workflowRevision": pause.workflowRevision, ":workflowStage": pause.workflowStage, ":workflowState": pause.workflowState,
      },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `DEVTASK#${input.task.taskId}`, sk: "PEOPLE" },
      ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": input.peopleRevision },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${pause.workspaceId}`, sk: `OPERATION#${pause.operationId}` },
      ConditionExpression: "fence = :fence AND (#status = :accepted OR #status = :dispatching)", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":fence": outbox.invocation.fence, ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING" },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${pause.workspaceId}`, sk: "META" },
      ConditionExpression: "fence = :fence AND activeOperationId = :operationId",
      ExpressionAttributeValues: { ":fence": outbox.invocation.fence, ":operationId": pause.operationId },
    } },
    { Delete: { TableName: deps.tableName, Key: pauseKey(pause.outboxId), ConditionExpression: "operationId = :operationId", ExpressionAttributeValues: { ":operationId": pause.operationId } } },
    { Delete: { TableName: deps.tableName, Key: taskPauseKey(input.task.taskId, pause.outboxId), ConditionExpression: "operationId = :operationId", ExpressionAttributeValues: { ":operationId": pause.operationId } } },
    { Put: { TableName: deps.tableName, Item: { ...auditKey, entityType: "TASK_ACCESS_RETRY", schemaVersion: 1, taskId: input.task.taskId,
      requestId: input.requestId, actorId: input.actorId, payloadHash: input.payloadHash, outboxId: pause.outboxId, operationId: pause.operationId, at }, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (!conditional(error)) throw error;
    const audit = await get<{ actorId?: string; operationId?: string; payloadHash?: string }>(deps, auditKey);
    const current = await get<{ status?: string; operationId?: string }>(deps, outboxKey(pause.outboxId));
    if (audit?.actorId === input.actorId && audit.operationId === pause.operationId && audit.payloadHash === input.payloadHash && current?.status === "PENDING") {
      await input.reauthorize?.();
      return true;
    }
    throw error;
  }
}
