import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type DocumentClient = { send(command: unknown): Promise<unknown> };

export interface GithubMergeReadBudget {
  signal: AbortSignal;
  beforeRequest: () => void;
}
export type MergeRecoveryResult =
  | { kind: "OBSERVED" }
  | { kind: "RETRY"; retryAt: number; scope: "task" | "github-global" }
  | { kind: "TERMINAL"; release: "confirmed" | "queued" }
  | { kind: "MISSING" };

export interface MergeRecoveryDependencies {
  documentClient: DocumentClient;
  tableName: string;
  now: () => number;
  reconcile: (taskId: string, budget: GithubMergeReadBudget) => Promise<MergeRecoveryResult>;
  validateSeed?: (taskId: string) => Promise<boolean>;
}

interface RecoveryRow {
  pk: string;
  sk: string;
  entityType: typeof RECOVERY_PK;
  taskId: string;
  attempts: number;
  nextAttemptAt: number;
  dispatchDuePk: typeof RECOVERY_PK;
  dispatchDueSk: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
}

interface TaskRecord {
  taskId: string;
  workspaceId?: string;
  releasedAt?: string;
  closedAt?: string;
  charge?: {
    member?: { pk?: string; sk?: string };
    organization?: { pk?: string; sk?: string };
  };
}

interface GlobalSweepRow {
  leaseToken?: string;
  nextSweepAt?: number;
}

type Settlement = "committed" | "stale" | "unknown";

const RECOVERY_PK = "WORKFLOW_MERGE_RECOVERY" as const;
const SWEEP_PK = "WORKFLOW_MERGE_SWEEP";
const SWEEP_SK = "META";
const DUE_INDEX = "workflow-dispatch-due";
const LEASE_MS = 30_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const GITHUB_BUDGET_MS = 20_000;
const GITHUB_START_RESERVE_MS = 2_000;
const MAX_ROWS = 10;
const MAX_REQUESTS = 256;
const RETIRED_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SEED_TASKS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class GithubBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubBudgetExhaustedError";
  }
}

function validTaskId(taskId: string): boolean {
  return UUID.test(taskId);
}

function dueKey(at: number, taskId: string): string {
  return `${new Date(at).toISOString()}#${taskId}`;
}

function isConditional(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
}

function asItem(response: unknown): Record<string, unknown> | undefined {
  if (response === null || typeof response !== "object") return undefined;
  const item = (response as { Item?: unknown }).Item;
  return item !== null && typeof item === "object" ? item as Record<string, unknown> : undefined;
}

async function readItem(
  dependencies: Pick<MergeRecoveryDependencies, "documentClient" | "tableName">,
  key: { pk: string; sk: string },
): Promise<Record<string, unknown> | undefined> {
  return asItem(await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: key,
    ConsistentRead: true,
  })));
}

function recoveryRow(item: Record<string, unknown> | undefined): RecoveryRow | undefined {
  if (item === undefined
    || item.pk !== RECOVERY_PK
    || typeof item.sk !== "string"
    || item.entityType !== RECOVERY_PK
    || typeof item.taskId !== "string"
    || !validTaskId(item.taskId)
    || item.sk !== `TASK#${item.taskId}`
    || typeof item.attempts !== "number"
    || !Number.isInteger(item.attempts)
    || item.attempts < 0
    || typeof item.nextAttemptAt !== "number"
    || !Number.isFinite(item.nextAttemptAt)
    || item.dispatchDuePk !== RECOVERY_PK
    || typeof item.dispatchDueSk !== "string"
    || item.dispatchDueSk !== dueKey(item.nextAttemptAt, item.taskId)
    || (item.leaseToken !== undefined && typeof item.leaseToken !== "string")
    || (item.leaseExpiresAt !== undefined && (typeof item.leaseExpiresAt !== "number" || !Number.isFinite(item.leaseExpiresAt)))) {
    return undefined;
  }
  return item as unknown as RecoveryRow;
}

function taskRecord(item: Record<string, unknown> | undefined, taskId: string): TaskRecord | undefined {
  if (item === undefined || item.taskId !== taskId) return undefined;
  return item as unknown as TaskRecord;
}

function retryDelay(attempts: number): number {
  return Math.min(SWEEP_INTERVAL_MS * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export function mergeRecoveryItem(tableName: string, taskId: string, now: string): TransactItems[number] {
  if (!validTaskId(taskId)) throw new Error("workflow merge recovery taskId must be a lowercase UUID");
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error("workflow merge recovery now must be an ISO timestamp");
  return { Update: {
    TableName: tableName,
    Key: { pk: RECOVERY_PK, sk: `TASK#${taskId}` },
    UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), taskId = if_not_exists(taskId, :task), createdAt = if_not_exists(createdAt, :now), updatedAt = :now, attempts = if_not_exists(attempts, :zero), nextAttemptAt = if_not_exists(nextAttemptAt, :at), dispatchDuePk = if_not_exists(dispatchDuePk, :pk), dispatchDueSk = if_not_exists(dispatchDueSk, :due)",
    ExpressionAttributeValues: {
      ":entity": RECOVERY_PK,
      ":task": taskId,
      ":now": now,
      ":zero": 0,
      ":at": at,
      ":pk": RECOVERY_PK,
      ":due": dueKey(at, taskId),
    },
  } };
}

export async function seedWorkflowMergeRecovery(
  dependencies: MergeRecoveryDependencies,
  taskIds: readonly string[],
): Promise<{ seeded: number; skipped: number }> {
  if (taskIds.length > MAX_SEED_TASKS) throw new Error(`workflow merge recovery seeds are limited to ${MAX_SEED_TASKS} task IDs`);
  if (dependencies.validateSeed === undefined) throw new Error("workflow merge recovery seed validator is required");
  if (taskIds.some((taskId) => !validTaskId(taskId))) throw new Error("every workflow merge recovery seed must be a lowercase UUID");
  if (new Set(taskIds).size !== taskIds.length) throw new Error("workflow merge recovery seed task IDs must be unique");

  let seeded = 0;
  let skipped = 0;
  for (const taskId of taskIds) {
    const allowed = await dependencies.validateSeed(taskId);
    if (!allowed) {
      skipped += 1;
      continue;
    }
    const task = taskRecord(await readItem(dependencies, { pk: `DEVTASK#${taskId}`, sk: "META" }), taskId);
    if (task === undefined) {
      skipped += 1;
      continue;
    }
    const item = mergeRecoveryItem(dependencies.tableName, taskId, new Date(dependencies.now()).toISOString());
    await dependencies.documentClient.send(new UpdateCommand(item.Update!));
    seeded += 1;
  }
  return { seeded, skipped };
}

async function claimGlobalSweep(dependencies: MergeRecoveryDependencies, now: number, token: string): Promise<boolean> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: SWEEP_SK },
      UpdateExpression: "SET entityType = :entity, leaseToken = :token, leaseExpiresAt = :lease, nextSweepAt = :next, createdAt = if_not_exists(createdAt, :nowIso), updatedAt = :nowIso",
      ConditionExpression: "(attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now) AND (attribute_not_exists(nextSweepAt) OR nextSweepAt <= :now)",
      ExpressionAttributeValues: {
        ":entity": SWEEP_PK,
        ":token": token,
        ":lease": now + LEASE_MS,
        ":next": now + SWEEP_INTERVAL_MS,
        ":now": now,
        ":nowIso": new Date(now).toISOString(),
      },
    }));
    return true;
  } catch {
    return false;
  }
}

async function releaseGlobalSweep(dependencies: MergeRecoveryDependencies, token: string, now: number): Promise<void> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: SWEEP_SK },
      UpdateExpression: "SET updatedAt = :now REMOVE leaseToken, leaseExpiresAt",
      ConditionExpression: "leaseToken = :token",
      ExpressionAttributeValues: { ":now": new Date(now).toISOString(), ":token": token },
    }));
  } catch {
    // A stale or ambiguous global settlement remains fenced by its lease and nextSweepAt.
  }
}

async function queryDueRows(dependencies: MergeRecoveryDependencies, now: number): Promise<Record<string, unknown>[]> {
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    IndexName: DUE_INDEX,
    KeyConditionExpression: "dispatchDuePk = :pk AND dispatchDueSk BETWEEN :low AND :high",
    ExpressionAttributeValues: {
      ":pk": RECOVERY_PK,
      ":low": "0",
      ":high": `${new Date(now).toISOString()}:`,
    },
    Limit: MAX_ROWS,
  })) as { Items?: Record<string, unknown>[] };
  return response.Items ?? [];
}

async function quarantine(
  dependencies: MergeRecoveryDependencies,
  item: Record<string, unknown>,
  now: number,
  errorClass: "MALFORMED_DISCOVERY" | "MISSING_TASK" | "RECONCILE_MISSING",
  token?: string,
): Promise<Settlement> {
  if (item.pk !== RECOVERY_PK || typeof item.sk !== "string" || typeof item.dispatchDueSk !== "string") return "stale";
  const condition = token === undefined ? "dispatchDueSk = :due" : "dispatchDueSk = :due AND leaseToken = :token";
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET recoveryStatus = :status, recoveryErrorClass = :error, updatedAt = :now, indexExpiresAt = :ttl REMOVE nextAttemptAt, dispatchDuePk, dispatchDueSk, leaseToken, leaseExpiresAt",
      ConditionExpression: condition,
      ExpressionAttributeValues: {
        ":due": item.dispatchDueSk,
        ":status": "QUARANTINED",
        ":error": errorClass,
        ":now": new Date(now).toISOString(),
        ":ttl": Math.floor(now / 1_000) + RETIRED_TTL_SECONDS,
        ...(token === undefined ? {} : { ":token": token }),
      },
    }));
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function claimRow(
  dependencies: MergeRecoveryDependencies,
  row: RecoveryRow,
  now: number,
  token: string,
): Promise<RecoveryRow | undefined> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET leaseToken = :token, leaseExpiresAt = :lease, updatedAt = :nowIso, attempts = if_not_exists(attempts, :zero) + :one, nextAttemptAt = :lease, dispatchDueSk = :leaseKey",
      ConditionExpression: "entityType = :entity AND taskId = :task AND nextAttemptAt = :dueAt AND dispatchDuePk = :pk AND dispatchDueSk = :dueKey AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)",
      ExpressionAttributeValues: {
        ":token": token,
        ":lease": now + LEASE_MS,
        ":nowIso": new Date(now).toISOString(),
        ":zero": 0,
        ":one": 1,
        ":entity": RECOVERY_PK,
        ":task": row.taskId,
        ":dueAt": row.nextAttemptAt,
        ":pk": RECOVERY_PK,
        ":dueKey": row.dispatchDueSk,
        ":now": now,
        ":leaseKey": dueKey(now + LEASE_MS, row.taskId),
      },
    }));
  } catch {
    return undefined;
  }
  const claimed = recoveryRow(await readItem(dependencies, { pk: row.pk, sk: row.sk }));
  return claimed?.leaseToken === token ? claimed : undefined;
}

async function settleActive(
  dependencies: MergeRecoveryDependencies,
  row: RecoveryRow,
  token: string,
  now: number,
  nextAttemptAt: number,
  attempts: number,
): Promise<Settlement> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET attempts = :attempts, nextAttemptAt = :next, dispatchDuePk = :pk, dispatchDueSk = :due, updatedAt = :now REMOVE leaseToken, leaseExpiresAt",
      ConditionExpression: "leaseToken = :token",
      ExpressionAttributeValues: {
        ":attempts": attempts,
        ":next": nextAttemptAt,
        ":pk": RECOVERY_PK,
        ":due": dueKey(nextAttemptAt, row.taskId),
        ":now": new Date(now).toISOString(),
        ":token": token,
      },
    }));
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function retire(
  dependencies: MergeRecoveryDependencies,
  row: RecoveryRow,
  token: string,
  now: number,
): Promise<Settlement> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET recoveryStatus = :status, retiredAt = :now, updatedAt = :now, indexExpiresAt = :ttl REMOVE nextAttemptAt, dispatchDuePk, dispatchDueSk, leaseToken, leaseExpiresAt",
      ConditionExpression: "leaseToken = :token",
      ExpressionAttributeValues: {
        ":status": "RETIRED",
        ":now": new Date(now).toISOString(),
        ":ttl": Math.floor(now / 1_000) + RETIRED_TTL_SECONDS,
        ":token": token,
      },
    }));
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function setGlobalCooldown(
  dependencies: MergeRecoveryDependencies,
  token: string,
  retryAt: number,
  now: number,
): Promise<Settlement> {
  let global: GlobalSweepRow;
  try {
    global = await readItem(dependencies, { pk: SWEEP_PK, sk: SWEEP_SK }) ?? {};
  } catch {
    return "unknown";
  }
  if (global.leaseToken !== token || typeof global.nextSweepAt !== "number") return "stale";
  const next = Math.max(global.nextSweepAt, retryAt);
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: SWEEP_SK },
      UpdateExpression: "SET nextSweepAt = :next, updatedAt = :now",
      ConditionExpression: "leaseToken = :token AND nextSweepAt = :current",
      ExpressionAttributeValues: {
        ":next": next,
        ":now": new Date(now).toISOString(),
        ":token": token,
        ":current": global.nextSweepAt,
      },
    }));
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function terminalReceipt(
  dependencies: MergeRecoveryDependencies,
  taskId: string,
): Promise<"confirmed" | "queued" | "missing" | "unproven"> {
  const task = taskRecord(await readItem(dependencies, { pk: `DEVTASK#${taskId}`, sk: "META" }), taskId);
  if (task === undefined) return "missing";

  if (task.closedAt !== undefined) {
    if (typeof task.workspaceId !== "string"
      || typeof task.charge?.member?.pk !== "string"
      || typeof task.charge.member.sk !== "string"
      || typeof task.charge?.organization?.pk !== "string"
      || typeof task.charge.organization.sk !== "string") return "unproven";
    const workspace = await readItem(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
    const member = await readItem(dependencies, { pk: task.charge.member.pk, sk: task.charge.member.sk });
    const organization = await readItem(dependencies, { pk: task.charge.organization.pk, sk: task.charge.organization.sk });
    const tasks = member?.tasks;
    const memberReleased = typeof member?.count === "number" && member.count >= 0 && tasks instanceof Set && !tasks.has(taskId);
    const organizationReleased = typeof organization?.count === "number" && organization.count >= 0
      && (!(organization.tasks instanceof Set) || !organization.tasks.has(taskId));
    return workspace?.status === "CLOSED" && memberReleased && organizationReleased ? "confirmed" : "unproven";
  }

  if (task.releasedAt !== undefined && typeof task.workspaceId === "string") {
    const workspace = await readItem(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
    if (workspace?.status === "CLOSED") return "confirmed";
  }

  const marker = await readItem(dependencies, { pk: "FINISHED_RELEASE", sk: `TASK#${taskId}` });
  return marker?.entityType === "FINISHED_RELEASE" && marker.taskId === taskId ? "queued" : "unproven";
}

function makeBudget(dependencies: MergeRecoveryDependencies, startedAt: number): {
  budget: GithubMergeReadBudget;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
} {
  const controller = new AbortController();
  let requests = 0;
  const timer = setTimeout(() => controller.abort(), GITHUB_BUDGET_MS);
  timer.unref();
  return {
    controller,
    timer,
    budget: {
      signal: controller.signal,
      beforeRequest: () => {
        if (controller.signal.aborted || dependencies.now() >= startedAt + GITHUB_BUDGET_MS) {
          controller.abort();
          throw new GithubBudgetExhaustedError("workflow merge recovery GitHub deadline exhausted");
        }
        if (requests >= MAX_REQUESTS) {
          controller.abort();
          throw new GithubBudgetExhaustedError("workflow merge recovery GitHub request budget exhausted");
        }
        requests += 1;
      },
    },
  };
}

export async function runDueWorkflowMergeRecovery(
  dependencies: MergeRecoveryDependencies,
): Promise<{ attempted: number; reconciled: number; deferred: number }> {
  const startedAt = dependencies.now();
  const globalToken = randomUUID();
  const result = { attempted: 0, reconciled: 0, deferred: 0 };
  if (!await claimGlobalSweep(dependencies, startedAt, globalToken)) return result;

  const { budget, controller, timer } = makeBudget(dependencies, startedAt);
  let keepGlobalLease = false;
  try {
    let discovered: Record<string, unknown>[];
    try {
      discovered = await queryDueRows(dependencies, startedAt);
    } catch {
      keepGlobalLease = true;
      return result;
    }

    for (const discovery of discovered) {
      if (dependencies.now() > startedAt + GITHUB_BUDGET_MS - GITHUB_START_RESERVE_MS) break;
      if (typeof discovery.pk !== "string" || typeof discovery.sk !== "string") {
        result.deferred += 1;
        continue;
      }
      let current: Record<string, unknown> | undefined;
      try {
        current = await readItem(dependencies, { pk: discovery.pk, sk: discovery.sk });
      } catch {
        result.deferred += 1;
        keepGlobalLease = true;
        break;
      }
      const row = recoveryRow(current);
      if (row === undefined) {
        const settled = await quarantine(dependencies, current ?? discovery, dependencies.now(), "MALFORMED_DISCOVERY");
        result.deferred += 1;
        if (settled === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }
      if (row.nextAttemptAt > dependencies.now() || (row.leaseExpiresAt !== undefined && row.leaseExpiresAt > dependencies.now())) continue;

      let task: TaskRecord | undefined;
      try {
        task = taskRecord(await readItem(dependencies, { pk: `DEVTASK#${row.taskId}`, sk: "META" }), row.taskId);
      } catch {
        result.deferred += 1;
        keepGlobalLease = true;
        break;
      }
      if (task === undefined) {
        const settled = await quarantine(dependencies, row as unknown as Record<string, unknown>, dependencies.now(), "MISSING_TASK");
        result.deferred += 1;
        if (settled === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }

      const rowToken = randomUUID();
      const claimed = await claimRow(dependencies, row, dependencies.now(), rowToken);
      if (claimed === undefined) continue;
      result.attempted += 1;

      let outcome: MergeRecoveryResult;
      try {
        outcome = await dependencies.reconcile(claimed.taskId, budget);
      } catch (error) {
        const now = dependencies.now();
        const settlement = await settleActive(dependencies, claimed, rowToken, now, now + retryDelay(claimed.attempts), claimed.attempts);
        result.deferred += 1;
        if (settlement === "unknown" || error instanceof GithubBudgetExhaustedError || controller.signal.aborted) {
          keepGlobalLease = settlement === "unknown";
          break;
        }
        continue;
      }

      const now = dependencies.now();
      if (outcome.kind === "MISSING") {
        const settlement = await quarantine(dependencies, claimed as unknown as Record<string, unknown>, now, "RECONCILE_MISSING", rowToken);
        result.deferred += 1;
        if (settlement === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }

      if (outcome.kind === "RETRY" && outcome.scope === "github-global") {
        const cooldown = await setGlobalCooldown(dependencies, globalToken, outcome.retryAt, now);
        result.deferred += 1;
        if (cooldown === "committed") {
          const next = Math.max(outcome.retryAt, now + retryDelay(claimed.attempts));
          const settlement = await settleActive(dependencies, claimed, rowToken, now, next, claimed.attempts);
          if (settlement === "unknown") keepGlobalLease = true;
        } else {
          keepGlobalLease = true;
        }
        return result;
      }

      if (outcome.kind === "TERMINAL") {
        let receipt: "confirmed" | "queued" | "missing" | "unproven";
        try {
          receipt = await terminalReceipt(dependencies, claimed.taskId);
        } catch {
          receipt = "unproven";
        }
        if (receipt === "missing") {
          const settlement = await quarantine(dependencies, claimed as unknown as Record<string, unknown>, now, "MISSING_TASK", rowToken);
          result.deferred += 1;
          if (settlement === "unknown") {
            keepGlobalLease = true;
            break;
          }
          continue;
        }
        if (receipt === "confirmed" || receipt === "queued") {
          const settlement = await retire(dependencies, claimed, rowToken, now);
          if (settlement === "committed") result.reconciled += 1;
          else result.deferred += 1;
          if (settlement === "unknown") {
            keepGlobalLease = true;
            break;
          }
          continue;
        }
        const settlement = await settleActive(dependencies, claimed, rowToken, now, now + retryDelay(claimed.attempts), claimed.attempts);
        result.deferred += 1;
        if (settlement === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }

      const next = outcome.kind === "RETRY"
        ? Math.max(outcome.retryAt, now + retryDelay(claimed.attempts))
        : now + SWEEP_INTERVAL_MS;
      const attempts = outcome.kind === "OBSERVED" ? 0 : claimed.attempts;
      const settlement = await settleActive(dependencies, claimed, rowToken, now, next, attempts);
      if (settlement === "committed" && outcome.kind === "OBSERVED") result.reconciled += 1;
      else result.deferred += 1;
      if (settlement === "unknown") {
        keepGlobalLease = true;
        break;
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!keepGlobalLease) await releaseGlobalSweep(dependencies, globalToken, dependencies.now());
  }
}
