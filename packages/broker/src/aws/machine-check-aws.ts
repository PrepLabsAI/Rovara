// WORKER-DELIVERY-IDENTITY (b-plus): the dispatcher's wiring of the machine check (machine-check.ts) to EC2 and to the State table. One small module so dispatcher.ts changes by names on lines it already has.
// The dispatcher's role gets `ec2:DescribeInstances` for this (read-only; EC2 cannot scope Describe to a resource), and nothing else on EC2.
import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { projectSetupExecutionKey, projectSetupOperationKey } from "@agentx/contracts";
import type { Ec2OutboxRecord } from "./lambda.js";
import { createMachineVerifier, WORKSPACE_TAG, type InstanceFact, type MachineReader, type MachineVerifier } from "./machine-check.js";
import { failActiveOperation, failOutboxOperation } from "./outbox-failure.js";
import { COMPUTE_LOST_WORDS } from "./session-lost.js";
import { markProjectSetupSessionLost, type SessionManager } from "./sessions.js";

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
let sharedEc2: EC2Client | undefined;

function factOf(instance: Instance): InstanceFact {
  return {
    instanceId: instance.InstanceId!,
    state: instance.State?.Name ?? "unknown",
    privateIp: instance.PrivateIpAddress,
    workspaceId: instance.Tags?.find((candidate) => candidate.Key === WORKSPACE_TAG)?.Value,
    subnetId: instance.SubnetId,
  };
}

/** EC2 as the check asks it: the row's instance by id, and (for the log only) who holds an address now. */
export function createEc2MachineReader(ec2: Pick<EC2Client, "send">): MachineReader {
  return {
    async byInstanceId(instanceId) {
      try {
        const page = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        const found = (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []).find((instance) => instance.InstanceId === instanceId);
        return found === undefined ? undefined : factOf(found);
      } catch (error) {
        // EC2 forgets a terminated instance after about an hour: that is "no such machine", not a failure to ask.
        if (error instanceof Error && error.name === "InvalidInstanceID.NotFound") return undefined;
        throw error;
      }
    },
    async byPrivateIp(privateIp) {
      const page = await ec2.send(new DescribeInstancesCommand({ Filters: [
        { Name: "private-ip-address", Values: [privateIp] },
        { Name: "instance-state-name", Values: ["pending", "running"] },
      ] }));
      return (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []).map(factOf);
    },
  };
}

/**
 * Ends a project setup run's execution and operation as FAILED with these words, while they are still accepted or dispatching (the same two conditional writes as the dispatcher's setup lifecycle
 * `markFailed`); a run that already ended is left as it is (the conditions refuse, and that is not an error here).
 */
export async function failProjectSetupOperation(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, record: Ec2OutboxRecord, error: string): Promise<void> {
  if (record.invocation.kind !== "project-setup-smoke") return;
  const setupId = record.invocation.payload.setupExecutionId;
  const now = new Date().toISOString();
  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: tableName, Key: projectSetupExecutionKey(setupId),
        UpdateExpression: "SET #state = :failed, updatedAt = :now, #error = :error", ConditionExpression: "#state = :accepted OR #state = :dispatching",
        ExpressionAttributeNames: { "#state": "state", "#error": "error" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":failed": "FAILED", ":now": now, ":error": error.slice(0, 2_000) } } },
      { Update: { TableName: tableName, Key: projectSetupOperationKey(setupId, record.operationId),
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #error = :error", ConditionExpression: "#status = :accepted OR #status = :dispatching OR #status = :delivered",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":failed": "FAILED", ":now": now, ":error": error.slice(0, 2_000) } } },
    ] }));
  } catch (failure) {
    if (!(failure instanceof Error && failure.name === "TransactionCanceledException")) throw failure;
  }
}

/** The metric the grace alarm reads: one count per setup delivery that could not be verified (CloudWatch embedded metric format, in the same log line). Without a namespace in the environment, no metric. */
export const SETUP_UNVERIFIED_METRIC = "SetupMachineUnverified";

export function withMetric(entry: Record<string, unknown>, namespace = process.env.AGENTX_METRICS_NAMESPACE): Record<string, unknown> {
  if (entry.event !== "dispatch.machine_unverified" || namespace === undefined || namespace === "") return entry;
  return { ...entry, [SETUP_UNVERIFIED_METRIC]: 1, _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: SETUP_UNVERIFIED_METRIC, Unit: "Count" }] }] } };
}

export interface DispatcherMachineChecks {
  verifyMachine: MachineVerifier;
  /** Ends an outbox record's operation for good with these words (the dispatcher's own terminal transition, outbox-failure.ts). */
  failOperation: (record: Ec2OutboxRecord, error: string, machine: { markedLost: boolean }) => Promise<void>;
}

/** What the dispatcher's two delivery paths (ec2-delivery.ts and the core's machines adapter) are given. */
export function dispatcherMachineChecks(input: {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string | undefined;
  sessions: Pick<SessionManager, "markLost">;
  ec2?: Pick<EC2Client, "send">;
  log?: (entry: Record<string, unknown>) => void;
}): DispatcherMachineChecks {
  // Fail loudly: a check that cannot reach the State table could not mark a row lost or end an operation, so it is never built half-wired.
  if (input.tableName === undefined || input.tableName === "") throw new Error("STATE_TABLE_NAME is required");
  const { tableName } = input;
  sharedEc2 ??= new EC2Client(awsClientConfiguration);
  return {
    verifyMachine: createMachineVerifier({
      reader: createEc2MachineReader(input.ec2 ?? sharedEc2),
      markLost: (seen) => input.sessions.markLost(seen),
      markSetupLost: (seen) => markProjectSetupSessionLost(input.documentClient, tableName, seen),
      log: input.log ?? ((entry) => { process.stderr.write(`${JSON.stringify({ component: "dispatcher", ...withMetric(entry) })}\n`); }),
    }),
    failOperation: async (record, error, machine) => {
      // A setup run's operation lives under its own keys (never WORKSPACE#): it is ended as the dispatcher's own terminal transition for a setup record ends it.
      if (record.invocation.kind === "project-setup-smoke") { await failProjectSetupOperation(input.documentClient, tableName, record, error); return; }
      await failOutboxOperation(input.documentClient, tableName, record, error);
      // A cancel holds no workspace: its own operation is the cancel, and the task it targets is the workspace's ACTIVE operation, which would otherwise wait for the stuck-cancel sweep (30 minutes) now that the
      // row is lost and the reconciler no longer sees it READY. Every other kind's own operation IS the active one, which the line above has already failed and released.
      // Only when this call really moved the row (it was ours), and only when the active operation IS the one the cancel targets: a row another path already repaired, or a task that replaced the target, is not ours to end.
      if (record.invocation.kind === "cancel" && machine.markedLost) await failActiveOperation(input.documentClient, tableName, record.workspaceId, COMPUTE_LOST_WORDS, record.invocation.payload.targetOperationId);
    },
  };
}
