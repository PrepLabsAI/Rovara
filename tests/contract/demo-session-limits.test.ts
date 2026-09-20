import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BedrockRuntimeClient, type ConverseStreamCommand, type ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import * as limitsModule from "../../packages/worker/src/demo-run-limits.js";

const fixture = vi.hoisted(() => ({ options: undefined as CreateAgentSessionOptions | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof PiCodingAgent>(),
  createAgentSession: async (options: CreateAgentSessionOptions) => {
    fixture.options = options;
    return { session: {
      sessionId: randomUUID(), sessionFile: join(options.cwd!, "agent-sessions/test.jsonl"),
      prompt: async () => {
        for (let i = 0; i < 9; i++) {
          // Real Pi runtime/provider; only AWS transport and coding agent are inert.
          await options.modelRuntime!.streamSimple(options.model as Model<"bedrock-converse-stream">, { messages: [] }).result();
        }
      },
      abort: async () => undefined, subscribe: () => () => undefined, dispose: () => undefined,
    } };
  },
}));

const previousAttempts = process.env.AWS_MAX_ATTEMPTS;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
  else process.env.AWS_MAX_ATTEMPTS = previousAttempts;
});

it("uses a trusted off-by-default flag and fails closed on invalid configuration", () => {
  const legacy = { AWS_MAX_ATTEMPTS: "3" };
  expect(limitsModule.demoRunLimitsEnabled(legacy)).toBe(false);
  expect(legacy.AWS_MAX_ATTEMPTS).toBe("3");
  expect(limitsModule.demoRunLimitsEnabled({ AGENTX_DEMO_RUN_LIMITS: "0" })).toBe(false);
  const demo = { AGENTX_DEMO_RUN_LIMITS: "1", AWS_MAX_ATTEMPTS: "9" };
  expect(limitsModule.demoRunLimitsEnabled(demo)).toBe(true);
  expect(demo.AWS_MAX_ATTEMPTS).toBe("1");
  expect(() => limitsModule.demoRunLimitsEnabled({ AGENTX_DEMO_RUN_LIMITS: "true" })).toThrow();
});

it("wires the default Pi provider to the task budget and refuses a swallowed provider-limit error", async () => {
  let dispatches = 0;
  const sdk = BedrockRuntimeClient.prototype as { send(command: ConverseStreamCommand): Promise<ConverseStreamCommandOutput> };
  vi.spyOn(sdk, "send").mockImplementation(async () => {
    dispatches++;
    return { $metadata: {}, stream: (async function* () {
      yield { messageStop: { stopReason: "end_turn" } };
    })() };
  });
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-demo-session-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ complete: true, projectRevision: 1 }));
  await expect(runTaskInvocation({
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(),
    fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Small demo task" },
  }, {
    rootPath, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
    demoLimits: true, eventSink: async () => undefined, artifactSink: async () => undefined,
  })).rejects.toThrow("DEMO_MODEL_CALL_LIMIT");
  expect(dispatches).toBe(8);
  expect(fixture.options?.settingsManager?.getRetryEnabled()).toBe(false);
  expect(fixture.options?.settingsManager?.getCompactionEnabled()).toBe(false);
  expect(fixture.options?.settingsManager?.getBlockImages()).toBe(true);
});
