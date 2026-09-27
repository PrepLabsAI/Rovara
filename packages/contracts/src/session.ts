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

export function workspaceSessionKey(workspaceId: string): { pk: string; sk: "SESSION" } {
  return { pk: `WORKSPACE#${workspaceId}`, sk: "SESSION" };
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

export type Ec2RuntimeBinding = z.infer<typeof Ec2RuntimeBindingSchema>;
export type WorkspaceSessionState = z.infer<typeof WorkspaceSessionStateSchema>;
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;
export type WorkerInvokeTokenClaims = z.infer<typeof WorkerInvokeTokenClaimsSchema>;
