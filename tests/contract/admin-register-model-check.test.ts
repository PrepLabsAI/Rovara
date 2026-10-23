import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import type { ProjectModelChecker } from "../../packages/cli/src/setup/project-model-check.js";
import type { ModelCheckResult } from "../../packages/model-runtime/src/model-check.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { STAGING_SETTINGS } from "../support/setup-fakes.js";

// M1.4 Task 4.10D fix round 1 (review I-2): `agentx admin project register --file`, the documented way to set a project's models, runs the same model check as project add.

const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
const NOW = "2026-10-23T12:00:00.000Z";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6", label: "Sonnet" };
const OPUS = { provider: "anthropic", modelId: "claude-opus-5", label: "Opus" };
const models = { default: SONNET, approved: [SONNET, OPUS] };

async function context(withModels: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "agentx-register-models-"));
  const deploymentFile = join(directory, "deployment.yaml");
  await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
  const projectFile = join(directory, "payments.yaml");
  await writeFile(projectFile, JSON.stringify({
    name: "payments", revision: 1,
    repositories: [{ name: "payments", url: "https://git.example.test/payments.git", path: "repo/payments", defaultBranch: "main", credentialRef: "payments-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate coding to the remote worker.", ...(withModels ? { models } : {}),
  }), "utf8");
  const tokens = new InMemoryTokenStore();
  await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret", expiresAt: Date.now() + 60_000 });
  const store = new MemoryParameterStore();
  return { directory, projectFile, tokens, store, globals: ["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback", "--env", "staging"] };
}

async function register(c: Awaited<ReturnType<typeof context>>, check: ProjectModelChecker | undefined, extra: string[] = []) {
  const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ project: { definition: { name: "payments" } }, duplicate: false, preflight: { connectors: [] } }, { status: 201 }));
  let stderr = "";
  const exitCode = await executeCli([...c.globals, "--json", "admin", "project", "register", "--file", c.projectFile, "--deployment-mode", "ec2-ebs", "--launch-template-id", "lt-0123456789abcdef0", "--subnets", "us-east-1a=subnet-0123456789abcdef0", ...extra], {
    fetchImplementation, tokenStore: c.tokens, environments: { home: c.directory, store: c.store },
    ...(check === undefined ? {} : { registerModelCheck: check }),
    stdout: { write() {} }, stderr: { write(text: string) { stderr += text; } },
  });
  const body = fetchImplementation.mock.calls[0] === undefined ? undefined : JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body as string)) as { definition: { models?: { default: { lastCheck?: unknown }; approved: Array<{ modelId: string; lastCheck?: unknown }> } } };
  return { exitCode, stderr, body, called: fetchImplementation.mock.calls.length };
}

const fail = (cls: Extract<ModelCheckResult, { ok: false }>["class"]): ModelCheckResult => ({ ok: false, class: cls, signal: null, error: new Error("Bearer sk-ant-never-stored") });
const answers = (table: Record<string, ModelCheckResult>): ProjectModelChecker => async (pair) => table[`${pair.provider}/${pair.modelId}`] ?? { ok: true };
const seeded = async (c: Awaited<ReturnType<typeof context>>) => { await writeEnvironmentSettings(c.store, STAGING_SETTINGS); };

describe("admin project register --file checks the project's models", () => {
  it("refuses a model-specific failure of the default model before registering anything, naming the override", async () => {
    const c = await context(true);
    await seeded(c);
    const result = await register(c, answers({ "anthropic/claude-sonnet-4-6": fail("key-rejected") }));
    expect(result.exitCode).not.toBe(0);
    expect(result.called).toBe(0);
    expect(result.stderr).toContain("Anthropic refused the key for claude-sonnet-4-6");
    expect(result.stderr).toContain("--accept-unchecked-model");
    expect(result.stderr).not.toContain("sk-ant");
  });

  it("registers a failing approved pair with a warning and the stored class, and a pair that passes with its record", async () => {
    const c = await context(true);
    await seeded(c);
    const result = await register(c, answers({ "anthropic/claude-opus-5": fail("model-not-found") }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("The approved model Opus (anthropic/claude-opus-5) failed its check, and is registered anyway");
    expect(result.body?.definition.models?.approved.map((model) => [model.modelId, (model.lastCheck as { status: string; class?: string }).status, (model.lastCheck as { class?: string }).class])).toEqual([
      ["claude-sonnet-4-6", "ok", undefined], ["claude-opus-5", "failed", "model-not-found"],
    ]);
  });

  it("registers an unchecked default (the check could not tell) with a warning, and records it unchecked", async () => {
    const c = await context(true);
    await seeded(c);
    const result = await register(c, answers({ "anthropic/claude-sonnet-4-6": fail("provider-outage") }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("could not be checked");
    expect(result.body?.definition.models?.default.lastCheck).toMatchObject({ status: "unchecked", class: "provider-outage" });
  });

  it("registers a refused default when --accept-unchecked-model gives a reason, and sends the reason with the revision", async () => {
    const c = await context(true);
    await seeded(c);
    const result = await register(c, answers({ "anthropic/claude-sonnet-4-6": fail("model-not-found") }), ["--accept-unchecked-model", "  access arrives Friday  "]);
    expect(result.exitCode).toBe(0);
    expect(result.body?.definition.models?.default.lastCheck).toMatchObject({ status: "failed", class: "model-not-found", acceptedReason: "access arrives Friday" });
    expect(result.stderr).toContain("access arrives Friday");
  });

  it("registers without a check, and says so, when this computer cannot read the environment's settings (never blocks), sending no stale record", async () => {
    const c = await context(true);
    const result = await register(c, answers({ "anthropic/claude-sonnet-4-6": fail("model-not-found") }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("The project's models were not checked");
    expect(result.stderr).toContain("agentx --env staging doctor");
    expect(JSON.stringify(result.body)).not.toContain("lastCheck");
  });

  it("checks nothing for a project without models", async () => {
    const c = await context(false);
    await seeded(c);
    const check = vi.fn<ProjectModelChecker>(async () => ({ ok: true }));
    const result = await register(c, check);
    expect(result.exitCode).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(result.stderr).not.toContain("not checked");
  });
});
