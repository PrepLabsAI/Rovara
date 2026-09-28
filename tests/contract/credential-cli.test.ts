import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectDefinition } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { listCredentials, registerCredential } from "../../packages/cli/src/admin/credential.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

describe("credential administration client", () => {
  it("posts a validated registration with the bearer token and returns the server's entry", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ credential: { ref: "linear" }, replaced: false }, { status: 201 }));
    const result = await registerCredential({ controlPlaneUrl: "https://agentx.example.test/", accessToken: "admin-token", ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" }, fetchImplementation);
    expect(result).toEqual({ credential: { ref: "linear" }, replaced: false });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://agentx.example.test/v1/admin/credentials");
    expect(init).toMatchObject({ method: "POST" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(JSON.parse(String(init?.body as string))).toEqual({ ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" });
  });

  it("refuses a bad secret name locally without calling the control plane", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "prod/db" }, fetchImplementation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("surfaces the server's error code and message", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFIG_INVALID", message: "credential linear: secret agentx/connectors/linear was not found" } }, { status: 400 }));
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }, fetchImplementation))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: credential linear: secret agentx/connectors/linear was not found" });
  });

  it("surfaces a clean HTTP status when the control plane returns a non-JSON error body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }, fetchImplementation))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: HTTP 502" });
  });

  it("classifies an unlabeled 4xx error as CONFIG_INVALID instead of always RUNTIME_UNAVAILABLE", async () => {
    // An HTTP API gateway's own default error shape: no { error: { code, message } } envelope.
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ message: "Bad Request" }, { status: 400 }));
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }, fetchImplementation))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: HTTP 400" });
  });

  it("lists credentials", async () => {
    const credentials = [{ ref: "github-app", type: "github-app", secretName: "arn", builtIn: true, tokenCached: false }];
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ credentials }));
    expect(await listCredentials({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t" }, fetchImplementation)).toEqual({ credentials });
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});

describe("project registration from the command line", () => {
  it("asks for preflight and writes each warning to stderr", async () => {
    const context = await administratorContext("agentx-cli-register-preflight-");
    const answer = { project: { definition: { name: "payments" } }, duplicate: false, warnings: ["w1"], preflight: { connectors: [] } };
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json(answer, { status: 201 }));
    const { exitCode, stdout, stderr } = await runRegister(context, fetchImplementation);
    expect(exitCode).toBe(0);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(new URL(url as string).pathname).toBe("/v1/admin/projects");
    expect(JSON.parse(String(init?.body as string))).toMatchObject({ preflight: true });
    expect(JSON.parse(stdout)).toEqual({ ok: true, data: answer });
    expect(stderr).toBe("Warning: w1\n");
  });

  it("says so when the control plane did not run preflight", async () => {
    const context = await administratorContext("agentx-cli-register-legacy-");
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ project: { definition: { name: "payments" } }, duplicate: false }, { status: 201 }));
    const { exitCode, stderr } = await runRegister(context, fetchImplementation);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Warning: this control plane did not check connectors at registration; deploy the latest AgentX release to get the preflight report.\n");
  });
});

describe("project registration without connectors", () => {
  it("does not mention connector checks when the definition has no integrations", async () => {
    const context = await administratorContext("agentx-cli-register-plain-");
    const plain = projectDefinition();
    delete plain.integrations;
    await writeFile(context.projectFile, JSON.stringify(plain), "utf8");
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ project: { definition: { name: "payments" } }, duplicate: false }, { status: 201 }));
    const { exitCode, stderr } = await runRegister(context, fetchImplementation);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("did not check connectors");
    expect(stderr).toBe("");
  });
});

describe("project registration errors", () => {
  it("surfaces the control plane's refusal so the administrator knows what to fix", async () => {
    const context = await administratorContext("agentx-cli-register-refused-");
    const message = "this project could expose 41 tools; at most 40 are allowed. Approve fewer connector tools.";
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFIG_INVALID", message } }, { status: 400 }));
    const { exitCode, stderr } = await runRegister(context, fetchImplementation);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`project registration failed with HTTP 400: ${message}`);
  });

  it("classifies an unlabeled server error by its HTTP status instead of always CONFIG_INVALID", async () => {
    const { exitCodeForError } = await import("../../packages/cli/src/output.js");
    const context = await administratorContext("agentx-cli-register-unlabeled-");
    // An HTTP API gateway's own default error shape: no { error: { code, message } } envelope.
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ message: "Service Unavailable" }, { status: 503 }));
    const { exitCode, stderr } = await runRegister(context, fetchImplementation);
    const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(parsed.error.message).toContain("project registration failed with HTTP 503");
    expect(exitCode).toBe(exitCodeForError("RUNTIME_UNAVAILABLE"));
    expect(exitCode).not.toBe(exitCodeForError("CONFIG_INVALID"));
  });
});

describe("project registration file name", () => {
  it("refuses a file name that cannot supply a valid project name, instead of a raw zod dump", async () => {
    // issue #101: connectors-check.rev3.yaml derives "connectors-check.rev3" as the project name,
    // which fails AgentXNameSchema's pattern (it contains dots).
    const context = await administratorContext("agentx-cli-register-badname-");
    const misnamed = join(dirname(context.projectFile), "connectors-check.rev3.yaml");
    await writeFile(misnamed, JSON.stringify({ ...projectDefinition(), name: "connectors-check" }), "utf8");
    const fetchImplementation = vi.fn<typeof fetch>();
    const { exitCode, stderr } = await runRegister({ ...context, projectFile: misnamed }, fetchImplementation);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_INVALID");
    expect(parsed.error.message).toContain("connectors-check.rev3.yaml");
    expect(parsed.error.message).toContain("connectors-check.yaml");
  });

  it("refuses a well-formed file name that disagrees with the YAML's own name, naming both", async () => {
    const context = await administratorContext("agentx-cli-register-mismatch-");
    const misnamed = join(dirname(context.projectFile), "storefront.yaml");
    await writeFile(misnamed, JSON.stringify({ ...projectDefinition(), name: "payments" }), "utf8");
    const fetchImplementation = vi.fn<typeof fetch>();
    const { exitCode, stderr } = await runRegister({ ...context, projectFile: misnamed }, fetchImplementation);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_INVALID");
    expect(parsed.error.message).toContain("storefront.yaml");
    expect(parsed.error.message).toContain("payments.yaml");
  });
});

const deployment = {
  controlPlaneUrl: "http://127.0.0.1:8787",
  auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" },
};

/** The deployment-file and token-store setup of cli-execution.test.ts, with a project file that approves a connector tool. */
async function administratorContext(prefix: string): Promise<{ globals: string[]; projectFile: string; tokens: InMemoryTokenStore }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const deploymentFile = join(directory, "deployment.yaml");
  await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
  const projectFile = join(directory, "payments.yaml");
  await writeFile(projectFile, JSON.stringify(projectDefinition()), "utf8");
  const tokens = new InMemoryTokenStore();
  await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret", expiresAt: Date.now() + 60_000 });
  return { tokens, projectFile, globals: ["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback"] };
}

async function runRegister(context: Awaited<ReturnType<typeof administratorContext>>, fetchImplementation: typeof fetch) {
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli([
    ...context.globals,
    "--json",
    "admin", "project", "register",
    "--file", context.projectFile,
    "--deployment-mode", "ec2-ebs",
    "--launch-template-id", "lt-0123456789abcdef0",
    "--subnets", "us-east-1a=subnet-0123456789abcdef0",
  ], {
    fetchImplementation,
    tokenStore: context.tokens,
    stdout: { write(text: string) { stdout += text; } },
    stderr: { write(text: string) { stderr += text; } },
  });
  return { exitCode, stdout, stderr };
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
    integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] },
  };
}
