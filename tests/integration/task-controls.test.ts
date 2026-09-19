import { randomUUID } from "node:crypto";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectDefinition } from "@agentx/contracts";
import {
  InMemoryProjectRegistry,
  InMemoryRegistry,
  LifecycleService,
  OperationStore,
  ResumeCoordinator,
  type AuthenticatedIdentity,
  type ProjectMembership,
} from "../../packages/broker/src/index.js";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { classifyFailure, createDiagnostic } from "../../packages/worker/src/diagnostics.js";
import { describe, expect, it, vi } from "vitest";

describe("task and lifecycle controls", () => {
  it("cooperatively aborts pi and terminates a real child process group without rolling back files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cancel-"));
    const marker = join(directory, "should-not-exist.txt");
    const controller = new WorkerCancellationController();
    const operationId = randomUUID();
    const abort = vi.fn(async () => undefined);
    controller.register(operationId, { abort });
    controller.spawnTracked(
      operationId,
      process.execPath,
      ["-e", `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),3000)`],
      { cwd: directory },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = await controller.cancel(operationId, 250);

    expect(abort).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects two writers in one workspace while independent owners proceed", async () => {
    const registry = new InMemoryRegistry();
    const alice = "a".repeat(64);
    const bob = "b".repeat(64);
    const aliceWorkspace = await registry.createDefault(workspace(alice));
    const bobWorkspace = await registry.createDefault(workspace(bob));
    const operations = new OperationStore(registry);
    await operations.acceptTask(aliceWorkspace.id, alice, request("alice first"));
    await expect(operations.acceptTask(aliceWorkspace.id, alice, request("alice overlap"))).rejects.toThrow(
      /busy/i,
    );
    await expect(operations.acceptTask(bobWorkspace.id, bob, request("bob independent"))).resolves.toMatchObject({
      duplicate: false,
    });
  });

  it("stops only idle compute and resumes the workspace's pinned revision after a newer registration", async () => {
    const registry = new InMemoryRegistry();
    const admin = identity("c".repeat(64), true);
    const developer = identity("d".repeat(64), false);
    const memberships: ProjectMembership[] = [
      { ownerKey: admin.ownerKey, project: "payments", role: "administrator" },
      { ownerKey: developer.ownerKey, project: "payments", role: "developer" },
    ];
    const projects = new InMemoryProjectRegistry();
    projects.register(admin, project(1, "a"), memberships);
    projects.register(admin, project(2, "b"), memberships);
    const ready = await registry.createDefault(workspace(developer.ownerKey));
    const stopRuntimeSession = vi.fn(async () => undefined);
    const lifecycle = new LifecycleService({ registry, memberships, stopRuntimeSession });
    const stopped = await lifecycle.stop(admin, ready.id);
    expect(stopped.status).toBe("STOPPED");
    expect(stopRuntimeSession).toHaveBeenCalledWith({
      runtimeArn: ready.runtimeArn,
      runtimeSessionId: ready.runtimeSessionId,
    });

    const resume = new ResumeCoordinator({ registry, projects });
    const resuming = await resume.begin(developer, ready.id);
    expect(resuming.status).toBe("RESUMING");
    expect(resuming.projectRevision).toBe(1);
    expect(resuming.environmentDigest).toBe(project(1, "a").environment.image);
  });

  it("redacts structured diagnostics and classifies disk/auth/setup failures", () => {
    const diagnostic = createDiagnostic({
      level: "error",
      category: "authentication",
      correlationId: randomUUID(),
      message: "Authorization: Bearer top-secret",
      details: { token: "top-secret", url: "https://user:password@example.test/repo" },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("top-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("password@example");
    expect(classifyFailure(new Error("ENOSPC: no space left"))).toBe("disk");
    expect(classifyFailure(new Error("token expired"))).toBe("authentication");
    expect(classifyFailure(new Error("readiness setup failed"))).toBe("setup");
  });
});

function request(prompt: string) {
  return { requestId: randomUUID(), conversationId: randomUUID(), prompt };
}

function workspace(ownerKey: string) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ownerKey,
    projectName: "payments",
    projectRevision: 1,
    environmentDigest: project(1, "a").environment.image,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
    endpointQualifier: "DEFAULT",
    runtimeSessionId: randomUUID(),
    deploymentMode: "instances-ebs" as const,
    capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx",
    rootPath: "/mnt/workspace" as const,
    status: "READY" as const,
    preparationManifest: ".agentx/preparation-manifest.json",
    activeOperationId: null,
    fence: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function identity(ownerKey: string, isAdministrator: boolean): AuthenticatedIdentity {
  return {
    issuer: "https://identity.example.test",
    subject: ownerKey,
    ownerKey,
    isAdministrator,
    claims: {},
  };
}

function project(revision: number, digestCharacter: string): ProjectDefinition {
  return {
    schemaVersion: 1,
    name: "payments",
    revision,
    controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
    environment: { image: `registry.example.test/worker@sha256:${digestCharacter.repeat(64)}` },
    repositories: [
      {
        name: "app",
        url: "https://git.example.test/app.git",
        path: "repo/app",
        initialCommit: "1".repeat(40),
        credentialRef: "app-readwrite",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate remotely.",
  };
}
