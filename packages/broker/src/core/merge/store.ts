// Port lane L7a: the merge core's state, on W0's document store. The keys are the ones Cloud uses (contracts `mergeTrackingKey`, `prHeadKey`, `mergeCommitIndexKey`; the task's own partition
// `DEVTASK#<taskId>`, a named exception to company scoping), so Cloud and Code share one layout (decision 45.6) and no data moves.
//
// Cloud wrote these with DynamoDB commands and expression strings. Here every write is a `TransactItem` of the port, with conditions as data; the callers add them to the transaction of the
// change that caused them, as before.
import { workflowWriteOps } from "../task-flow/flow-guard.js";
import {
  INDEX_EXPIRY_ATTRIBUTE, MergeTrackingItemSchema, change, mergeTrackingKey, prHeadKey, queryAll, when,
  type DocumentStore, type MergeTrackingItem, type OrgId, type StoredDocument, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";

/** A plain JSON document: no `undefined` member anywhere (the port refuses one). */
export function plain<T extends object>(value: T): StoredDocument {
  return JSON.parse(JSON.stringify(value)) as StoredDocument;
}

/** The key of the task's own record (the task-flow lane owns the record; the merge core writes only its `workflow` field, guarded by the workflow's revision). */
export const taskRecordKey = (taskId: string): { pk: string; sk: "META" } => ({ pk: `DEVTASK#${taskId}`, sk: "META" });
/** The sweep's row for a task: when it was last observed, and where a tracking pass that ran out of requests stopped. */
export const recoveryRowKey = (taskId: string): { pk: "WORKFLOW_MERGE_RECOVERY"; sk: string } => ({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${taskId}` });

// ---- the tracking items

const TRACKING_FIELDS = [
  "orgId", "taskId", "repositoryId", "number", "version", "headSha", "draft", "state", "baseBranch", "ci", "ciBasis", "ciUnreadableSince", "checksEverSeen", "failingChecks", "review", "approval",
  "branch", "headByRovara", "lastRovaraPushAt", "readyAt", "reviewersRequestedAt", "nudges", "syncs", "mergeClaim", "decisionDigest", "observedAt",
] as const;

/** A stored item as the schema reads it, or undefined (never an item of another org or task). */
export function trackingItemOf(stored: Record<string, unknown> | undefined, orgId: OrgId, taskId: string): MergeTrackingItem | undefined {
  if (stored === undefined || stored["orgId"] !== orgId || stored["taskId"] !== taskId) return undefined;
  const picked: Record<string, unknown> = {};
  for (const field of TRACKING_FIELDS) if (stored[field] !== undefined) picked[field] = stored[field];
  // Dual read (item C4): an item written before the host account id got its neutral name keeps the old spelling for the approval's account; it reads as `hostUserId` and is rewritten that way.
  const approval = picked["approval"];
  if (approval !== null && typeof approval === "object" && !Array.isArray(approval) && "githubUserId" in approval) {
    const { githubUserId, ...rest } = approval as Record<string, unknown>;
    picked["approval"] = "hostUserId" in rest ? rest : { ...rest, hostUserId: githubUserId };
  }
  const parsed = MergeTrackingItemSchema.safeParse(picked);
  return parsed.success ? parsed.data : undefined;
}

export async function readTrackingItem(store: Pick<DocumentStore, "get">, taskId: string, repositoryId: string, number: number): Promise<Record<string, unknown> | undefined> {
  return store.get(mergeTrackingKey(taskId, repositoryId, number));
}

/** The task's tracking items, read from its partition and checked against the task's org; an item that does not read is left out. `mergeClaim` is included (the view drops it). */
export async function readMergeTracking(store: Pick<DocumentStore, "query">, taskId: string, orgId: OrgId): Promise<MergeTrackingItem[]> {
  const items: MergeTrackingItem[] = [];
  for (const stored of await queryAll(store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "MERGE_TRACKING#" } })) {
    const item = trackingItemOf(stored, orgId, taskId);
    if (item !== undefined) items.push(item);
  }
  return items.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);
}

/** The item as the task view shows it: without the merge claim. */
export function publicTrackingItem(item: MergeTrackingItem): Omit<MergeTrackingItem, "mergeClaim"> {
  const { mergeClaim: _claim, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  return rest;
}

const OPTIONAL_FIELDS = ["approval", "lastRovaraPushAt", "readyAt", "reviewersRequestedAt", "ciUnreadableSince"] as const;

/** The write of the next tracking item: a create when there is no readable prior one, else an update conditioned on the version read. It never removes `mergeClaim`. */
export function trackingWriteItem(prior: MergeTrackingItem | undefined, next: MergeTrackingItem): TransactItem {
  const key = mergeTrackingKey(next.taskId, next.repositoryId, next.number);
  if (prior === undefined) return { kind: "put", item: plain({ ...key, entityType: "MERGE_TRACKING", ...next }), condition: when.absent() };
  const ops = [];
  for (const field of TRACKING_FIELDS) {
    if (field === "mergeClaim" || field === "orgId" || field === "taskId") continue;
    const value = next[field as keyof MergeTrackingItem];
    if (value === undefined) {
      if ((OPTIONAL_FIELDS as readonly string[]).includes(field)) ops.push(change.remove([field]));
    } else {
      ops.push(change.set([field], JSON.parse(JSON.stringify(value)) as never));
    }
  }
  return { kind: "update", key, ops, condition: when.and(when.eq("version", prior.version), when.eq("orgId", next.orgId), when.eq("taskId", next.taskId)) };
}

// ---- the head index

/** How long a head's index item lives after it was written (the store's expiry): a task's pull request does not outlive it. */
const HEAD_INDEX_RETENTION_SECONDS = 90 * 86_400;

/** The index items for a pull request's head and its branch: put with the change that records the head, in the same transaction. A later head is another item. */
export function prHeadItems(
  input: { orgId: OrgId; repositoryKey: string; headSha: string; taskId: string; repositoryId: string; number: number; branch?: string | undefined },
  now: number,
  ttlAttribute: string = INDEX_EXPIRY_ATTRIBUTE,
): TransactItem[] {
  const repositoryKey = input.repositoryKey.toLowerCase();
  const expires = Math.floor(now / 1_000) + HEAD_INDEX_RETENTION_SECONDS;
  const item = (sk: string): TransactItem => ({
    kind: "put",
    item: plain({ ...prHeadKey(input.orgId, repositoryKey, sk), entityType: "PR_HEAD", orgId: input.orgId, taskId: input.taskId, repositoryId: input.repositoryId, number: input.number, [ttlAttribute]: expires }),
  });
  return [item(input.headSha), ...(input.branch === undefined ? [] : [item(`branch:${input.branch}`)])];
}

// ---- the task's workflow

/** The write of the task's next workflow snapshot: only if the workflow is still at the revision the caller read and the task is not closed. */
export function workflowUpdateItem(taskId: string, next: WorkflowSnapshot, expectedRevision: number, read?: WorkflowSnapshot): TransactItem {
  // With the workflow the caller read, only the keys that differ are written and the stored `flow` is carried forward (see flow-guard.ts); without it the whole workflow is written.
  const write = workflowWriteOps(read, next, { ownsFlow: true });
  return {
    kind: "update", key: taskRecordKey(taskId), ops: [...write.ops, change.set(["updatedAt"], next.updatedAt)],
    condition: when.and(when.eq(["workflow", "revision"], expectedRevision), when.notExists("closedAt"), ...write.guard),
  };
}
