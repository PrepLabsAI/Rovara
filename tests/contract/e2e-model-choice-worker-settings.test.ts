import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_SETTING_PARAMETERS, chunkParameterNames } from "../../packages/contracts/src/session.js";

// M1.4 Task 4.10A, test 9: the AI navigation model is a setting the broker reads, never a worker boot variable, and the code that reads every other worker setting copes with it.

const { ssmSend, kmsSend } = vi.hoisted(() => ({ ssmSend: vi.fn(), kmsSend: vi.fn() }));
vi.mock("@aws-sdk/client-ssm", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), SSMClient: class { send = ssmSend; } }));
vi.mock("@aws-sdk/client-kms", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), KMSClient: class { send = kmsSend; } }));

const PREFIX = "/agentx/test/";
const settings: Record<string, string> = {
  "worker-image": `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-test@sha256:${"a".repeat(64)}`, "worker-model-provider": "amazon-bedrock", "worker-model-id": "us.anthropic.claude-sonnet-4-6",
  "worker-prompt-cache-retention": "long",
};

beforeEach(() => {
  vi.stubEnv("WORKER_SETTINGS_PREFIX", PREFIX);
  vi.stubEnv("INVOKE_SIGNING_KEY_ARN", "arn:aws:kms:us-east-1:111122223333:key/11111111-1111-4111-8111-111111111111");
  vi.stubEnv("CONTROL_PLANE_URL", "https://abc.execute-api.us-east-1.amazonaws.com");
  vi.stubEnv("WORKER_LOG_GROUP_NAME", "/agentx/test/worker");
  vi.stubEnv("LAMBDA_TASK_ROOT", new URL("../../packages/worker/ec2", import.meta.url).pathname);
  vi.stubEnv("STATE_TABLE_NAME", "state");
  kmsSend.mockReset().mockResolvedValue({ PublicKey: Buffer.from(`MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`, "base64") });
  ssmSend.mockReset();
});

const answer = (values: Record<string, string>) => ssmSend.mockImplementation(async (command: { input: { Names: string[] } }) => ({
  Parameters: command.input.Names.flatMap((name) => { const key = name.slice(PREFIX.length); return key in values ? [{ Name: name, Value: values[key] }] : []; }),
}));

describe("the session steps' read of the worker settings", () => {
  const launch = async () => {
    const { handler } = await import("../../packages/broker/src/aws/session-steps.js");
    return handler({ action: "launchConfiguration", workspaceId: randomUUID(), generation: 1, volumeId: "vol-0123456789abcdef0", expectNewVolume: false }) as Promise<{ userData: string }>;
  };

  it("reads the worker settings in chunks of at most ten names (GetParameters takes no more), asks for the model settings among them, and boots a worker with and without them", async () => {
    for (const present of [false, true]) {
      answer({ ...settings, ...(present ? { "worker-e2e-agent-model": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "worker-model-fallback": "us.anthropic.claude-sonnet-4-6" } : {}) });
      ssmSend.mockClear();
      const result = await launch();
      expect(typeof result.userData).toBe("string");
      const calls = ssmSend.mock.calls.map((call) => (call[0] as { input: { Names: string[] } }).input.Names);
      const asked = calls.flat();
      expect(asked).toContain(`${PREFIX}worker-e2e-agent-model`);
      expect(asked).toContain(`${PREFIX}worker-model-fallback`);
      expect(asked).toHaveLength(Object.keys(WORKER_SETTING_PARAMETERS).length);
      expect(new Set(asked).size).toBe(asked.length);
      for (const names of calls) expect(names.length).toBeLessThanOrEqual(10);
      expect(calls.length).toBeGreaterThan(1);
    }
  });

  it("puts the chosen fallback model in the boot user data, and nothing when it is none or absent (MODEL3)", async () => {
    const { gunzipSync } = await import("node:zlib");
    const boot = async (extra: Record<string, string>) => { answer({ ...settings, ...extra }); return gunzipSync(Buffer.from((await launch()).userData, "base64")).toString("utf8"); };
    expect(await boot({ "worker-model-fallback": "us.anthropic.claude-sonnet-4-6" })).toContain("export AGENTX_MODEL_FALLBACK='us.anthropic.claude-sonnet-4-6'");
    expect(await boot({ "worker-model-fallback": "none" })).not.toContain("AGENTX_MODEL_FALLBACK='");
    expect(await boot({})).not.toContain("AGENTX_MODEL_FALLBACK='");
  });

  it("puts no AI navigation model in the worker's boot user data", async () => {
    answer({ ...settings, "worker-e2e-agent-model": "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    const { gunzipSync } = await import("node:zlib");
    const userData = gunzipSync(Buffer.from((await launch()).userData, "base64")).toString("utf8");
    expect(userData).not.toContain("claude-haiku-4-5");
    expect(userData).not.toMatch(/E2E_AGENT_MODEL|E2E_MODEL/);
  });

  it("gives the boot script no variable for it: user data has almost no headroom, and the worker never reads the model from its boot environment", () => {
    const boot = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
    expect(boot).not.toMatch(/E2E_AGENT_MODEL|E2E_MODEL|e2eAgentModel|worker-e2e-agent-model/);
    const derive = readFileSync(new URL("../../packages/model-runtime/src/e2e-route-derive.ts", import.meta.url), "utf8");
    expect(derive).not.toMatch(/AGENTX_E2E_/);
  });

  it("pins the chunking: the worker settings are more than one GetParameters call, so every reader of all of them goes through chunkParameterNames", () => {
    expect(Object.keys(WORKER_SETTING_PARAMETERS).length).toBeGreaterThan(10);
    expect(chunkParameterNames(Object.values(WORKER_SETTING_PARAMETERS)).every((names) => names.length <= 10)).toBe(true);
    expect(chunkParameterNames(Object.values(WORKER_SETTING_PARAMETERS)).flat()).toEqual(Object.values(WORKER_SETTING_PARAMETERS));
    expect(chunkParameterNames([])).toEqual([]);
    for (const file of ["packages/broker/src/aws/session-steps.ts", "scripts/test-qualify-runtime.ts", "scripts/ec2-preflight.ts"]) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(source, file).toContain("chunkParameterNames(");
      expect(source, file).not.toMatch(/Names: Object\.values\(\w*[nN]ames\)/);
    }
  });
});

describe("the qualification script's read of the worker settings", () => {
  const source = readFileSync(new URL("../../scripts/test-qualify-runtime.ts", import.meta.url), "utf8");

  it("takes every worker setting by name from WORKER_SETTING_PARAMETERS and reads only the keys it has always read, so the model setting is asked for and ignored", () => {
    expect(source).toContain("Object.entries(WORKER_SETTING_PARAMETERS)");
    const read = [...source.matchAll(/(?:required|optional)\("([A-Za-z]+)"\)/g)].map((match) => match[1]).sort();
    expect(read).toEqual(["anthropicSecretArn", "executorImage", "modelId", "modelProvider", "openRouterProviders", "openRouterSecretArn", "openaiSecretArn", "promptCacheRetention", "workerImage"]);
    expect(source).not.toContain("modelFallback");
    expect(source).not.toContain("e2eAgentModel");
  });
});
