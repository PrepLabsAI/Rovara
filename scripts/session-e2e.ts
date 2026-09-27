// End-to-end check of the EC2 session lifecycle (issue #83) against a deployed control plane:
// provision a new volume, resume on it, fail a provisioning, then delete. Uses a throwaway
// workspace ID, so only a SESSION item, one EBS volume and short-lived instances are created, and
// the delete phase removes the volume. Run it only with the operator's approval:
//   npm run session:e2e -- [--region us-east-1] [--profile <name>]
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { WORKSPACE_SESSION_STATE_INDEX, workspaceSessionKey, type Ec2RuntimeBinding, type WorkspaceSession } from "../packages/contracts/src/index.js";
import { SessionManager } from "../packages/broker/src/aws/sessions.js";

interface Options { region: string; profile?: string }

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const profile = value("--profile");
  return { region: value("--region") ?? "us-east-1", ...(profile === undefined ? {} : { profile }) };
}

function aws(options: Options, args: string[]): unknown {
  const output = execFileSync("aws", [...args, "--region", options.region, "--output", "json", ...(options.profile ? ["--profile", options.profile] : [])], { encoding: "utf8" });
  return output.trim() === "" ? undefined : JSON.parse(output) as unknown;
}

function stackOutputs(options: Options, stackName: string): Record<string, string> {
  const result = aws(options, ["cloudformation", "describe-stacks", "--stack-name", stackName]) as { Stacks: Array<{ Outputs?: Array<{ OutputKey: string; OutputValue: string }> }> };
  return Object.fromEntries((result.Stacks[0]!.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]));
}

const log = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

async function waitFor(sessions: SessionManager, workspaceId: string, states: Array<WorkspaceSession["state"]>, minutes: number): Promise<WorkspaceSession> {
  const deadline = Date.now() + minutes * 60_000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const session = await sessions.get(workspaceId);
    const summary = `${session?.state} gen ${session?.generation} instance ${session?.instanceId ?? "-"} volume ${session?.volumeId ?? "-"}`;
    if (summary !== last) log(`  session: ${summary}`);
    last = summary;
    if (session && states.includes(session.state)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`session did not reach ${states.join(" or ")} within ${minutes} minutes`);
}

/** What the idle reaper (#85) will do: terminate the instance, wait for the volume, READY → STOPPED. */
async function stopLikeTheReaper(options: Options, documentClient: DynamoDBDocumentClient, tableName: string, session: WorkspaceSession): Promise<void> {
  log(`  stopping: terminating ${session.instanceId}`);
  aws(options, ["ec2", "terminate-instances", "--instance-ids", session.instanceId!]);
  aws(options, ["ec2", "wait", "instance-terminated", "--instance-ids", session.instanceId!]);
  aws(options, ["ec2", "wait", "volume-available", "--volume-ids", session.volumeId!]);
  await documentClient.send(new UpdateCommand({
    TableName: tableName,
    Key: workspaceSessionKey(session.workspaceId),
    UpdateExpression: "SET #state = :stopped, #index = :stopped REMOVE instanceId, privateIp",
    ConditionExpression: "#state = :ready AND #generation = :generation",
    ExpressionAttributeNames: { "#state": "state", "#generation": "generation", "#index": WORKSPACE_SESSION_STATE_INDEX.partitionKey },
    ExpressionAttributeValues: { ":stopped": "STOPPED", ":ready": "READY", ":generation": session.generation },
  }));
  log("  session: STOPPED");
}

export async function runSessionEndToEnd(options: Options): Promise<void> {
  const control = stackOutputs(options, "AgentXControlPlane");
  const foundation = stackOutputs(options, "AgentXProductionFoundation");
  const tableName = control.StateTableName!;
  const subnets = foundation.Ec2WorkerSubnets!.split(",").map((pair) => {
    const [availabilityZone, subnetId] = pair.split("=") as [string, string];
    return { availabilityZone, subnetId };
  });
  const binding: Ec2RuntimeBinding = {
    deploymentMode: "ec2-ebs",
    launchTemplateId: foundation.Ec2WorkerLaunchTemplateId!,
    subnets,
    volumeSizeGiB: 20,
    volumeType: "gp3",
  };
  const clientConfiguration = { region: options.region };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration));
  const sfnClient = new SFNClient(clientConfiguration);
  const sessions = new SessionManager({
    documentClient,
    tableName,
    executions: {
      provisionerArn: control.SessionProvisionerArn!,
      deleterArn: control.SessionDeleterArn!,
      async start(input) {
        const response = await sfnClient.send(new StartExecutionCommand(input));
        return response.executionArn!;
      },
    },
    chooseSubnet: (candidates) => candidates[0]!,
  });
  const workspaceId = randomUUID();
  log(`workspace ${workspaceId} (throwaway; no workspace record)`);

  try {
    log("1/4 provision: new volume, generation 1");
    await sessions.ensureSession({ workspaceId, binding });
    const first = await waitFor(sessions, workspaceId, ["READY", "FAILED"], 25);
    if (first.state !== "READY") throw new Error("generation 1 failed; see the provisioner execution");

    log("2/4 resume: stop, then generation 2 on the same volume");
    await stopLikeTheReaper(options, documentClient, tableName, first);
    await sessions.ensureSession({ workspaceId, binding });
    const second = await waitFor(sessions, workspaceId, ["READY", "FAILED"], 25);
    if (second.state !== "READY" || second.generation !== 2 || second.volumeId !== first.volumeId) {
      throw new Error("generation 2 did not come up on the first generation's volume");
    }

    log("3/4 failure: the volume's zone mapped to the other zone's subnet, so the attach fails");
    await stopLikeTheReaper(options, documentClient, tableName, second);
    const other = subnets.find((subnet) => subnet.availabilityZone !== second.availabilityZone)!;
    await sessions.ensureSession({ workspaceId, binding: { ...binding, subnets: [{ availabilityZone: second.availabilityZone!, subnetId: other.subnetId }] } });
    const failed = await waitFor(sessions, workspaceId, ["READY", "FAILED"], 15);
    if (failed.state !== "FAILED" || failed.instanceId !== undefined || failed.volumeId !== first.volumeId) {
      throw new Error("generation 3 should have failed, terminated its instance and kept the volume");
    }

    log("4/4 delete: the volume is deleted and the session recorded DELETED");
    await sessions.deleteSession(workspaceId);
    await waitFor(sessions, workspaceId, ["DELETED"], 15);
    const volumes = aws(options, ["ec2", "describe-volumes", "--filters", `Name=volume-id,Values=${first.volumeId}`]) as { Volumes: unknown[] };
    if (volumes.Volumes.length !== 0) throw new Error(`volume ${first.volumeId} still exists`);
    log("PASSED: provision, resume, failure and delete");
  } catch (error) {
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    log(`clean up: find instances and volumes tagged agentx:workspace=${workspaceId}`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSessionEndToEnd(parseArgs(process.argv.slice(2))).catch(() => {
    process.exitCode = 1;
  });
}
