// One-off drain for the EC2 cutover (#88): closes every open AgentCore workspace (instances-ebs and
// demo-microvm). It does what a normal close completes with, minus the unpublished-work check, so
// any unpublished work in these workspaces is lost:
//   1. fail the workspace's active operation, if any;
//   2. release its AgentCore storage (instances-ebs deletes the capacity provider session;
//      demo-microvm stops the runtime session, best effort);
//   3. mark it CLOSED and, for a Slack thread workspace, close the thread and give its quota back.
// Dry run by default; --apply makes the changes. Run the apply only with the operator's approval:
//   npm run drain:agentcore -- [--region us-east-1] [--apply]
import { pathToFileURL } from "node:url";
import { BedrockAgentCoreClient, DeleteCapacityProviderSessionCommand, StopRuntimeSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { failActiveOperation } from "../packages/broker/src/aws/outbox-failure.js";

interface Options { region: string; apply: boolean }

interface Workspace {
  id: string;
  ownerKey: string;
  projectName: string;
  deploymentMode: "instances-ebs" | "demo-microvm";
  status: string;
  fence: number;
  activeOperationId?: string | null;
  runtimeArn?: string;
  endpointQualifier?: string;
  runtimeSessionId?: string;
  capacityProviderArn?: string;
}

interface Thread { workspaceId?: string; thread?: string; starterUserId?: string; closedAt?: string }

const CLOSE_ERROR = "workspace closed for the EC2 migration (#88)";

function parseArgs(argv: string[]): Options {
  const index = argv.indexOf("--region");
  return { region: index < 0 ? "us-east-1" : argv[index + 1]!, apply: argv.includes("--apply") };
}

const log = (message: string) => process.stdout.write(`${message}\n`);

async function openAgentCoreWorkspaces(documentClient: DynamoDBDocumentClient, tableName: string): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await documentClient.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: "entityType = :workspace AND sk = :meta AND #status <> :closed AND (deploymentMode = :ebs OR deploymentMode = :microvm)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":workspace": "WORKSPACE", ":meta": "META", ":closed": "CLOSED", ":ebs": "instances-ebs", ":microvm": "demo-microvm" },
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    }));
    workspaces.push(...(page.Items ?? []) as Workspace[]);
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return workspaces.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.id.localeCompare(b.id));
}

async function get<T>(documentClient: DynamoDBDocumentClient, tableName: string, pk: string, sk: string): Promise<T | undefined> {
  return (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }))).Item as T | undefined;
}

/** The thread this workspace was created for, or undefined for a CLI workspace or a closed thread. */
async function openThread(documentClient: DynamoDBDocumentClient, tableName: string, workspace: Workspace): Promise<(Thread & { thread: string }) | undefined> {
  const thread = await get<Thread>(documentClient, tableName, `SLACK_THREAD#${workspace.ownerKey}`, "META");
  if (thread === undefined || thread.closedAt !== undefined || thread.workspaceId !== workspace.id) return undefined;
  if (typeof thread.thread !== "string") return undefined;
  return thread as Thread & { thread: string };
}

async function releaseStorage(agentCore: BedrockAgentCoreClient, workspace: Workspace): Promise<string> {
  if (workspace.runtimeSessionId === undefined) return "no session";
  switch (workspace.deploymentMode) {
    case "instances-ebs":
      if (workspace.capacityProviderArn === undefined) return "no capacity provider";
      // As the broker's close does (deleteCapacityProviderWorkspaceSession, not imported because
      // broker.ts wires its Lambda handler on import): a session already gone counts as deleted.
      try {
        await agentCore.send(new DeleteCapacityProviderSessionCommand({
          capacityProviderId: workspace.capacityProviderArn.split("/").at(-1)!,
          sessionId: workspace.runtimeSessionId,
        }));
        return "session storage deleted";
      } catch (error) {
        if (error instanceof Error && error.name === "ResourceNotFoundException") return "session storage already gone";
        throw error;
      }
    case "demo-microvm":
      if (workspace.runtimeArn === undefined) return "no runtime";
      try {
        await agentCore.send(new StopRuntimeSessionCommand({
          agentRuntimeArn: workspace.runtimeArn,
          qualifier: workspace.endpointQualifier ?? "DEFAULT",
          runtimeSessionId: workspace.runtimeSessionId,
          clientToken: randomUUID(),
        }));
        return "runtime session stopped";
      } catch (error) {
        // An idle session has usually ended already; closing does not depend on stopping it.
        return `runtime session not stopped (${error instanceof Error ? error.name : String(error)})`;
      }
  }
}

export async function markClosed(documentClient: DynamoDBDocumentClient, tableName: string, workspace: Workspace, thread: (Thread & { thread: string }) | undefined): Promise<string> {
  const current = await get<Workspace>(documentClient, tableName, `WORKSPACE#${workspace.id}`, "META");
  if (current === undefined || current.status === "CLOSED") return "already closed";
  const closedAt = new Date().toISOString();
  const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ Update: {
    TableName: tableName,
    Key: { pk: `WORKSPACE#${workspace.id}`, sk: "META" },
    UpdateExpression: "SET #status = :closed, closedAt = :closedAt, updatedAt = :closedAt REMOVE activeOperationId, closeError",
    ConditionExpression: "#status = :current AND fence = :fence AND (attribute_not_exists(activeOperationId) OR activeOperationId = :none)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":closed": "CLOSED", ":closedAt": closedAt, ":current": current.status, ":fence": current.fence, ":none": null },
  } }];
  let quota = "no Slack thread";
  if (thread !== undefined && thread.starterUserId === undefined) {
    // An unprepared thread workspace (spec 014) never took quota; only the thread is closed.
    quota = "thread closed; no quota taken";
  } else if (thread !== undefined) {
    const teamId = thread.thread.split("/")[0]!;
    const organizationKey = { pk: `SLACK_LIMIT#${teamId}`, sk: "ORGANIZATION" };
    const memberKey = { pk: `SLACK_LIMIT#${teamId}`, sk: `MEMBER#${thread.starterUserId}` };
    const organization = await get<{ count?: number }>(documentClient, tableName, organizationKey.pk, organizationKey.sk);
    const member = await get<{ count?: number; threads?: string[] }>(documentClient, tableName, memberKey.pk, memberKey.sk);
    const organizationCount = organization?.count ?? 0;
    const memberCount = member?.count ?? 0;
    const threads = member?.threads ?? [];
    // Give the quota back only where it was taken: a thread listed on its starter's record.
    if (threads.includes(thread.thread) && organizationCount > 0 && memberCount > 0) {
      items.push(
        { Update: {
          TableName: tableName, Key: organizationKey,
          UpdateExpression: "SET #count = :next", ConditionExpression: "#count = :current",
          ExpressionAttributeNames: { "#count": "count" },
          ExpressionAttributeValues: { ":next": organizationCount - 1, ":current": organizationCount },
        } },
        { Update: {
          TableName: tableName, Key: memberKey,
          UpdateExpression: "SET #count = :next, #threads = :threads", ConditionExpression: "#count = :current",
          ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
          ExpressionAttributeValues: { ":next": memberCount - 1, ":current": memberCount, ":threads": threads.filter((subject) => subject !== thread.thread) },
        } },
      );
      quota = `thread closed; ${thread.starterUserId} ${memberCount}→${memberCount - 1}, organization ${organizationCount}→${organizationCount - 1}`;
    } else {
      quota = `thread closed; quota not held (member ${memberCount}, organization ${organizationCount})`;
    }
  }
  if (thread !== undefined) {
    items.push({ Update: {
      TableName: tableName,
      Key: { pk: `SLACK_THREAD#${workspace.ownerKey}`, sk: "META" },
      UpdateExpression: "SET closedAt = :closedAt",
      ConditionExpression: "attribute_not_exists(closedAt)",
      ExpressionAttributeValues: { ":closedAt": closedAt },
    } });
  }
  await documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  return quota;
}

export async function closeAgentCoreWorkspaces(options: Options): Promise<void> {
  const clientConfiguration = { region: options.region };
  const stacks = await new CloudFormationClient(clientConfiguration).send(new DescribeStacksCommand({ StackName: "AgentXControlPlane" }));
  const tableName = stacks.Stacks?.[0]?.Outputs?.find((output) => output.OutputKey === "StateTableName")?.OutputValue;
  if (tableName === undefined) throw new Error("AgentXControlPlane has no StateTableName output");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration));
  const agentCore = new BedrockAgentCoreClient(clientConfiguration);

  const workspaces = await openAgentCoreWorkspaces(documentClient, tableName);
  log(`${options.apply ? "APPLY" : "DRY RUN"}: ${workspaces.length} open AgentCore workspaces in ${tableName}`);
  let failures = 0;
  for (const workspace of workspaces) {
    const thread = await openThread(documentClient, tableName, workspace);
    const summary = `${workspace.projectName.padEnd(28)} ${workspace.id} ${workspace.deploymentMode.padEnd(13)} ${workspace.status.padEnd(18)}`;
    if (!options.apply) {
      const operation = workspace.activeOperationId ? ` fail operation ${workspace.activeOperationId};` : "";
      const storage = workspace.runtimeSessionId === undefined ? "no session"
        : workspace.deploymentMode === "instances-ebs" ? "delete session storage" : "stop runtime session";
      log(`${summary}${operation} ${storage}; ${thread === undefined ? "no open Slack thread" : `close thread ${thread.thread}${thread.starterUserId === undefined ? " (no quota taken)" : ` (return quota of ${thread.starterUserId})`}`}`);
      continue;
    }
    try {
      const failed = await failActiveOperation(documentClient, tableName, workspace.id, CLOSE_ERROR);
      const storage = await releaseStorage(agentCore, workspace);
      const closed = await markClosed(documentClient, tableName, workspace, thread);
      log(`${summary} CLOSED${failed ? ` (failed operation ${failed})` : ""}; ${storage}; ${closed}`);
    } catch (error) {
      failures += 1;
      log(`${summary} NOT CLOSED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }
  if (options.apply) log(`${workspaces.length - failures} closed, ${failures} failed${failures > 0 ? "; rerun to retry them" : ""}`);
  else log("nothing changed; rerun with --apply to close them");
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  closeAgentCoreWorkspaces(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
