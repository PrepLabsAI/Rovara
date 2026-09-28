import { createHash } from "node:crypto";
import {
  Ec2RuntimeBindingSchema,
  agentXError,
  type LegacyDeploymentMode,
  type Ec2RuntimeBinding,
  type WorkerInvocation,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

export interface HttpApiV2Event {
  version?: string;
  /** The API Gateway route that matched, for example "ANY /v1/dev/{proxy+}". */
  routeKey?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: { method?: string };
    authorizer?: {
      jwt?: { claims?: Record<string, unknown> };
      iam?: { userArn?: string };
    };
  };
}

export interface AdaptedHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
  requestId: string;
  jwtClaims?: Record<string, unknown>;
  iamPrincipalArn?: string;
}

export interface LegacyRuntimeBinding {
  runtimeArn: string;
  endpointQualifier: string;
  deploymentMode: LegacyDeploymentMode;
  capacityProviderArn?: string;
}

export type RuntimeBinding = LegacyRuntimeBinding | Ec2RuntimeBinding;

/**
 * PENDING → QUEUED (publisher) → DELIVERED or FAILED (dispatcher). An ec2-ebs record whose session
 * is not ready waits in WAITING_FOR_SESSION; moving it back to PENDING makes the publisher, which
 * re-publishes PENDING records on MODIFY, queue it again.
 */
export type OutboxStatus = "PENDING" | "QUEUED" | "WAITING_FOR_SESSION" | "DELIVERED" | "FAILED";

interface OutboxRecordBase {
  id: string;
  entityType: "OUTBOX";
  status: OutboxStatus;
  operationId: string;
  workspaceId: string;
  invocation: WorkerInvocation;
}

/** Records written before ec2-ebs existed have no deploymentMode, so its absence marks a retired runtime. */
export interface LegacyOutboxRecord extends OutboxRecordBase {
  deploymentMode?: undefined;
  runtimeArn: string;
  endpointQualifier: string;
  runtimeSessionId: string;
}

/** The dispatcher finds an ec2-ebs worker through the workspace's SESSION record. */
export interface Ec2OutboxRecord extends OutboxRecordBase {
  deploymentMode: "ec2-ebs";
}

export type DurableOutboxRecord = LegacyOutboxRecord | Ec2OutboxRecord;

export function adaptHttpApiEvent(event: HttpApiV2Event): AdaptedHttpRequest {
  const rawPath = event.rawPath ?? "/";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const decodedBody =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
  return {
    method: event.requestContext?.http?.method ?? "GET",
    path: `${rawPath}${query}`,
    headers,
    ...(decodedBody === undefined ? {} : { body: decodedBody }),
    requestId: event.requestContext?.requestId ?? crypto.randomUUID(),
    ...(event.requestContext?.authorizer?.jwt?.claims === undefined
      ? {}
      : { jwtClaims: event.requestContext.authorizer.jwt.claims }),
    ...(event.requestContext?.authorizer?.iam?.userArn === undefined
      ? {}
      : { iamPrincipalArn: event.requestContext.authorizer.iam.userArn }),
  };
}

// API Gateway reports an assumed role as arn:aws:sts::<account>:assumed-role/<name>/<session>, without the role path.
export function isAssumedRoleOf(principalArn: string, roleArn: string): boolean {
  const role = /^arn:(aws[a-z-]*):iam::(\d{12}):role\/(?:[^/]+\/)*([^/]+)$/.exec(roleArn);
  const principal = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(principalArn);
  return Boolean(role && principal && role[1] === principal[1] && role[2] === principal[2] && role[3] === principal[3]);
}

export function identityFromJwtClaims(
  claims: Record<string, unknown> | undefined,
  config: { issuer: string; adminClaim: string; adminValues: readonly string[] },
): AuthenticatedIdentity {
  if (!claims) throw agentXError("AUTH_REQUIRED", "verified JWT claims are required");
  const issuer = claims.iss;
  const subject = claims.sub;
  if (issuer !== config.issuer || typeof subject !== "string" || subject.length === 0) {
    throw agentXError("AUTH_REQUIRED", "verified JWT issuer or subject is invalid");
  }
  const adminClaims = claimValues(claims[config.adminClaim]);
  return {
    issuer,
    subject,
    ownerKey: ownerKeyForSubject(issuer, subject),
    isAdministrator: adminClaims.some((value) => config.adminValues.includes(value)),
    claims,
  };
}

export function ownerKeyForSubject(issuer: string, subject: string): string {
  if (!subject || subject.length > 512) throw agentXError("CONFIG_INVALID", "owner subject is invalid");
  return createHash("sha256").update(issuer).update("\0").update(subject).digest("hex");
}

export function parseRuntimeBinding(value: unknown): Ec2RuntimeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", "runtimeBinding must be an object");
  }
  const input = value as Record<string, unknown>;
  return parseEc2RuntimeBinding(input);
}

function parseEc2RuntimeBinding(input: Record<string, unknown>): Ec2RuntimeBinding {
  const parsed = Ec2RuntimeBindingSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "runtimeBinding"}: ${issue.message}`);
    throw agentXError("CONFIG_INVALID", `ec2-ebs runtime binding is invalid: ${problems.join("; ")}`);
  }
  // A fixed key order, because registration compares stored and requested bindings as JSON.
  const binding = parsed.data;
  return {
    deploymentMode: binding.deploymentMode,
    launchTemplateId: binding.launchTemplateId,
    subnets: binding.subnets.map((subnet) => ({ availabilityZone: subnet.availabilityZone, subnetId: subnet.subnetId })),
    volumeSizeGiB: binding.volumeSizeGiB,
    volumeType: binding.volumeType,
  };
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function claimValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string") return [];
  const serialized = value.trim();
  if (serialized.startsWith("[") && serialized.endsWith("]")) {
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
    } catch {
      return splitClaimValues(serialized.slice(1, -1));
    }
  }
  return splitClaimValues(serialized);
}

function splitClaimValues(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim().replace(/^(?:"|')|(?:"|')$/g, ""))
    .filter(Boolean);
}
