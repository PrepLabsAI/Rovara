import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CloseRetentionReplySchema, CloseRetentionSchema, CLOSE_RETENTION_FEATURE, OrgIdSchema, retentionSuperseded, SessionCloseDestroySchema, canonicalRetentionValue, change, when, workspaceSessionKey, type CloseRetention, type CloseRetentionPayload, type DocumentStore, type OrgId, type TransactItem, type WorkerInvocation, type WorkerMachines, type WorkspaceSession } from "@agentx/contracts";
import type { CloseInspectionProvider, RetainedCloseInspection } from "../../core/task-flow/close-inspection.js";
import { taskKey } from "../../core/task-flow/keys.js";
import { readWorkspace } from "../../core/task-flow/stage-machine.js";
import { workspaceKeys } from "../../core/task-flow/workspace-location.js";
import { fromDocument, toDocument, type OperationRecord } from "../../core/task-flow/records.js";
import { closeOperationId } from "../../core/task-flow/close-acceptance-record.js";
import type { SessionManager } from "../sessions.js";
import { sessionMachineId } from "./session-worker-machines.js";

export const CloseVerificationEventSchema = z.object({ kind: z.literal("close-retention.verify"), schemaVersion: z.literal(1), companyId: OrgIdSchema,
  workspaceId: z.string().uuid(), retention: CloseRetentionSchema, queryId: z.string().uuid() }).strict();
export type CloseVerificationEvent = z.infer<typeof CloseVerificationEventSchema>;
type Inspection = RetainedCloseInspection & { contentDigest: string };
const equal = (a: unknown, b: unknown) => canonicalRetentionValue(a) === canonicalRetentionValue(b);
const selector = (input: Inspection): CloseRetention | undefined => {
  const result = CloseRetentionSchema.safeParse({ inspectionOperationId: input.operationId, inspectionFence: input.fence, retentionId: input.retentionId,
    contentDigest: input.contentDigest, generation: input.retentionProof?.generation });
  return result.success ? result.data : undefined;
};
interface HostedCloseDeps { now?: () => Date; companyId: OrgId; store: DocumentStore; machines: WorkerMachines; sessions: Pick<SessionManager, "get"> & Partial<Pick<SessionManager, "deleteRetainedSession">> }

/** Strict read-only request discrimination happens before any legacy/SQS routing. */
export function withCloseVerification<E, C, R>(inner: (event: E, context?: C) => Promise<R>, verify: (event: CloseVerificationEvent) => Promise<boolean>) {
  return async (event: unknown, context?: C): Promise<R | { schemaVersion: 1; queryId: string; verified: boolean }> => {
    if (typeof event !== "object" || event === null || !("kind" in event) || event.kind !== "close-retention.verify") return inner(event as E, context);
    const query = CloseVerificationEventSchema.parse(event);
    return { schemaVersion: 1, queryId: query.queryId, verified: await verify(query).catch(() => false) };
  };
}

/** Dispatcher-only provider: signed transport goes through the production company-bound fleet. */
export function createDispatcherCloseInspection(deps: HostedCloseDeps): CloseInspectionProvider {
  const { store, companyId, machines } = deps;
  const sessionFor = async (workspaceId: string) => {
    const workspace = await readWorkspace({ store, companyId }, workspaceId);
    if (workspace?.companyId !== companyId) throw new Error("workspace unavailable");
    return deps.sessions.get(workspaceId);
  };
  const command = async (workspaceId: string, operationId: string, fence: number, payload: CloseRetentionPayload) => {
    const workspace = await readWorkspace({ store, companyId }, workspaceId);
    if (workspace === undefined) throw new Error("workspace unavailable");
    const invocation: WorkerInvocation = { protocolVersion: 1, kind: "close", workspaceId, operationId, fence,
      projectRevision: workspace.projectRevision, callbackCapability: "retention-inline-no-callback".repeat(3), payload };
    const answer = CloseRetentionReplySchema.parse((await machines.deliver(sessionMachineId(workspaceId), invocation)).answer);
    if (answer.workspaceId !== workspaceId || answer.operationId !== operationId || answer.fence !== fence || answer.action !== payload.action) throw new Error("retention reply mismatch");
    return answer;
  };
  const retained = async (input: Inspection, queryId = randomUUID()): Promise<boolean> => {
    const retention = selector(input), session = await sessionFor(input.workspaceId);
    if (retention === undefined || session?.state !== "READY" || !equal(session.closeRetention?.retained, retention) || !sameMachine(session, retention.generation)) return false;
    const reply = await command(input.workspaceId, closeOperationId(companyId, input.operationId, `verify:${queryId}`), input.fence, { schemaVersion: 1, action: "verify", retention, queryId });
    return reply.status === "verified" && reply.verified && reply.queryId === queryId && equal(reply.retention, retention);
  };
  const provider: CloseInspectionProvider = {
    availability: async workspaceId => closeAvailability(await sessionFor(workspaceId), await readWorkspace({ store, companyId }, workspaceId)),
    wake: async workspaceId => {
      const session = await sessionFor(workspaceId);
      if (session === undefined) return "gone";
      if (session.state === "READY") { await provider.noteRuntime?.(workspaceId, await machines.health(sessionMachineId(workspaceId))); return "ready"; }
      // A stopped (or stopping, or already starting) machine: the start is idempotent, keeps the volume, and admits nothing new (the workspace's machine already exists).
      if (session.state !== "STOPPED" && session.state !== "STOPPING" && session.state !== "PROVISIONING") return "gone";
      const workspace = await readWorkspace({ store, companyId }, workspaceId);
      if (workspace === undefined) return "gone";
      const handle = await machines.start({ machineKey: workspaceId, companyId, projectName: workspace.projectName, labels: { workspaceId } });
      return handle.state === "ready" ? "ready" : "waking";
    },
    replayRetention: async (workspaceId, unconfirmed) => {
      const reply = await command(workspaceId, unconfirmed.operationId, unconfirmed.fence, { schemaVersion: 1, action: "retain", target: unconfirmed.generation });
      return reply.status === "retained" && reply.action === "retain" ? reply.retention : undefined;
    },
    noteRuntime: async (workspaceId, health, operation) => {
      const session = await sessionFor(workspaceId), generation = health.workspaceDataIdentity;
      if (session?.state !== "READY" || generation === undefined || !sameMachine(session, generation)) return;
      const supersedes = operation?.supersedesRetention;
      const condition = supersedes === undefined ? when.notExists("closeRetention") : when.and(when.eq("closeRetention.retained", toDocument(supersedes)), when.notExists("closeRetention.acceptedOperationId"));
      await store.transact([{ kind: "update", key: workspaceSessionKey(workspaceId), condition: when.and(sessionIdentity(session), condition, when.notExists("closeDestroy")), ops: [change.set("workerFeatures", [...health.features]), change.set("workspaceDataIdentity", toDocument(generation)), ...(supersedes === undefined ? [] : [change.remove("closeRetention")])] }]);
    },
    ready: async (workspaceId, live = false) => {
      const session = await sessionFor(workspaceId);
      if (session?.state !== "READY") return false;
      if (!live) return session.workerFeatures?.includes(CLOSE_RETENTION_FEATURE) === true;
      const health = await machines.health(sessionMachineId(workspaceId));
      return health.state === "ready" && health.features.includes(CLOSE_RETENTION_FEATURE) && health.workspaceDataIdentity !== undefined && sameMachine(session, health.workspaceDataIdentity);
    },
    raiseFence: async () => { /* retain signs and syncs the barrier inside its host ownership lock */ },
    inspectWorkspaceForClose: async input => {
      const session = await sessionFor(input.workspaceId), location = await workspaceKeys({ store, companyId }, input.workspaceId);
      const operation = fromDocument<OperationRecord>(await store.get(location.operationKey(input.operationId)));
      if (session?.state !== "READY" || operation?.closePreflight === undefined) throw new Error("retention preparation unavailable");
      const health = await machines.health(sessionMachineId(input.workspaceId));
      const generation = operation.closePreflight.target ?? health.workspaceDataIdentity;
      if (generation === undefined || !health.features.includes(CLOSE_RETENTION_FEATURE) || !sameMachine(session, generation)) throw new Error("retention generation unavailable");
      const intent = { schemaVersion: 1 as const, operationId: input.operationId, fence: input.fence, generation };
      // A record of ANOTHER preflight is replaced (atomically, by the claim below) only when it is from an EARLIER fence and not an accepted close's: its step superseded it, so it guards nothing; the same preflight's own intent is resumed.
      if (session.closeRetention !== undefined && !equal({ ...session.closeRetention, retained: undefined }, intent) && (session.closeRetention.operationId === input.operationId || session.closeRetention.fence >= input.fence || session.closeRetention.acceptedOperationId !== undefined)) throw new Error("another retention owns the session");
      const claimed = await store.transact([
        { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("companyId", companyId), when.eq("activeOperationId", input.operationId), when.eq("fence", input.fence), when.notExists("legacyCloseClaim")) },
        { kind: "update", key: location.operationKey(input.operationId), condition: when.and(when.eq("companyId", companyId), when.eq("status", "RUNNING"), when.eq("closePreflight", toDocument(operation.closePreflight))), ops: [change.set("closePreflight.target", toDocument(generation))] },
        { kind: "update", key: workspaceSessionKey(input.workspaceId), condition: when.and(sessionIdentity(session), session.closeRetention === undefined ? when.notExists("closeRetention") : when.eq("closeRetention", toDocument(session.closeRetention)), when.notExists("closeDestroy")), // The check gets a FULL idle window from here: a step longer than the window leaves the session looking idle, and the idle reaper must not end the instance under a retain that is running.
        ops: [change.set("closeRetention", toDocument(session.closeRetention?.operationId === input.operationId ? session.closeRetention : intent)), change.set("workspaceDataIdentity", toDocument(generation)), change.set("lastActivityAt", (deps.now?.() ?? new Date()).toISOString())] },
      ]);
      if (!claimed.applied) throw new Error("retention preparation moved");
      const reply = await command(input.workspaceId, input.operationId, input.fence, { schemaVersion: 1, action: "retain", target: generation });
      if (reply.status !== "retained" || !equal(reply.retention.generation, generation)) throw new Error("retention not completed");
      const saved = await store.transact([{ kind: "update", key: workspaceSessionKey(input.workspaceId), condition: when.and(sessionIdentity(session), when.eq("closeRetention.operationId", input.operationId), when.eq("closeRetention.generation", toDocument(generation)), when.notExists("closeRetention.acceptedOperationId")), ops: [change.set("closeRetention.retained", toDocument(reply.retention))] }]);
      if (!saved.applied) throw new Error("retention ownership moved");
      return { inspection: reply.inspection, retentionId: reply.retention.retentionId, retentionProof: { schemaVersion: 1, generation } };
    },
    retained,
    acceptanceItems: retentionAcceptanceItems,
    destroyRetained: async input => {
      const retention = selector(input), session = await sessionFor(input.workspaceId);
      if (retention === undefined || session === undefined || !equal([...input.machineIds].sort(), [sessionMachineId(input.workspaceId)])) return false;
      const location = await workspaceKeys({ store, companyId }, input.workspaceId), id = session.closeRetention?.acceptedOperationId;
      if (id === undefined) return false;
      const operation = fromDocument<OperationRecord>(await store.get(location.operationKey(id))), acceptance = operation?.closeAcceptance;
      if (operation === undefined || acceptance === undefined || acceptance.effectIds.terminate !== input.effectId || acceptance.phase !== "accounted" || acceptance.receipts["account"] === undefined || !equal(selector(acceptance.inspection), retention)) return false;
      const target = SessionCloseDestroySchema.parse({ schemaVersion: 1, acceptedOperationId: id, retention, effectId: input.effectId, machineIds: [...input.machineIds].sort() });
      if (session.closeDestroy !== undefined) return equal(session.closeDestroy, target) && await deps.sessions.deleteRetainedSession?.(input.workspaceId, target) === true;
      if (session.state !== "READY" || !sameMachine(session, retention.generation) || !equal(session.closeRetention?.retained, retention)) return false;
      const reply = await command(input.workspaceId, closeOperationId(companyId, id, input.effectId), operation.fence, { schemaVersion: 1, action: "destroy", retention, effectId: input.effectId, machineIds: [...input.machineIds].sort() });
      if (reply.status !== "destroy_authorized" || !equal(reply.retention, retention) || reply.effectId !== target.effectId || !equal(reply.machineIds, target.machineIds)) return false;
      const claimed = await store.transact([
        ...await destroyClaimItems(store, companyId, operation),
        { kind: "update", key: location.operationKey(id), condition: when.eq("closeAcceptance", toDocument(acceptance)), ops: [change.set("closeDestroyAuthorization", toDocument(target))] },
        { kind: "update", key: workspaceSessionKey(input.workspaceId), condition: when.and(sessionIdentity(session), when.eq("workspaceDataIdentity", toDocument(retention.generation)), when.eq("closeRetention", toDocument(session.closeRetention!)), when.notExists("closeDestroy")), ops: [change.set("state", "DELETING"), change.set("closeDestroy", toDocument(target))] },
      ]);
      return claimed.applied && await deps.sessions.deleteRetainedSession?.(input.workspaceId, target) === true;
    },
  };
  return provider;
}

/**
 * What a check of a workspace needs, read from its session item alone: a READY machine is checkable when its worker is known to retain (an old worker is never); a STOPPED or STOPPING one has no instance,
 * so its preparation starts it first (the new instance runs the install's current worker); anything else (failed, starting for a step, deleted, absent) cannot be checked.
 */
export function closeAvailability(session: object | undefined, workspace?: { activeOperationId?: unknown; fence?: unknown }): "ready" | "wake" | "unsupported" {
  const { state, workerFeatures, closeRetention, closeDestroy } = (session ?? {}) as { state?: unknown; workerFeatures?: unknown; closeRetention?: { operationId: string; fence: number; acceptedOperationId?: unknown }; closeDestroy?: unknown };
  // A session the retention protocol already owns cannot have a second check layered on it (its preparation refuses "another retention owns the session"): such a close is never promised a check. (Work CAN resume
  // on it: a Continue or a new step wakes a retained STOPPED session on its volume and lifts the retention; only a Close's check is not layered on a retention.)
  // ... unless a step has superseded the record (the workspace is no longer held by its preflight): then it guards nothing, and the check replaces it.
  if (closeDestroy !== undefined || closeRetention?.acceptedOperationId !== undefined) return "unsupported";
  if (closeRetention !== undefined && !retentionSuperseded(closeRetention, workspace)) return "unsupported";
  if (state === "STOPPED" || state === "STOPPING") return "wake";
  if (state !== "READY") return "unsupported";
  return Array.isArray(workerFeatures) && workerFeatures.includes(CLOSE_RETENTION_FEATURE) ? "ready" : "unsupported";
}

function sameMachine(session: WorkspaceSession, generation: CloseRetention["generation"]): boolean {
  return session.generation === generation.sessionGeneration && session.instanceId === generation.instanceId && session.volumeId === generation.volumeId;
}
function sessionIdentity(session: WorkspaceSession) {
  return when.and(when.eq("state", session.state), when.eq("generation", session.generation), when.eq("instanceId", session.instanceId!), when.eq("volumeId", session.volumeId!));
}
async function destroyClaimItems(store: DocumentStore, companyId: OrgId, operation: OperationRecord): Promise<TransactItem[]> {
  const a = operation.closeAcceptance!, location = await workspaceKeys({ store, companyId }, operation.workspaceId);
  return [
    { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("companyId", companyId), when.eq("status", "CLOSING"), when.eq("fence", operation.fence), when.eq("activeOperationId", operation.id)) },
    { kind: "check", key: taskKey(a.taskId), condition: when.and(when.eq("companyId", companyId), when.eq("closeOperationId", operation.id), when.notExists("closedAt")) },
  ];
}

/** Broker has only the strict read-only Lambda relay; no worker signing, posting or mutation port. */
export function createBrokerCloseInspection(verify: (event: CloseVerificationEvent) => Promise<boolean>, companyId: OrgId, store: DocumentStore): CloseInspectionProvider {
  const unavailable = async (): Promise<never> => { throw new Error("retention preparation runs only on the dispatcher"); };
  return { raiseFence: unavailable, inspectWorkspaceForClose: unavailable, acceptanceItems: retentionAcceptanceItems,
    availability: async workspaceId => closeAvailability(await store.get(workspaceSessionKey(workspaceId)), await readWorkspace({ store, companyId }, workspaceId)),
    ready: async workspaceId => {
      const session = await store.get(workspaceSessionKey(workspaceId));
      return session?.["state"] === "READY" && Array.isArray(session["workerFeatures"]) && session["workerFeatures"].includes(CLOSE_RETENTION_FEATURE);
    },
    retained: async input => { const retention = selector(input); return retention !== undefined && await verify({ kind: "close-retention.verify", schemaVersion: 1, companyId, workspaceId: input.workspaceId, retention, queryId: randomUUID() }); },
  };
}
function retentionAcceptanceItems(input: Inspection, acceptedOperationId: string): TransactItem[] {
  const retention = selector(input);
  if (retention === undefined) throw new Error("retention proof missing");
  return [{ kind: "update", key: workspaceSessionKey(input.workspaceId), condition: when.and(when.eq("state", "READY"), when.eq("workspaceDataIdentity", toDocument(retention.generation)), when.eq("closeRetention.retained", toDocument(retention)), when.notExists("closeRetention.acceptedOperationId"), when.notExists("closeDestroy")), ops: [change.set("closeRetention.acceptedOperationId", acceptedOperationId)] }];
}
