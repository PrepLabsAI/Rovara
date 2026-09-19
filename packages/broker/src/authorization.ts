import { agentXError } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";

export interface ProjectMembership {
  ownerKey: string;
  project: string;
  role?: "developer" | "administrator";
}

export function authorizeProject(
  identity: AuthenticatedIdentity,
  project: string,
  memberships: readonly ProjectMembership[],
): ProjectMembership {
  const membership = memberships.find(
    (candidate) => candidate.ownerKey === identity.ownerKey && candidate.project === project,
  );
  if (!membership) throw agentXError("NOT_FOUND", "project not found");
  return membership;
}

export function authorizeWorkspace(
  identity: AuthenticatedIdentity,
  workspace: { ownerKey: string; projectName: string },
): void {
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
}

const FORBIDDEN_ROUTING_FIELDS = new Set([
  "capacityProviderArn",
  "deploymentMode",
  "owner",
  "ownerKey",
  "ownerSubject",
  "runtimeArn",
  "runtimeSessionId",
  "sessionId",
]);

export function assertNoUntrustedRoutingFields(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUntrustedRoutingFields(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ROUTING_FIELDS.has(key)) {
      throw agentXError("FORBIDDEN", `${path}.${key} is server controlled`);
    }
    assertNoUntrustedRoutingFields(child, `${path}.${key}`);
  }
}
