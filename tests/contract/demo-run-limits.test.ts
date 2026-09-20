import { BedrockRuntimeClient, type ConverseStreamCommand, type ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCoreBedrockProvider } from "../../packages/worker/src/pi-session.js";

const previousAttempts = process.env.AWS_MAX_ATTEMPTS;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (previousAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
  else process.env.AWS_MAX_ATTEMPTS = previousAttempts;
});

function transport() {
  const requests: unknown[] = [];
  const sdk = BedrockRuntimeClient.prototype as { send(command: ConverseStreamCommand): Promise<ConverseStreamCommandOutput> };
  vi.spyOn(sdk, "send").mockImplementation(async function (this: BedrockRuntimeClient, command) {
    if (process.env.AWS_MAX_ATTEMPTS === "1") expect(await this.config.maxAttempts()).toBe(1);
    requests.push(command.input);
    return { $metadata: {}, stream: (async function* () {
      yield { messageStart: { role: "assistant" } };
      yield { messageStop: { stopReason: "end_turn" } };
    })() };
  });
  return requests;
}

describe("opt-in demo model dispatch limits", () => {
  it("caps the actual Bedrock payload after other request hooks and rejects the ninth dispatch", async () => {
    const requests = transport();
    const provider = agentCoreBedrockProvider(true);
    const model = provider.getModels().find((item) => item.id === "amazon.nova-pro-v1:0")!;
    for (let i = 0; i < 8; i++) {
      const result = await provider.streamSimple(model, { messages: [] }, {
        maxTokens: 20_000,
        onPayload: (payload) => ({ ...payload as object, inferenceConfig: { maxTokens: 99_999 } }),
      }).result();
      expect(result.stopReason).toBe("stop");
    }
    expect(requests).toHaveLength(8);
    expect(requests.map((request) => (request as { inferenceConfig: unknown }).inferenceConfig))
      .toEqual(Array.from({ length: 8 }, () => ({ maxTokens: 4096 })));
    const denied = await provider.stream(model, { messages: [] }).result();
    expect(denied.stopReason).toBe("error");
    expect(denied.errorMessage).toContain("DEMO_MODEL_CALL_LIMIT");
    expect(requests).toHaveLength(8);
  });

  it("rejects oversized cumulative payloads before network dispatch", async () => {
    const requests = transport();
    const provider = agentCoreBedrockProvider(true);
    const model = provider.getModels().find((item) => item.id === "amazon.nova-pro-v1:0")!;
    const context = { messages: [], systemPrompt: "x".repeat(140_000) };
    expect((await provider.stream(model, context).result()).stopReason).toBe("stop");
    const denied = await provider.stream(model, context).result();
    expect(denied.errorMessage).toContain("DEMO_INPUT_LIMIT");
    expect(requests).toHaveLength(1);
  });

  it("never refunds failed requests and rejects attempts after retry configuration changes", async () => {
    const requests = transport();
    const sdk = BedrockRuntimeClient.prototype as { send(command: ConverseStreamCommand): Promise<ConverseStreamCommandOutput> };
    const send = vi.spyOn(sdk, "send").mockRejectedValue(new Error("fixture uncertain transport failure"));
    const provider = agentCoreBedrockProvider(true);
    const model = provider.getModels().find((item) => item.id === "amazon.nova-pro-v1:0")!;
    for (let i = 0; i < 8; i++) {
      expect((await provider.stream(model, { messages: [] }).result()).errorMessage).toContain("fixture uncertain");
    }
    expect((await provider.streamSimple(model, { messages: [] }).result()).errorMessage).toContain("DEMO_MODEL_CALL_LIMIT");
    expect(send).toHaveBeenCalledTimes(8);
    const next = agentCoreBedrockProvider(true);
    process.env.AWS_MAX_ATTEMPTS = "10";
    expect((await next.stream(model, { messages: [] }).result()).errorMessage).toContain("DEMO_RETRY_CONFIGURATION");
    expect(send).toHaveBeenCalledTimes(8);
    expect(requests).toEqual([]);
  });

  it("keeps legacy provider requests unchanged when disabled", async () => {
    const requests = transport();
    const provider = agentCoreBedrockProvider();
    const model = provider.getModels().find((item) => item.id === "amazon.nova-pro-v1:0")!;
    await provider.stream(model, { messages: [] }, { maxTokens: 7000 }).result();
    expect((requests[0] as { inferenceConfig: unknown }).inferenceConfig).toEqual({ maxTokens: 7000 });
  });

  it("fails closed on another model, image payload, or an expired job without calling Bedrock", async () => {
    const requests = transport();
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = agentCoreBedrockProvider(true);
    const model = provider.getModels().find((item) => item.id === "amazon.nova-pro-v1:0")!;
    const wrong = await provider.stream({ ...model, id: "different-model" }, { messages: [] }).result();
    expect(wrong.errorMessage).toContain("DEMO_MODEL_UNSUPPORTED");
    const second = agentCoreBedrockProvider(true);
    const image = await second.stream(model, { messages: [] }, {
      onPayload: (payload) => ({ ...payload as object, image: { bytes: "untrusted" } }),
    }).result();
    expect(image.errorMessage).toContain("DEMO_PAYLOAD_UNSUPPORTED");
    const third = agentCoreBedrockProvider(true);
    vi.setSystemTime(Date.now() + 180_000);
    const expired = await third.stream(model, { messages: [] }).result();
    expect(expired.errorMessage).toContain("DEMO_TASK_DEADLINE");
    expect(requests).toHaveLength(0);
  });
});
