import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectDefinition } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

describe("AgentX administration workflow", () => {
  it("stops a workspace through the administrator route", async () => {
    const context = await administratorContext("agentx-cli-stop-");
    const workspaceId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(requestUrl(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
      expect(url.pathname).toBe(`/v1/admin/workspaces/${workspaceId}/stop`);
      return Response.json({ workspace: { id: workspaceId, status: "STOPPED" } }, { status: 202 });
    });
    let output = "";

    const exitCode = await executeCli([
      ...context.globals,
      "--json",
      "admin", "workspace", "stop",
      "--workspace", workspaceId,
    ], {
      fetchImplementation,
      tokenStore: context.tokens,
      stdout: { write(text) { output += text; } },
      stderr: { write(text) { throw new Error(text); } },
    });

    expect(exitCode).toBe(0);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      data: { workspace: { id: workspaceId, status: "STOPPED" } },
    });
  });

  it("binds a Slack channel to the selected project", async () => {
    const context = await administratorContext("agentx-cli-bind-");
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(requestUrl(input));
      expect(url.pathname).toBe("/v1/admin/slack/bindings/T0123456789/C0123456789");
      expect(init?.method).toBe("PUT");
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      // A binding names the project; a new thread picks up its latest registered revision.
      expect(JSON.parse(init.body)).toEqual({ projectName: "payments" });
      return Response.json({ binding: { teamId: "T0123456789", channelId: "C0123456789" } });
    });
    let output = "";

    const exitCode = await executeCli([
      ...context.globals,
      "--json",
      "admin", "slack", "bind",
      "--team", "T0123456789",
      "--channel", "C0123456789",
    ], {
      fetchImplementation,
      tokenStore: context.tokens,
      stdout: { write(text) { output += text; } },
      stderr: { write(text) { throw new Error(text); } },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { binding: { channelId: "C0123456789" } } });
  });

  it("refuses the retired developer commands without calling the control plane", async () => {
    const context = await administratorContext("agentx-cli-retired-");
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error("the retired commands must not reach the control plane");
    });

    for (const retired of [["status"], ["conversation", "new"], ["pr", "create"], ["cancel"], ["slack", "logout"]]) {
      const errors: string[] = [];
      const exitCode = await executeCli([...context.globals, ...retired], {
        fetchImplementation,
        tokenStore: context.tokens,
        stdout: { write() {} },
        stderr: { write(text: string) { errors.push(text); } },
      });
      expect(exitCode, `${retired.join(" ")} must fail`).not.toBe(0);
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

async function administratorContext(prefix: string): Promise<{
  globals: string[];
  tokens: InMemoryTokenStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const definition = projectDefinition();
  await writeFile(join(directory, "payments.yaml"), JSON.stringify(definition), "utf8");
  const tokens = new InMemoryTokenStore();
  await tokens.set(tokenStoreKey({
    issuer: definition.auth.issuer,
    clientId: definition.auth.clientId,
    audience: definition.auth.audience,
  }), { accessToken: "access-secret", expiresAt: Date.now() + 60_000 });
  return {
    tokens,
    globals: ["--project", "payments", "--config-dir", directory, "--allow-loopback"],
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function projectDefinition(): ProjectDefinition {
  return {
    schemaVersion: 2,
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
      defaultBranch: "main",
      credentialRef: "payments-readwrite",
    }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding to the remote worker.",
  };
}
