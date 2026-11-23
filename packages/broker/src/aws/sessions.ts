import { SessionCloseDestroySchema, canonicalRetentionValue, type SessionCloseDestroy } from "@agentx/contracts";
import { readWorkspaceMeta } from "./worker-machines/workspace-company.js";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  Ec2RuntimeBindingSchema,
  ProjectSetupSessionSchema,
  WORKSPACE_SESSION_STATE_INDEX,
  WorkspaceSessionSchema,
  agentXError,
  canonicalJson,
  sessionDeletionName,
  sessionProvisioningName,
  workspaceSessionKey,
  projectSetupSessionKey,
  type Ec2RuntimeBinding,
  type WorkspaceSession,
  type WorkspaceSessionState,
  type ProjectSetupSession,
  type MachineFallback,
  type MachineLaunch,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import type { DurableOutboxRecord } from "./lambda.js";
import { failOutboxOperation } from "./outbox-failure.js";
import type { MachinePick } from "./worker-machines/machine-size-pick.js";

/** What the provisioner state machine starts from. Deterministic for one generation, so a retried start is idempotent. */
export interface ProvisioningInput {
  workspaceId: string;
  generation: number;
  availabilityZone: string;
  subnetId: string;
  launchTemplateId: string;
  /** Absent on the generation that creates the volume. */
  volumeId: string | null;
  volumeSizeGiB: number;
  volumeType: Ec2RuntimeBinding["volumeType"];
  /** DEC 254zb: the project's chosen machine size. Absent: the launch template's own type, exactly as before. */
  machine?: MachineLaunch;
}

export interface DeletionInput {
  workspaceId: string;
  instanceId: string | null;
  volumeId: string | null;
  closeDestroy?: SessionCloseDestroy;
}

export type EnsureSessionResult =
  /** `machineFallback`: this generation runs on the default size instead of the project's choice, for that fixed reason (the task is told). */
  | { ready: true; generation: number; privateIp: string; machineFallback?: MachineFallback }
  | { ready: false; generation: number; state: WorkspaceSessionState };

export interface SessionExecutions {
  provisionerArn: string;
  deleterArn: string;
  /** StepFunctions StartExecution; returns the execution ARN. */
  start: (input: { stateMachineArn: string; name: string; input: string }) => Promise<string>;
}

export interface SessionManagerDependencies {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
  /**
   * Needed by ensureSession and deleteSession. The state machines' own step Lambda has none: it
   * only records their progress, and the state machines refer to it, not the other way round.
   */
  executions?: SessionExecutions;
  now?: () => Date;
  /** Picks the first availability zone of a workspace; random by default. */
  chooseSubnet?: (subnets: Ec2RuntimeBinding["subnets"]) => Ec2RuntimeBinding["subnets"][number];
  /**
   * DEC 254zb: the size the workspace's next worker launches as (machine-size-pick.ts), asked once per provisioning. Absent (the switch is off): every worker
   * launches as the launch template says, and the provisioning input is exactly today's. A picker that fails is "no choice".
   */
  pickMachine?: (workspaceId: string) => Promise<MachinePick>;
}

const MAX_ATTEMPTS = 5;
const SESSION_ENTITY = "SESSION";

/**
 * Owns every SESSION state transition of an ec2-ebs workspace (design in #76). Each write is
 * conditional on the state and generation it was read in, so concurrent callers (the dispatcher,
 * the provisioner, the idle reaper, the reconciler) can only ever apply one transition.
 */
export class SessionManager {
  constructor(private readonly dependencies: SessionManagerDependencies) {}

  async get(workspaceId: string): Promise<WorkspaceSession | undefined> {
    const response = await this.dependencies.documentClient.send(new GetCommand({
      TableName: this.dependencies.tableName,
      Key: workspaceSessionKey(workspaceId),
      ConsistentRead: true,
    }));
    return response.Item === undefined ? undefined : sessionFromItem(response.Item);
  }

  /**
   * Returns the worker's address when the session is READY. Otherwise starts provisioning when
   * nothing is starting it yet, parks `waitingOutboxId` (when given) until markReady or markFailed,
   * and returns NOT_READY: the caller acknowledges its message without using a retry.
   */
  async ensureSession(input: { workspaceId: string; binding: Ec2RuntimeBinding; waitingOutboxId?: string }): Promise<EnsureSessionResult> {
    const { workspaceId, binding, waitingOutboxId } = input;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const session = await this.get(workspaceId);
      const retainedReady = retainedReadySession(session);
      if (retainedReady !== undefined) return retainedReady;
      const state = session?.state ?? "NONE";
      switch (state) {
        case "READY": {
          const ready = session!;
          if (!(await this.conditional(this.update(workspaceId, {
            set: { lastActivityAt: this.now() },
            when: { state: "READY", generation: ready.generation },
          })))) continue;
          return { ready: true, generation: ready.generation, privateIp: ready.privateIp!, ...(ready.machineFallback === undefined ? {} : { machineFallback: ready.machineFallback }) };
        }
        case "NONE":
        case "STOPPED":
        case "FAILED": {
          const placement = placementFor(session, binding, this.dependencies.chooseSubnet ?? randomSubnet);
          const generation = (session?.generation ?? 0) + 1;
          const provisioning = {
            state: "PROVISIONING" as const,
            generation,
            availabilityZone: placement.availabilityZone,
            subnetId: placement.subnetId,
          };
          const sessionWrite = (park: boolean) => session === undefined
            ? { Put: {
                TableName: this.dependencies.tableName,
                Item: {
                  ...workspaceSessionKey(workspaceId),
                  entityType: SESSION_ENTITY,
                  workspaceId,
                  ...provisioning,
                  [WORKSPACE_SESSION_STATE_INDEX.partitionKey]: provisioning.state,
                  ...(park ? { waitingOutboxIds: new Set([waitingOutboxId]) } : {}),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              } }
            : { Update: this.update(workspaceId, {
                set: { ...provisioning },
                // DEC 254zb: a new generation starts with no fallback reason; this one's is recorded when it is picked or launched.
                remove: ["instanceId", "privateIp", "launchedAt", "readyAt", "executionArn", "machineFallback"],
                ...(park ? { addWaiting: waitingOutboxId } : {}),
                // A retained session that was stopped (or whose last start failed) is started again on its kept volume, exactly like a plain one: retention changes what a Close does, never whether work resumes.
                ...(session.closeRetention === undefined ? {} : { retention: session.closeRetention, retainedBy: "wake" as const }),
                when: { state, generation: session.generation },
              }) };
          if (!(await this.writeWithOutbox(sessionWrite, waitingOutboxId))) continue;
          const started = await this.get(workspaceId);
          await this.startMatchingProvisioning(started, binding, generation);
          return { ready: false, generation, state: "PROVISIONING" };
        }
        case "PROVISIONING":
        case "STOPPING": {
          const current = session!;
          if (waitingOutboxId !== undefined) {
            // Nothing changes on the session unless the record is parked.
            const parked = await this.writeWithOutbox((park) => (park ? { Update: this.update(workspaceId, {
              addWaiting: waitingOutboxId, retainedBy: "provisioning",
              when: { state, generation: current.generation },
            }) } : undefined), waitingOutboxId);
            if (!parked) continue;
          }
          // A provisioning whose start failed before its execution was recorded is started again;
          // the execution name makes that idempotent.
          if (state === "PROVISIONING" && current.executionArn === undefined) await this.startProvisioning(current, binding);
          return { ready: false, generation: current.generation, state };
        }
        case "DELETING":
        case "DELETED":
          throw agentXError("WORKSPACE_NOT_READY", "workspace compute has been deleted");
        default:
          return unhandledState(state);
      }
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "workspace session kept changing; retry the request");
  }

  /** Records the volume the provisioner created; the volume's zone was fixed when provisioning began. */
  async markVolume(workspaceId: string, generation: number, volumeId: string): Promise<void> {
    await this.dependencies.documentClient.send(new UpdateCommand({
      ...this.update(workspaceId, { set: { volumeId }, when: { state: "PROVISIONING", generation } }),
      ConditionExpression: "#state = :whenState AND #generation = :whenGeneration AND (attribute_not_exists(volumeId) OR volumeId = :volumeId)",
    }));
  }

  /**
   * Records the launched instance. DEC 254zb: `launched.instanceType` is the type it launched as (kept, like `launchedAt`, for the machine time it used), and
   * `launched.machineFallback` the fixed reason when the chosen size fell back to the default. An earlier generation's reason is cleared when provisioning starts.
   */
  async markInstance(workspaceId: string, generation: number, instanceId: string, privateIp: string, launched: { instanceType?: string; machineFallback?: "size-unavailable" } = {}): Promise<void> {
    await this.dependencies.documentClient.send(new UpdateCommand(this.update(workspaceId, {
      set: { instanceId, privateIp, launchedAt: this.now(), ...(launched.instanceType === undefined ? {} : { instanceType: launched.instanceType }), ...(launched.machineFallback === undefined ? {} : { machineFallback: launched.machineFallback }) },
      when: { state: "PROVISIONING", generation }, retainedBy: "provisioning",
    })));
  }

  /** PROVISIONING → READY once the worker answered its health probe, then re-sends the parked work. */
  async markReady(workspaceId: string, generation: number): Promise<{ requeued: string[] }> {
    const now = this.now();
    const moved = await this.conditional(this.update(workspaceId, {
      set: { state: "READY", readyAt: now, lastActivityAt: now },
      when: { state: "PROVISIONING", generation }, retainedBy: "provisioning",
      require: ["instanceId", "privateIp", "volumeId"],
    }));
    const session = await this.get(workspaceId);
    if (!moved && !(session?.state === "READY" && session.generation === generation)) {
      throw agentXError("STALE_FENCE", `session ${workspaceId} generation ${generation} is no longer provisioning`);
    }
    return this.requeueParked(workspaceId, session);
  }

  /** Sends a READY session's parked outbox records back to PENDING; the publisher re-queues them. */
  async requeueParked(workspaceId: string, current?: WorkspaceSession): Promise<{ requeued: string[] }> {
    const session = current ?? await this.get(workspaceId);
    const requeued: string[] = [];
    for (const outboxId of session?.waitingOutboxIds ?? []) {
      // PENDING again: the outbox publisher re-queues a record on its MODIFY event.
      const sent = await this.conditional({ transaction: [
        { Update: {
          TableName: this.dependencies.tableName,
          Key: outboxKey(outboxId),
          UpdateExpression: "SET #status = :pending",
          ConditionExpression: "#status = :waiting",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":pending": "PENDING", ":waiting": "WAITING_FOR_SESSION" },
        } },
        { Update: this.unpark(workspaceId, outboxId) },
      ] });
      if (sent) requeued.push(outboxId);
      else await this.dependencies.documentClient.send(new UpdateCommand(this.unpark(workspaceId, outboxId)));
    }
    return { requeued };
  }

  /**
   * PROVISIONING → FAILED after the provisioner terminated any instance it launched. The volume is
   * kept. Parked work fails with its operation, so a broken start never loops through new
   * generations; the next request starts a fresh one.
   */
  async markFailed(workspaceId: string, generation: number, error: string): Promise<{ failed: string[] }> {
    const moved = await this.conditional(this.update(workspaceId, {
      set: { state: "FAILED" },
      remove: ["instanceId", "privateIp"],
      when: { state: "PROVISIONING", generation }, retainedBy: "provisioning",
    }));
    const session = await this.get(workspaceId);
    if (!moved && !(session?.state === "FAILED" && session.generation === generation)) {
      throw agentXError("STALE_FENCE", `session ${workspaceId} generation ${generation} is no longer provisioning`);
    }
    const message = `RUNTIME_UNAVAILABLE: workspace compute failed to start: ${error}`.slice(0, 16_384);
    const failed: string[] = [];
    for (const outboxId of session?.waitingOutboxIds ?? []) {
      const response = await this.dependencies.documentClient.send(new GetCommand({ TableName: this.dependencies.tableName, Key: outboxKey(outboxId) }));
      const record = response.Item as DurableOutboxRecord | undefined;
      if (record?.status === "WAITING_FOR_SESSION") {
        try {
          await failOutboxOperation(this.dependencies.documentClient, this.dependencies.tableName, record, message, { status: "WAITING_FOR_SESSION" });
          failed.push(outboxId);
        } catch (failure) {
          if (!isConditionalFailure(failure)) throw failure;
        }
      }
      await this.dependencies.documentClient.send(new UpdateCommand(this.unpark(workspaceId, outboxId)));
    }
    return { failed };
  }

  /**
   * Starts deleting the workspace's instance and volume when it closes. A session that never
   * provisioned has nothing to delete. Refuses while compute is starting. A STOPPING session (a person's Stop,
   * or the reaper's) moves straight to DELETING: the deleter ends the instance itself and waits for the volume
   * to detach before it deletes it, so a Close inside the stop's window still removes the volume (it would
   * otherwise be marked STOPPED by the reaper and kept for ever, after the task closed).
   */
  async deleteSession(workspaceId: string): Promise<{ state: "DELETING" | "DELETED" }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const session = await this.get(workspaceId);
      assertUnretainedSession(session);
      if (session === undefined || session.state === "DELETED") return { state: "DELETED" };
      switch (session.state) {
        case "NONE":
          if (!(await this.conditional(this.update(workspaceId, {
            set: { state: "DELETED" },
            when: { state: "NONE", generation: session.generation },
          })))) continue;
          return { state: "DELETED" };
        case "READY":
        case "STOPPING":
        case "STOPPED":
        case "FAILED":
          if (!(await this.conditional(this.update(workspaceId, {
            set: { state: "DELETING" },
            remove: ["executionArn"],
            when: { state: session.state, generation: session.generation },
          })))) continue;
          await this.startDeletion({ ...session, state: "DELETING" });
          return { state: "DELETING" };
        case "DELETING":
          if (session.executionArn === undefined) await this.startDeletion(session);
          return { state: "DELETING" };
        case "PROVISIONING":
          throw agentXError("WORKSPACE_BUSY", "workspace compute is starting; retry the close");
        default:
          return unhandledState(session.state);
      }
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "workspace session kept changing; retry the close");
  }

  /**
   * READY -> STOPPING for a person's (or the flow's) Stop of a running step: the instance is ended by the reaper's STOPPING pass and the volume is KEPT (a Close deletes it, nothing
   * else does). Unlike `claimStop` it does not wait for the workspace to be idle: the caller holds the operation it is cancelling. So the write is fenced in the same transaction on
   * the workspace's active operation: it must still be the operation read a moment ago, so a step dispatched in the gap is never ended by a Stop meant for the one before it.
   * Returns whether this call made the claim. A no-op (false), never a throw, for a session that is already STOPPING, STOPPED, FAILED, DELETING, NONE, DELETED or absent, and for
   * a workspace with no running operation (the idle rule takes that instance). A PROVISIONING session throws WORKSPACE_BUSY: its instance is not up yet.
   * A session in the middle of a retention hold (`closeRetention` / `closeDestroy`) is never claimed here, and `deleteSession` (every state, the STOPPING arm included) refuses it: only the accepted Close destroys it.
   */
  async requestStop(workspaceId: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const target = await this.stopTarget(workspaceId);
      if (target === undefined) return false;
      const claim = this.update(workspaceId, { set: { state: "STOPPING" }, when: { state: "READY", generation: target.generation } });
      try {
        await this.dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
          { Update: claim },
          { ConditionCheck: {
            TableName: this.dependencies.tableName,
            Key: target.workspaceKey,
            ConditionExpression: "activeOperationId = :seenOperation",
            ExpressionAttributeValues: { ":seenOperation": target.operationId },
          } },
        ] }));
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        // The operation moved on (a result cleared it, or the next step took the workspace): not this Stop's to carry out. Anything else (the session changed, a transaction conflict): read again.
        if (cancelledBy(error, 1)) return false;
      }
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "workspace session kept changing; retry the stop");
  }

  /** The READY session a Stop may claim and the operation the workspace runs now; undefined when there is nothing to stop (see `requestStop`). Throws WORKSPACE_BUSY while PROVISIONING. */
  private async stopTarget(workspaceId: string): Promise<{ generation: number; operationId: string; workspaceKey: { pk: string; sk: string } } | undefined> {
    const session = await this.get(workspaceId);
    if (session?.state === "PROVISIONING") throw agentXError("WORKSPACE_BUSY", "workspace compute is starting; stop it once it is ready");
    if (session?.state !== "READY") return undefined;
    // A session held for a Close's retention (or being destroyed by an accepted Close) is never stopped by a Stop: the preparation holds the workspace and owns the instance until the person decides.
    if (session.closeRetention !== undefined || session.closeDestroy !== undefined) return undefined;
    const workspace = await readWorkspaceMeta(this.dependencies.documentClient, this.dependencies.tableName, workspaceId);
    const operationId = workspace?.item.activeOperationId;
    if (workspace === undefined || typeof operationId !== "string" || operationId === "") return undefined;
    return { generation: session.generation, operationId, workspaceKey: workspace.key };
  }

  /** Every session in `state`, from the sparse state index. */
  async listByState(state: WorkspaceSessionState): Promise<WorkspaceSession[]> {
    const sessions: WorkspaceSession[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.dependencies.documentClient.send(new QueryCommand({
        TableName: this.dependencies.tableName,
        IndexName: WORKSPACE_SESSION_STATE_INDEX.name,
        KeyConditionExpression: "#index = :state",
        ExpressionAttributeNames: { "#index": WORKSPACE_SESSION_STATE_INDEX.partitionKey },
        ExpressionAttributeValues: { ":state": state },
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }));
      sessions.push(...(page.Items ?? []).map(sessionFromItem));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return sessions;
  }

  /**
   * READY → STOPPING for the idle reaper. Holds only if nothing touched the session since `seen`
   * was read (a dispatch touches lastActivityAt) and the workspace has no active operation, both
   * checked in one transaction, so a dispatch racing the reap always wins.
   */
  async claimStop(seen: WorkspaceSession): Promise<boolean> {
    if (seen.closeRetention !== undefined && (seen.closeRetention.retained === undefined || seen.closeRetention.acceptedOperationId !== undefined)) return false;
    const workspace = await readWorkspaceMeta(this.dependencies.documentClient, this.dependencies.tableName, seen.workspaceId);
    const claim = this.update(seen.workspaceId, { retention: seen.closeRetention, set: { state: "STOPPING" }, when: { state: "READY", generation: seen.generation } });
    return this.conditional({ transaction: [
      { Update: {
        ...claim,
        ConditionExpression: `${claim.ConditionExpression} AND lastActivityAt = :seenActivity`,
        ExpressionAttributeValues: { ...claim.ExpressionAttributeValues, ":seenActivity": seen.lastActivityAt },
      } },
      { ConditionCheck: {
        TableName: this.dependencies.tableName,
        Key: workspace?.key ?? { pk: `WORKSPACE#${seen.workspaceId}`, sk: "META" },
        // Terminal transitions remove activeOperationId; some records store it as null instead.
        ...idleWorkspaceCondition(seen),
      } },
      ...idleInspectionCheck(seen, this.dependencies.tableName, workspace?.key.pk),
    ] });
  }

  /**
   * READY → STOPPED when the reconciler finds the READY session's instance gone. Holds only for the
   * instance it saw, so a session that moved on (a new generation, a claim) is left alone.
   */
  async markLost(seen: WorkspaceSession): Promise<boolean> {
    const lost = this.update(seen.workspaceId, {
      retention: seen.closeRetention,
      set: { state: "STOPPED" },
      remove: ["instanceId", "privateIp", "pingFailures"],
      when: { state: "READY", generation: seen.generation },
    });
    return this.conditional({
      ...lost,
      ConditionExpression: `${lost.ConditionExpression} AND instanceId = :seenInstance`,
      ExpressionAttributeValues: { ...lost.ExpressionAttributeValues, ":seenInstance": seen.instanceId },
    });
  }

  /** Counts one more failed health probe of a READY session; returns the new count, or 0 if it moved on. */
  async recordPingFailure(seen: WorkspaceSession): Promise<number> {
    const counted = await this.conditional(this.update(seen.workspaceId, {
      addPingFailure: true, retention: seen.closeRetention,
      when: { state: "READY", generation: seen.generation },
    }));
    return counted ? (await this.get(seen.workspaceId))?.pingFailures ?? 0 : 0;
  }

  async clearPingFailures(seen: WorkspaceSession): Promise<void> {
    await this.conditional(this.update(seen.workspaceId, { retention: seen.closeRetention, remove: ["pingFailures"], when: { state: "READY", generation: seen.generation } }));
  }

  /** STOPPING → STOPPED once the instance is gone and the volume detached. Returns the session after. */
  async markStopped(workspaceId: string, generation: number): Promise<WorkspaceSession> {
    const seen = await this.get(workspaceId);
    const moved = await this.conditional(this.update(workspaceId, {
      set: { state: "STOPPED" },
      remove: ["instanceId", "privateIp"],
      when: { state: "STOPPING", generation }, retention: seen?.closeRetention,
    }));
    const session = await this.get(workspaceId);
    if (!moved && !(session?.state === "STOPPED" && session.generation === generation)) {
      throw agentXError("STALE_FENCE", `session ${workspaceId} generation ${generation} is no longer stopping`);
    }
    return session!;
  }

  /** DELETING → DELETED once the instance is gone and the volume is deleted. */
  async markDeleted(workspaceId: string, closeDestroy?: SessionCloseDestroy): Promise<void> {
    if (closeDestroy !== undefined) return this.markRetainedDeleted(workspaceId, closeDestroy);
    const moved = await this.conditional({ update: {
      TableName: this.dependencies.tableName,
      Key: workspaceSessionKey(workspaceId),
      UpdateExpression: "SET #state = :deleted REMOVE instanceId, privateIp, waitingOutboxIds, #index",
      ConditionExpression: "#state = :deleting AND attribute_not_exists(closeRetention) AND attribute_not_exists(closeDestroy)",
      ExpressionAttributeNames: { "#state": "state", "#index": WORKSPACE_SESSION_STATE_INDEX.partitionKey },
      ExpressionAttributeValues: { ":deleted": "DELETED", ":deleting": "DELETING" },
    } });
    const current = await this.get(workspaceId);
    if (!moved && (current?.state !== "DELETED" || current.closeRetention !== undefined || current.closeDestroy !== undefined)) {
      throw agentXError("STALE_FENCE", `session ${workspaceId} is not being deleted`);
    }
  }

  /** A captured claim is checked before the immutable-target deleter starts; DELETING is only pending. */
  async deleteRetainedSession(workspaceId: string, input: SessionCloseDestroy): Promise<boolean> {
    const target = SessionCloseDestroySchema.parse(input), session = await this.get(workspaceId);
    if (session === undefined || canonicalRetentionValue(session.closeDestroy) !== canonicalRetentionValue(target)) return false;
    if (session.state === "DELETED") return session.closeDestroyCompleted === true;
    if (session.state !== "DELETING" || !this.sameDestroyGeneration(session, target)) return false;
    const name = `close-${createHash("sha256").update(canonicalRetentionValue({ workspaceId, target })).digest("hex").slice(0, 64)}`;
    await this.start("deleter", name, { workspaceId, instanceId: target.retention.generation.instanceId, volumeId: target.retention.generation.volumeId, closeDestroy: target });
    return false;
  }

  /** Called by the deleter before any physical effect, including a resumed execution. */
  async validateDeletion(workspaceId: string, closeDestroy?: SessionCloseDestroy): Promise<void> {
    const session = await this.get(workspaceId);
    const valid = session?.state === "DELETING" && (closeDestroy === undefined
      ? session.closeRetention === undefined && session.closeDestroy === undefined
      : canonicalRetentionValue(session.closeDestroy) === canonicalRetentionValue(closeDestroy) && this.sameDestroyGeneration(session, closeDestroy));
    if (!valid) throw agentXError("STALE_FENCE", "deletion no longer owns this exact generation");
  }

  private sameDestroyGeneration(session: WorkspaceSession, target: SessionCloseDestroy): boolean {
    const generation = target.retention.generation;
    return session.generation === generation.sessionGeneration && session.instanceId === generation.instanceId && session.volumeId === generation.volumeId && canonicalRetentionValue(session.workspaceDataIdentity) === canonicalRetentionValue(generation);
  }

  private async markRetainedDeleted(workspaceId: string, target: SessionCloseDestroy): Promise<void> {
    SessionCloseDestroySchema.parse(target);
    const generation = target.retention.generation;
    const moved = await this.conditional({ update: {
      TableName: this.dependencies.tableName, Key: workspaceSessionKey(workspaceId),
      UpdateExpression: "SET #state = :deleted, closeDestroyCompleted = :completed REMOVE instanceId, privateIp, waitingOutboxIds, #index",
      ConditionExpression: "#state = :deleting AND #generation = :generation AND instanceId = :instance AND volumeId = :volume AND workspaceDataIdentity = :identity AND closeDestroy = :target",
      ExpressionAttributeNames: { "#state": "state", "#generation": "generation", "#index": WORKSPACE_SESSION_STATE_INDEX.partitionKey },
      ExpressionAttributeValues: { ":deleted": "DELETED", ":deleting": "DELETING", ":completed": true, ":generation": generation.sessionGeneration, ":instance": generation.instanceId, ":volume": generation.volumeId, ":identity": generation, ":target": target },
    } });
    if (!moved) {
      const session = await this.get(workspaceId);
      if (session?.state !== "DELETED" || session.closeDestroyCompleted !== true || canonicalRetentionValue(session.closeDestroy) !== canonicalRetentionValue(target)) throw agentXError("STALE_FENCE", "deletion completion is for another generation");
    }
  }

  private async startMatchingProvisioning(session: WorkspaceSession | undefined, binding: Ec2RuntimeBinding, generation: number): Promise<void> {
    if (session?.state === "PROVISIONING" && session.generation === generation) await this.startProvisioning(session, binding);
  }

  private async startProvisioning(session: WorkspaceSession, binding: Ec2RuntimeBinding): Promise<void> {
    const pick = this.dependencies.pickMachine === undefined ? undefined : await this.dependencies.pickMachine(session.workspaceId).catch((): MachinePick => ({}));
    // A choice the install cannot run is recorded on the generation now, so the task is told; a launch-time fallback is recorded by the provisioner.
    if (pick?.fallback !== undefined) {
      // Only the note depends on it: a write that fails never stops the worker from starting (review B1 L1).
      await this.conditional(this.update(session.workspaceId, { set: { machineFallback: pick.fallback }, when: { state: "PROVISIONING", generation: session.generation } })).catch(() => false);
    }
    const input: ProvisioningInput = {
      workspaceId: session.workspaceId,
      generation: session.generation,
      availabilityZone: session.availabilityZone!,
      subnetId: session.subnetId!,
      launchTemplateId: binding.launchTemplateId,
      volumeId: session.volumeId ?? null,
      volumeSizeGiB: binding.volumeSizeGiB,
      volumeType: binding.volumeType,
      ...(pick?.machine === undefined ? {} : { machine: { instanceType: pick.machine.instanceType, chip: pick.machine.chip } }),
    };
    const executionArn = await this.start("provisioner", sessionProvisioningName(session.workspaceId, session.generation), input);
    await this.conditional(this.update(session.workspaceId, {
      set: { executionArn },
      when: { state: "PROVISIONING", generation: session.generation },
    }));
  }

  private async startDeletion(session: WorkspaceSession): Promise<void> {
    const input: DeletionInput = {
      workspaceId: session.workspaceId,
      instanceId: session.instanceId ?? null,
      volumeId: session.volumeId ?? null,
    };
    const executionArn = await this.start("deleter", sessionDeletionName(session.workspaceId), input);
    await this.conditional(this.update(session.workspaceId, {
      set: { executionArn },
      when: { state: "DELETING", generation: session.generation },
    }));
  }

  /** An execution that already exists under this name is the one this call would have started. */
  private async start(machine: "provisioner" | "deleter", name: string, input: object): Promise<string> {
    const executions = this.dependencies.executions;
    if (executions === undefined) throw agentXError("CONFIG_INVALID", "this session manager cannot start state machines");
    const stateMachineArn = machine === "provisioner" ? executions.provisionerArn : executions.deleterArn;
    try {
      return await executions.start({ stateMachineArn, name, input: JSON.stringify(input) });
    } catch (error) {
      if (error instanceof Error && error.name === "ExecutionAlreadyExists") return executionArnFor(stateMachineArn, name);
      throw error;
    }
  }

  /**
   * Writes the session change and, when given, parks the outbox record, in one transaction.
   * `sessionWrite(park)` builds the change with or without the record in the session's parked set;
   * undefined means there is nothing to write.
   */
  private async writeWithOutbox(
    sessionWrite: (park: boolean) => Record<string, unknown> | undefined,
    waitingOutboxId: string | undefined,
  ): Promise<boolean> {
    const alone = async () => {
      const write = sessionWrite(false);
      return write === undefined ? true : this.conditional({ transaction: [write] });
    };
    if (waitingOutboxId === undefined) return alone();
    const parked = await this.conditional({ transaction: [
      sessionWrite(true)!,
      { Update: {
        TableName: this.dependencies.tableName,
        Key: outboxKey(waitingOutboxId),
        UpdateExpression: "SET #status = :waiting",
        // PENDING too: the dispatcher can receive a record before the publisher marks it QUEUED.
        ConditionExpression: "#status = :queued OR #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":waiting": "WAITING_FOR_SESSION", ":queued": "QUEUED", ":pending": "PENDING" },
      } },
    ] });
    if (parked) return true;
    // A record that is no longer PENDING or QUEUED is a duplicate delivery; it is not parked again.
    const outbox = await this.dependencies.documentClient.send(new GetCommand({ TableName: this.dependencies.tableName, Key: outboxKey(waitingOutboxId) }));
    const status = (outbox.Item as { status?: string } | undefined)?.status;
    if (status !== "PENDING" && status !== "QUEUED") return alone();
    return false;
  }

  private update(workspaceId: string, change: {
    retention?: WorkspaceSession["closeRetention"];
    /**
     * How a retained session is touched. `wake`: a STOPPED or FAILED session is started again on its kept volume; the retention record must be the one seen and name this volume. `provisioning`: a step of the
     * start that is under way (the provisioner's, a parked request); the retention record rides along untouched. Absent: a plain write, which only a session with no retention accepts.
     */
    retainedBy?: "wake" | "provisioning";
    set?: Partial<Record<keyof WorkspaceSession, unknown>>;
    remove?: Array<keyof WorkspaceSession>;
    addWaiting?: string;
    addPingFailure?: boolean;
    when: { state: WorkspaceSessionState; generation: number };
    require?: Array<keyof WorkspaceSession>;
  }): UpdateCommandInput & { UpdateExpression: string } {
    const names: Record<string, string> = { "#state": "state", "#generation": "generation" };
    const values: Record<string, unknown> = { ":whenState": change.when.state, ":whenGeneration": change.when.generation };
    const sets: string[] = [];
    for (const [field, value] of Object.entries(change.set ?? {})) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }
    // The index attribute follows the state, so the reaper and reconciler can query by it.
    if (change.set?.state !== undefined) {
      names["#index"] = WORKSPACE_SESSION_STATE_INDEX.partitionKey;
      sets.push("#index = :state");
    }
    const clauses = [
      ...(sets.length === 0 ? [] : [`SET ${sets.join(", ")}`]),
      ...(change.remove === undefined || change.remove.length === 0 ? [] : [`REMOVE ${change.remove.join(", ")}`]),
      ...(change.addWaiting === undefined && !change.addPingFailure ? [] : [
        `ADD ${[...(change.addWaiting === undefined ? [] : ["waitingOutboxIds :waiting"]), ...(change.addPingFailure ? ["pingFailures :one"] : [])].join(", ")}`,
      ]),
    ];
    if (change.addPingFailure) values[":one"] = 1;
    if (change.addWaiting !== undefined) values[":waiting"] = new Set([change.addWaiting]);
    const retained = retainedLifecycleGuard(change.retention, change.retainedBy);
    Object.assign(values, retained.values);
    const required = (change.require ?? []).map((field) => ` AND attribute_exists(${field})`).join("");
    return {
      TableName: this.dependencies.tableName,
      Key: workspaceSessionKey(workspaceId),
      UpdateExpression: clauses.join(" "),
      ConditionExpression: `#state = :whenState AND #generation = :whenGeneration${required}${retained.condition}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };
  }

  private unpark(workspaceId: string, outboxId: string): UpdateCommandInput {
    return {
      TableName: this.dependencies.tableName,
      Key: workspaceSessionKey(workspaceId),
      UpdateExpression: "DELETE waitingOutboxIds :id",
      ExpressionAttributeValues: { ":id": new Set([outboxId]) },
    };
  }

  /** Runs a conditional update or transaction; false when its condition did not hold. */
  private async conditional(write: UpdateCommandInput | { update: UpdateCommandInput } | { transaction: Array<Record<string, unknown>> }): Promise<boolean> {
    try {
      if ("transaction" in write) {
        await this.dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: write.transaction }));
      } else if ("update" in write) {
        await this.dependencies.documentClient.send(new UpdateCommand(write.update));
      } else {
        await this.dependencies.documentClient.send(new UpdateCommand(write));
      }
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  private now(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

/** Reads only an already-authorized PROJECT_SETUP session; it never creates a workspace or provisions compute. */
export class ProjectSetupSessionManager {
  constructor(private readonly dependencies: Pick<SessionManagerDependencies, "documentClient" | "tableName">) {}

  async get(setupExecutionId: string): Promise<ProjectSetupSession | undefined> {
    const key = projectSetupSessionKey(setupExecutionId);
    const response = await this.dependencies.documentClient.send(new GetCommand({
      TableName: this.dependencies.tableName,
      Key: key,
      ConsistentRead: true,
    }));
    if (response.Item === undefined) return undefined;
    if (response.Item.pk !== key.pk || response.Item.sk !== key.sk || response.Item.entityType !== "PROJECT_SETUP_SESSION") {
      throw agentXError("RUNTIME_UNAVAILABLE", "stored project setup session identity is invalid");
    }
    const { pk: _pk, sk: _sk, entityType: _entityType, ...domain } = response.Item;
    void _pk; void _sk; void _entityType;
    return ProjectSetupSessionSchema.parse(domain);
  }

  async ensureSession(input: {
    setupExecutionId: string; subjectId: string; approvalRevision: number; transportCorrelationId: string;
    binding: Ec2RuntimeBinding; waitingOutboxId: string;
  }): Promise<{ ready: true; generation: number; privateIp: string } | { ready: false; generation: number; state: string }> {
    const binding = Ec2RuntimeBindingSchema.parse(input.binding);
    const session = await this.get(input.setupExecutionId);
    if (session === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "an authorized project setup worker session is not available; no workspace session or compute was created");
    const bindingDigest = createHash("sha256").update(canonicalJson(binding)).digest("hex");
    if (session.setupExecutionId !== input.setupExecutionId || session.subjectId !== input.subjectId
      || session.approvalRevision !== input.approvalRevision || session.transportCorrelationId !== input.transportCorrelationId
      || session.bindingDigest !== bindingDigest) {
      throw agentXError("STALE_FENCE", "project setup session does not match the current approved setup execution");
    }
    if (session.state === "READY") return { ready: true, generation: session.generation, privateIp: session.privateIp! };
    if (session.state === "PROVISIONING") return { ready: false, generation: session.generation, state: session.state };
    throw agentXError("RUNTIME_UNAVAILABLE", `project setup session is ${session.state}; explicit setup retry is required`);
  }
}

/**
 * The ec2-ebs runtime binding of a workspace's pinned project revision, or undefined when the
 * workspace does not exist or is not ec2-ebs.
 */
export async function workspaceBinding(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  workspaceId: string,
): Promise<Ec2RuntimeBinding | undefined> {
  // Strongly consistent: a lazy Slack thread's first preparation moves the record to the latest
  // revision (#12) just before this runs, and a stale read would size and place compute from the old one.
  const workspace = (await readWorkspaceMeta(documentClient, tableName, workspaceId))?.item;
  if (workspace?.deploymentMode !== "ec2-ebs" || typeof workspace.projectName !== "string" || typeof workspace.projectRevision !== "number") return undefined;
  const project = (await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `PROJECT#${workspace.projectName}`, sk: `REV#${String(workspace.projectRevision).padStart(12, "0")}` },
  }))).Item as { runtimeBinding?: unknown } | undefined;
  const parsed = Ec2RuntimeBindingSchema.safeParse(project?.runtimeBinding);
  return parsed.success ? parsed.data : undefined;
}

/** A stored SESSION item without its keys and index attribute, its waiting set as a sorted list. */
export function sessionFromItem(item: Record<string, unknown>): WorkspaceSession {
  const storageKeys = new Set(["pk", "sk", "entityType", WORKSPACE_SESSION_STATE_INDEX.partitionKey]);
  const session = Object.fromEntries(Object.entries(item).filter(([key]) => !storageKeys.has(key)));
  if (session.waitingOutboxIds instanceof Set) session.waitingOutboxIds = [...(session.waitingOutboxIds as Set<string>)].sort();
  return WorkspaceSessionSchema.parse(session);
}

/** The zone and subnet a generation launches in: the volume's zone once there is one. */
function placementFor(
  session: WorkspaceSession | undefined,
  binding: Ec2RuntimeBinding,
  choose: NonNullable<SessionManagerDependencies["chooseSubnet"]>,
): { availabilityZone: string; subnetId: string } {
  if (session?.availabilityZone === undefined) return choose(binding.subnets);
  const subnet = binding.subnets.find((candidate) => candidate.availabilityZone === session.availabilityZone);
  if (subnet === undefined) {
    throw agentXError("CONFIG_INVALID", `the runtime binding has no subnet in ${session.availabilityZone}, where the workspace volume is`);
  }
  return subnet;
}

function randomSubnet(subnets: Ec2RuntimeBinding["subnets"]): Ec2RuntimeBinding["subnets"][number] {
  return subnets[Math.floor(Math.random() * subnets.length)]!;
}

function executionArnFor(stateMachineArn: string, name: string): string {
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;
}

function outboxKey(outboxId: string): { pk: string; sk: string } {
  return { pk: `OUTBOX#${outboxId}`, sk: "OUTBOX" };
}

/** Whether the cancelled transaction reports that its step `index` failed its own condition. */
function cancelledBy(error: unknown, index: number): boolean {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.[index]?.Code === "ConditionalCheckFailed";
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}

function unhandledState(state: never): never {
  throw agentXError("CONFIG_INVALID", `unsupported session state ${String(state)}`);
}

function assertUnretainedSession(session: WorkspaceSession | undefined): void {
  if (session?.closeRetention !== undefined || session?.closeDestroy !== undefined) throw agentXError("WORKSPACE_BUSY", "retained workspace requires the Close preview");
}
function retainedReadySession(session: WorkspaceSession | undefined): EnsureSessionResult | undefined {
  if (session?.closeRetention?.acceptedOperationId !== undefined || session?.closeDestroy !== undefined) throw agentXError("WORKSPACE_BUSY", "accepted Close owns this workspace");
  if (session?.closeRetention !== undefined && session.state === "READY") return { ready: true, generation: session.generation, privateIp: session.privateIp! };
  return undefined;
}

function retainedLifecycleGuard(retention: WorkspaceSession["closeRetention"], retainedBy?: "wake" | "provisioning"): { condition: string; values: Record<string, unknown> } {
  // A Close that was accepted, or a destroy under way, owns the session: nothing here touches it.
  if (retainedBy === "provisioning") return { condition: " AND attribute_not_exists(closeDestroy) AND attribute_not_exists(closeRetention.acceptedOperationId)", values: {} };
  if (retainedBy === "wake" && retention !== undefined) {
    return { condition: " AND closeRetention = :seenRetention AND volumeId = :retainedVolume AND attribute_not_exists(closeDestroy) AND attribute_not_exists(closeRetention.acceptedOperationId)",
      values: { ":seenRetention": retention, ":retainedVolume": retention.generation.volumeId } };
  }
  if (retention === undefined) return { condition: " AND attribute_not_exists(closeRetention) AND attribute_not_exists(closeDestroy)", values: {} };
  return { condition: " AND closeRetention = :seenRetention AND instanceId = :retainedInstance AND volumeId = :retainedVolume AND attribute_not_exists(closeDestroy)",
    values: { ":seenRetention": retention, ":retainedInstance": retention.generation.instanceId, ":retainedVolume": retention.generation.volumeId } };
}
function idleWorkspaceCondition(seen: WorkspaceSession): Pick<UpdateCommandInput, "ConditionExpression" | "ExpressionAttributeValues" | "ExpressionAttributeNames"> {
  if (seen.closeRetention === undefined) return { ConditionExpression: "attribute_not_exists(activeOperationId) OR attribute_type(activeOperationId, :null)", ExpressionAttributeValues: { ":null": "NULL" } };
  return { ConditionExpression: "#workspaceStatus = :retainedReady AND activeOperationId = :retainedOperation AND fence = :retainedFence",
    ExpressionAttributeNames: { "#workspaceStatus": "status" }, ExpressionAttributeValues: { ":retainedReady": "READY", ":retainedOperation": seen.closeRetention.operationId, ":retainedFence": seen.closeRetention.fence } };
}
function idleInspectionCheck(seen: WorkspaceSession, tableName: string, pk: string | undefined): Array<Record<string, unknown>> {
  if (seen.closeRetention === undefined) return [];
  return [{ ConditionCheck: { TableName: tableName, Key: { pk: pk ?? `WORKSPACE#${seen.workspaceId}`, sk: `OPERATION#${seen.closeRetention.operationId}` },
    ConditionExpression: "#status = :completed AND #kind = :close AND fence = :fence AND workspaceId = :workspace AND closePreflight.schemaVersion = :version",
    ExpressionAttributeNames: { "#status": "status", "#kind": "kind" }, ExpressionAttributeValues: { ":completed": "SUCCEEDED", ":close": "close", ":fence": seen.closeRetention.fence, ":workspace": seen.workspaceId, ":version": 1 } } }];
}
