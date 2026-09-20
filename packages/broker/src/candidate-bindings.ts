import {
  CandidatePublicationAuthorizationSchema,
  CandidateResultSchema,
  agentXError,
  type CandidateResult,
} from "@agentx/contracts";

export type ExpectedCandidateBinding = Pick<CandidateResult,
  "jobId" | "attempt" | "operationId" | "workspaceId" | "projectRevision" |
  "repository" | "repositoryUrl" | "baseCommit">;

/** Check worker claims against the broker's stored job, not caller-supplied expectations. */
export function validateCandidateBinding(value: unknown, expected: ExpectedCandidateBinding): CandidateResult {
  const candidate = CandidateResultSchema.parse(value);
  const keys: (keyof ExpectedCandidateBinding)[] = ["jobId", "attempt", "operationId", "workspaceId",
    "projectRevision", "repository", "repositoryUrl", "baseCommit"];
  if (keys.some((key) => candidate[key] !== expected[key])) {
    throw agentXError("FORBIDDEN", "candidate does not match the stored job");
  }
  return candidate;
}

/**
 * Binding check only. The caller must first load a stored candidate and obtain
 * the grant from the trusted approval service. This does not authenticate a
 * JSON grant, qualify evidence, or authorize publication by itself.
 */
export function authorizeCandidatePublication(
  value: unknown, grantValue: unknown, authenticatedActor: string, expectedBaseBranch: string,
) {
  const candidate = CandidateResultSchema.parse(value);
  const grant = CandidatePublicationAuthorizationSchema.parse(grantValue);
  const now = Date.now();
  if (grant.actor !== authenticatedActor || grant.jobId !== candidate.jobId ||
      grant.candidateId !== candidate.candidateId || grant.commit !== candidate.commit ||
      grant.repository !== candidate.repository || grant.baseBranch !== expectedBaseBranch ||
      Date.parse(grant.expiresAt) <= now || Date.parse(candidate.expiresAt) <= now ||
      Date.parse(candidate.createdAt) > now) {
    throw agentXError("FORBIDDEN", "publication grant does not match the current candidate");
  }
  return grant;
}
