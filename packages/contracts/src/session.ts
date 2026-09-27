import { Buffer } from "node:buffer";
import { z } from "zod";

// Contracts for ec2-ebs workspaces, whose compute the Session Manager provisions on self-managed
// EC2 instances with one EBS volume per workspace (design in issue #76).

const AvailabilityZoneSchema = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+[a-z]$/, "invalid availability zone");
const SubnetIdSchema = z.string().regex(/^subnet-[0-9a-f]{8,17}$/, "invalid subnet ID");

/** A project's trusted runtime binding for ec2-ebs. It carries no AgentCore ARNs. */
export const Ec2RuntimeBindingSchema = z
  .object({
    deploymentMode: z.literal("ec2-ebs"),
    launchTemplateId: z.string().regex(/^lt-[0-9a-f]{8,17}$/, "invalid launch template ID"),
    // One private subnet per availability zone. A workspace's first volume fixes its zone, and
    // every later instance for it launches in that zone's subnet.
    subnets: z
      .array(z.object({ availabilityZone: AvailabilityZoneSchema, subnetId: SubnetIdSchema }).strict())
      .min(1)
      .max(16),
    volumeSizeGiB: z.number().int().min(1).max(16_384),
    volumeType: z.enum(["gp3"]),
  })
  .strict()
  .superRefine((binding, context) => {
    const zones = binding.subnets.map((subnet) => subnet.availabilityZone);
    if (new Set(zones).size !== zones.length) {
      context.addIssue({ code: "custom", path: ["subnets"], message: "each availability zone may have only one subnet" });
    }
    const subnetIds = binding.subnets.map((subnet) => subnet.subnetId);
    if (new Set(subnetIds).size !== subnetIds.length) {
      context.addIssue({ code: "custom", path: ["subnets"], message: "subnet IDs must be unique" });
    }
  });

export const WorkspaceSessionStateSchema = z.enum([
  "NONE",
  "PROVISIONING",
  "READY",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "DELETING",
  "DELETED",
]);

/**
 * The compute state of one ec2-ebs workspace, stored at `workspaceSessionKey(workspaceId)` in the
 * same partition as the workspace's OPERATION# items. `generation` counts provisioning attempts and
 * fences every write that belongs to one of them.
 */
export const WorkspaceSessionSchema = z
  .object({
    workspaceId: z.string().uuid(),
    state: WorkspaceSessionStateSchema,
    generation: z.number().int().nonnegative(),
    volumeId: z.string().regex(/^vol-[0-9a-f]{8,17}$/, "invalid volume ID").optional(),
    availabilityZone: AvailabilityZoneSchema.optional(),
    subnetId: SubnetIdSchema.optional(),
    instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/, "invalid instance ID").optional(),
    privateIp: z.ipv4().optional(),
    launchedAt: z.string().datetime().optional(),
    readyAt: z.string().datetime().optional(),
    lastActivityAt: z.string().datetime().optional(),
    executionArn: z.string().startsWith("arn:aws:states:").optional(),
    /**
     * Outbox records parked in WAITING_FOR_SESSION for this session. markReady sends each back to
     * PENDING; markFailed fails their operations. Stored as a DynamoDB string set.
     */
    waitingOutboxIds: z.array(z.string().uuid()).optional(),
    /** Consecutive failed health probes of a READY worker, counted by the reconciler (#86). */
    pingFailures: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((session, context) => {
    const require = (field: keyof typeof session, reason: string) => {
      if (session[field] === undefined) context.addIssue({ code: "custom", path: [field], message: `${field} is required ${reason}` });
    };
    const forbid = (field: keyof typeof session, reason: string) => {
      if (session[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: `${field} must be absent ${reason}` });
    };
    if ((session.state === "NONE") !== (session.generation === 0)) {
      context.addIssue({ code: "custom", path: ["generation"], message: "generation is 0 exactly while the session is NONE" });
    }
    // An EBS volume cannot move between zones, so a volume or subnet always has its zone recorded.
    if (session.volumeId !== undefined || session.subnetId !== undefined) require("availabilityZone", "with a volume or subnet");
    if (session.instanceId !== undefined) require("subnetId", "with an instance");
    if (session.privateIp !== undefined) require("instanceId", "with a private IP");
    switch (session.state) {
      case "NONE":
        for (const field of ["volumeId", "availabilityZone", "subnetId", "instanceId", "launchedAt", "readyAt", "executionArn"] as const) {
          forbid(field, "before the first provisioning");
        }
        break;
      case "PROVISIONING":
        require("availabilityZone", "while provisioning");
        require("subnetId", "while provisioning");
        break;
      case "READY":
        for (const field of ["volumeId", "instanceId", "privateIp", "launchedAt", "readyAt", "lastActivityAt"] as const) {
          require(field, "while READY");
        }
        break;
      case "STOPPING":
        require("volumeId", "while stopping");
        require("instanceId", "while stopping");
        break;
      case "STOPPED":
        require("volumeId", "while STOPPED");
        forbid("instanceId", "once STOPPED");
        forbid("privateIp", "once STOPPED");
        break;
      case "DELETED":
        forbid("instanceId", "once DELETED");
        forbid("privateIp", "once DELETED");
        break;
      case "FAILED":
      case "DELETING":
        break;
      default: {
        const unhandled: never = session.state;
        throw new Error(`unhandled session state ${String(unhandled)}`);
      }
    }
  });

/**
 * The state table's sparse index of SESSION items by state, for the idle reaper and reconciler.
 * A SESSION item carries `sessionState` (a copy of `state`) only so that it appears here; no other
 * item has that attribute. `state` itself cannot be the key: pull request records also have one.
 */
export const WORKSPACE_SESSION_STATE_INDEX = {
  name: "bySessionState",
  partitionKey: "sessionState",
  sortKey: "workspaceId",
} as const;

export function workspaceSessionKey(workspaceId: string): { pk: string; sk: "SESSION" } {
  return { pk: `WORKSPACE#${workspaceId}`, sk: "SESSION" };
}

/**
 * The provisioner execution for one generation. Starting an execution again under the same name and
 * input returns the running one, so a retried start never launches a second instance. Also the
 * ClientToken of that generation's CreateVolume and RunInstances calls.
 */
export function sessionProvisioningName(workspaceId: string, generation: number): string {
  return `ws-${workspaceId}-gen-${generation}`;
}

/**
 * SSM parameters under the environment's settings prefix (`/agentx/<env>/`) that each release sets
 * in the runtime stack, and the session provisioner reads to boot an EC2 worker.
 */
export const WORKER_SETTING_PARAMETERS = {
  workerImage: "worker-image",
  modelProvider: "worker-model-provider",
  modelId: "worker-model-id",
  promptCacheRetention: "worker-prompt-cache-retention",
  openRouterSecretArn: "worker-openrouter-secret-arn",
  openRouterProviders: "worker-openrouter-providers",
} as const;

/**
 * Foundation outputs the control plane takes as stack parameters of the same name, for the EC2
 * session lifecycle. Parameters rather than cross-stack exports, so the manually deployed foundation
 * never has to change for them. The release and `agentx deploy` both pass them.
 */
export const CONTROL_PLANE_FOUNDATION_PARAMETERS = [
  "PrivateSubnetIds",
  "SessionManagerSecurityGroupId",
  "DispatcherSecurityGroupId",
  "WorkspaceKmsKeyArn",
  "Ec2WorkerInstanceRoleArn",
  "Ec2WorkerLaunchTemplateId",
] as const;

/** The deleter execution for a workspace; a workspace is deleted once. */
export function sessionDeletionName(workspaceId: string): string {
  return `ws-${workspaceId}-delete`;
}

/**
 * Claims of the token the dispatcher signs with the KMS key for each POST to a worker. The worker
 * accepts it only for its own workspace and generation, before `expiresAt` (epoch seconds).
 */
export const WorkerInvokeTokenClaimsSchema = z
  .object({
    workspaceId: z.string().uuid(),
    generation: z.number().int().positive(),
    operationId: z.string().uuid(),
    fence: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

/** The HTTP authorization scheme of a worker invocation: `Authorization: AgentX-Invoke <token>`. */
export const WORKER_INVOKE_AUTHORIZATION_SCHEME = "AgentX-Invoke";

/**
 * The first part of an invoke token, and the exact bytes the KMS key signs (ECDSA_SHA_256 on an
 * ECC_NIST_P256 key): the base64url of the claims' JSON. Signing the encoded form means the worker
 * verifies what it received, with no JSON canonicalization.
 */
export function workerInvokeTokenPayload(claims: WorkerInvokeTokenClaims): string {
  return Buffer.from(JSON.stringify(WorkerInvokeTokenClaimsSchema.parse(claims)), "utf8").toString("base64url");
}

/** `<payload>.<signature>`, the signature being the DER-encoded ECDSA signature KMS Sign returns. */
export function workerInvokeToken(payload: string, signature: Uint8Array): string {
  return `${payload}.${Buffer.from(signature).toString("base64url")}`;
}

// Every boot value is interpolated into a shell script, so each pattern admits no quote,
// whitespace or other shell metacharacter.
const SHELL_SAFE = /^[A-Za-z0-9._:/@+=-]+$/;

/**
 * What an EC2 worker boots with. The provisioner renders it into user data with
 * `ec2WorkerUserData`; `packages/worker/ec2/boot.sh` reads each field from the variable named here.
 */
export const Ec2WorkerBootConfigSchema = z
  .object({
    /** AGENTX_WORKSPACE_ID */
    workspaceId: z.string().uuid(),
    /** AGENTX_SESSION_GENERATION */
    generation: z.number().int().positive(),
    /** AGENTX_VOLUME_ID */
    volumeId: z.string().regex(/^vol-[0-9a-f]{8,17}$/, "invalid volume ID"),
    /** AGENTX_EXPECT_NEW_VOLUME: true only for a generation that created the volume. */
    expectNewVolume: z.boolean(),
    /** AGENTX_WORKER_IMAGE: an ECR image pinned by digest. */
    workerImage: z
      .string()
      .regex(/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/, "worker image must be an ECR image pinned by digest"),
    /** AGENTX_INVOKE_PUBLIC_KEY: base64 DER SPKI, as KMS GetPublicKey returns it. */
    invokePublicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "invoke public key must be base64").max(1_024),
    /** AGENTX_CONTROL_PLANE_URL */
    controlPlaneUrl: z.string().url().startsWith("https://").max(512).regex(SHELL_SAFE, "control plane URL has unsafe characters"),
    /** AGENTX_MODEL_PROVIDER */
    modelProvider: z.string().min(1).max(128).regex(SHELL_SAFE, "model provider has unsafe characters"),
    /** AGENTX_MODEL_ID */
    modelId: z.string().min(1).max(256).regex(SHELL_SAFE, "model ID has unsafe characters"),
    openRouterSecretArn: z.string().regex(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/).optional(),
    openRouterProviders: z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,79}(?:,[a-z0-9][a-z0-9_/-]{0,79})*$/).optional(),
    /** PI_CACHE_RETENTION */
    promptCacheRetention: z.enum(["short", "long"]),
    /** AGENTX_LOG_GROUP: the CloudWatch Logs group the worker container writes to. */
    logGroupName: z.string().regex(/^[A-Za-z0-9._/-]{1,512}$/, "invalid log group name"),
  })
  .strict();

/** The boot script's user data: a validated configuration block, then the script itself. */
export function ec2WorkerUserData(config: Ec2WorkerBootConfig, bootScript: string): string {
  const parsed = Ec2WorkerBootConfigSchema.parse(config);
  const variables: Array<[string, string]> = [
    ["AGENTX_WORKSPACE_ID", parsed.workspaceId],
    ["AGENTX_SESSION_GENERATION", String(parsed.generation)],
    ["AGENTX_VOLUME_ID", parsed.volumeId],
    ["AGENTX_EXPECT_NEW_VOLUME", String(parsed.expectNewVolume)],
    ["AGENTX_WORKER_IMAGE", parsed.workerImage],
    ["AGENTX_INVOKE_PUBLIC_KEY", parsed.invokePublicKey],
    ["AGENTX_CONTROL_PLANE_URL", parsed.controlPlaneUrl],
    ["AGENTX_MODEL_PROVIDER", parsed.modelProvider],
    ["AGENTX_MODEL_ID", parsed.modelId],
    ["PI_CACHE_RETENTION", parsed.promptCacheRetention],
    ["AGENTX_LOG_GROUP", parsed.logGroupName],
  ];
  if (parsed.openRouterSecretArn) variables.push(["AGENTX_OPENROUTER_SECRET_ARN", parsed.openRouterSecretArn]);
  if (parsed.openRouterProviders) variables.push(["AGENTX_OPENROUTER_PROVIDERS", parsed.openRouterProviders]);
  const body = bootScript.replace(/^#!.*\n/, "");
  return [
    "#!/bin/bash",
    "# Rendered by ec2WorkerUserData (@agentx/contracts).",
    ...variables.map(([name, value]) => `export ${name}='${value}'`),
    body,
  ].join("\n");
}

export type Ec2WorkerBootConfig = z.infer<typeof Ec2WorkerBootConfigSchema>;
export type Ec2RuntimeBinding = z.infer<typeof Ec2RuntimeBindingSchema>;
export type WorkspaceSessionState = z.infer<typeof WorkspaceSessionStateSchema>;
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;
export type WorkerInvokeTokenClaims = z.infer<typeof WorkerInvokeTokenClaimsSchema>;
