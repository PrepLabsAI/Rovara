import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { WORKER_SETTING_PARAMETERS, ec2WorkerUserData } from "@agentx/contracts";
import { requiredEnvironment } from "./lambda.js";
import { SessionManager } from "./sessions.js";

/** The worker's health endpoint (#80 leaves it unauthenticated for exactly this probe). */
const WORKER_PORT = 8080;
const PING_TIMEOUT_MS = 2_000;

const uuid = z.string().uuid();
const generation = z.number().int().positive();
const volumeId = z.string().regex(/^vol-[0-9a-f]{8,17}$/);

/** One step of the provisioner or deleter state machine. */
export const SessionStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("launchConfiguration"), workspaceId: uuid, generation, volumeId, expectNewVolume: z.boolean() }).strict(),
  z.object({ action: z.literal("recordVolume"), workspaceId: uuid, generation, volumeId }).strict(),
  z.object({ action: z.literal("recordInstance"), workspaceId: uuid, generation, instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/), privateIp: z.ipv4() }).strict(),
  z.object({ action: z.literal("probePing"), privateIp: z.ipv4() }).strict(),
  z.object({ action: z.literal("markReady"), workspaceId: uuid, generation }).strict(),
  z.object({ action: z.literal("markFailed"), workspaceId: uuid, generation, error: z.string().max(16_384) }).strict(),
  z.object({ action: z.literal("markDeleted"), workspaceId: uuid }).strict(),
]);

export type SessionStep = z.infer<typeof SessionStepSchema>;

/** What a worker runs with besides its own workspace: set by each release in SSM. */
export interface WorkerSettings {
  workerImage: string;
  modelProvider: string;
  modelId: string;
  promptCacheRetention: "short" | "long";
}

export interface SessionStepsDependencies {
  sessions: Pick<SessionManager, "markVolume" | "markInstance" | "markReady" | "markFailed" | "markDeleted">;
  workerSettings: () => Promise<WorkerSettings>;
  /** The invoke signing key's public key as base64 DER, as KMS GetPublicKey returns it. */
  invokePublicKey: () => Promise<string>;
  bootScript: () => string;
  controlPlaneUrl: string;
  logGroupName: string;
  /** GET on the worker's /ping; resolves to the reported status, rejects when unreachable. */
  ping: (url: string) => Promise<string | undefined>;
}

export function createSessionStepsHandler(dependencies: SessionStepsDependencies) {
  return async (event: unknown): Promise<unknown> => {
    const step = SessionStepSchema.parse(event);
    switch (step.action) {
      case "launchConfiguration": {
        const [settings, invokePublicKey] = await Promise.all([dependencies.workerSettings(), dependencies.invokePublicKey()]);
        const userData = ec2WorkerUserData({
          workspaceId: step.workspaceId,
          generation: step.generation,
          volumeId: step.volumeId,
          expectNewVolume: step.expectNewVolume,
          workerImage: settings.workerImage,
          invokePublicKey,
          controlPlaneUrl: dependencies.controlPlaneUrl,
          modelProvider: settings.modelProvider,
          modelId: settings.modelId,
          promptCacheRetention: settings.promptCacheRetention,
          logGroupName: dependencies.logGroupName,
        }, dependencies.bootScript());
        return { userData: Buffer.from(userData, "utf8").toString("base64") };
      }
      case "recordVolume":
        await dependencies.sessions.markVolume(step.workspaceId, step.generation, step.volumeId);
        return {};
      case "recordInstance":
        await dependencies.sessions.markInstance(step.workspaceId, step.generation, step.instanceId, step.privateIp);
        return {};
      case "probePing": {
        let status: string | undefined;
        try {
          status = await dependencies.ping(`http://${step.privateIp}:${WORKER_PORT}/ping`);
        } catch {
          status = undefined;
        }
        return { healthy: status === "Healthy" || status === "HealthyBusy", status: status ?? "Unreachable" };
      }
      case "markReady":
        return dependencies.sessions.markReady(step.workspaceId, step.generation);
      case "markFailed":
        return dependencies.sessions.markFailed(step.workspaceId, step.generation, step.error);
      case "markDeleted":
        await dependencies.sessions.markDeleted(step.workspaceId);
        return {};
    }
  };
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const ssm = new SSMClient(awsClientConfiguration);
const kms = new KMSClient(awsClientConfiguration);
let publicKey: Promise<string> | undefined;

export const handler = createSessionStepsHandler({
  sessions: new SessionManager({
    documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration)),
    tableName: process.env.STATE_TABLE_NAME ?? "",
  }),
  async workerSettings() {
    const prefix = requiredEnvironment("WORKER_SETTINGS_PREFIX");
    const names = Object.fromEntries(Object.entries(WORKER_SETTING_PARAMETERS).map(([key, name]) => [key, `${prefix}${name}`]));
    const response = await ssm.send(new GetParametersCommand({ Names: Object.values(names) }));
    const values = new Map((response.Parameters ?? []).map((parameter) => [parameter.Name, parameter.Value]));
    const setting = (key: keyof typeof WORKER_SETTING_PARAMETERS) => {
      const value = values.get(names[key]);
      if (!value) throw new Error(`SSM parameter ${names[key]} is missing`);
      return value;
    };
    const promptCacheRetention = setting("promptCacheRetention");
    if (promptCacheRetention !== "short" && promptCacheRetention !== "long") throw new Error("worker prompt cache retention must be short or long");
    return { workerImage: setting("workerImage"), modelProvider: setting("modelProvider"), modelId: setting("modelId"), promptCacheRetention };
  },
  invokePublicKey() {
    // The key never changes, so one read per container.
    publicKey ??= kms.send(new GetPublicKeyCommand({ KeyId: requiredEnvironment("INVOKE_SIGNING_KEY_ARN") }))
      .then((response) => Buffer.from(response.PublicKey ?? new Uint8Array()).toString("base64"));
    return publicKey;
  },
  // Bundled beside the handler from packages/worker/ec2/boot.sh.
  bootScript: () => readFileSync(join(process.env.LAMBDA_TASK_ROOT ?? ".", "boot.sh"), "utf8"),
  controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? "",
  logGroupName: process.env.WORKER_LOG_GROUP_NAME ?? "",
  async ping(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const body = await response.json() as { status?: unknown };
    return typeof body.status === "string" ? body.status : undefined;
  },
});
