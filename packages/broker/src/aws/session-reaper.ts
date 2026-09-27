import { DescribeInstancesCommand, DescribeVolumesCommand, EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Ec2RuntimeBinding, WorkspaceSession } from "@agentx/contracts";
import { requiredEnvironment } from "./lambda.js";
import { SessionManager, workspaceBinding } from "./sessions.js";

/** AgentCore's idle stop and maximum lifetime, which the reaper replaces (design in #76). */
export const IDLE_STOP_MS = 5 * 60_000;
export const MAX_LIFETIME_MS = 14 * 24 * 60 * 60_000;
const WORKER_PORT = 8080;
const PING_TIMEOUT_MS = 2_000;

/** Where a stopping session's instance and volume are. */
export interface StopProgress {
  /** Terminated or no longer found. */
  instanceGone: boolean;
  /** Still running or pending: the terminate has to be sent again. */
  instanceLive: boolean;
  volumeAvailable: boolean;
}

export interface ReaperReport {
  claimed: string[];
  skippedBusy: string[];
  lostRace: string[];
  stopped: string[];
  restarted: string[];
  stillStopping: string[];
}

export interface ReaperDependencies {
  sessions: Pick<SessionManager, "listByState" | "claimStop" | "markStopped" | "ensureSession">;
  /** Whether the workspace has an operation in progress. */
  activeOperation: (workspaceId: string) => Promise<boolean>;
  /** GET /ping; resolves to the reported status, rejects when unreachable. */
  ping: (url: string) => Promise<string | undefined>;
  terminate: (instanceId: string) => Promise<void>;
  progress: (instanceId: string, volumeId: string) => Promise<StopProgress>;
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
  emit: (metrics: Record<string, number>) => void;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * The idle reaper (issue #85, flow 4 in #76), run every minute. It stops READY sessions idle over
 * five minutes or launched over 14 days ago, then finishes stopping sessions once their instance is
 * gone and their volume detached. It never changes the workspace's status.
 */
export function createReaperHandler(dependencies: ReaperDependencies) {
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify({ component: "session-reaper", ...entry })));
  return async (): Promise<ReaperReport> => {
    const now = (dependencies.now?.() ?? new Date()).getTime();
    const report: ReaperReport = { claimed: [], skippedBusy: [], lostRace: [], stopped: [], restarted: [], stillStopping: [] };

    for (const session of await dependencies.sessions.listByState("READY")) {
      const idle = now - Date.parse(session.lastActivityAt!) > IDLE_STOP_MS;
      const expired = now - Date.parse(session.launchedAt!) > MAX_LIFETIME_MS;
      if (!idle && !expired) continue;
      // Never reaped while the broker sees work, or while the worker reports work the broker does not.
      if (await dependencies.activeOperation(session.workspaceId) || await isBusy(dependencies, session)) {
        report.skippedBusy.push(session.workspaceId);
        continue;
      }
      if (!(await dependencies.sessions.claimStop(session))) {
        // A dispatch touched the session or took the workspace first; it stays READY.
        report.lostRace.push(session.workspaceId);
        continue;
      }
      report.claimed.push(session.workspaceId);
      log({ event: "session.stop_claimed", workspaceId: session.workspaceId, generation: session.generation, reason: expired ? "lifetime" : "idle" });
      await terminate(dependencies, session, log);
    }

    for (const session of await dependencies.sessions.listByState("STOPPING")) {
      const progress = await dependencies.progress(session.instanceId!, session.volumeId!);
      if (progress.instanceLive) await terminate(dependencies, session, log);
      if (!progress.instanceGone || !progress.volumeAvailable) {
        report.stillStopping.push(session.workspaceId);
        continue;
      }
      const stopped = await dependencies.sessions.markStopped(session.workspaceId, session.generation);
      report.stopped.push(session.workspaceId);
      // Work that arrived while it was stopping starts the next generation at once.
      if ((stopped.waitingOutboxIds ?? []).length > 0) {
        const binding = await dependencies.binding(session.workspaceId);
        if (binding === undefined) {
          log({ event: "session.restart_skipped", workspaceId: session.workspaceId, reason: "no ec2-ebs binding" });
        } else {
          await dependencies.sessions.ensureSession({ workspaceId: session.workspaceId, binding });
          report.restarted.push(session.workspaceId);
        }
      }
    }

    // The STOPPING query runs after this tick's claims, so it already counts them.
    dependencies.emit({ SessionsStopped: report.stopped.length, SessionsStopping: report.stillStopping.length });
    return report;
  };
}

async function isBusy(dependencies: ReaperDependencies, session: WorkspaceSession): Promise<boolean> {
  try {
    return await dependencies.ping(`http://${session.privateIp}:${WORKER_PORT}/ping`) === "HealthyBusy";
  } catch {
    // An unreachable worker is doing no work; stopping it frees the instance (the reconciler, #86,
    // handles one that stays unreachable while in use).
    return false;
  }
}

async function terminate(dependencies: ReaperDependencies, session: WorkspaceSession, log: (entry: Record<string, unknown>) => void): Promise<void> {
  try {
    await dependencies.terminate(session.instanceId!);
  } catch (error) {
    // Left STOPPING; the next tick sends the terminate again.
    log({ event: "session.terminate_failed", workspaceId: session.workspaceId, instanceId: session.instanceId, error: error instanceof Error ? error.name : "unknown" });
  }
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));
const ec2 = new EC2Client(awsClientConfiguration);
const sfn = new SFNClient(awsClientConfiguration);
const tableName = process.env.STATE_TABLE_NAME ?? "";

export const handler = createReaperHandler({
  sessions: new SessionManager({
    documentClient,
    tableName,
    executions: {
      provisionerArn: process.env.PROVISIONER_ARN ?? "",
      deleterArn: process.env.DELETER_ARN ?? "",
      async start(input) {
        return (await sfn.send(new StartExecutionCommand(input))).executionArn!;
      },
    },
  }),
  async activeOperation(workspaceId) {
    const item = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true }))).Item;
    return typeof item?.activeOperationId === "string";
  },
  async ping(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const body = await response.json() as { status?: unknown };
    return typeof body.status === "string" ? body.status : undefined;
  },
  async terminate(instanceId) {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  },
  async progress(instanceId, volumeId) {
    let state: string | undefined;
    try {
      const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      state = response.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    } catch (error) {
      if (!(error instanceof Error && error.name === "InvalidInstanceID.NotFound")) throw error;
    }
    const volume = (await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))).Volumes?.[0];
    return {
      instanceGone: state === undefined || state === "terminated",
      instanceLive: state === "running" || state === "pending" || state === "stopped" || state === "stopping",
      volumeAvailable: volume?.State === "available",
    };
  },
  binding: (workspaceId) => workspaceBinding(documentClient, tableName, workspaceId),
  emit(metrics) {
    // CloudWatch embedded metric format: Lambda turns this stdout line into metrics.
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), Dimensions: [[]], Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: "Count" })) }],
      },
      component: "session-reaper",
      event: "metric",
      ...metrics,
    }));
  },
});
