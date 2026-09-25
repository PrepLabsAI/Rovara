import { describe, expect, it } from "vitest";
import {
  OperationRequestSchema,
  PullRequestRequestSchema,
  PullRequestResultSchema,
  PullRequestLifecycleRequestSchema,
  PullRequestLifecycleResultSchema,
  ProjectDefinitionSchema,
  StoredProjectDefinitionSchema,
  WorkerInvocationSchema,
  legacyProjectFields,
  WorkspaceInstanceSchema,
} from "../../packages/contracts/src/index.js";

const digest = `registry.example.com/payments@sha256:${"a".repeat(64)}`;
function projectDefinition() {
  return {
    name: "payments",
    revision: 1,
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

  it("rejects the retired connection and environment fields, and names them for a caller", () => {
    const legacy = {
      ...projectDefinition(),
      schemaVersion: 2,
      controlPlaneUrl: "https://agentx.example.test",
      auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
      environment: { image: digest },
    };
    expect(() => ProjectDefinitionSchema.parse(legacy)).toThrow();
    expect(legacyProjectFields(legacy)).toEqual([
      "schemaVersion",
      "controlPlaneUrl",
      "auth",
      "environment",
    ]);
    expect(legacyProjectFields(projectDefinition())).toEqual([]);

    // A definition registered before the removal still loads, without those fields.
    const stored = StoredProjectDefinitionSchema.parse(legacy);
    expect(stored).toEqual(projectDefinition());
  });

  it("StoredProjectDefinitionSchema passes through a connector of an unknown type and keeps a github connector validated; registration still refuses it", () => {
    const withLinear = {
      ...projectDefinition(),
      integrations: {
        connectors: [
          { name: "gh", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
          { name: "tracker", type: "future-vendor", credentialRef: "future-vendor-key", scopes: ["payments"] },
        ],
      },
    };
    const stored = StoredProjectDefinitionSchema.parse(withLinear);
    expect(stored.integrations?.connectors).toEqual(withLinear.integrations.connectors);
    expect(() => ProjectDefinitionSchema.parse(withLinear)).toThrow();

    // A malformed github connector still fails; it never passes through as an unknown type.
    const malformedGithub = {
      ...projectDefinition(),
      integrations: {
        connectors: [
          { name: "gh", type: "github", scopes: 5, tools: [{ name: "list_issues", access: "read" }] },
        ],
      },
    };
    expect(() => StoredProjectDefinitionSchema.parse(malformedGithub)).toThrow();
  });

  it("accepts a prepare invocation whose stored project has a connector of an unknown type", () => {
    const invocation = WorkerInvocationSchema.parse({
      protocolVersion: 1,
      kind: "prepare",
      operationId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      fence: 1,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        project: {
          ...projectDefinition(),
          integrations: {
            connectors: [
              { name: "tracker", type: "future-vendor", credentialRef: "future-vendor-key", scopes: ["payments"] },
            ],
          },
        },
        repositoryGrant: "signed-grant",
      },
    });
    if (invocation.kind !== "prepare") throw new Error("expected a prepare invocation");
    expect(invocation.payload.project.integrations?.connectors).toEqual([
      { name: "tracker", type: "future-vendor", credentialRef: "future-vendor-key", scopes: ["payments"] },
    ]);
  });

  it("drops the environment pin from a workspace record written before it was removed", () => {
    const now = new Date().toISOString();
    const workspace = WorkspaceInstanceSchema.parse({
      id: crypto.randomUUID(),
      ownerKey: "a".repeat(64),
      projectName: "payments",
      projectRevision: 1,
      environmentDigest: digest,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: crypto.randomUUID(),
      deploymentMode: "demo-microvm",
      rootPath: "/mnt/workspace",
      status: "READY",
      fence: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(workspace).not.toHaveProperty("environmentDigest");
    expect(workspace.projectRevision).toBe(1);
  });

  it("accepts a worker invocation from a broker that still sends the retired fields", () => {
    // The release deploys the runtime before the control plane, so a new worker briefly receives
    // definitions from the old broker.
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
        project: {
          ...projectDefinition(),
          schemaVersion: 2,
          controlPlaneUrl: "https://agentx.example.test",
          auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
          environment: { image: digest },
        },
        repository: "api",
        title: "Publish API change",
        headBranch: `agentx/${operationId}`,
        repositoryGrant: "signed-grant",
      },
    });
    expect(invocation.payload).toMatchObject({ project: projectDefinition() });
  });

  it("accepts optional CodeBuild gates and rejects unsafe or duplicate projects", () => {
    const project = projectDefinition();
    project.repositories[0] = {
      ...project.repositories[0]!,
      codeBuildGates: [
        { name: "quality", projectName: "agentx-payments-quality", timeoutMinutes: 30 },
        { name: "browser", projectName: "agentx-payments-browser", timeoutMinutes: 45 },
      ],
    } as typeof project.repositories[number];
    expect(ProjectDefinitionSchema.parse(project).repositories[0]!.codeBuildGates).toHaveLength(2);

    const duplicate = structuredClone(project) as unknown as Record<string, unknown>;
    const repositories = duplicate.repositories as Array<Record<string, unknown>>;
    const gates = repositories[0]!.codeBuildGates as Array<Record<string, unknown>>;
    gates[1]!.projectName = gates[0]!.projectName;
    expect(() => ProjectDefinitionSchema.parse(duplicate)).toThrow(/unique/i);

    const unsafe = structuredClone(project) as unknown as Record<string, unknown>;
    const unsafeRepositories = unsafe.repositories as Array<Record<string, unknown>>;
    const unsafeGates = unsafeRepositories[0]!.codeBuildGates as Array<Record<string, unknown>>;
    unsafeGates[0]!.projectName = "unmanaged-project";
    expect(() => ProjectDefinitionSchema.parse(unsafe)).toThrow(/agentx-/i);
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
      codeBuildChecks: [{
        gate: "quality",
        projectName: "agentx-payments-quality",
        buildId: `agentx-payments-quality:${crypto.randomUUID()}`,
        status: "SUCCEEDED",
        requestedSourceVersion: "a".repeat(40),
        resolvedSourceVersion: "a".repeat(40),
        currentPhase: "COMPLETED",
        logsUrl: "https://console.aws.amazon.com/codesuite/codebuild/projects/agentx-payments-quality",
      }],
      reconciled: false,
    }).number).toBe(42);
  });

  it("validates conditional pull request lifecycle requests and maintain invocations", () => {
    const base = {
      requestId: crypto.randomUUID(),
      repository: "api",
      pullRequestNumber: 42,
    };
    expect(PullRequestLifecycleRequestSchema.parse({ ...base, action: "append" }).action).toBe("append");
    expect(PullRequestLifecycleRequestSchema.parse({
      ...base,
      action: "edit",
      title: "Updated title",
    }).title).toBe("Updated title");
    expect(() => PullRequestLifecycleRequestSchema.parse({ ...base, action: "edit" })).toThrow(
      /title or body/,
    );
    expect(() => PullRequestLifecycleRequestSchema.parse({
      ...base,
      action: "close",
      title: "not allowed",
    })).toThrow(/must not include/);

    const invocation = WorkerInvocationSchema.parse({
      protocolVersion: 1,
      kind: "maintain",
      operationId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      fence: 3,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        action: "sync",
        project: projectDefinition(),
        repository: "api",
        pullRequestNumber: 42,
        headBranch: `agentx/${crypto.randomUUID()}`,
        baseBranch: "main",
        expectedHeadCommit: "a".repeat(40),
        repositoryGrant: "signed-grant",
      },
    });
    expect(invocation.kind).toBe("maintain");

    expect(PullRequestLifecycleResultSchema.parse({
      action: "sync",
      repository: "api",
      number: 42,
      url: "https://github.com/example/api/pull/42",
      state: "open",
      headBranch: `agentx/${crypto.randomUUID()}`,
      baseBranch: "main",
      previousCommit: "a".repeat(40),
      commit: "b".repeat(40),
      checks: [],
      reconciled: false,
    }).number).toBe(42);

    const publish = {
      protocolVersion: 1,
      kind: "publish",
      operationId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      fence: 2,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        project: projectDefinition(),
        repository: "api",
        title: "Lifecycle",
        headBranch: `agentx/${crypto.randomUUID()}`,
        repositoryGrant: "signed-grant",
      },
    };
    expect(WorkerInvocationSchema.safeParse({
      ...publish,
      payload: { ...publish.payload, mode: "replace" },
    }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({
      ...publish,
      payload: { ...publish.payload, mode: "revert", targetPullRequestNumber: 3 },
    }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({
      ...publish,
      payload: { ...publish.payload, mode: "create", revertCommit: "a".repeat(40) },
    }).success).toBe(false);
  });
});
