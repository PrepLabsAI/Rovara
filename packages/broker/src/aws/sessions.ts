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
  WORKSPACE_SESSION_STATE_INDEX,
  WorkspaceSessionSchema,
  agentXError,
  sessionDeletionName,
  sessionProvisioningName,
  workspaceSessionKey,
  type Ec2RuntimeBinding,
  type WorkspaceSession,
  type WorkspaceSessionState,
} from "@agentx/contracts";
import type { DurableOutboxRecord } from "./lambda.js";
import { failOutboxOperation } from "./outbox-failure.js";

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
}

export interface DeletionInput {
  workspaceId: string;
  instanceId: string | null;
  volumeId: string | null;
}

export type EnsureSessionResult =
  | { ready: true; generation: number; privateIp: string }
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
      const state = session?.state ?? "NONE";
      switch (state) {
        case "READY": {
          const ready = session!;
          if (!(await this.conditional(this.update(workspaceId, {
            set: { lastActivityAt: this.now() },
            when: { state: "READY", generation: ready.generation },
          })))) continue;
          return { ready: true, generation: ready.generation, privateIp: ready.privateIp! };
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
                remove: ["instanceId", "privateIp", "launchedAt", "readyAt", "executionArn"],
                ...(park ? { addWaiting: waitingOutboxId } : {}),
                when: { state, generation: session.generation },
              }) };
          if (!(await this.writeWithOutbox(sessionWrite, waitingOutboxId))) continue;
          const started = await this.get(workspaceId);
          if (started?.state === "PROVISIONING" && started.generation === generation) await this.startProvisioning(started, binding);
          return { ready: false, generation, state: "PROVISIONING" };
        }
        case "PROVISIONING":
        case "STOPPING": {
          const current = session!;
          if (waitingOutboxId !== undefined) {
            // Nothing changes on the session unless the record is parked.
            const parked = await this.writeWithOutbox((park) => (park ? { Update: this.update(workspaceId, {
              addWaiting: waitingOutboxId,
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

  async markInstance(workspaceId: string, generation: number, instanceId: string, privateIp: string): Promise<void> {
    await this.dependencies.documentClient.send(new UpdateCommand(this.update(workspaceId, {
      set: { instanceId, privateIp, launchedAt: this.now() },
      when: { state: "PROVISIONING", generation },
    })));
  }

  /** PROVISIONING → READY once the worker answered its health probe, then re-sends the parked work. */
  async markReady(workspaceId: string, generation: number): Promise<{ requeued: string[] }> {
    const now = this.now();
    const moved = await this.conditional(this.update(workspaceId, {
      set: { state: "READY", readyAt: now, lastActivityAt: now },
      when: { state: "PROVISIONING", generation },
      require: ["instanceId", "privateIp", "volumeId"],
    }));
    const session = await this.get(workspaceId);
    if (!moved && !(session?.state === "READY" && session.generation === generation)) {
      throw agentXError("STALE_FENCE", `session ${workspaceId} generation ${generation} is no longer provisioning`);
    }
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
      when: { state: "PROVISIONING", generation },
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
   * provisioned has nothing to delete. Refuses while compute is starting or stopping.
   */
  async deleteSession(workspaceId: string): Promise<{ state: "DELETING" | "DELETED" }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const session = await this.get(workspaceId);
      if (session === undefined || session.state === "DELETED") return { state: "DELETED" };
      switch (session.state) {
        case "NONE":
          if (!(await this.conditional(this.update(workspaceId, {
            set: { state: "DELETED" },
            when: { state: "NONE", generation: session.generation },
          })))) continue;
          return { state: "DELETED" };
        case "READY":
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
        case "STOPPING":
          throw agentXError("WORKSPACE_BUSY", "workspace compute is starting or stopping; retry the close");
        default:
          return unhandledState(session.state);
      }
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "workspace session kept changing; retry the close");
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
    const claim = this.update(seen.workspaceId, { set: { state: "STOPPING" }, when: { state: "READY", generation: seen.generation } });
    return this.conditional({ transaction: [
      { Update: {
        ...claim,
        ConditionExpression: `${claim.ConditionExpression} AND lastActivityAt = :seenActivity`,
        ExpressionAttributeValues: { ...claim.ExpressionAttributeValues, ":seenActivity": seen.lastActivityAt },
      } },
      { ConditionCheck: {
        TableName: this.dependencies.tableName,
        Key: { pk: `WORKSPACE#${seen.workspaceId}`, sk: "META" },
        // Terminal transitions remove activeOperationId; some records store it as null instead.
        ConditionExpression: "attribute_not_exists(activeOperationId) OR attribute_type(activeOperationId, :null)",
        ExpressionAttributeValues: { ":null": "NULL" },
      } },
    ] });
  }

  /** STOPPING → STOPPED once the instance is gone and the volume detached. Returns the session after. */
  async markStopped(workspaceId: string, generation: number): Promise<WorkspaceSession> {
    const moved = await this.conditional(this.update(workspaceId, {
      set: { state: "STOPPED" },
      remove: ["instanceId", "privateIp"],
      when: { state: "STOPPING", generation },
    }));
    const session = await this.get(workspaceId);
    if (!moved && !(session?.state === "STOPPED" && session.generation === generation)) {
      throw agentXError("STALE_FENCE", `session ${workspaceId} generation ${generation} is no longer stopping`);
    }
    return session!;
  }

  /** DELETING → DELETED once the instance is gone and the volume is deleted. */
  async markDeleted(workspaceId: string): Promise<void> {
    const moved = await this.conditional({ update: {
      TableName: this.dependencies.tableName,
      Key: workspaceSessionKey(workspaceId),
      UpdateExpression: "SET #state = :deleted REMOVE instanceId, privateIp, waitingOutboxIds, #index",
      ConditionExpression: "#state = :deleting",
      ExpressionAttributeNames: { "#state": "state", "#index": WORKSPACE_SESSION_STATE_INDEX.partitionKey },
      ExpressionAttributeValues: { ":deleted": "DELETED", ":deleting": "DELETING" },
    } });
    if (!moved && (await this.get(workspaceId))?.state !== "DELETED") {
      throw agentXError("STALE_FENCE", `session ${workspaceId} is not being deleted`);
    }
  }

  private async startProvisioning(session: WorkspaceSession, binding: Ec2RuntimeBinding): Promise<void> {
    const input: ProvisioningInput = {
      workspaceId: session.workspaceId,
      generation: session.generation,
      availabilityZone: session.availabilityZone!,
      subnetId: session.subnetId!,
      launchTemplateId: binding.launchTemplateId,
      volumeId: session.volumeId ?? null,
      volumeSizeGiB: binding.volumeSizeGiB,
      volumeType: binding.volumeType,
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
    set?: Partial<Record<keyof WorkspaceSession, unknown>>;
    remove?: Array<keyof WorkspaceSession>;
    addWaiting?: string;
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
      ...(change.addWaiting === undefined ? [] : ["ADD waitingOutboxIds :waiting"]),
    ];
    if (change.addWaiting !== undefined) values[":waiting"] = new Set([change.addWaiting]);
    const required = (change.require ?? []).map((field) => ` AND attribute_exists(${field})`).join("");
    return {
      TableName: this.dependencies.tableName,
      Key: workspaceSessionKey(workspaceId),
      UpdateExpression: clauses.join(" "),
      ConditionExpression: `#state = :whenState AND #generation = :whenGeneration${required}`,
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

/**
 * The ec2-ebs runtime binding of a workspace's pinned project revision, or undefined when the
 * workspace does not exist or is not ec2-ebs.
 */
export async function workspaceBinding(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  workspaceId: string,
): Promise<Ec2RuntimeBinding | undefined> {
  const workspace = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" } }))).Item;
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

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}

function unhandledState(state: never): never {
  throw agentXError("CONFIG_INVALID", `unsupported session state ${String(state)}`);
}
