import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_STACK_NAMES } from "../../infra/lib/naming.js";
import { ADOPTED_STACK_NAMES, adoptEnvironment, type StackReader } from "../../packages/cli/src/environments/adopt.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const liveStacks: Record<string, { outputs: Record<string, string>; parameters: Record<string, string>; status: string }> = {
  AgentXProductionFoundation: { outputs: {}, parameters: {}, status: "UPDATE_COMPLETE" },
  AgentXProductionRuntime: { outputs: {}, parameters: { ModelId: "amazon.nova-pro-v1:0" }, status: "UPDATE_COMPLETE" },
  AgentXControlPlane: {
    outputs: { ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com" },
    parameters: { OidcIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", OidcAudience: "client123" },
    status: "UPDATE_COMPLETE",
  },
  AgentXSlackOrchestrator: { outputs: {}, parameters: { ModelId: "amazon.nova-pro-v1:0", GateClassifierModelId: "amazon.nova-lite-v1:0" }, status: "UPDATE_COMPLETE" },
};

function reader(stacks: typeof liveStacks, log: string[] = []): StackReader {
  return { describe: async (name) => { log.push(name); return stacks[name]; } };
}

const identity = { get: async () => ({ account: "944937319445", arn: "arn:aws:iam::944937319445:user/admin" }) };
const now = () => Date.parse("2026-09-26T00:00:00.000Z");

async function run(stacks = liveStacks, store = new MemoryParameterStore()) {
  const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
  return { store, home, result: adoptEnvironment({ env: "production", region: "us-east-1", stacks: reader(stacks), identity, store, home, now }) };
}

describe("agentx env adopt", () => {
  it("uses the same stack names as the infra's legacy naming", () => {
    expect(ADOPTED_STACK_NAMES).toEqual(LEGACY_STACK_NAMES);
  });

  it("registers the existing deployment from its stacks without changing them", async () => {
    const { store, result } = await run();
    const settings = await result;
    expect(settings).toEqual({
      schemaVersion: 1,
      env: "production",
      account: "944937319445",
      region: "us-east-1",
      engine: "cdk",
      version: "unversioned",
      naming: "legacy",
      stacks: { foundation: "AgentXProductionFoundation", runtime: "AgentXProductionRuntime", "control-plane": "AgentXControlPlane", slack: "AgentXSlackOrchestrator" },
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", audience: "client123", clientId: "client123" },
      models: { orchestrator: "amazon.nova-pro-v1:0", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    expect(await readEnvironmentSettings(store, "production")).toEqual(settings);
    expect(store.values.has("/agentx/production/lock")).toBe(false);
    expect(store.calls.every((call) => call.name.startsWith("/agentx/production/"))).toBe(true);
  });

  it("refuses and writes nothing when a stack is missing", async () => {
    const rest: typeof liveStacks = Object.fromEntries(Object.entries(liveStacks).filter(([name]) => name !== "AgentXSlackOrchestrator"));
    const { store, result } = await run(rest);
    await expect(result).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("AgentXSlackOrchestrator") as unknown });
    expect(store.values.has("/agentx/production/settings")).toBe(false);
  });

  it("refuses and writes nothing when an output is missing", async () => {
    const stacks = { ...liveStacks, AgentXControlPlane: { ...liveStacks.AgentXControlPlane!, outputs: {} } };
    const { store, result } = await run(stacks);
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining("ApiEndpoint") as unknown });
    expect(store.values.has("/agentx/production/settings")).toBe(false);
  });

  it("refuses a stack in a failed state", async () => {
    const stacks = { ...liveStacks, AgentXProductionRuntime: { ...liveStacks.AgentXProductionRuntime!, status: "UPDATE_ROLLBACK_FAILED" } };
    await expect((await run(stacks)).result).rejects.toMatchObject({ message: expect.stringContaining("AgentXProductionRuntime") as unknown });
  });

  it("refuses a stack that is being deleted", async () => {
    const stacks = { ...liveStacks, AgentXProductionRuntime: { ...liveStacks.AgentXProductionRuntime!, status: "DELETE_IN_PROGRESS" } };
    await expect((await run(stacks)).result).rejects.toMatchObject({ message: expect.stringContaining("DELETE_IN_PROGRESS") as unknown });
  });

  it("refuses a deleted stack (DELETE_COMPLETE is not healthy)", async () => {
    const stacks = { ...liveStacks, AgentXProductionRuntime: { ...liveStacks.AgentXProductionRuntime!, status: "DELETE_COMPLETE" } };
    await expect((await run(stacks)).result).rejects.toMatchObject({ message: expect.stringContaining("DELETE_COMPLETE") as unknown });
  });

  it("refuses to adopt any environment other than production, touching no store or AWS call", async () => {
    const store = new MemoryParameterStore();
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    const identityGet = vi.fn(async () => ({ account: "944937319445", arn: "arn:aws:iam::944937319445:user/admin" }));
    const stacksLog: string[] = [];
    await expect(
      adoptEnvironment({ env: "staging", region: "us-east-1", stacks: reader(liveStacks, stacksLog), identity: { get: identityGet }, store, home, now }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("only the production environment can adopt") as unknown,
    });
    expect(store.calls).toEqual([]);
    expect(identityGet).not.toHaveBeenCalled();
    expect(stacksLog).toEqual([]);
  });

  it("refuses an environment that already has settings, changing nothing", async () => {
    const store = new MemoryParameterStore();
    await (await run(liveStacks, store)).result;
    const before = store.values.get("/agentx/production/settings");
    await expect((await run(liveStacks, store)).result).rejects.toMatchObject({ message: expect.stringContaining("already has settings") as unknown });
    expect(store.values.get("/agentx/production/settings")).toBe(before);
  });

  it("closes the check-then-write race: settings written between the check and the createOnly write are not overwritten", async () => {
    const inner = new MemoryParameterStore();
    const settingsName = "/agentx/production/settings";
    let raced = false;
    // A store whose get() simulates another process writing settings in the instant after we read
    // them as absent, before our own createOnly write lands.
    const store: ParameterStore = {
      async get(name) {
        const result = await inner.get(name);
        if (name === settingsName && result === undefined && !raced) {
          raced = true;
          await inner.put(name, "raced-in-between-value");
        }
        return result;
      },
      put: (name, value, options) => inner.put(name, value, options),
      delete: (name) => inner.delete(name),
      list: (path) => inner.list(path),
    };
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    await expect(
      adoptEnvironment({ env: "production", region: "us-east-1", stacks: reader(liveStacks), identity, store, home, now }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("already has settings") as unknown });
    expect(inner.values.get(settingsName)).toBe("raced-in-between-value");
  });

  it("fails clearly when the SSM write succeeds but the local cache cannot be written", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    // Occupy the path where writeEnvironmentCache needs to mkdir a directory (<home>/.agentx/...).
    await writeFile(join(home, ".agentx"), "not a directory");
    const store = new MemoryParameterStore();
    await expect(
      adoptEnvironment({ env: "production", region: "us-east-1", stacks: reader(liveStacks), identity, store, home, now }),
    ).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: expect.stringContaining("local cache could not be written") as unknown,
    });
    // The SSM write already landed; only the cache write failed.
    expect(await readEnvironmentSettings(store, "production")).toBeDefined();
  });

  it("marks a non-Cognito issuer as oidc and uses --client-id", async () => {
    const stacks = { ...liveStacks, AgentXControlPlane: { ...liveStacks.AgentXControlPlane!, parameters: { OidcIssuer: "https://login.example.com", OidcAudience: "api://agentx" } } };
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    const settings = await adoptEnvironment({ env: "production", region: "us-east-1", clientId: "cli-client", stacks: reader(stacks), identity, store: new MemoryParameterStore(), home, now });
    expect(settings.identity).toEqual({ mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx", clientId: "cli-client" });
  });
});
