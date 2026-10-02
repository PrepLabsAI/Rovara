// Spec 052: an offline eval-batch harness: FakeDynamoDb, a vi.fn state machine and S3 that keeps
// what was written, and a fake clock. The batch broker tests keep their own copy of this setup.
import { vi, type Mock } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, type ModelIdentifier } from "@agentx/contracts";
import { withEvalBatches, type EvalBatchDependencies } from "../../packages/broker/src/aws/eval-batch.js";
import {
  handleSwebenchCallback,
  issueSwebenchCapability,
  putSwebenchChannel,
  type SwebenchDependencies,
  type SwebenchDeployment,
  type SwebenchSlackContext,
} from "../../packages/broker/src/aws/swebench.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const TEAM = "T0BSHLLUGBD";
export const CHANNEL = "C0123456789";
export const thread = { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000001" };
export const requester = { teamId: TEAM, userId: "U0123456789" };
export const runnerImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;

export const cheap = { provider: "openrouter", modelId: "vendor/cheap-v1", thinkingLevel: "high", routing: { only: ["fireworks"] } } as const;
export const dear = { provider: "amazon-bedrock", modelId: "us.vendor.dear-v1", thinkingLevel: "medium" } as const;
const prices: Record<string, number> = { [cheap.modelId]: 1.5, [dear.modelId]: 7.2 };

export const tasks = ["django__django-11099", "sympy__sympy-13878"];

export const usage = (costUsd: number | null) => ({
  schemaVersion: 1, outcome: "SUCCEEDED", provider: "openrouter", modelId: cheap.modelId, cacheRetention: "long",
  tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, total: 115 }, cacheReadRatio: 0.9, costUsd,
});
export const graded = (costUsd: number, resolved = true) => ({
  outcome: "GRADED", resolved, stopReason: "finished", patchBytes: 899,
  failToPass: { passed: 3, total: 3 }, passToPass: { passed: 19, total: 19 },
  agentSeconds: 420, imageDigest: "swebench/x@sha256:abc", usage: usage(costUsd), artifactsPrefix: "evals/run/",
});

export interface Harness {
  db: FakeDynamoDb;
  dependencies: EvalBatchDependencies;
  context: SwebenchSlackContext;
  /** Every object written to S3, by key. */
  objects: Map<string, string>;
  s3Send: Mock;
  startExecution: Mock<SwebenchDependencies["startExecution"]>;
  /** Each execution's status, by execution ARN, as DescribeExecution reports it; RUNNING when unset. */
  executions: Map<string, string>;
  describeExecution: Mock<NonNullable<SwebenchDependencies["describeExecution"]>>;
  deployment: Mock<() => Promise<SwebenchDeployment | undefined>>;
  advance: (ms: number) => void;
}

export async function harness(options: { maxConcurrentEvals?: number; maxCostUsd?: number } = {}): Promise<Harness> {
  const db = new FakeDynamoDb();
  const objects = new Map<string, string>();
  const s3Send = vi.fn(async (command: { input: { Key?: string; Body?: string } }) => {
    if (command.input.Key !== undefined) objects.set(command.input.Key, String(command.input.Body));
    return {};
  });
  const startExecution = vi.fn<SwebenchDependencies["startExecution"]>(async (input) => ({ executionArn: executionArn(input.name) }));
  const executions = new Map<string, string>();
  const describeExecution = vi.fn<NonNullable<SwebenchDependencies["describeExecution"]>>(async (arn) => ({ status: executions.get(arn) ?? "RUNNING" }));
  let clock = new Date("2026-10-02T10:00:00.000Z").getTime();
  const deployment = vi.fn(async (): Promise<SwebenchDeployment | undefined> => ({
    settings: {
      stateMachineArn: "arn:aws:states:us-east-1:111122223333:stateMachine:agentx-production-swebench-eval",
      subnetIds: ["subnet-0123456789abcdef0"],
      controlPlaneUrl: "https://api.example.com",
      logGroupName: "/agentx/production/swebench",
      maxConcurrentEvals: options.maxConcurrentEvals ?? 4,
    },
    runnerImage,
    defaultModel: { provider: "amazon-bedrock", modelId: "us.vendor.default-v1" },
    environment: { PI_CACHE_RETENTION: "long", AGENTX_OPENROUTER_PROVIDERS: "deployment-default" },
    runnerFeatures: ["model.thinkingLevel"],
  }));
  const dependencies: EvalBatchDependencies = withEvalBatches({
    documentClient: db as never,
    s3: { send: s3Send } as never,
    tableName: "state",
    artifactBucketName: "artifacts",
    callbackSigningKey: "c".repeat(64),
    deployment,
    startExecution,
    describeExecution,
    now: () => new Date(clock),
    estimateRunCostUsd: (model) => prices[model.modelId],
    sleep: async () => undefined,
  });
  await putSwebenchChannel(dependencies, TEAM, CHANNEL, { maxCostUsd: options.maxCostUsd ?? 10 });
  const approved: ModelIdentifier[] = [cheap, dear];
  const context: SwebenchSlackContext = {
    thread, requester, projectName: "payments",
    projectModel: async (requested) => {
      const found = approved.find((model) => model.provider === requested?.provider && model.modelId === requested.modelId);
      if (found === undefined) throw agentXError("CONFIG_INVALID", `model ${requested?.provider}/${requested?.modelId} is not approved for this project`);
      return { provider: found.provider, modelId: found.modelId };
    },
  };
  s3Send.mockClear();
  return { db, dependencies, context, objects, s3Send, startExecution, executions, describeExecution, deployment, advance: (ms) => { clock += ms; } };
}

/** The ARN Step Functions gives a run's execution: the run ID is the execution's name. */
export const executionArn = (runId: string) => `arn:aws:states:us-east-1:111122223333:execution:agentx-production-swebench-eval:${runId}`;

export const file = (overrides: Record<string, unknown> = {}) => ({
  benchmark: "verified", tasks, models: [dear, cheap], repeats: 1, costCapUsd: 200, ...overrides,
});

/** The runner's result callback for one run, as the runner sends it. */
export async function finish(h: Harness, runId: string, body: unknown) {
  return handleSwebenchCallback(h.dependencies, issueSwebenchCapability(h.dependencies, runId), runId, "result", body);
}

/** The runner's started callback: from here on the run may spend tokens. */
export async function runnerStarted(h: Harness, runId: string) {
  await handleSwebenchCallback(h.dependencies, issueSwebenchCapability(h.dependencies, runId), runId, "started", {});
}

/**
 * The state machine ends a run (time limit, instance lost, cancel) as its EndRun does: the run goes
 * terminal and its slot is released, and the broker hears nothing of it.
 */
export async function endByStateMachine(h: Harness, runId: string, status: "FAILED" | "CANCELLED", error: string) {
  await h.db.send(new TransactWriteCommand({
    TransactItems: [
      { Update: { TableName: "state", Key: { pk: `SWEBENCH_RUN#${runId}`, sk: "META" }, UpdateExpression: "SET #status = :status, #error = :error, finishedAt = :now", ExpressionAttributeNames: { "#status": "status", "#error": "error" }, ExpressionAttributeValues: { ":status": status, ":error": error, ":now": "2026-10-02T11:00:00.000Z" } } },
      { Delete: { TableName: "state", Key: { pk: "SWEBENCH#SLOT", sk: `RUN#${runId}` } } },
      { Update: { TableName: "state", Key: { pk: "SWEBENCH#SLOTS", sk: "COUNTER" }, UpdateExpression: "SET #count = #count - :one", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":one": 1 } } },
    ],
  }));
}

export const without = (item: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
