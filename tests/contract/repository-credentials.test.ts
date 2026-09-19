import { randomUUID } from "node:crypto";
import type { WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRepositoryCredentialProvider } from "../../packages/worker/src/repository-credentials.js";

describe("worker repository credential exchange", () => {
  it("exchanges the operation grant for the exact repository without logging it into the URL", async () => {
    const invocation: Extract<WorkerInvocation, { kind: "prepare" }> = {
      protocolVersion: 1,
      kind: "prepare",
      operationId: randomUUID(),
      workspaceId: randomUUID(),
      fence: 1,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        project: project(),
        repositoryGrant: "signed.repository-grant",
      },
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push({ url: requestUrl, init });
      return new Response(JSON.stringify({
        credential: { username: "x-access-token", password: "installation-token" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = createRepositoryCredentialProvider({
      controlPlaneUrl: "https://agentx.example.test/",
      invocation,
      fetchImplementation,
    });

    await expect(provider(invocation.payload.project.repositories[0]!)).resolves.toEqual({
      username: "x-access-token",
      password: "installation-token",
    });
    expect(requests[0]?.url).toBe(
      `https://agentx.example.test/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/repository-credentials`,
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("x-agentx-repository-grant")).toBe(
      "signed.repository-grant",
    );
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      credentialRef: "github-agentx-sdlc",
      repositoryUrl: "https://github.com/ps06756/personal-website-test.git",
      access: "clone",
    }));
  });

  it("does not include a failed response body in its error", async () => {
    const invocation = {
      protocolVersion: 1,
      kind: "prepare",
      operationId: randomUUID(),
      workspaceId: randomUUID(),
      fence: 1,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: { project: project(), repositoryGrant: "grant" },
    } as const satisfies Extract<WorkerInvocation, { kind: "prepare" }>;
    const provider = createRepositoryCredentialProvider({
      controlPlaneUrl: "https://agentx.example.test",
      invocation,
      fetchImplementation: async () => new Response("secret-response-body", { status: 403 }),
    });

    await expect(provider(invocation.payload.project.repositories[0])).rejects.toThrow(/HTTP 403/);
    await expect(provider(invocation.payload.project.repositories[0])).rejects.not.toThrow(
      /secret-response-body/,
    );
  });

  it("requests exact push access for a publish invocation", async () => {
    const operationId = randomUUID();
    const invocation = {
      protocolVersion: 1,
      kind: "publish",
      operationId,
      workspaceId: randomUUID(),
      fence: 4,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        project: project(),
        repository: "personal-website",
        title: "Publish change",
        headBranch: `agentx/${operationId}`,
        repositoryGrant: "push-grant",
      },
    } as const satisfies Extract<WorkerInvocation, { kind: "publish" }>;
    const bodies: string[] = [];
    const provider = createRepositoryCredentialProvider({
      controlPlaneUrl: "https://agentx.example.test",
      invocation,
      fetchImplementation: async (_url, init) => {
        if (typeof init?.body !== "string") throw new Error("expected JSON request body");
        bodies.push(init.body);
        return new Response(JSON.stringify({ credential: { token: "push-token" } }), { status: 200 });
      },
    });

    await provider(invocation.payload.project.repositories[0]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ access: "push" });
  });
});

function project() {
  return {
    schemaVersion: 2,
    name: "personal-website",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: {
      issuer: "https://identity.example.test",
      clientId: "agentx",
      audience: "agentx",
    },
    environment: {
      image: `registry.example.test/agentx@sha256:${"a".repeat(64)}`,
    },
    repositories: [{
      name: "personal-website",
      url: "https://github.com/ps06756/personal-website-test.git",
      path: "repo/personal-website",
      defaultBranch: "main",
      credentialRef: "github-agentx-sdlc",
    }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate work to the remote agent.",
  } as const;
}
