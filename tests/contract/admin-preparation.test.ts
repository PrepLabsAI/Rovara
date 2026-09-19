import { randomUUID } from "node:crypto";
import type { ProjectDefinition } from "@agentx/contracts";
import {
  InMemoryProjectRegistry,
  InMemoryRegistry,
  PreparationCoordinator,
  RepositoryGrantService,
  type AuthenticatedIdentity,
} from "../../packages/broker/src/index.js";
import { describe, expect, it } from "vitest";

const administrator = identity("a".repeat(64), true);
const memberships = [
  { ownerKey: administrator.ownerKey, project: "payments", role: "administrator" as const },
];

describe("administrator project registration", () => {
  it("registers immutable scoped revisions and never accepts embedded credentials", () => {
    const projects = new InMemoryProjectRegistry();
    const definition = projectDefinition();

    expect(projects.register(administrator, definition, memberships).duplicate).toBe(false);
    expect(projects.register(administrator, definition, memberships).duplicate).toBe(true);
    expect(() =>
      projects.register(administrator, { ...definition, orchestratorInstructions: "changed" }, memberships),
    ).toThrow(/immutable/i);
    expect(() =>
      projects.register(
        administrator,
        {
          ...definition,
          revision: 2,
          repositories: [
            { ...definition.repositories[0]!, url: "https://user:secret@example.test/payments.git" },
          ],
        },
        memberships,
      ),
    ).toThrow(/credentials/i);
    expect(() => projects.register(identity("b".repeat(64), false), definition, memberships)).toThrow(
      /administrator/i,
    );
  });
});

describe("workspace preparation coordination", () => {
  it("allocates an owner-isolated workspace and issues only operation-scoped repository access", async () => {
    const projects = new InMemoryProjectRegistry();
    const definition = projectDefinition();
    projects.register(administrator, definition, memberships);
    const registry = new InMemoryRegistry();
    const grants = new RepositoryGrantService(Buffer.alloc(32, 7), async (reference) => ({
      token: `resolved-${reference}`,
    }));
    const coordinator = new PreparationCoordinator({
      projects,
      registry,
      memberships,
      repositoryGrants: grants,
      allocateRuntime: async () => ({
        runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
        endpointQualifier: "DEFAULT",
        runtimeSessionId: randomUUID(),
        deploymentMode: "instances-ebs",
        capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx",
      }),
      createCallbackCapability: () => "c".repeat(64),
    });
    const targetOwnerKey = "d".repeat(64);
    const requestId = randomUUID();

    const dispatch = await coordinator.prepare(administrator, {
      requestId,
      projectName: "payments",
      projectRevision: 1,
      targetOwnerKey,
    });
    const duplicate = await coordinator.prepare(administrator, {
      requestId,
      projectName: "payments",
      projectRevision: 1,
      targetOwnerKey,
    });

    expect(dispatch.alreadyReady).toBe(false);
    expect(duplicate.operationId).toBe(dispatch.operationId);
    expect(dispatch.workspace.ownerKey).toBe(targetOwnerKey);
    expect(dispatch.workspace.deploymentMode).toBe("instances-ebs");
    expect(dispatch.invocation?.kind).toBe("prepare");
    if (dispatch.invocation?.kind !== "prepare") throw new Error("missing prepare invocation");
    const grant = dispatch.invocation.payload.repositoryGrant;
    await expect(
      grants.exchange(grant, {
        workspaceId: dispatch.workspace.id,
        operationId: dispatch.operationId,
        credentialRef: "payments-readwrite",
        repositoryUrl: "https://git.example.test/payments.git",
        access: "clone",
      }),
    ).resolves.toEqual({ token: "resolved-payments-readwrite" });
    await expect(
      grants.exchange(grant, {
        workspaceId: randomUUID(),
        operationId: dispatch.operationId,
        credentialRef: "payments-readwrite",
        repositoryUrl: "https://git.example.test/payments.git",
        access: "clone",
      }),
    ).rejects.toThrow(/does not cover/i);
    await expect(
      grants.exchange(grant, {
        workspaceId: dispatch.workspace.id,
        operationId: dispatch.operationId,
        credentialRef: "payments-readwrite",
        repositoryUrl: "https://git.example.test/another-repository.git",
        access: "clone",
      }),
    ).rejects.toThrow(/does not cover/i);
    await expect(
      grants.exchange(grant, {
        workspaceId: dispatch.workspace.id,
        operationId: dispatch.operationId,
        credentialRef: "payments-readwrite",
        repositoryUrl: "https://git.example.test/payments.git",
        access: "push",
      }),
    ).rejects.toThrow(/does not cover/i);

    const ready = await coordinator.recordResult({
      operationId: dispatch.operationId,
      workspaceId: dispatch.workspace.id,
      fence: dispatch.workspace.fence,
      succeeded: true,
      manifestPath: ".agentx/preparation-manifest.json",
    });
    expect(ready.status).toBe("READY");
    const retry = await coordinator.prepare(administrator, {
      requestId: randomUUID(),
      projectName: "payments",
      projectRevision: 1,
      targetOwnerKey,
    });
    expect(retry.alreadyReady).toBe(true);
    expect(retry.invocation).toBeUndefined();
  });
});

function identity(ownerKey: string, isAdministrator: boolean): AuthenticatedIdentity {
  return {
    issuer: "https://identity.example.test",
    subject: ownerKey,
    ownerKey,
    isAdministrator,
    claims: {},
  };
}

function projectDefinition(): ProjectDefinition {
  return {
    schemaVersion: 2,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: {
      issuer: "https://identity.example.test",
      clientId: "agentx",
      audience: "agentx-api",
    },
    environment: {
      image: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx@sha256:${"a".repeat(64)}`,
    },
    repositories: [
      {
        name: "payments",
        url: "https://git.example.test/payments.git",
        path: "repo/payments",
        defaultBranch: "main",
        credentialRef: "payments-readwrite",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding to the remote worker.",
  };
}
