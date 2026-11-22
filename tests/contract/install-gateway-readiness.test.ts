import { afterEach, expect, it, vi } from "vitest";
import { deployEnvironment, type DeployEnvironmentInput } from "../../packages/cli/src/deploy/deploy-environment.js";
import { DeployAnswersSchema, UpgradeDeployAnswersSchema } from "../../packages/cli/src/deploy/commands.js";
import { allStackOutputs, fakeRelease, HOLDER, memoryInitSecrets, sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import type { DeployRequest } from "../../packages/cli/src/deploy/deployer.js";

const coreEngine = { modelGatewayUrl: "https://gateway.example", agentModel: "claude-sonnet-4-6" };
const healthy = () => Response.json({ runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const answers = sampleAnswers();
  const store = new MemoryParameterStore();
  const secrets = memoryInitSecrets();
  const requests: DeployRequest[] = [];
  const outputs = allStackOutputs();
  delete outputs["agentx-staging-control-plane"]!.ModelRunPriceVersion;
  const release = fakeRelease();
  release.template = () => JSON.stringify({ Parameters: { CoreModelGatewayHost: {}, CoreAgentModel: {} }, Outputs: { ModelRunPriceVersion: { Value: "1" } } });
  const input: DeployEnvironmentInput = {
    mode: "install", engine: "templates", store, secrets, holder: HOLDER, release,
    answers: { env: answers.env, region: answers.region, account: answers.account, models: answers.models, identity: { mode: "cognito" },
      github: { appId: "123", privateKeySecretArn: "test" }, coreEngine },
    deployer: { outputs: async (name) => outputs[name], deploy: async (request) => {
      requests.push(request);
      return { ...outputs[request.stackName], ...(request.part === "control-plane" ? { ModelRunPriceVersion: "1" } : {}) };
    } },
  };
  return { input, requests, outputs, store, secrets };
}
function noWrites(f: ReturnType<typeof fixture>) {
  expect(f.requests).toEqual([]);
  expect(f.secrets.values.size).toBe(0);
  expect(f.store.calls.filter(({ op }) => op !== "get" && op !== "list")).toEqual([]);
}
it("fresh install without coreEngine refuses before any write", async () => {
  const f = fixture(); delete f.input.answers.coreEngine;
  await expect(deployEnvironment(f.input)).rejects.toThrow("coreEngine");
  noWrites(f);
});
it("fresh install refuses unsigned gateway with its URL and zero writes", async () => {
  const f = fixture(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
  await expect(deployEnvironment(f.input)).rejects.toThrow(/https:\/\/gateway.example.*gateway must serve run prices/);
  noWrites(f);
});
it("qualifies the selected artifact before probing the gateway or writing", async () => {
  const f = fixture(); f.input.release.template = () => JSON.stringify({ Outputs: {} });
  const transport = vi.fn(async () => healthy()); vi.stubGlobal("fetch", transport);
  await expect(deployEnvironment(f.input)).rejects.toThrow("release must contain a price-serving broker");
  expect(transport).not.toHaveBeenCalled(); noWrites(f);
});
it("old deployed broker can upgrade to a qualified artifact, retaining omitted coreEngine", async () => {
  const f = fixture(); await writeEnvironmentSettings(f.store, stagingSettings); f.store.calls.length = 0;
  f.input.mode = "upgrade"; delete f.input.answers.coreEngine;
  f.input.deployedParameters = async () => ({ CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" });
  const transport = vi.fn(async () => healthy()); vi.stubGlobal("fetch", transport);
  await expect(deployEnvironment(f.input)).resolves.toMatchObject({ settingsWritten: true });
  expect(f.requests.find(({ part }) => part === "control-plane")?.parameters).toMatchObject({ CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" });
  expect(transport).toHaveBeenCalledWith("https://gateway.example/healthz", expect.anything());
});
it("upgrade omitting coreEngine still refuses an unchanged unready gateway before writes", async () => {
  const f = fixture(); await writeEnvironmentSettings(f.store, stagingSettings); f.store.calls.length = 0;
  f.input.mode = "upgrade"; delete f.input.answers.coreEngine;
  f.input.deployedParameters = async () => ({ CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
  await expect(deployEnvironment(f.input)).rejects.toThrow("gateway must serve run prices"); noWrites(f);
});
it("re-checks the completed broker before worker activation", async () => {
  const f = fixture(); vi.stubGlobal("fetch", vi.fn(async () => healthy()));
  const deploy = f.input.deployer.deploy.bind(f.input.deployer);
  f.input.deployer.deploy = async (request) => {
    const result = await deploy(request); if (request.part === "control-plane") delete result.ModelRunPriceVersion;
    return result;
  };
  await expect(deployEnvironment(f.input)).rejects.toThrow("price-serving broker must be installed before worker activation");
  expect(f.requests.map(({ part }) => part)).toContain("control-plane");
  expect(f.requests.map(({ part }) => part)).not.toContain("runtime");
});
it("deploy answers require the validated pair only on install", () => {
  const { input } = fixture();
  expect(DeployAnswersSchema.safeParse(input.answers).success).toBe(true);
  delete input.answers.coreEngine;
  expect(DeployAnswersSchema.safeParse(input.answers).success).toBe(false);
  expect(UpgradeDeployAnswersSchema.safeParse(input.answers).success).toBe(true);
  for (const value of [{ modelGatewayUrl: "none", agentModel: "claude-sonnet-4-6" }, { modelGatewayUrl: "https://gateway.example", agentModel: "none" }, { modelGatewayUrl: "https://gateway.example/path", agentModel: "claude-sonnet-4-6" }]) {
    expect(DeployAnswersSchema.safeParse({ ...input.answers, coreEngine: value }).success).toBe(false);
  }
});
