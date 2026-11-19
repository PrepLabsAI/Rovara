// DEC 254zzz84 (5): removing a company member WITH an ownership hand-over. What the removed person owns in their company moves to a successor the remover picks:
//
//   - their custom agents and chains (the META row's `owner`, while it still names them),
//   - their open tasks (the task's People list: they become `denied`, the successor an owner), where the successor can own the task now (a live member with a live
//     grant on its project). A task the successor cannot open is never handed to them: it waits for someone with access to take it over, as any task that lost its
//     owner does, and the preview and the answer say how many.
//
//   - the projects they administer: the successor gets the administrator grant (a new grant, or their developer grant raised), and the person's administrator
//     grant goes, in the company layout's keys (company-layout.ts, DEC 254zzz80: a named company's own partition, the built-in company's legacy keys).
//
// One removal is one record, `ORG#<company>#MEMBER_REMOVAL` / `REMOVAL#<requestId>`: written STARTED before the membership ends, finished (DONE) in the SAME
// transaction that moves everything and writes the audit record. So the moves are all or nothing, a retry with the same request id finishes or repeats nothing,
// and a request id reused for another removal is refused. The transaction is DynamoDB's (at most 100 steps): a hand-over larger than one transaction is refused
// BEFORE anyone is removed ("hand some of it over first").
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { OrgIdSchema, OrgRoleSchema, agentDirectoryKey, agentKey, chainDirectoryKey, chainKey, companyScoped, type AuditEvent, type OrgId, type OrgRole } from "@agentx/contracts";
import { DocumentAuditSink } from "@agentx/local-adapters";
import { ownPartitionRow, recordInCompany } from "./company-check.js";
import { grantKeyFor, grantsPkFor, latestRevisionRowFor, namedCompany, projectMemberRowKeyFor } from "./company-layout.js";
import { involvedPartition } from "../core/task-flow/involved.js";
import { taskOwnershipHandOverSteps, type TaskHandOverSkip, type TaskPeopleDependencies } from "../developer/task-people.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type Client = { send(command: unknown): Promise<unknown> };

/** Total bounds of one hand-over: rows read per list, open tasks looked at, and DynamoDB's own transaction size. */
export const HANDOVER_LIMITS = { directoryRows: 2_000, taskRows: 5_000, involvedRows: 1_000, openTasks: 200, transactionSteps: 100 } as const;
/** Point reads run this many at a time. */
const READ_BATCH = 25;
/** Fixed words: the hand-over does not fit in one transaction, or one of its lists is past its bound. Nothing has been removed when this is said. */
export const HANDOVER_TOO_BIG = "This person owns too much to hand over in one go. Hand some of it over first.";

export class HandOverTooBig extends Error { constructor() { super(HANDOVER_TOO_BIG); } }
/** A row moved or a list changed between the plan and the commit; the caller plans again. */
export class HandOverRaced extends Error { constructor() { super("hand-over raced"); } }

const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
const RemovalId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The removal record's key: the company's own partition, one row per request id. */
export function memberRemovalKey(companyId: string, removalId: string): { pk: string; sk: string } {
  return { pk: companyScoped(OrgIdSchema.parse(companyId), "MEMBER_REMOVAL"), sk: `REMOVAL#${RemovalId.parse(removalId).toLowerCase()}` };
}

export const MemberRemovalRecord = z.object({
  entityType: z.literal("COMPANY_MEMBER_REMOVAL"), companyId: OrgIdSchema, removalId: RemovalId,
  leaverId: PersonId, successorId: PersonId, expectedRole: OrgRoleSchema, by: PersonId, startedAt: z.iso.datetime(),
  state: z.enum(["STARTED", "DONE"]), finishedAt: z.iso.datetime().optional(),
  /** DEC 254zzz101: a stuck hand-over finished by an owner or admin to another successor: who it went to, who finished it and that request's id. */
  handedTo: PersonId.optional(), finishedBy: PersonId.optional(), finishRequestId: RemovalId.optional(),
  moved: z.object({ agents: z.number().int().min(0), chains: z.number().int().min(0), projects: z.number().int().min(0), tasks: z.number().int().min(0), tasksLeft: z.number().int().min(0) }).strict().optional(),
}).strict();
export type MemberRemovalRecord = z.infer<typeof MemberRemovalRecord>;

/**
 * DEC 254zzz101: the leaver's pending hand-over, `ORG#<company>#MEMBER_REMOVAL` / `LEAVER#<person>`: written with the STARTED record, removed when the hand-over
 * finishes or the removal is refused, so an owner or admin can find and finish a hand-over that is stuck after the membership ended.
 */
export function pendingHandOverKey(companyId: string, leaverId: string): { pk: string; sk: string } {
  return { pk: companyScoped(OrgIdSchema.parse(companyId), "MEMBER_REMOVAL"), sk: `LEAVER#${PersonId.parse(leaverId)}` };
}
/** The receipt of one "finish hand-over" request, so its repeat answers the same: `ORG#<company>#MEMBER_REMOVAL` / `FINISH#<requestId>`. */
export function finishReceiptKey(companyId: string, requestId: string): { pk: string; sk: string } {
  return { pk: companyScoped(OrgIdSchema.parse(companyId), "MEMBER_REMOVAL"), sk: `FINISH#${RemovalId.parse(requestId).toLowerCase()}` };
}
const PendingHandOver = z.object({ entityType: z.literal("COMPANY_MEMBER_HANDOVER_PENDING"), companyId: OrgIdSchema, leaverId: PersonId, removalId: RemovalId }).strict();
const FinishReceipt = z.object({ entityType: z.literal("COMPANY_MEMBER_HANDOVER_FINISH"), companyId: OrgIdSchema, removalId: RemovalId, leaverId: PersonId, by: PersonId, successorId: PersonId }).strict();

/** The request a removal record answers: the same request id must name the same person, successor, role and remover. */
export function sameRemoval(record: MemberRemovalRecord, request: { leaverId: string; successorId: string; expectedRole: OrgRole; by: string }): boolean {
  return record.leaverId === request.leaverId && record.successorId === request.successorId && record.expectedRole === request.expectedRole && record.by === request.by;
}

export interface HandOverContext {
  documentClient: Client;
  tableName: string;
  now: () => number;
  /** Task People, as the task routes build it (the successor's live proof on each task's project). Absent: tasks are not handed over (each is counted as left). */
  tasks?: { deps: TaskPeopleDependencies; register(task: DeveloperTaskRecord, developerId: string): Promise<unknown> };
}

export interface HandOverPlan {
  agents: number;
  chains: number;
  /** Projects whose administrator grant moves to the successor. */
  projects: number;
  tasks: number;
  /** Open tasks of theirs that stay without an owner (the successor cannot own them now, or the install keeps no People lists). */
  tasksLeft: number;
  steps: Write[];
}

async function get(ctx: HandOverContext, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const answer = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return answer.Item;
}

/** Every row of one partition under a prefix, refusing the whole hand-over past `max` rows (never a partial one). */
async function rows(ctx: HandOverContext, pk: string, prefix: string | undefined, max: number): Promise<Array<Record<string, unknown>>> {
  const found: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ctx.documentClient.send(new QueryCommand({
      TableName: ctx.tableName, ConsistentRead: true, Limit: max + 1 - found.length,
      KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ...(prefix === undefined ? {} : { ":prefix": prefix }) },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown; LastEvaluatedKey?: Record<string, unknown> };
    if (!Array.isArray(page.Items)) throw new Error("rows did not read");
    found.push(...(page.Items as Array<Record<string, unknown>>));
    if (found.length > max) throw new HandOverTooBig();
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

/** Runs `read` over `items`, READ_BATCH at a time, keeping the order. */
async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += READ_BATCH) out.push(...await Promise.all(items.slice(start, start + READ_BATCH).map(read)));
  return out;
}

/** The custom agents or chains (one company's directory) whose owner is the leaver: one conditional owner move each. */
async function ownedRecords(ctx: HandOverContext, kind: "agent" | "chain", companyId: OrgId, leaverId: string, successorId: string): Promise<Write[]> {
  const directory = kind === "agent" ? agentDirectoryKey(companyId, "agt_x").pk : chainDirectoryKey(companyId, "chn_x").pk;
  const steps: Write[] = [];
  const ids = (await rows(ctx, directory, undefined, HANDOVER_LIMITS.directoryRows)).flatMap((row) => typeof row["sk"] === "string" ? [row["sk"]] : []);
  const keyOf = (id: string) => kind === "agent" ? agentKey(companyId, id, "META") : chainKey(companyId, id, "META");
  const records = await inBatches(ids, (id) => get(ctx, keyOf(id)));
  for (const [index, id] of ids.entries()) {
    const key = keyOf(id);
    const record = records[index];
    const owner = record?.["owner"] as { kind?: unknown; developerId?: unknown } | undefined;
    // Only this company's record, still owned by the leaver as a member; anything else is not theirs to hand over.
    if (record === undefined || record["orgId"] !== companyId || owner?.kind !== "member" || owner.developerId !== leaverId) continue;
    steps.push({ Update: {
      TableName: ctx.tableName, Key: key,
      // The whole owner (a member: exactly `kind` and `developerId`), under a condition on the one read.
      UpdateExpression: "SET #owner = :owner, #updatedAt = :now",
      ConditionExpression: "#orgId = :company AND #owner.#kind = :member AND #owner.#developerId = :leaver",
      ExpressionAttributeNames: { "#owner": "owner", "#developerId": "developerId", "#kind": "kind", "#orgId": "orgId", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":owner": { kind: "member", developerId: successorId }, ":leaver": leaverId, ":company": companyId, ":member": "member", ":now": new Date(ctx.now()).toISOString() },
    } });
  }
  return steps;
}

/** A grant row of this company, read where the company layout keeps it (a named company's own partition; else the legacy key with its stored-company rule). */
function companyGrant(row: Record<string, unknown> | undefined, companyId: OrgId, key: { pk: string; sk: string }, project: string): Record<string, unknown> | undefined {
  if (row === undefined || row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== "MEMBERSHIP" || row["projectName"] !== project) return undefined;
  if (namedCompany(companyId) !== undefined ? !ownPartitionRow(row, companyId) : !recordInCompany(row, companyId)) return undefined;
  return row;
}

/** Whether the project's latest revision lives in this company's own layout (a named company's partition; the legacy one naming this company). A read error throws. */
async function projectInCompany(ctx: HandOverContext, companyId: OrgId, project: string): Promise<boolean> {
  const revision = await latestRevisionRowFor(ctx.documentClient, ctx.tableName, companyId, project);
  return revision !== undefined && (namedCompany(companyId) !== undefined || recordInCompany(revision, companyId));
}

/**
 * The projects the leaver administers in this company: per project, the successor's administrator grant (put new, or their developer grant raised) and its
 * project-side row, and the leaver's administrator grant and project-side row deleted, each under a condition on the row as read.
 */
async function administeredProjects(ctx: HandOverContext, companyId: OrgId, leaverId: string, successorId: string): Promise<{ count: number; steps: Write[] }> {
  const steps: Write[] = [];
  let count = 0;
  const at = new Date(ctx.now()).toISOString();
  for (const row of await rows(ctx, grantsPkFor(companyId, leaverId), "PROJECT#", HANDOVER_LIMITS.directoryRows)) {
    const project = typeof row["projectName"] === "string" ? row["projectName"] : undefined;
    if (project === undefined || row["role"] !== "administrator") continue;
    const leaverKey = grantKeyFor(companyId, leaverId, project);
    if (companyGrant(row, companyId, leaverKey, project) === undefined) continue;
    // Only a project of THIS company, read where the company layout keeps it (company-layout.ts): a grant naming another company's project, or none, is
    // left as it is (for cleanup), never handed over or counted.
    if (!await projectInCompany(ctx, companyId, project)) continue;
    const successorKey = grantKeyFor(companyId, successorId, project);
    const raw = await get(ctx, successorKey);
    const current = companyGrant(raw, companyId, successorKey, project);
    // A row under the successor's key that is not this company's grant is never overwritten: the project is not handed over.
    if (raw !== undefined && current === undefined) continue;
    count++;
    steps.push(
      { Delete: { TableName: ctx.tableName, Key: leaverKey, ConditionExpression: "#role = :administrator AND ownerKey = :leaver",
        ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":administrator": "administrator", ":leaver": leaverId } } },
      { Delete: { TableName: ctx.tableName, Key: projectMemberRowKeyFor(companyId, project, leaverId) } },
    );
    if (current?.["role"] === "administrator") continue;
    if (current === undefined) {
      steps.push({ Put: { TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        // The grant writer's own row shape (admin-actions.ts grantProjectAccess), as an administrator; the key says the company.
        ...successorKey, entityType: "MEMBERSHIP", ownerKey: successorId, projectName: project, role: "administrator", grantId: randomUUID(), grantedAt: at,
      } } });
    } else {
      steps.push({ Update: { TableName: ctx.tableName, Key: successorKey, UpdateExpression: "SET #role = :administrator", ConditionExpression: "#role = :developer AND ownerKey = :successor",
        ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":administrator": "administrator", ":developer": "developer", ":successor": successorId } } });
    }
    steps.push({ Put: { TableName: ctx.tableName, Item: { ...projectMemberRowKeyFor(companyId, project, successorId), entityType: "PROJECT_MEMBER", role: "administrator", grantedAt: at },
      // Only over the successor's own project-side row (or none): never over a row of another kind.
      ConditionExpression: "attribute_not_exists(pk) OR (entityType = :projectMember AND (#role = :developer OR #role = :administrator))",
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":projectMember": "PROJECT_MEMBER", ":developer": "developer", ":administrator": "administrator" } } });
  }
  return { count, steps };
}

/** The leaver's open tasks in this company: the ones they started (their task index) and the ones they co-own (their involved rows), each read live. */
async function openTasks(ctx: HandOverContext, companyId: OrgId, leaverId: string): Promise<DeveloperTaskRecord[]> {
  const ids = new Set<string>();
  for (const row of await rows(ctx, `DEVELOPER#${leaverId}`, "TASK#", HANDOVER_LIMITS.taskRows)) {
    if (row["status"] !== "CLOSED" && typeof row["taskId"] === "string" && TASK_ID.test(row["taskId"])) ids.add(row["taskId"]);
  }
  // Involved rows carry no status (one can outlive its task's close): each is read live below, and only OPEN tasks count toward the open-task bound.
  for (const row of await rows(ctx, involvedPartition(companyId, leaverId), "TASK#", HANDOVER_LIMITS.involvedRows)) {
    if (typeof row["taskId"] === "string" && TASK_ID.test(row["taskId"])) ids.add(row["taskId"]);
  }
  const tasks: DeveloperTaskRecord[] = [];
  const sorted = [...ids].sort();
  const read = await inBatches(sorted, (taskId) => get(ctx, { pk: `DEVTASK#${taskId}`, sk: "META" }));
  for (const [index, taskId] of sorted.entries()) {
    const task = read[index];
    if (task === undefined || task["taskId"] !== taskId || task["entityType"] !== "DEVELOPER_TASK" || task["closedAt"] !== undefined || task["status"] === "CLOSED" || !recordInCompany(task, companyId)) continue;
    tasks.push(task as unknown as DeveloperTaskRecord);
  }
  if (tasks.length > HANDOVER_LIMITS.openTasks) throw new HandOverTooBig();
  return tasks;
}

/**
 * What would move, and (with `commit`) the steps that move it. `commit` also registers the successor on each task first (registration grants nothing; it is the
 * task person row a People entry needs). The preview never writes.
 */
export async function planHandOver(ctx: HandOverContext, input: { companyId: string; leaverId: string; successorId: string; by: string; removalId: string; commit: boolean }): Promise<HandOverPlan> {
  const companyId = OrgIdSchema.parse(input.companyId);
  const agents = await ownedRecords(ctx, "agent", companyId, input.leaverId, input.successorId);
  const chains = await ownedRecords(ctx, "chain", companyId, input.leaverId, input.successorId);
  const projects = await administeredProjects(ctx, companyId, input.leaverId, input.successorId);
  const steps: Write[] = [...agents, ...chains, ...projects.steps];
  let tasks = 0, tasksLeft = 0, taskSteps = 0;
  const asked = { leaverId: input.leaverId, successorId: input.successorId, removalId: input.removalId, by: input.by };
  for (const task of await openTasks(ctx, companyId, input.leaverId)) {
    if (ctx.tasks === undefined) { tasksLeft++; continue; }
    // The successor is registered only on a task that would be handed to them (registration grants nothing, but it is a row the task did not need otherwise).
    const would = await taskOwnershipHandOverSteps(ctx.tasks.deps, task, { ...asked, preview: true });
    if ("skipped" in would) { if (would.skipped !== ("not_their_task" satisfies TaskHandOverSkip)) tasksLeft++; continue; }
    if (!input.commit) { tasks++; taskSteps += would.steps; continue; }
    try { await ctx.tasks.register(task, input.successorId); } catch { /* not registrable now: the steps below skip the task */ }
    const handOver = await taskOwnershipHandOverSteps(ctx.tasks.deps, task, asked);
    if ("items" in handOver) { tasks++; taskSteps += handOver.items.length; steps.push(...handOver.items); continue; }
    if (handOver.skipped !== ("not_their_task" satisfies TaskHandOverSkip)) tasksLeft++;
  }
  // The record's finish, the audit record, the pending row's delete and a finish receipt share the transaction; the preview counts the task steps the commit will write.
  if (steps.length + (input.commit ? 0 : taskSteps) + 4 > HANDOVER_LIMITS.transactionSteps) throw new HandOverTooBig();
  return { agents: agents.length, chains: chains.length, projects: projects.count, tasks, tasksLeft, steps };
}

/** The audit record of a finished hand-over: the row Code's audit sink (`DocumentAuditSink`) writes, as one raw step of this transaction. */
function auditStep(tableName: string, event: AuditEvent): Write {
  const [staged] = new DocumentAuditSink({ store: () => { throw new Error("staged only"); } }).stage(event);
  if (staged === undefined || staged.kind !== "update") throw new Error("audit step did not stage");
  const fields: Record<string, unknown> = {};
  for (const op of staged.ops) {
    if (op.op !== "setIfAbsent" || op.path.length !== 1) throw new Error("audit step did not stage");
    fields[op.path[0]] = op.value;
  }
  return { Put: { TableName: tableName, Item: { ...staged.key, ...fields }, ConditionExpression: "attribute_not_exists(pk)" } };
}

/** The pending row's delete, only while it still names this removal (a newer removal of the same person keeps its own). */
function pendingDelete(ctx: HandOverContext, record: MemberRemovalRecord): Write {
  return { Delete: { TableName: ctx.tableName, Key: pendingHandOverKey(record.companyId, record.leaverId),
    ConditionExpression: "attribute_not_exists(pk) OR removalId = :removal", ExpressionAttributeValues: { ":removal": record.removalId } } };
}

/** A refused removal leaves no STARTED record behind (so that request id can never end the membership later); best effort, only while still STARTED. */
export async function dropStartedRemoval(ctx: HandOverContext, record: MemberRemovalRecord): Promise<void> {
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: ctx.tableName, Key: memberRemovalKey(record.companyId, record.removalId),
        ConditionExpression: "#state = :started AND leaverId = :leaver", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":started": "STARTED", ":leaver": record.leaverId } } },
      pendingDelete(ctx, record),
    ] }));
  } catch { /* a record left behind is refused by its age and its revoker (company-member-routes.ts) */ }
}

/** Writes the STARTED record (once per request id). A record already there is returned for the caller to compare; nothing is overwritten. */
export async function startRemoval(ctx: HandOverContext, input: { companyId: string; removalId: string; leaverId: string; successorId: string; expectedRole: OrgRole; by: string }): Promise<MemberRemovalRecord> {
  const key = memberRemovalKey(input.companyId, input.removalId);
  const record = MemberRemovalRecord.parse({ entityType: "COMPANY_MEMBER_REMOVAL", companyId: input.companyId, removalId: input.removalId.toLowerCase(), leaverId: input.leaverId,
    successorId: input.successorId, expectedRole: input.expectedRole, by: input.by, startedAt: new Date(ctx.now()).toISOString(), state: "STARTED" });
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: ctx.tableName, Item: { ...key, ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
      // The latest removal of this person is the one a "finish hand-over" finds.
      { Put: { TableName: ctx.tableName, Item: { ...pendingHandOverKey(input.companyId, input.leaverId), ...PendingHandOver.parse({ entityType: "COMPANY_MEMBER_HANDOVER_PENDING", companyId: input.companyId, leaverId: input.leaverId, removalId: record.removalId }) } } },
    ] }));
    return record;
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== "TransactionCanceledException" && error.name !== "ConditionalCheckFailedException")) throw error;
    const stored = await readRemoval(ctx, input.companyId, input.removalId);
    if (stored === undefined) throw error;
    return stored;
  }
}

/** The removal record of a request id in this company, or undefined. A row that does not read throws (never treated as absent). */
export async function readRemoval(ctx: HandOverContext, companyId: string, removalId: string): Promise<MemberRemovalRecord | undefined> {
  const key = memberRemovalKey(companyId, removalId);
  const item = await get(ctx, key);
  if (item === undefined) return undefined;
  const { pk, sk, ...fields } = item;
  const parsed = MemberRemovalRecord.parse(fields);
  if (pk !== key.pk || sk !== key.sk || parsed.companyId !== companyId) throw new Error("removal record does not read");
  return parsed;
}

/**
 * Moves everything in ONE transaction with the record's finish (STARTED -> DONE, still naming this leaver and successor) and the audit record. Any step that
 * finds its row changed cancels all of it (HandOverRaced; the caller plans again). Answers what moved.
 */
export async function finishHandOver(ctx: HandOverContext, record: MemberRemovalRecord, plan: HandOverPlan,
  takeover?: { successorId: string; by: string; requestId: string }): Promise<NonNullable<MemberRemovalRecord["moved"]>> {
  const at = new Date(ctx.now()).toISOString();
  const moved = { agents: plan.agents, chains: plan.chains, projects: plan.projects, tasks: plan.tasks, tasksLeft: plan.tasksLeft };
  const handedTo = takeover?.successorId ?? record.successorId;
  const finish: Write = { Update: {
    TableName: ctx.tableName, Key: memberRemovalKey(record.companyId, record.removalId),
    UpdateExpression: `SET #state = :done, finishedAt = :at, moved = :moved${takeover === undefined ? "" : ", handedTo = :handedTo, finishedBy = :finishedBy, finishRequestId = :finishRequest"}`,
    ConditionExpression: "#state = :started AND leaverId = :leaver AND successorId = :successor",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":done": "DONE", ":started": "STARTED", ":at": at, ":moved": moved, ":leaver": record.leaverId, ":successor": record.successorId,
      ...(takeover === undefined ? {} : { ":handedTo": takeover.successorId, ":finishedBy": takeover.by, ":finishRequest": takeover.requestId.toLowerCase() }) },
  } };
  const audit = auditStep(ctx.tableName, {
    eventId: `evt_member_removal_${record.removalId.toLowerCase()}`, companyId: record.companyId, at, actor: { type: "person", id: takeover?.by ?? record.by },
    action: "member.removed", subject: { type: "person", id: record.leaverId },
    details: { successor: handedTo, role: record.expectedRole, agents: moved.agents, chains: moved.chains, projects: moved.projects, tasks: moved.tasks, tasksLeft: moved.tasksLeft,
      ...(takeover === undefined ? {} : { removedBy: record.by, finishedBy: takeover.by }) },
  });
  const receipt: Write[] = takeover === undefined ? [] : [{ Put: { TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)",
    Item: { ...finishReceiptKey(record.companyId, takeover.requestId), ...FinishReceipt.parse({ entityType: "COMPANY_MEMBER_HANDOVER_FINISH", companyId: record.companyId, removalId: record.removalId,
      leaverId: record.leaverId, by: takeover.by, successorId: takeover.successorId }) } } }];
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [finish, audit, pendingDelete(ctx, record), ...receipt, ...plan.steps] }));
  } catch (error) {
    if (error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException")) throw new HandOverRaced();
    throw error;
  }
  return moved;
}

/** A pending hand-over of this leaver (the latest removal of theirs that has not finished), or undefined. A row that does not read throws. */
export async function pendingHandOver(ctx: HandOverContext, companyId: string, leaverId: string): Promise<MemberRemovalRecord | undefined> {
  const key = pendingHandOverKey(companyId, leaverId);
  const item = await get(ctx, key);
  if (item === undefined) return undefined;
  const { pk, sk, ...fields } = item;
  const row = PendingHandOver.parse(fields);
  if (pk !== key.pk || sk !== key.sk || row.companyId !== companyId || row.leaverId !== leaverId) throw new Error("pending hand-over does not read");
  const record = await readRemoval(ctx, companyId, row.removalId);
  return record?.state === "STARTED" && record.leaverId === leaverId ? record : undefined;
}

/** A finish request's receipt: the removal it finished, or undefined. A row that does not read throws. */
export async function finishReceipt(ctx: HandOverContext, companyId: string, requestId: string): Promise<z.infer<typeof FinishReceipt> | undefined> {
  const key = finishReceiptKey(companyId, requestId);
  const item = await get(ctx, key);
  if (item === undefined) return undefined;
  const { pk, sk, ...fields } = item;
  const receipt = FinishReceipt.parse(fields);
  if (pk !== key.pk || sk !== key.sk || receipt.companyId !== companyId) throw new Error("finish receipt does not read");
  return receipt;
}

/** Every pending hand-over in the company (at most `max`; past it the whole answer is refused, never a part). */
export async function pendingHandOvers(ctx: HandOverContext, companyId: string, max: number): Promise<MemberRemovalRecord[]> {
  const found: MemberRemovalRecord[] = [];
  for (const row of await rows(ctx, companyScoped(OrgIdSchema.parse(companyId), "MEMBER_REMOVAL"), "LEAVER#", max)) {
    const leaverId = typeof row["leaverId"] === "string" ? row["leaverId"] : undefined;
    if (leaverId === undefined || !PersonId.safeParse(leaverId).success) throw new Error("pending hand-over does not read");
    const record = await pendingHandOver(ctx, companyId, leaverId);
    if (record !== undefined) found.push(record);
  }
  return found;
}
