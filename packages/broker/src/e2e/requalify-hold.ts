import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { STALE_RUN_SWEEP_AGE_MS } from "@agentx/verifier";
import {
  INDEX_EXPIRY_ATTRIBUTE, REQUALIFY_PROFILE_ID, RequalifyHoldSchema, TERMINAL_OPERATION_STATUSES, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX, WORKSPACE_SESSION_STATE_INDEX,
  agentXError, canonicalJson, projectSetupExecutionKey, requalifyHoldKey,
  type E2EApplicationSelectionRecord, type E2ERegisteredRuntime,
} from "@agentx/contracts";
import type { SessionManager } from "../aws/sessions.js";
import { ApplicationDispatchRefusal, applicationSelectionStillCurrent } from "./application-dispatch-check.js";

/**
 * AUTOREQUALIFY (AR-3): what the renewal of the browser and API test machine asks of the work around it.
 *
 *  - The HOLD row (written and removed by the renewal's own steps, AR-2; its schema and key are in contracts). While a switch is in progress (the renewal drains the old machine, then moves the registered rows), new browser and API rounds and new project setup runs are
 *    deferred, never blocked: a deferred dispatch row stays due and the recovery sweep tries it again. The hold carries its own end (`until`), so a renewal that crashed cannot defer
 *    work for ever; a hold that cannot be read is read as active (fail closed: a deferral costs minutes, a round started across the switch costs the round).
 *  - The drain. `requalifyDrainStatus` says whether any round or setup run that already started on the old machine is still running.
 *  - The renewal-only change. A selection that differs from the approved one only because the machine was renewed (same profile, binding and capabilities, a newer generation, the
 *    plan, setup, targets and test accounts untouched) is told apart from every other change, so that one automatic retry approves it again. Nothing else is ever approved by Rovara.
 *  - Replays. A round that ran on an earlier machine cannot be replayed exactly (its case ids are bound to the rows it ran on); the refusal says so.
 *
 * Nothing here is built from what a runner, a worker or a model said. The renewal's steps (AR-2) place and release the hold and poll `requalifyDrainCount`.
 */

export type RequalifyHoldStore = Readonly<{ documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }>;

/** The sentence an interactive caller (a project setup) is given when it is deferred. */
export const REQUALIFY_DEFERRED_MESSAGE = "The browser and API test machine is being renewed; try again in a few minutes.";

/**
 * Whether a switch is in progress. No row: no. A row that is past its `until`: no (a crashed renewal). A row that cannot be read as a hold: yes. A read that fails throws, and the
 * caller's own retry applies.
 */
export async function requalifyHoldActive(store: RequalifyHoldStore, now: number): Promise<boolean> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: requalifyHoldKey(REQUALIFY_PROFILE_ID), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (response.Item === undefined) return false;
  const { pk: _pk, sk: _sk, ...fields } = response.Item;
  void _pk; void _sk;
  const hold = RequalifyHoldSchema.safeParse(fields);
  if (hold.success) return Date.parse(hold.data.until) > now;
  // Not a hold this code wrote (an extra attribute, a damaged time): still read as active, but never for ever. It ends at its own `until` if that is a time, else `acquiredAt` plus the
  // longest a renewal may run; with neither, it stands and the log says so (a fixed event, no row contents).
  const until = typeof fields.until === "string" ? Date.parse(fields.until) : Number.NaN;
  const acquired = typeof fields.acquiredAt === "string" ? Date.parse(fields.acquiredAt) : Number.NaN;
  const end = Number.isFinite(until) ? until : Number.isFinite(acquired) ? acquired + REQUALIFY_HOLD_MAX_MS : Number.NaN;
  if (!Number.isFinite(end)) console.log(JSON.stringify({ component: "broker", event: "requalify.hold_unreadable" }));
  return !Number.isFinite(end) || end > now;
}

/** The longest a renewal may run (its execution timeout): the bound of a hold row that cannot be read as one. */
export const REQUALIFY_HOLD_MAX_MS = 3 * 3_600_000;

/**
 * The hold as a condition inside a round's or setup run's own start transaction (the item is a ConditionCheck on the HOLD row): the start commits only while no hold stands. A start that
 * passed the earlier look just before the renewal placed its hold is refused here, so no round or setup run can begin on the old machine once the switch is in progress. A hold row that
 * cannot be read as one fails the check too, until its `until` string sorts before now.
 */
export function requalifyHoldFence(tableName: string, now: number): Record<string, unknown> {
  return { ConditionCheck: { TableName: tableName, Key: requalifyHoldKey(REQUALIFY_PROFILE_ID), ConditionExpression: "attribute_not_exists(pk) OR #until <= :now",
    ExpressionAttributeNames: { "#until": "until" }, ExpressionAttributeValues: { ":now": new Date(now).toISOString() } } };
}

/** For an interactive start (a project setup): refuses while a switch is in progress, with a retryable error and a fixed sentence. */
export async function assertNoRequalifyHold(store: RequalifyHoldStore, now: number): Promise<void> {
  if (await requalifyHoldActive(store, now)) throw agentXError("RUNTIME_UNAVAILABLE", REQUALIFY_DEFERRED_MESSAGE);
}

// ---- the drain ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** How long after its deadline a project setup run is still counted as running if its record cannot be read. */
const SETUP_RUN_GRACE_MS = 5 * 60_000;
const setupWorkKey = (setupExecutionId: string) => ({ pk: `RUNTIME_REQUALIFY_WORK#${REQUALIFY_PROFILE_ID}`, sk: `SETUP#${setupExecutionId}` });

/**
 * The marker a project setup run leaves when it is admitted on the registered machine, so the drain can find it (executions have no index of their own). It ends with the run's
 * deadline plus a grace and expires with the table's time to live. Written in the same transaction as the run's rows.
 */
export function requalifySetupWorkRow(setupExecutionId: string, deadlineAt: string): Record<string, unknown> {
  const until = new Date(Date.parse(deadlineAt) + SETUP_RUN_GRACE_MS).toISOString();
  return { ...setupWorkKey(setupExecutionId), entityType: "RUNTIME_REQUALIFY_SETUP_WORK", setupExecutionId, until, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(until) / 1000) + 86_400 };
}

export interface RequalifyDrainStatus { drained: boolean; applicationRounds: number; setupRuns: number }

async function queryAll(store: RequalifyHoldStore, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await store.documentClient.send(new QueryCommand({ TableName: store.tableName, ...input, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as
      { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/**
 * Whether anything that started on the old machine is still running: a browser and API CHECKS operation (any purpose) of a workspace whose compute is READY, or a project setup run that
 * was admitted and has not ended. An operation that has not moved for longer than the stale-run sweep is not counted (the sweep ends it; a round cannot still be running). A setup run
 * counts until its record is terminal or its marker ends. Reads only.
 */
export async function requalifyDrainStatus(store: RequalifyHoldStore, now: number): Promise<RequalifyDrainStatus> {
  const sessions = await queryAll(store, { IndexName: WORKSPACE_SESSION_STATE_INDEX.name, KeyConditionExpression: "#index = :state",
    ExpressionAttributeNames: { "#index": WORKSPACE_SESSION_STATE_INDEX.partitionKey }, ExpressionAttributeValues: { ":state": "READY" } });
  let applicationRounds = 0;
  for (const session of sessions) {
    if (typeof session.workspaceId !== "string") continue;
    const operations = await queryAll(store, { KeyConditionExpression: "pk = :pk AND begins_with(sk, :operation)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": `WORKSPACE#${session.workspaceId}`, ":operation": "OPERATION#" } });
    for (const operation of operations) {
      const admission = operation.workflowE2EAdmission as { kind?: unknown } | undefined;
      if (operation.entityType !== "OPERATION" || operation.workflowMode !== "CHECKS" || admission?.kind !== "application") continue;
      if ((TERMINAL_OPERATION_STATUSES as ReadonlySet<unknown>).has(operation.status)) continue;
      const touched = Date.parse(typeof operation.updatedAt === "string" ? operation.updatedAt : typeof operation.createdAt === "string" ? operation.createdAt : "");
      if (Number.isFinite(touched) && now - touched > STALE_RUN_SWEEP_AGE_MS) continue;
      applicationRounds += 1;
    }
  }
  let setupRuns = 0;
  const markers = await queryAll(store, { KeyConditionExpression: "pk = :pk AND begins_with(sk, :setup)", ConsistentRead: true,
    ExpressionAttributeValues: { ":pk": setupWorkKey("x").pk, ":setup": "SETUP#" } });
  for (const marker of markers) {
    if (typeof marker.setupExecutionId !== "string" || Date.parse(String(marker.until)) <= now) continue;
    const execution = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: projectSetupExecutionKey(marker.setupExecutionId), ConsistentRead: true })) as { Item?: { state?: unknown } };
    if (execution.Item === undefined || execution.Item.state === "ACCEPTED" || execution.Item.state === "DISPATCHING") setupRuns += 1;
  }
  return { drained: applicationRounds === 0 && setupRuns === 0, applicationRounds, setupRuns };
}

/** What the renewal's drain step asks (AR-2's `RequalifyDrainPort`): how many rounds and setup runs that began on the old machine are still running. A read that fails throws, and the step's own retry applies; it never answers "none" for what it could not read. */
export async function requalifyDrainCount(store: RequalifyHoldStore, now: number): Promise<number> {
  const status = await requalifyDrainStatus(store, now);
  return status.applicationRounds + status.setupRuns;
}

// ---- a renewal is not any other change of the selection ----------------------------------------------------------------------------------------------------------------------

/** A dispatch refused only because the test machine was renewed. Its message begins with `WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX`. */
export class ApplicationRuntimeRenewed extends ApplicationDispatchRefusal {}

type SelectionRow = E2EApplicationSelectionRecord["runtimeRows"][number];

/**
 * Whether `current` differs from the `recorded` (approved) selection only by a renewal of the runtime rows: every other field the dispatch compares is the same, the pinned test
 * accounts are the same, each recorded row has a current row of the same kind and profile with the same catalog id, binding and capabilities and a newer generation, and at least one row
 * moved. Anything else (a row that is gone, re-bound or with other capabilities, a changed plan, setup, target or account) is not a renewal.
 */
export function isRenewalOnlyChange(recorded: E2EApplicationSelectionRecord, current: E2EApplicationSelectionRecord): boolean {
  if (recorded.runtimeRows.length === 0 || recorded.runtimeRows.length !== current.runtimeRows.length) return false;
  // Everything the dispatch compares, with the rows taken as approved: a difference in any of it is not a renewal.
  if (!applicationSelectionStillCurrent(recorded, { ...current, runtimeRows: recorded.runtimeRows }).ok) return false;
  const accounts = (selection: E2EApplicationSelectionRecord) => canonicalJson([...selection.accountRefs].sort((left, right) => `${left.applicationId}\0${left.profileId}`.localeCompare(`${right.applicationId}\0${right.profileId}`)));
  if (accounts(recorded) !== accounts(current)) return false;
  // What the dispatch comparison leaves out: the criteria that wait. (The application plan and bundle digests are not compared: they are derived from the runtime rows and move with every
  // renewal. The catalog revision is only allowed to grow for the same reason: every registration of a row writes the next one.)
  if (canonicalJson(recorded.unavailableCriteria) !== canonicalJson(current.unavailableCriteria)) return false;
  const renewed = (row: SelectionRow, now: SelectionRow) => now.kind === row.kind && now.profileId === row.profileId && now.runtimeCatalogId === row.runtimeCatalogId
    && now.bindingDigest === row.bindingDigest && now.capabilityDigest === row.capabilityDigest && now.generation > row.generation && now.catalogRevision >= row.catalogRevision;
  let moved = false;
  for (const row of recorded.runtimeRows) {
    const now = current.runtimeRows.find((item) => item.kind === row.kind && item.profileId === row.profileId);
    if (now === undefined) return false;
    if (canonicalJson(now) === canonicalJson(row)) continue;
    if (!renewed(row, now)) return false;
    moved = true;
  }
  return moved;
}

/**
 * The refusal for an approved selection that is no longer the current one: the renewal kind when the machine was only renewed, else the ordinary one that asks for a person. The
 * message is the prefix plus the reason `applicationSelectionStillCurrent` gave.
 */
export function selectionChangedRefusal(recorded: E2EApplicationSelectionRecord, current: E2EApplicationSelectionRecord, reason: string, ordinaryPrefix: string): ApplicationDispatchRefusal {
  return isRenewalOnlyChange(recorded, current) ? new ApplicationRuntimeRenewed(`${WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX}${reason}`) : new ApplicationDispatchRefusal(`${ordinaryPrefix}${reason}`);
}

/** Whether a block reason is the renewal kind, whose approval again Rovara's own retry may do (once, by the policy's retry limit). */
export const isRuntimeRenewedBlock = (blockReason: string | undefined): boolean => blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX) === true;

/**
 * The guard on Rovara's own re-approval: the selection derived again must be the approved one with only the rows renewed (and the same test accounts, which the owner's re-approval would
 * otherwise move to the latest). Anything else needs the owner, so the automatic retry refuses.
 */
export function requireRenewalOnlyReapproval(approved: E2EApplicationSelectionRecord, derived: E2EApplicationSelectionRecord): void {
  if (!isRenewalOnlyChange(approved, derived)) throw agentXError("CONFIG_INVALID", "this block needs the owner to approve the plan again; only a renewal of the test machine is approved again automatically");
}

// ---- replays ------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whether a round ran on runtime rows that are not the registered ones any more (a row that is gone or was requalified since). */
export function replayPredatesRenewal(admitted: readonly E2ERegisteredRuntime[], current: readonly E2ERegisteredRuntime[]): boolean {
  return admitted.some((row) => {
    const now = current.find((item) => item.capabilities.kind === row.capabilities.kind && item.profileId === row.profileId);
    return now === undefined || canonicalJson(now) !== canonicalJson(row);
  });
}

// ---- a task worker on another kernel than the test machine ------------------------------------------------------------------------------------------------------------------

/**
 * A round ended `runtime-environment-drifted`: the task's worker booted on another image than the machine the runtime was qualified on. The worker is stopped so that the one automatic
 * retry starts a fresh one (which the provisioner launches from the qualified image, AR-4). Only a READY session is claimed, and with the reaper's own atomic claim: it fails if the
 * worker was touched since it was read or the workspace has an operation running, so a dispatch always wins. Returns whether the worker was claimed; any other state needs nothing.
 */
export async function recycleDriftedWorker(sessions: Pick<SessionManager, "get" | "claimStop">, workspaceId: string): Promise<boolean> {
  const seen = await sessions.get(workspaceId);
  if (seen === undefined || seen.state !== "READY") return false;
  return sessions.claimStop(seen);
}
