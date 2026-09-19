import { describe, expect, it } from "vitest";
import {
  OperationRequestSchema,
  PullRequestRequestSchema,
  PullRequestResultSchema,
  ProjectDefinitionSchema,
  WorkerInvocationSchema,
  WorkspaceInstanceSchema,
} from "../../packages/contracts/src/index.js";

const digest = `registry.example.com/payments@sha256:${"a".repeat(64)}`;
function projectDefinition() {
  return {
    schemaVersion: 2,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.com",
    auth: {
      issuer: "https://identity.example.com",
      clientId: "agentx-cli",
      audience: "agentx",
    },
    environment: { image: digest },
    repositories: [
      {
        name: "api",
        url: "https://git.example.com/team/api.git",
        path: "services/api",
        defaultBranch: "main",
        credentialRef: "payments-read",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding remotely.",
  };
}

describe("strict contracts", () => {
  it("accepts a valid versioned project", () => {
    expect(ProjectDefinitionSchema.parse(projectDefinition()).name).toBe("payments");
  });

  it("requires a safe default branch and rejects the retired initialCommit field", () => {
    const invalidBranch = projectDefinition();
    invalidBranch.repositories[0]!.defaultBranch = "../main";
    expect(() => ProjectDefinitionSchema.parse(invalidBranch)).toThrow(/defaultBranch/);

    const retired = projectDefinition() as ReturnType<typeof projectDefinition> & {
      repositories: Array<ReturnType<typeof projectDefinition>["repositories"][number] & {
        initialCommit?: string;
      }>;
    };
    retired.repositories[0]!.initialCommit = "b".repeat(40);
    expect(() => ProjectDefinitionSchema.parse(retired)).toThrow();
  });

  it("rejects secrets, routing IDs and overlapping repository paths", () => {
    expect(() =>
      ProjectDefinitionSchema.parse({ ...projectDefinition(), runtimeSessionId: "attacker" }),
    ).toThrow();

    const project = projectDefinition();
    project.repositories.push({
      ...project.repositories[0],
      name: "nested",
      path: "services/api/nested",
    });
    expect(() => ProjectDefinitionSchema.parse(project)).toThrow(/overlap/);
  });

  it("rejects unsupported states and unknown workspace keys", () => {
    expect(() =>
      WorkspaceInstanceSchema.parse({
        id: crypto.randomUUID(),
        ownerKey: "owner",
        projectName: "payments",
        projectRevision: 1,
        environmentDigest: digest,
        runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agentx",
        endpointQualifier: "DEFAULT",
        runtimeSessionId: crypto.randomUUID(),
        deploymentMode: "instances-ebs",
        capacityProviderArn:
          "arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/agentx",
        rootPath: "/mnt/workspace",
        status: "MAGIC",
        activeOperationId: null,
        fence: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        extra: true,
      }),
    ).toThrow();
  });

  it("requires mode-appropriate private storage bindings", () => {
    const base = {
      id: crypto.randomUUID(),
      ownerKey: "a".repeat(64),
      projectName: "payments",
      projectRevision: 1,
      environmentDigest: digest,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: crypto.randomUUID(),
      rootPath: "/mnt/workspace",
      status: "READY",
      activeOperationId: null,
      fence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(
      WorkspaceInstanceSchema.parse({ ...base, deploymentMode: "demo-microvm" }),
    ).not.toHaveProperty("capacityProviderArn");
    const withoutActiveOperation = Object.fromEntries(
      Object.entries(base).filter(([key]) => key !== "activeOperationId"),
    );
    expect(
      WorkspaceInstanceSchema.parse({ ...withoutActiveOperation, deploymentMode: "demo-microvm" }),
    ).toHaveProperty("activeOperationId", null);
    expect(() =>
      WorkspaceInstanceSchema.parse({ ...base, deploymentMode: "instances-ebs" }),
    ).toThrow(/capacity provider/i);
    expect(() =>
      WorkspaceInstanceSchema.parse({
        ...base,
        deploymentMode: "demo-microvm",
        capacityProviderArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/agentx",
      }),
    ).toThrow(/must not have/i);
  });

  it("limits prompts by UTF-8 bytes and rejects unknown operation fields", () => {
    const base = {
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      prompt: "change the fixture",
    };
    expect(OperationRequestSchema.parse(base)).toEqual(base);
    expect(() => OperationRequestSchema.parse({ ...base, prompt: "🧑‍💻".repeat(20_000) })).toThrow(
      /65536 UTF-8 bytes/,
    );
    expect(() => OperationRequestSchema.parse({ ...base, ownerKey: "alice" })).toThrow();
  });

  it("validates publication requests, results, and worker invocations", () => {
    const request = {
      requestId: crypto.randomUUID(),
      repository: "api",
      title: "  Publish API change  ",
      body: "Validated locally.",
    };
    expect(PullRequestRequestSchema.parse(request).title).toBe("Publish API change");
    expect(() => PullRequestRequestSchema.parse({ ...request, title: "bad\ntitle" })).toThrow(
      /control characters/,
    );
    expect(() => PullRequestRequestSchema.parse({ ...request, body: "🧑‍💻".repeat(9_000) })).toThrow(
      /32768 UTF-8 bytes/,
    );

    const operationId = crypto.randomUUID();
    const invocation = WorkerInvocationSchema.parse({
      protocolVersion: 1,
      kind: "publish",
      operationId,
      workspaceId: crypto.randomUUID(),
      fence: 2,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        project: projectDefinition(),
        repository: "api",
        title: "Publish API change",
        headBranch: `agentx/${operationId}`,
        repositoryGrant: "signed-grant",
      },
    });
    expect(invocation.kind).toBe("publish");

    expect(PullRequestResultSchema.parse({
      repository: "api",
      number: 42,
      url: "https://github.com/example/api/pull/42",
      headBranch: `agentx/${operationId}`,
      baseBranch: "main",
      commit: "a".repeat(40),
      checks: [{
        index: 0,
        cwd: "services/api",
        executable: "npm",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        outcome: "passed",
      }],
      reconciled: false,
    }).number).toBe(42);
  });
});
