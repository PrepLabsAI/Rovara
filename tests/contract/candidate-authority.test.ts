import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeCandidatePublication, validateCandidateBinding } from "../../packages/broker/src/candidate-bindings.js";

export function candidateFixture() {
  const operationId = randomUUID();
  return { schemaVersion: 1 as const, candidateId: operationId, operationId, workspaceId: randomUUID(), projectRevision: 1,
    jobId: randomUUID(), attempt: 1, repository: "demo", repositoryUrl: "https://github.com/example/demo.git", baseCommit: "a".repeat(40), commit: "b".repeat(40), tree: "c".repeat(40),
    createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), producer: "agentx-worker" as const, qualification: "claimed" as const,
    retrieval: { kind: "agentx-artifacts" as const, format: "git-bundle" as const, sha256: "d".repeat(64), sizeBytes: 1, chunks: [{ artifactId: randomUUID(), name: `candidate-${operationId}-0000.bundle.base64`, sha256: "d".repeat(64), sizeBytes: 1 }] } };
}
describe("candidate authority boundary", () => {
  it("requires every job, operation, repository and base binding", () => {
    const candidate = candidateFixture();
    const expected = { jobId: candidate.jobId, attempt: 1, operationId: candidate.operationId, workspaceId: candidate.workspaceId, projectRevision: 1, repository: "demo", repositoryUrl: candidate.repositoryUrl, baseCommit: candidate.baseCommit };
    expect(validateCandidateBinding(candidate, expected)).toEqual(candidate);
    for (const change of [{ jobId: randomUUID() }, { baseCommit: "e".repeat(40) }, { repositoryUrl: "https://github.com/other/repo.git" }, { workspaceId: randomUUID() }, { attempt: 2 }]) {
      expect(() => validateCandidateBinding({ ...candidate, ...change }, expected)).toThrow();
    }
  });
  it("authenticates the named actor and exact candidate, action, target and expiry", () => {
    const candidate = candidateFixture();
    const grant = { actor: "alice", jobId: candidate.jobId, candidateId: candidate.candidateId, commit: candidate.commit, action: "create-pull-request", repository: "demo", baseBranch: "main", evidencePacketRef: "sha256:qualified-evidence-reference", expiresAt: new Date(Date.now() + 30000).toISOString() };
    expect(authorizeCandidatePublication(candidate, grant, "alice", "main")).toEqual(grant);
    for (const change of [{ actor: "mallory" }, { commit: "a".repeat(40) }, { action: "merge" }, { baseBranch: "other" }, { expiresAt: "2000-01-01T00:00:00Z" }]) {
      expect(() => authorizeCandidatePublication(candidate, { ...grant, ...change }, "alice", "main")).toThrow();
    }
  });
});
