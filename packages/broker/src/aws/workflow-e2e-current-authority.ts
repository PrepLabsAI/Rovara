import { canonicalJson } from "@agentx/contracts";

export interface WorkflowE2ECurrentAuthorityInput {
  admission: {
    candidateDigest: string;
    intent: unknown;
    policy: unknown;
    runtime: unknown;
    portableApprovalBinding: unknown;
    creatorAuthority: unknown;
    approval: { artifactId: string; artifactDigest: string; graphDigest: string; runId: string; workflowRevision: number; actorId: string };
  };
  current: {
    candidateDigest: string;
    intent: unknown;
    policy: unknown;
    runtime: unknown;
    portableApprovalBinding: unknown;
    creatorAuthority: unknown;
    approval: { artifactId: string; artifactDigest: string; graphDigest: string; runId: string; workflowRevision: number; actorId: string };
    approvedDecision: boolean;
    creatorHasProjectAccess: boolean;
    now: number;
  };
}

/** A stored E2E admission is evidence input, never a substitute for reloaded current authority. */
export function workflowE2ECurrentAuthorityMatches(input: WorkflowE2ECurrentAuthorityInput): boolean {
  const { admission, current } = input;
  if (admission.candidateDigest !== current.candidateDigest || !current.approvedDecision || !current.creatorHasProjectAccess
    || !same(admission.intent, current.intent) || !same(admission.policy, current.policy)
    || !same(admission.runtime, current.runtime) || !same(admission.portableApprovalBinding, current.portableApprovalBinding)
    || !same(admission.creatorAuthority, current.creatorAuthority)
    || !same(admission.approval, current.approval)) return false;
  const runtime = objectOf(current.runtime);
  if (runtime?.state !== "READY") return false;
  const qualifiedAt = typeof runtime.qualifiedAt === "string" ? Date.parse(runtime.qualifiedAt) : Number.NaN;
  const expiresAt = typeof runtime.expiresAt === "string" ? Date.parse(runtime.expiresAt) : Number.NaN;
  return Number.isFinite(qualifiedAt) && Number.isFinite(expiresAt) && qualifiedAt <= current.now && expiresAt > current.now;
}

function same(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
