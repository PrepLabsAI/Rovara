import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  E2EModelDayBudgetRequestSchema, E2E_MODEL_BUDGET_SCHEMA_VERSION, E2E_MODEL_ROUTE_DEFAULT_BUDGETS, INDEX_EXPIRY_ATTRIBUTE, agentXError, indexExpiresAt,
  type E2EModelDayBudgetRequest, type E2EModelDayBudgetResponse,
} from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";
import { deriveE2EAgentRoute, e2eModelBudgetKey, e2eModelBudgetReservationKey, isTransientAwsFault, type E2EAgentInstallation } from "./model-route-registry.js";

/**
 * The worker's callback for the project's day budget (M1.4 Task 4.3a, Ruling DB-8): `e2e-model-budget`, one reserve, settle or release at a time. The worker has no database access,
 * so this is where a model call is charged, and everything that decides what it may be charged is the broker's:
 *
 * - The project is the one the operation's task belongs to. A body names a reservation and a group run, never a project, a day or a cap.
 * - The day caps are the route's, derived here from the installation's settings; the worker's limits are never read.
 * - Only a running CHECKS operation whose admission reference says `agentSteps: true` (and is not a baseline) may call it, for a group run of that reference.
 *
 * Rows: the day's `{ inputTokens, calls }` and one reservation row per call, keyed by the reservation id the worker made, which is what makes every stage idempotent.
 * `reserve` is one transaction (the reservation, with `attribute_not_exists`, and the day's conditional increment), so a repeat is answered from the stored row and a reserve over
 * a cap writes nothing. `settle` and `release` are each one transaction that moves the reservation off `open` and corrects the day; whichever came first stays, and the other is
 * refused. A DynamoDB fault that a later attempt can get past is rethrown, so the worker's retry (settle and release) can take it.
 */

export interface E2EModelBudgetDependencies {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
  /** The installation's worker model settings, the same the dispatch check reads. Absent or unreadable: the owner's default caps (which every derived route carries). */
  e2eAgentInstallation?: () => Promise<E2EAgentInstallation>;
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The part of an operation record the callback reads. */
export interface E2EModelBudgetOperation {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  workflowMode?: string | undefined;
  workflowE2EAdmission?: { taskId: string; groupRunIds: readonly string[]; agentSteps?: true | undefined; purpose?: string | undefined } | undefined;
}

type Stored = { status?: unknown; day?: unknown; reservedInputTokens?: unknown; groupRunId?: unknown; operationId?: unknown; entityType?: unknown };

const forbidden = (why: string) => agentXError("CALLBACK_FORBIDDEN", why);
const utcDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);
const answer = (reservationId: string, status: E2EModelDayBudgetResponse["status"]): E2EModelDayBudgetResponse => ({ schemaVersion: E2E_MODEL_BUDGET_SCHEMA_VERSION, reservationId, status });
const statusOf = (status: unknown): E2EModelDayBudgetResponse["status"] | undefined => (status === "open" ? "reserved" : status === "settled" ? "settled" : status === "released" ? "released" : undefined);

async function dayCaps(dependencies: E2EModelBudgetDependencies): Promise<{ maxInputTokens: number; maxCalls: number }> {
  let budgets: { maxInputTokensPerProjectDay: number; maxCallsPerProjectDay: number } = E2E_MODEL_ROUTE_DEFAULT_BUDGETS;
  if (dependencies.e2eAgentInstallation !== undefined) {
    try {
      const derived = deriveE2EAgentRoute(await dependencies.e2eAgentInstallation());
      if (derived.status === "available") budgets = derived.definition.budgets;
    } catch (error) {
      if (isTransientAwsFault(error)) throw error;
    }
  }
  return { maxInputTokens: budgets.maxInputTokensPerProjectDay, maxCalls: budgets.maxCallsPerProjectDay };
}

export async function handleE2EModelBudgetCallback(dependencies: E2EModelBudgetDependencies, operation: E2EModelBudgetOperation, rawBody: unknown): Promise<E2EModelDayBudgetResponse> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || operation.status !== "RUNNING" || reference === undefined
    || reference.agentSteps !== true || reference.purpose === "baseline") {
    throw forbidden("the model budget is available only to a running CHECKS operation whose admission has AI navigation steps");
  }
  const body: E2EModelDayBudgetRequest = E2EModelDayBudgetRequestSchema.parse(rawBody);
  if (body.stage === "reserve" && !reference.groupRunIds.includes(body.groupRunId)) throw forbidden("the model budget reservation is for a group this operation does not run");
  // The project comes from the task the operation belongs to, and from nothing the worker said.
  const task = (await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: taskKey(reference.taskId), ConsistentRead: true }))).Item as
    { workspaceId?: unknown; project?: unknown; closedAt?: unknown } | undefined;
  if (task === undefined || task.workspaceId !== operation.workspaceId || typeof task.project !== "string" || task.project === "" || task.closedAt !== undefined) {
    throw forbidden("the model budget is not available for this operation's task");
  }
  const project = task.project;
  if (body.stage === "reserve") return reserve(dependencies, operation, project, body);
  return correct(dependencies, operation, project, body);
}

async function readReservation(dependencies: E2EModelBudgetDependencies, project: string, reservationId: string): Promise<Stored | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: e2eModelBudgetReservationKey(project, reservationId), ConsistentRead: true }));
  const item = response.Item as Stored | undefined;
  return item?.entityType === "E2E_MODEL_BUDGET_RESERVATION" ? item : undefined;
}

type Cancelled = Error & { CancellationReasons?: Array<{ Code?: string }> };
const cancelledReasons = (error: unknown): Array<{ Code?: string }> | undefined => (error instanceof Error && error.name === "TransactionCanceledException" ? (error as Cancelled).CancellationReasons ?? [] : undefined);

async function reserve(dependencies: E2EModelBudgetDependencies, operation: E2EModelBudgetOperation, project: string, body: Extract<E2EModelDayBudgetRequest, { stage: "reserve" }>): Promise<E2EModelDayBudgetResponse> {
  const limits = await dayCaps(dependencies);
  // Without room for even this call on an empty day, nothing could ever be reserved, and nothing is written.
  if (body.inputTokens > limits.maxInputTokens) return answer(body.reservationId, "exhausted");
  const day = utcDay(dependencies.now());
  const expires = indexExpiresAt(`${day}T23:59:59.000Z`);
  const reservationKey = e2eModelBudgetReservationKey(project, body.reservationId);
  const sameRequest = (stored: Stored) => stored.groupRunId === body.groupRunId && stored.reservedInputTokens === body.inputTokens && stored.operationId === operation.id;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)", Item: { ...reservationKey, entityType: "E2E_MODEL_BUDGET_RESERVATION",
        schemaVersion: 1, status: "open", day, reservedInputTokens: body.inputTokens, groupRunId: body.groupRunId, operationId: operation.id, [INDEX_EXPIRY_ATTRIBUTE]: expires } } },
      { Update: { TableName: dependencies.tableName, Key: e2eModelBudgetKey(project, day),
        UpdateExpression: "ADD #tokens :reserved, #calls :one SET entityType = :entityType, #expires = :expires",
        ConditionExpression: "(attribute_not_exists(#tokens) OR #tokens <= :tokenRoom) AND (attribute_not_exists(#calls) OR #calls <= :callRoom)",
        ExpressionAttributeNames: { "#tokens": "inputTokens", "#calls": "calls", "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: { ":reserved": body.inputTokens, ":one": 1, ":entityType": "E2E_MODEL_BUDGET", ":tokenRoom": limits.maxInputTokens - body.inputTokens,
          ":callRoom": limits.maxCalls - 1, ":expires": expires } } },
    ] }));
    return answer(body.reservationId, "reserved");
  } catch (error) {
    const reasons = cancelledReasons(error);
    if (reasons === undefined) throw error;
    if (reasons[0]?.Code === "ConditionalCheckFailed") {
      // A repeated reserve (a redelivery): the stored row answers, if it is this very request.
      const stored = await readReservation(dependencies, project, body.reservationId);
      const status = stored === undefined ? undefined : statusOf(stored.status);
      if (stored === undefined || status === undefined || !sameRequest(stored)) throw forbidden("the model budget reservation id is already used by another request");
      return answer(body.reservationId, status);
    }
    if (reasons[1]?.Code === "ConditionalCheckFailed") return answer(body.reservationId, "exhausted");
    // Anything else (a conflicting transaction, an unreadable reason) is not an answer about the budget.
    throw error;
  }
}

async function correct(dependencies: E2EModelBudgetDependencies, operation: E2EModelBudgetOperation, project: string,
  body: Extract<E2EModelDayBudgetRequest, { stage: "settle" | "release" }>): Promise<E2EModelDayBudgetResponse> {
  const stored = await readReservation(dependencies, project, body.reservationId);
  if (stored === undefined || stored.operationId !== operation.id || typeof stored.day !== "string" || !Number.isSafeInteger(stored.reservedInputTokens)) {
    throw forbidden("the model budget reservation is not this operation's");
  }
  const reserved = stored.reservedInputTokens as number;
  const settling = body.stage === "settle";
  // A second settle (or release) of the same reservation is a no-op; the other of the two after the first is refused.
  if (stored.status === (settling ? "settled" : "released")) return answer(body.reservationId, settling ? "settled" : "released");
  if (stored.status !== "open") throw forbidden(`the model budget reservation was already ${String(stored.status)}`);
  const dayKey = e2eModelBudgetKey(project, stored.day);
  const delta = settling ? body.actualInputTokens - reserved : -reserved;
  const names = { "#tokens": "inputTokens", "#calls": "calls", "#status": "status" };
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: dependencies.tableName, Key: e2eModelBudgetReservationKey(project, body.reservationId),
        UpdateExpression: settling ? "SET #status = :next, settledInputTokens = :actual" : "SET #status = :next",
        ConditionExpression: "attribute_exists(pk) AND #status = :open", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":next": settling ? "settled" : "released", ":open": "open", ...(settling ? { ":actual": body.actualInputTokens } : {}) } } },
      { Update: { TableName: dependencies.tableName, Key: dayKey,
        // The day's row must exist and hold at least what is taken back, so a counter can never go below zero.
        UpdateExpression: settling ? "ADD #tokens :delta" : "ADD #tokens :delta, #calls :minusOne",
        ConditionExpression: settling ? "attribute_exists(pk) AND #tokens >= :tokenFloor" : "attribute_exists(pk) AND #tokens >= :tokenFloor AND #calls >= :callFloor",
        ExpressionAttributeNames: settling ? { "#tokens": names["#tokens"] } : { "#tokens": names["#tokens"], "#calls": names["#calls"] },
        ExpressionAttributeValues: { ":delta": delta, ":tokenFloor": delta < 0 ? -delta : 0, ...(settling ? {} : { ":minusOne": -1, ":callFloor": 1 }) } } },
    ] }));
    return answer(body.reservationId, settling ? "settled" : "released");
  } catch (error) {
    const reasons = cancelledReasons(error);
    if (reasons === undefined) throw error;
    // A racing settle or release moved the reservation first: what stands is answered, or refused when it is the other kind.
    const now = await readReservation(dependencies, project, body.reservationId);
    if (now?.status === (settling ? "settled" : "released")) return answer(body.reservationId, settling ? "settled" : "released");
    if (now !== undefined && now.status !== "open") throw forbidden(`the model budget reservation was already ${String(now.status)}`);
    if (reasons.some((reason) => reason.Code === "TransactionConflict")) throw error;
    throw forbidden("the project's day budget cannot take this correction");
  }
}
