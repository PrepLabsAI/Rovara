// packages/broker/src/aws/admin-change-audit.ts
// Spec 025 E3, FR-051, FR-052: the audit record of each admin change request, in the TurnRecords
// table (30 days by TTL), under its own export partition. Written once, then only stepped forward:
// the outcome, once set, never changes, and no route writes this record. Log lines carry IDs only.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_CHANGES_PARTITION, ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX, AdminChangeAuditRecordSchema, adminChangeAuditKeys, agentXError, outcomeOfStatus, redactSecrets,
  type AdminChangeAuditRecord, type AdminChangeOutcome, type RefusedAttemptReason,
} from "@agentx/contracts";

export interface AuditStore {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  log(entry: Record<string, unknown>): void;
  metric(outcome: AdminChangeOutcome): void;
}
const STORAGE_KEYS = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt", "entityType"]);
const CURSOR_INVALID = "cursor is invalid; start again without it";

export type AuditStep = Partial<Pick<AdminChangeAuditRecord, "status" | "confirmationRequestedAt" | "answeredAt" | "appliedAt" | "failedAt" | "expiredAt" | "methodUsed" | "pressedBy" | "result" | "error">>;
// A step or attempt is checked before it is written: a value the record's schema refuses would
// otherwise make the whole record unreadable, and so hide it from every read and export.
const AuditStepSchema = AdminChangeAuditRecordSchema.pick({
  status: true, confirmationRequestedAt: true, answeredAt: true, appliedAt: true, failedAt: true, expiredAt: true, methodUsed: true, pressedBy: true, result: true, error: true,
}).partial().strict();
const RefusedAttemptsSchema = AdminChangeAuditRecordSchema.shape.refusedAttempts;

/** The proposal's put, for a transaction; the proposed change holds no secret value (FR-051). */
export function proposalItem(tableName: string, record: AdminChangeAuditRecord): { Put: Record<string, unknown> } {
  const safe = AdminChangeAuditRecordSchema.parse({
    ...record,
    change: redactSecrets(record.change) as Record<string, unknown>,
    effect: redactSecrets(record.effect) as string,
    ...(record.result === undefined ? {} : { result: redactSecrets(record.result) as Record<string, unknown> }),
    ...(record.error === undefined ? {} : { error: redactSecrets(record.error) as AdminChangeAuditRecord["error"] }),
    // A proposal written already settled keeps the outcome its metric counts.
    ...(record.outcome === undefined && outcomeOfStatus(record.status) !== undefined ? { outcome: outcomeOfStatus(record.status) } : {}),
  });
  return { Put: { TableName: tableName, Item: { ...adminChangeAuditKeys(safe.changeId, safe.proposedAt), entityType: "ADMIN_CHANGE_AUDIT", ...safe }, ConditionExpression: "attribute_not_exists(pk)" } };
}

/** One step forward, for a transaction: never once an outcome is set, and only on an existing record. */
export function auditStepItem(tableName: string, changeId: string, step: AuditStep): { Update: Record<string, unknown> } {
  const safe = AuditStepSchema.parse({
    ...step,
    ...(step.result === undefined ? {} : { result: redactSecrets(step.result) }),
    ...(step.error === undefined ? {} : { error: redactSecrets(step.error) }),
  });
  const outcome = safe.status === undefined ? undefined : outcomeOfStatus(safe.status);
  const fields: Record<string, unknown> = { ...safe, ...(outcome === undefined ? {} : { outcome }) };
  const names: Record<string, string> = { "#outcome": "outcome" };
  const values: Record<string, unknown> = {};
  const sets = Object.entries(fields).filter(([, value]) => value !== undefined).map(([name, value], index) => {
    names[`#f${index}`] = name;
    values[`:v${index}`] = value;
    return `#f${index} = :v${index}`;
  });
  if (sets.length === 0) throw new Error("an audit step must set at least one field");
  return { Update: {
    TableName: tableName,
    Key: { pk: `CHANGE#${changeId}`, sk: "AUDIT" },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#outcome)",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  } };
}

export async function writeProposal(store: AuditStore, record: AdminChangeAuditRecord): Promise<void> {
  await store.documentClient.send(new PutCommand(proposalItem(store.tableName, record).Put as never));
  const outcome = outcomeOfStatus(record.status);
  if (outcome !== undefined) store.metric(outcome);
}

export async function recordAuditStep(store: AuditStore, changeId: string, proposedAt: string, step: AuditStep): Promise<void> {
  if (Object.values(step).every((value) => value === undefined)) return;
  try {
    await store.documentClient.send(new UpdateCommand(auditStepItem(store.tableName, changeId, step).Update as never));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      store.log({ event: "admin_change.audit_step_ignored", changeId, proposedAt });
      return;
    }
    throw error;
  }
  const outcome = step.status === undefined ? undefined : outcomeOfStatus(step.status);
  if (outcome !== undefined) store.metric(outcome);
}

export async function recordRefusedAttempt(store: AuditStore, changeId: string, attempt: { at: string; reason: RefusedAttemptReason; slackUserId?: string }): Promise<void> {
  const [checked] = RefusedAttemptsSchema.parse([attempt]) ?? [];
  const current = await readAudit(store, changeId);
  if (current === undefined || (current.refusedAttempts?.length ?? 0) >= ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX) return;
  await store.documentClient.send(new UpdateCommand({
    TableName: store.tableName,
    Key: { pk: `CHANGE#${changeId}`, sk: "AUDIT" },
    UpdateExpression: "SET refusedAttempts = list_append(if_not_exists(refusedAttempts, :empty), :attempt)",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":empty": [], ":attempt": [checked] },
  }));
}

function parse(item: Record<string, unknown> | undefined): AdminChangeAuditRecord | undefined {
  if (item === undefined) return undefined;
  const parsed = AdminChangeAuditRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
  return parsed.success ? parsed.data : undefined;
}

export async function readAudit(store: AuditStore, changeId: string): Promise<AdminChangeAuditRecord | undefined> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: { pk: `CHANGE#${changeId}`, sk: "AUDIT" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const record = parse(response.Item);
  if (response.Item !== undefined && record === undefined) store.log({ event: "admin_change.audit_unreadable", changeId });
  return record;
}

const encode = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString("base64url");
function decode(cursor: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    // Only a key from this partition's own pages, as the turn export does.
    if (key.exportPk !== ADMIN_CHANGES_PARTITION || typeof key.pk !== "string" || !key.pk.startsWith("CHANGE#") || key.sk !== "AUDIT" || typeof key.exportSk !== "string") throw new Error("bad");
    return key;
  } catch {
    throw agentXError("CONFIG_INVALID", CURSOR_INVALID);
  }
}

export async function listAudit(store: AuditStore, query: { since: string; until?: string; admin?: string; outcome?: AdminChangeOutcome; limit: number; cursor?: string }): Promise<{ changes: AdminChangeAuditRecord[]; cursor?: string }> {
  const changes: AdminChangeAuditRecord[] = [];
  let start = query.cursor === undefined ? undefined : decode(query.cursor);
  // Where the next page resumes: after the last item read when this page stopped mid-read, else
  // the index's own LastEvaluatedKey (which also covers items the filter left out), so a filter
  // that empties every read page still hands back a cursor and nothing is cut off silently.
  let resume: Record<string, unknown> | undefined;
  for (let reads = 0; reads < 10 && changes.length < query.limit; reads += 1) {
    const filters = [...(query.admin === undefined ? [] : ["admin.subject = :admin"]), ...(query.outcome === undefined ? [] : ["outcome = :outcome"])];
    const page = await store.documentClient.send(new QueryCommand({
      TableName: store.tableName,
      IndexName: "byTime",
      KeyConditionExpression: query.until === undefined ? "exportPk = :partition AND exportSk >= :since" : "exportPk = :partition AND exportSk BETWEEN :since AND :until",
      ExpressionAttributeValues: {
        ":partition": ADMIN_CHANGES_PARTITION, ":since": query.since,
        ...(query.until === undefined ? {} : { ":until": `${query.until}\uffff` }),
        ...(query.admin === undefined ? {} : { ":admin": query.admin }),
        ...(query.outcome === undefined ? {} : { ":outcome": query.outcome }),
      },
      ...(filters.length === 0 ? {} : { FilterExpression: filters.join(" AND ") }),
      ScanIndexForward: false,
      Limit: query.limit,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    const items = page.Items ?? [];
    let read = 0;
    for (; read < items.length && changes.length < query.limit; read += 1) {
      const item = items[read]!;
      const record = parse(item);
      if (record === undefined) store.log({ event: "admin_change.audit_unreadable", ...(typeof item.pk === "string" && item.pk.startsWith("CHANGE#") ? { changeId: item.pk.slice("CHANGE#".length) } : {}) });
      else changes.push(record);
    }
    if (read < items.length) {
      const item = items[read - 1]!;
      resume = { pk: item.pk, sk: item.sk, exportPk: item.exportPk, exportSk: item.exportSk };
      break;
    }
    resume = page.LastEvaluatedKey;
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return { changes, ...(resume === undefined ? {} : { cursor: encode(resume) }) };
}

export function logChangeStep(log: (entry: Record<string, unknown>) => void, step: string, fields: { changeId: string; traceId: string; kind?: string; outcome?: string; error?: string }): void {
  log({ event: `admin_change.${step}`, ...fields });
}

export function outcomeMetric(namespace: string): (outcome: AdminChangeOutcome) => void {
  return (outcome) => console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["Outcome"]], Metrics: [{ Name: "AdminChangeOutcome", Unit: "Count" }] }] },
    component: "broker", event: "metric", Outcome: outcome, AdminChangeOutcome: 1,
  }));
}
