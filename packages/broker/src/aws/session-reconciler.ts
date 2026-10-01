import {
  CreateTagsCommand,
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Ec2RuntimeBinding, WorkspaceSession, WorkspaceSessionState } from "@agentx/contracts";
import { requiredEnvironment } from "./lambda.js";
import { failActiveOperation } from "./outbox-failure.js";
import { SessionManager, workspaceBinding } from "./sessions.js";
import { expireIndexDays, indexSweepWanted } from "./index-expiry.js";
import { sweepStuckSetups } from "./stuck-setup.js";
import { slackBotTokenFrom, sweepUnwaitedTasks, unwaitedTaskBackstopConfiguration, unwaitedTaskBackstopWanted, type UnwaitedTaskSweepResult } from "./unwaited-tasks.js";
import { cachedSlackPoster } from "./developer-task-notifier.js";

/** A just-launched instance or just-created volume is not judged until its session has recorded it. */
export const GRACE_MS = 15 * 60_000;
/** A workspace's volume outlives its close by this long before the reconciler deletes it. */
export const CLOSED_VOLUME_MS = 60 * 60_000;
/** Consecutive failed /ping probes before a READY worker is replaced. */
export const UNRESPONSIVE_PROBES = 3;
export const QUARANTINE_TAG = "agentx:quarantined";
const WORKER_PORT = 8080;
const PING_TIMEOUT_MS = 2_000;

export interface InstanceView { instanceId: string; state: string; workspaceId?: string; launchedAt: string }
export interface VolumeView { volumeId: string; state: string; workspaceId?: string; createdAt: string; quarantined: boolean }
export type ExecutionStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | "PENDING_REDRIVE";

export interface ReconcilerReport {
  orphanInstances: string[];
  lostInstances: string[];
  unresponsiveInstances: string[];
  stuckProvisioning: string[];
  restartedProvisioning: string[];
  stuckDeleting: string[];
  requeued: string[];
  closedVolumesDeleted: string[];
  quarantinedVolumes: string[];
  /** Spec 025 FR-055: workspaces whose developer-task setup the sweep failed this run. */
  stuckSetups: string[];
  /** Issue 173: idle Slack tasks cancelled with nobody waiting; present only where the backstop is wired. */
  unwaitedTasks?: UnwaitedTaskSweepResult;
}

export interface ReconcilerDependencies {
  sessions: Pick<SessionManager, "get" | "listByState" | "markLost" | "recordPingFailure" | "clearPingFailures" | "requeueParked" | "markFailed" | "markDeleted" | "ensureSession">;
  /** This environment's ec2-ebs instances that are not yet terminated. */
  instances: () => Promise<InstanceView[]>;
  /** This environment's ec2-ebs workspace volumes. */
  volumes: () => Promise<VolumeView[]>;
  executionStatus: (executionArn: string) => Promise<ExecutionStatus | undefined>;
  ping: (url: string) => Promise<string | undefined>;
  terminate: (instanceId: string) => Promise<void>;
  deleteVolume: (volumeId: string) => Promise<void>;
  quarantine: (volumeId: string) => Promise<void>;
  /** Fails the workspace's active operation and releases it; returns the operation ID, if any. */
  failActiveOperation: (workspaceId: string, error: string) => Promise<string | undefined>;
  /** When the workspace closed, if it did. */
  closedAt: (workspaceId: string) => Promise<string | undefined>;
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
  emit: (metrics: Record<string, number>) => void;
  /** Spec 025 FR-055: fails developer-task prepares 50 minutes old; absent in tests that do not need it. */
  sweepStuckSetups?: (now: Date) => Promise<{ failed: string[] }>;
  /**
   * Issue 173: cancels Slack thread tasks idle over 24 hours with nobody waiting, among the given
   * workspaces. Named environments only; absent in the legacy deployment and in tests that do not need it.
   */
  sweepUnwaitedTasks?: (workspaceIds: Iterable<string>, now: Date) => Promise<UnwaitedTaskSweepResult>;
  /** Spec 025 A6: deletes failure and usage index days older than 30 days; absent in tests that do not need it. */
  expireIndexDays?: (now: Date) => Promise<{ deleted: number }>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

const LIVE_STATES: readonly WorkspaceSessionState[] = ["PROVISIONING", "READY", "STOPPING", "STOPPED", "FAILED", "DELETING"];
/** Session states that own their instance: anything else holding one is an orphan. */
const INSTANCE_OWNERS: ReadonlySet<WorkspaceSessionState> = new Set(["PROVISIONING", "READY", "STOPPING", "DELETING"]);
const GONE = new Set(["terminated", "shutting-down"]);

/**
 * The reconciler (issue #86, flow 5 in #76), run every 10 minutes. Repairs drift between this
 * environment's ec2-ebs instances and volumes and the SESSION items that own them. It never deletes
 * a volume it cannot tie to a closed workspace: an unclaimed one is quarantined and alarmed (#22).
 */
export function createReconcilerHandler(dependencies: ReconcilerDependencies) {
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify({ component: "session-reconciler", ...entry })));
  return async (): Promise<ReconcilerReport> => {
    const now = (dependencies.now?.() ?? new Date()).getTime();
    const report: ReconcilerReport = {
      orphanInstances: [], lostInstances: [], unresponsiveInstances: [], stuckProvisioning: [], restartedProvisioning: [],
      stuckDeleting: [], requeued: [], closedVolumesDeleted: [], quarantinedVolumes: [], stuckSetups: [],
    };
    const sessions = new Map<string, WorkspaceSession>();
    for (const state of LIVE_STATES) {
      for (const session of await dependencies.sessions.listByState(state)) sessions.set(session.workspaceId, session);
    }
    const instances = await dependencies.instances();
    const instanceById = new Map(instances.map((instance) => [instance.instanceId, instance]));
    const settled = (timestamp: string) => now - Date.parse(timestamp) > GRACE_MS;

    // Instances no session owns.
    for (const instance of instances) {
      if (GONE.has(instance.state) || !settled(instance.launchedAt)) continue;
      const owner = instance.workspaceId === undefined ? undefined : sessions.get(instance.workspaceId);
      if (owner !== undefined && owner.instanceId === instance.instanceId && INSTANCE_OWNERS.has(owner.state)) continue;
      await dependencies.terminate(instance.instanceId);
      report.orphanInstances.push(instance.instanceId);
      log({ event: "reconciler.orphan_terminated", instanceId: instance.instanceId, workspaceId: instance.workspaceId });
    }

    for (const session of sessions.values()) {
      switch (session.state) {
        case "READY":
          await reconcileReady(dependencies, session, instanceById, report, log);
          break;
        case "PROVISIONING":
          await reconcileProvisioning(dependencies, session, report, log);
          break;
        case "DELETING":
          await reconcileDeleting(dependencies, session, instanceById, report, log);
          break;
        default:
          break;
      }
    }

    // Volumes no session claims.
    for (const volume of await dependencies.volumes()) {
      if (volume.quarantined) {
        report.quarantinedVolumes.push(volume.volumeId);
        continue;
      }
      if (!settled(volume.createdAt) || volume.workspaceId === undefined) continue;
      const owner = sessions.get(volume.workspaceId) ?? await dependencies.sessions.get(volume.workspaceId);
      if (owner !== undefined && owner.state !== "DELETED" && owner.volumeId === volume.volumeId) continue;
      const closedAt = await dependencies.closedAt(volume.workspaceId);
      if (closedAt !== undefined && now - Date.parse(closedAt) > CLOSED_VOLUME_MS && volume.state === "available") {
        await dependencies.deleteVolume(volume.volumeId);
        report.closedVolumesDeleted.push(volume.volumeId);
        log({ event: "reconciler.closed_volume_deleted", volumeId: volume.volumeId, workspaceId: volume.workspaceId });
        continue;
      }
      if (closedAt !== undefined) continue;
      await dependencies.quarantine(volume.volumeId);
      report.quarantinedVolumes.push(volume.volumeId);
      log({ event: "reconciler.volume_quarantined", volumeId: volume.volumeId, workspaceId: volume.workspaceId });
    }

    // FR-055, C17: last, so a failure here never stops the EC2 repairs above. A failed sweep is
    // logged (its error name only) and counted, the metrics are still emitted (F17), and the run
    // then fails so the existing SessionReconcilerErrors alarm still sees it.
    let sweepError: Error | undefined;
    if (dependencies.sweepStuckSetups !== undefined) {
      try {
        // The sweep logs each failed setup itself (stuck_setup.failed), so nothing is repeated here.
        report.stuckSetups = (await dependencies.sweepStuckSetups(new Date(now))).failed;
      } catch (error) {
        sweepError = error instanceof Error ? error : new Error("stuck-setup sweep failed");
        log({ event: "reconciler.stuck_setup_sweep_failed", errorName: error instanceof Error ? error.name : "unknown" });
      }
    }

    // Issue 173: after the repairs above, so a failure here never stops them. Each failed cancel is
    // logged by the sweep and retried on the next run (the task is still live), so a failure here is
    // logged by its error name, counted for the UnwaitedTaskFailures alarm, and the run goes on.
    let unwaitedMetrics: Record<string, number> = {};
    if (dependencies.sweepUnwaitedTasks !== undefined) {
      try {
        report.unwaitedTasks = await dependencies.sweepUnwaitedTasks(sessions.keys(), new Date(now));
        unwaitedMetrics = {
          ReconcilerUnwaitedTasksCancelled: report.unwaitedTasks.cancelled.length,
          ReconcilerUnwaitedTaskFailures: report.unwaitedTasks.failed.length,
          ReconcilerUnwaitedTaskReadFailures: report.unwaitedTasks.readFailures.length,
          // No alarm: a bot removed from a channel or a bad secret shows here and in the logs.
          ReconcilerUnwaitedTaskNoteFailures: report.unwaitedTasks.noteFailures,
        };
      } catch (error) {
        log({ event: "reconciler.unwaited_task_sweep_failed", errorName: error instanceof Error ? error.name : "unknown" });
        // Nothing was cancelled or tried: the sweep's own reads failed.
        unwaitedMetrics = { ReconcilerUnwaitedTasksCancelled: 0, ReconcilerUnwaitedTaskFailures: 0, ReconcilerUnwaitedTaskReadFailures: 1, ReconcilerUnwaitedTaskNoteFailures: 0 };
      }
    }

    // Spec 025 A6: housekeeping. A failure is logged by its error name and the run goes on; the
    // next run's 15-day look-back catches the day up, so no metric or report field changes.
    if (dependencies.expireIndexDays !== undefined) {
      try {
        await dependencies.expireIndexDays(new Date(now));
      } catch (error) {
        log({ event: "reconciler.index_expiry_failed", errorName: error instanceof Error ? error.name : "unknown" });
      }
    }

    dependencies.emit({
      ReconcilerOrphanInstances: report.orphanInstances.length,
      ReconcilerLostInstances: report.lostInstances.length,
      ReconcilerUnresponsiveInstances: report.unresponsiveInstances.length,
      ReconcilerStuckProvisioning: report.stuckProvisioning.length,
      ReconcilerStuckDeleting: report.stuckDeleting.length,
      ReconcilerRequeued: report.requeued.length,
      ReconcilerClosedVolumesDeleted: report.closedVolumesDeleted.length,
      ReconcilerQuarantinedVolumes: report.quarantinedVolumes.length,
      ReconcilerStuckSetups: report.stuckSetups.length,
      ReconcilerStuckSetupErrors: sweepError === undefined ? 0 : 1,
      ...unwaitedMetrics,
    });
    if (sweepError !== undefined) throw sweepError;
    return report;
  };
}

async function reconcileReady(
  dependencies: ReconcilerDependencies,
  session: WorkspaceSession,
  instances: Map<string, InstanceView>,
  report: ReconcilerReport,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const instance = instances.get(session.instanceId!);
  if (instance === undefined || instance.state !== "running") {
    // Terminated, stopped or gone from under a READY session: its work cannot finish.
    if (instance !== undefined && !GONE.has(instance.state)) await dependencies.terminate(instance.instanceId);
    if (!(await dependencies.sessions.markLost(session))) return;
    const operationId = await dependencies.failActiveOperation(session.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    report.lostInstances.push(session.instanceId!);
    log({ event: "reconciler.instance_lost", workspaceId: session.workspaceId, instanceId: session.instanceId, failedOperationId: operationId });
    return;
  }
  let status: string | undefined;
  try {
    status = await dependencies.ping(`http://${session.privateIp}:${WORKER_PORT}/ping`);
  } catch {
    status = undefined;
  }
  if (status === "Healthy" || status === "HealthyBusy") {
    if (session.pingFailures !== undefined) await dependencies.sessions.clearPingFailures(session);
  } else if (await dependencies.sessions.recordPingFailure(session) >= UNRESPONSIVE_PROBES) {
    // Replaced: the next run finds the instance gone and handles it as lost.
    await dependencies.terminate(session.instanceId!);
    report.unresponsiveInstances.push(session.instanceId!);
    log({ event: "reconciler.instance_unresponsive", workspaceId: session.workspaceId, instanceId: session.instanceId });
  }
  if ((session.waitingOutboxIds ?? []).length > 0) {
    const { requeued } = await dependencies.sessions.requeueParked(session.workspaceId);
    report.requeued.push(...requeued);
  }
}

async function reconcileProvisioning(
  dependencies: ReconcilerDependencies,
  session: WorkspaceSession,
  report: ReconcilerReport,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  if (session.executionArn === undefined) {
    // Its start failed before the execution was recorded; starting again is idempotent by name.
    const binding = await dependencies.binding(session.workspaceId);
    if (binding === undefined) return;
    await dependencies.sessions.ensureSession({ workspaceId: session.workspaceId, binding });
    report.restartedProvisioning.push(session.workspaceId);
    return;
  }
  const status = await dependencies.executionStatus(session.executionArn);
  // A running provisioner is trusted: it has its own 45-minute timeout.
  if (status === undefined || status === "RUNNING" || status === "PENDING_REDRIVE") return;
  if (session.instanceId !== undefined) await dependencies.terminate(session.instanceId);
  try {
    await dependencies.sessions.markFailed(session.workspaceId, session.generation, `provisioning ended ${status} without finishing`);
  } catch (error) {
    // It reached READY or FAILED after all.
    if (!(error instanceof Error && error.message.includes("STALE_FENCE"))) throw error;
    return;
  }
  report.stuckProvisioning.push(session.workspaceId);
  log({ event: "reconciler.provisioning_stuck", workspaceId: session.workspaceId, generation: session.generation, executionStatus: status });
}

async function reconcileDeleting(
  dependencies: ReconcilerDependencies,
  session: WorkspaceSession,
  instances: Map<string, InstanceView>,
  report: ReconcilerReport,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  if (session.executionArn !== undefined) {
    const status = await dependencies.executionStatus(session.executionArn);
    if (status === "RUNNING" || status === "PENDING_REDRIVE") return;
  }
  // The deleter cannot run again under its name (unique for 90 days), so finish here.
  const instance = session.instanceId === undefined ? undefined : instances.get(session.instanceId);
  if (instance !== undefined && !GONE.has(instance.state)) {
    await dependencies.terminate(instance.instanceId);
    report.stuckDeleting.push(session.workspaceId);
    return;
  }
  if (instance !== undefined && instance.state === "shutting-down") return;
  if (session.volumeId !== undefined) {
    const volume = (await dependencies.volumes()).find((candidate) => candidate.volumeId === session.volumeId);
    if (volume !== undefined) {
      if (volume.state !== "available") {
        report.stuckDeleting.push(session.workspaceId);
        return;
      }
      await dependencies.deleteVolume(volume.volumeId);
    }
  }
  await dependencies.sessions.markDeleted(session.workspaceId);
  report.stuckDeleting.push(session.workspaceId);
  log({ event: "reconciler.deletion_finished", workspaceId: session.workspaceId });
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));
const ec2 = new EC2Client(awsClientConfiguration);
const sfn = new SFNClient(awsClientConfiguration);
const tableName = process.env.STATE_TABLE_NAME ?? "";
const ownFilters = () => [
  { Name: "tag:DeploymentMode", Values: ["ec2-ebs"] },
  { Name: "tag:Environment", Values: [requiredEnvironment("ENVIRONMENT_TAG")] },
];
const tag = (tags: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined, key: string) => tags?.find((candidate) => candidate.Key === key)?.Value;

/**
 * Issue 173, named environments only: the reconciler cancels through the shared cancel code (it
 * already reads and writes the State table; the outbox publisher dispatches the cancel), reads the
 * thread's activeTurn (GetItem on THREAD# keys only), and posts the note with the bot token (the
 * Slack secret alone).
 */
function unwaitedTaskSweep(): NonNullable<ReconcilerDependencies["sweepUnwaitedTasks"]> {
  const secrets = new SecretsManagerClient(awsClientConfiguration);
  const slackSecretArn = requiredEnvironment("SLACK_SECRET_ARN");
  const threadsTableName = requiredEnvironment("SLACK_THREADS_TABLE_NAME");
  const callbackSigningKey = requiredEnvironment("CALLBACK_SIGNING_KEY");
  // A bad secret fails the note as SlackSecretInvalid, the name the sweep logs; never the secret's text.
  const post = cachedSlackPoster(() => secrets.send(new GetSecretValueCommand({ SecretId: slackSecretArn }))
    .then((secret) => slackBotTokenFrom(secret.SecretString)));
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "session-reconciler", ...entry }));
  return (workspaceIds, now) => sweepUnwaitedTasks({
    client: documentClient,
    tableName,
    threadsTableName,
    callbackSigningKey,
    postNote: async (thread, text) => { await post({ channel: thread.channelId, threadTs: thread.threadTs, text }); },
    log,
  }, workspaceIds, now);
}

// Issue 173: a half-wired environment runs without the backstop; say so once, by the missing names.
const backstop = unwaitedTaskBackstopConfiguration(process.env);
if (backstop.state === "partial") console.log(JSON.stringify({ component: "session-reconciler", event: "reconciler.unwaited_task_backstop_partial", missing: backstop.missing.join(",") }));

export const handler = createReconcilerHandler({
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
  async instances() {
    const found: InstanceView[] = [];
    let NextToken: string | undefined;
    do {
      const page = await ec2.send(new DescribeInstancesCommand({
        Filters: [...ownFilters(), { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] }],
        ...(NextToken ? { NextToken } : {}),
      }));
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const workspaceId = tag(instance.Tags, "agentx:workspace");
          found.push({
            instanceId: instance.InstanceId!,
            state: instance.State?.Name ?? "unknown",
            launchedAt: (instance.LaunchTime ?? new Date()).toISOString(),
            ...(workspaceId === undefined ? {} : { workspaceId }),
          });
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return found;
  },
  async volumes() {
    const found: VolumeView[] = [];
    let NextToken: string | undefined;
    do {
      // Workspace volumes only: root volumes carry no agentx:workspace tag and go with their instance.
      const page = await ec2.send(new DescribeVolumesCommand({ Filters: [...ownFilters(), { Name: "tag-key", Values: ["agentx:workspace"] }], ...(NextToken ? { NextToken } : {}) }));
      for (const volume of page.Volumes ?? []) {
        const workspaceId = tag(volume.Tags, "agentx:workspace");
        found.push({
          volumeId: volume.VolumeId!,
          state: volume.State ?? "unknown",
          createdAt: (volume.CreateTime ?? new Date()).toISOString(),
          quarantined: tag(volume.Tags, QUARANTINE_TAG) !== undefined,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        });
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return found;
  },
  async executionStatus(executionArn) {
    try {
      return (await sfn.send(new DescribeExecutionCommand({ executionArn }))).status;
    } catch (error) {
      if (error instanceof Error && error.name === "ExecutionDoesNotExist") return undefined;
      throw error;
    }
  },
  async ping(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const body = await response.json() as { status?: unknown };
    return typeof body.status === "string" ? body.status : undefined;
  },
  async terminate(instanceId) {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  },
  async deleteVolume(volumeId) {
    await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
  },
  async quarantine(volumeId) {
    await ec2.send(new CreateTagsCommand({ Resources: [volumeId], Tags: [{ Key: QUARANTINE_TAG, Value: new Date().toISOString() }] }));
  },
  failActiveOperation: (workspaceId, error) => failActiveOperation(documentClient, tableName, workspaceId, error),
  async closedAt(workspaceId) {
    const item = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" } }))).Item as { status?: string; closedAt?: string } | undefined;
    return item?.status === "CLOSED" ? item.closedAt : undefined;
  },
  binding: (workspaceId) => workspaceBinding(documentClient, tableName, workspaceId),
  sweepStuckSetups: (now) => sweepStuckSetups(documentClient, tableName, now, (entry) => console.log(JSON.stringify({ component: "session-reconciler", ...entry }))),
  ...(unwaitedTaskBackstopWanted(process.env) ? { sweepUnwaitedTasks: unwaitedTaskSweep() } : {}),
  ...(indexSweepWanted(process.env) ? { expireIndexDays: (now: Date) => expireIndexDays(documentClient, tableName, now, (entry) => console.log(JSON.stringify({ component: "session-reconciler", ...entry }))) } : {}),
  emit(metrics) {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), Dimensions: [[]], Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: "Count" })) }],
      },
      component: "session-reconciler",
      event: "metric",
      ...metrics,
    }));
  },
});
