import { createHash } from "node:crypto";
import {
  WorkspaceDeploymentModeSchema,
  agentXError,
  type WorkerInvocation,
  type WorkspaceDeploymentMode,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

export interface HttpApiV2Event {
  version?: string;
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

export interface RuntimeBinding {
  runtimeArn: string;
  endpointQualifier: string;
  deploymentMode: WorkspaceDeploymentMode;
  capacityProviderArn?: string;
}

export interface DurableOutboxRecord {
  id: string;
  entityType: "OUTBOX";
  status: "PENDING" | "QUEUED" | "DELIVERED" | "FAILED";
  operationId: string;
  workspaceId: string;
  runtimeArn: string;
  endpointQualifier: string;
  runtimeSessionId: string;
  invocation: WorkerInvocation;
}

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

export function parseRuntimeBinding(value: unknown): RuntimeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", "runtimeBinding must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "runtimeArn",
    "endpointQualifier",
    "deploymentMode",
    "capacityProviderArn",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "runtimeBinding contains unknown fields");
  }
  if (
    typeof input.runtimeArn !== "string" ||
    !input.runtimeArn.startsWith("arn:aws:bedrock-agentcore:") ||
    typeof input.endpointQualifier !== "string" ||
    input.endpointQualifier.length < 1 ||
    input.endpointQualifier.length > 64
  ) {
    throw agentXError("CONFIG_INVALID", "runtime binding ARN or endpoint qualifier is invalid");
  }
  const deploymentMode = WorkspaceDeploymentModeSchema.parse(input.deploymentMode);
  const capacityProviderArn = input.capacityProviderArn;
  if (
    capacityProviderArn !== undefined &&
    (typeof capacityProviderArn !== "string" ||
      !capacityProviderArn.startsWith("arn:aws:bedrock-agentcore:"))
  ) {
    throw agentXError("CONFIG_INVALID", "capacity provider ARN is invalid");
  }
  if (deploymentMode === "instances-ebs" && capacityProviderArn === undefined) {
    throw agentXError("CONFIG_INVALID", "instances-ebs runtime binding requires a capacity provider ARN");
  }
  if (deploymentMode === "demo-microvm" && capacityProviderArn !== undefined) {
    throw agentXError("CONFIG_INVALID", "demo-microvm runtime binding must not have a capacity provider ARN");
  }
  return {
    runtimeArn: input.runtimeArn,
    endpointQualifier: input.endpointQualifier,
    deploymentMode,
    ...(capacityProviderArn === undefined ? {} : { capacityProviderArn }),
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
