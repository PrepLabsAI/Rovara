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

  it("admin workspace cancel keeps WORKSPACE_BUSY and its try-again message when the cancel raced its task (final review I2)", async () => {
    const context = await administratorContext("agentx-cli-cancel-");
    const workspaceId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json(
      { error: { code: "WORKSPACE_BUSY", message: "the workspace changed while the cancel was being recorded; try again" } },
      { status: 409 },
    ));
    let errors = "";
    const exitCode = await executeCli([...context.globals, "admin", "workspace", "cancel", "--workspace", workspaceId], {
      fetchImplementation,
      tokenStore: context.tokens,
      stdout: { write(text) { throw new Error(text); } },
      stderr: { write(text) { errors += text; } },
    });
    expect(exitCode).toBe(5);
    expect(errors).toContain("AgentX error [WORKSPACE_BUSY]");
    expect(errors).toContain("try again");
  });

  it("admin workspace cancel reports nothing running when the task finished first (final review I2)", async () => {
    const context = await administratorContext("agentx-cli-cancel-");
    const workspaceId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ outcome: "NOTHING_RUNNING", workspaceId }, { status: 202 }));
    let output = "";
    const exitCode = await executeCli([...context.globals, "--json", "admin", "workspace", "cancel", "--workspace", workspaceId], {
      fetchImplementation,
      tokenStore: context.tokens,
      stdout: { write(text) { output += text; } },
      stderr: { write(text) { throw new Error(text); } },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({ ok: true, data: { outcome: "NOTHING_RUNNING", workspaceId } });
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

  it("reads its connection settings from the deployment file, not from a project file", async () => {
    const context = await administratorContext("agentx-cli-login-");
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error("login must not reach the network before its settings load");
    });
    // No --project, and a deployment file that does not exist: the error names the settings the
    // command actually needs, proving nothing is read from a project file any more.
    const globals = context.globals.filter((value, index, values) =>
      value !== "--project" && values[index - 1] !== "--project"
      && value !== "--deployment-file" && values[index - 1] !== "--deployment-file");
    const errors: string[] = [];

    const exitCode = await executeCli([
      ...globals,
      "--deployment-file", join(context.directory, "absent.yaml"),
      "login",
    ], {
      fetchImplementation,
      tokenStore: context.tokens,
      stdout: { write() {} },
      stderr: { write(text: string) { errors.push(text); } },
    });

    expect(exitCode).toBe(2);
    expect(errors.join("")).toMatch(/deployment settings are not configured/);
    expect(fetchImplementation).not.toHaveBeenCalled();
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

const deployment = {
  controlPlaneUrl: "http://127.0.0.1:8787",
  auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" },
};

async function administratorContext(prefix: string): Promise<{
  globals: string[];
  directory: string;
  tokens: InMemoryTokenStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  // One deployment file serves every project; the project file holds the definition alone.
  const deploymentFile = join(directory, "deployment.yaml");
  await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
  await writeFile(join(directory, "payments.yaml"), JSON.stringify(projectDefinition()), "utf8");
  const tokens = new InMemoryTokenStore();
  await tokens.set(tokenStoreKey(deployment.auth), {
    accessToken: "access-secret",
    expiresAt: Date.now() + 60_000,
  });
  return {
    tokens,
    directory,
    globals: [
      "--project", "payments",
      "--config-dir", directory,
      "--deployment-file", deploymentFile,
      "--allow-loopback",
    ],
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function projectDefinition(): ProjectDefinition {
  return {
    name: "payments",
    revision: 1,
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
