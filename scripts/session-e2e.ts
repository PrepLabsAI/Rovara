// End-to-end check of the EC2 session lifecycle (issues #83 and #85) against a deployed control
// plane: provision a new volume, let the idle reaper stop it and resume on the same volume, fail a
// provisioning, then delete. Uses a throwaway workspace ID, so only a SESSION item, one EBS volume
// and short-lived instances are created, and the delete phase removes the volume. Run it only with
// the operator's approval:
//   npm run session:e2e -- [--region us-east-1] [--profile <name>] [--no-idle-wait]
// --no-idle-wait stops the session directly instead of waiting about six minutes for the reaper.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Ec2RuntimeBinding, WorkspaceSession } from "../packages/contracts/src/index.js";
import { SessionManager } from "../packages/broker/src/aws/sessions.js";

interface Options { region: string; profile?: string; idleWait: boolean }

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const profile = value("--profile");
  return { region: value("--region") ?? "us-east-1", idleWait: !argv.includes("--no-idle-wait"), ...(profile === undefined ? {} : { profile }) };
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

/** The reaper's stop without its idle wait: claim, terminate, wait, mark STOPPED. */
async function stopNow(options: Options, sessions: SessionManager, session: WorkspaceSession): Promise<void> {
  if (!(await sessions.claimStop(session))) throw new Error("could not claim the session for stopping");
  log(`  stopping: terminating ${session.instanceId}`);
  aws(options, ["ec2", "terminate-instances", "--instance-ids", session.instanceId!]);
  aws(options, ["ec2", "wait", "instance-terminated", "--instance-ids", session.instanceId!]);
  aws(options, ["ec2", "wait", "volume-available", "--volume-ids", session.volumeId!]);
  await sessions.markStopped(session.workspaceId, session.generation);
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

    if (options.idleWait) {
      log("2/4 idle stop and resume: the reaper stops it after 5 idle minutes, then generation 2 on the same volume");
      await waitFor(sessions, workspaceId, ["STOPPED"], 12);
    } else {
      log("2/4 resume: stop, then generation 2 on the same volume");
      await stopNow(options, sessions, first);
    }
    await sessions.ensureSession({ workspaceId, binding });
    const second = await waitFor(sessions, workspaceId, ["READY", "FAILED"], 25);
    if (second.state !== "READY" || second.generation !== 2 || second.volumeId !== first.volumeId) {
      throw new Error("generation 2 did not come up on the first generation's volume");
    }

    log("3/4 failure: the volume's zone mapped to the other zone's subnet, so the attach fails");
    await stopNow(options, sessions, second);
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
    log(`PASSED: provision, ${options.idleWait ? "idle stop by the reaper, " : ""}resume, failure and delete`);
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
