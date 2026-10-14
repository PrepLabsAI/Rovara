import { describe, expect, it } from "vitest";
import {
  workflowPublicationContext,
  workflowPublicationContextDigest,
  type WorkerInvocation,
  type WorkflowPublicationContextV1,
} from "@agentx/contracts";

const sha = (character: string) => character.repeat(40);

function publishInvocation(): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "publish",
    operationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    fence: 7,
    projectRevision: 3,
    callbackCapability: "synthetic-capability",
    payload: {
      mode: "create",
      project: { repositories: [{ name: "demo", url: "https://example.test/org/demo.git", path: "repo/demo", defaultBranch: "main" }] },
      repository: "demo",
      title: "Add greeting",
      headBranch: "agentx/11111111-1111-4111-8111-111111111111",
      repositoryGrant: "synthetic-grant",
      publicationMode: "CHECKED_TREE",
      candidateTreeSha: sha("a"),
      workflowBaseCommit: sha("b"),
    },
  } as unknown as WorkerInvocation;
}

describe("workflow publication context", () => {
  it("binds the exact candidate, repository destination, operation and mode", () => {
    const invocation = publishInvocation();
    const context = workflowPublicationContext(invocation);
    expect(context).toMatchObject({
      schemaVersion: "workflow-publication-context/v1",
      workspaceId: invocation.workspaceId,
      operationId: invocation.operationId,
      fence: invocation.fence,
      projectRevision: invocation.projectRevision,
      publicationMode: "CHECKED_TREE",
      repository: "demo",
      repositoryUrl: "https://example.test/org/demo.git",
      repositoryPath: "repo/demo",
      defaultBranch: "main",
      headBranch: invocation.payload.headBranch,
      candidateTreeSha: sha("a"),
      candidateCommitSha: null,
      workflowBaseCommit: sha("b"),
    });
    expect(workflowPublicationContextDigest(context!)).toMatch(/^[a-f0-9]{64}$/u);
    expect(workflowPublicationContext({ ...invocation, kind: "task" } as WorkerInvocation)).toBeUndefined();
  });

  it("changes the digest for every signed publication selector", () => {
    const base = workflowPublicationContext(publishInvocation())!;
    const changes: Array<Partial<WorkflowPublicationContextV1>> = [
      { workspaceId: "33333333-3333-4333-8333-333333333333" },
      { operationId: "44444444-4444-4444-8444-444444444444" },
      { fence: base.fence + 1 },
      { projectRevision: base.projectRevision + 1 },
      { publicationMode: "COMMITTED_HEAD", candidateCommitSha: sha("c") },
      { repository: "other" },
      { repositoryUrl: "https://example.test/other/repo.git" },
      { repositoryPath: "repo/other" },
      { defaultBranch: "trunk" },
      { headBranch: "agentx/other" },
      { candidateTreeSha: sha("d") },
      { workflowBaseCommit: sha("e") },
    ];
    for (const change of changes) {
      expect(workflowPublicationContextDigest({ ...base, ...change })).not.toBe(workflowPublicationContextDigest(base));
    }
  });

  it("rejects partial workflow bindings instead of treating them as ordinary publish", () => {
    const invocation = publishInvocation();
    const payload = { ...invocation.payload, publicationMode: undefined };
    expect(() => workflowPublicationContext({ ...invocation, payload } as WorkerInvocation)).toThrow(/incomplete/u);
  });
});
