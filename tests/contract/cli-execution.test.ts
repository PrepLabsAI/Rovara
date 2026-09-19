import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectDefinition } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

describe("AgentX executable workflow", () => {
  it("connects, creates local reconnect state, submits remotely and polls to completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-"));
    const definition = projectDefinition();
    await writeFile(join(directory, "payments.yaml"), JSON.stringify(definition), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey({
      issuer: definition.auth.issuer,
      clientId: definition.auth.clientId,
      audience: definition.auth.audience,
    }), { accessToken: "access-secret", expiresAt: Date.now() + 60_000 });
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const operationId = randomUUID();
    const requestId = randomUUID();
    const now = new Date().toISOString();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
      if (url.pathname === "/v1/projects/payments/workspace") {
        return Response.json({ workspace: {
          id: workspaceId,
          projectName: "payments",
          projectRevision: 1,
          deploymentMode: "demo-microvm",
          status: "READY",
          createdAt: now,
          updatedAt: now,
        } });
      }
      if (url.pathname.endsWith("/conversations")) {
        return Response.json({ conversation: { id: conversationId, workspaceId } });
      }
      if (url.pathname.endsWith("/tasks")) {
        if (typeof init?.body !== "string") throw new Error("expected JSON request body");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body).toMatchObject({ conversationId, prompt: "fix the fixture" });
        expect(body).not.toHaveProperty("runtimeSessionId");
        return Response.json({ operation: operation("ACCEPTED") }, { status: 202 });
      }
      if (url.pathname.endsWith("/events")) return Response.json({ events: [] });
      if (url.pathname.endsWith(`/operations/${operationId}`)) {
        return Response.json({ operation: operation("SUCCEEDED") });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    let output = "";
    const exitCode = await executeCli([
      "--project", "payments",
      "--config-dir", directory,
      "--state-dir", directory,
      "--allow-loopback",
      "--prompt", "fix the fixture",
      "--json",
    ], {
      fetchImplementation,
      tokenStore: tokens,
      stdout: { write(text) { output += text; } },
      stderr: { write(text) { throw new Error(text); } },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      data: { operation: { id: operationId, status: "SUCCEEDED" } },
    });

    function operation(status: "ACCEPTED" | "SUCCEEDED") {
      return {
        id: operationId,
        workspaceId,
        conversationId,
        kind: "task",
        requestId,
        payloadHash: "a".repeat(64),
        status,
        fence: 1,
        createdAt: now,
        updatedAt: now,
      };
    }
  });
});

function projectDefinition(): ProjectDefinition {
  return {
    schemaVersion: 1,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "http://127.0.0.1:8787",
    auth: {
      issuer: "https://identity.example.test",
      clientId: "agentx-client",
      audience: "agentx-api",
    },
    environment: {
      image: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx@sha256:${"a".repeat(64)}`,
    },
    repositories: [{
      name: "payments",
      url: "https://git.example.test/payments.git",
      path: "repo/payments",
      initialCommit: "1".repeat(40),
      credentialRef: "payments-readwrite",
    }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding to the remote worker.",
  };
}
