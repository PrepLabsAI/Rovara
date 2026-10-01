import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { Context } from "@earendil-works/pi-ai";
import { redactText } from "../../packages/contracts/src/redaction.js";
import { DEFAULT_BEDROCK_MODELS, providerKeyProblem, readProviderKey } from "../../packages/model-runtime/src/config.js";
import { createConfiguredModelRuntime, createModelRuntimeWithFallback } from "../../packages/model-runtime/src/index.js";
import { createModelClassifier } from "../../packages/orchestrator/src/action-classifier.js";
import { createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";

const anthropicArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf";
const openaiArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openai-AbCdEf";
const anthropicKey = "sk-ant-api03-never-persist-this-key";
const openaiKey = "sk-proj-never-persist-this-key";
const environment = { AGENTX_ANTHROPIC_SECRET_ARN: anthropicArn, AGENTX_OPENAI_SECRET_ARN: openaiArn };
const readSecret = async (arn: string) => (arn === anthropicArn ? anthropicKey : openaiKey);
const context: Context = { messages: [{ role: "user", content: "Read a file", timestamp: 0 }], tools: [{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }] };

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

const anthropicUsage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
function anthropicText(text: string) {
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6-20260217", content: [], stop_reason: null, usage: anthropicUsage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}
function anthropicToolCall() {
  return sse([
    { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-4-6-20260217", content: [], stop_reason: null, usage: anthropicUsage } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}

const openaiUsage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
function openaiText(text: string) {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_1", object: "response", model: "gpt-5.4-2026-03-05", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", object: "response", model: "gpt-5.4-2026-03-05", status: "completed", output: [item], usage: openaiUsage } },
  ]);
}
function openaiToolCall() {
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}', status: "completed" };
  return sse([
    { type: "response.created", response: { id: "resp_2", object: "response", model: "gpt-5.4-2026-03-05", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '"README.md"}' },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_2", object: "response", model: "gpt-5.4-2026-03-05", status: "completed", output: [item], usage: openaiUsage } },
  ]);
}

const cases = [
  { provider: "anthropic", modelId: "claude-sonnet-4-6", key: anthropicKey, url: "https://api.anthropic.com/v1/messages", text: anthropicText, toolCall: anthropicToolCall,
    auth: (headers: Headers) => headers.get("x-api-key"), returned: "claude-sonnet-4-6-20260217", label: "Anthropic" },
  { provider: "openai", modelId: "gpt-5.4", key: openaiKey, url: "https://api.openai.com/v1/responses", text: openaiText, toolCall: openaiToolCall,
    auth: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer /, ""), returned: "gpt-5.4-2026-03-05", label: "OpenAI" },
] as const;

afterEach(() => { vi.unstubAllEnvs(); });

describe.each(cases)("$label through the installed Pi transport", (provider) => {
  const selected = { provider: provider.provider, modelId: provider.modelId };
  type Recorded = { url: string; headers: Headers; body: Record<string, unknown> };
  function recordingTransport(responses: Array<() => Response>) {
    const requests: Recorded[] = [];
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
      requests.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init.headers), body: JSON.parse(init.body) as Record<string, unknown> });
      return responses[Math.min(requests.length - 1, responses.length - 1)]!();
    });
    return { transport, requests };
  }
  async function runtime(transport: typeof fetch, onUsage = vi.fn()) {
    const result = await createConfiguredModelRuntime(selected, { environment, readSecret, fetch: transport, onUsage });
    return { result, model: result.getModel(selected.provider, selected.modelId)!, onUsage };
  }

  it("sends the stored key from memory, ignoring the provider's environment variables", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-from-the-environment");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "from-the-environment");
    vi.stubEnv("OPENAI_API_KEY", "sk-from-the-environment");
    const { transport, requests } = recordingTransport([() => provider.text("Done")]);
    const { result, model, onUsage } = await runtime(transport);
    const message = await result.completeSimple(model, context);
    expect(message.content).toMatchObject([{ type: "text", text: "Done" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.split("?")[0]).toBe(provider.url);
    expect(provider.auth(requests[0]!.headers)).toBe(provider.key);
    expect(requests[0]!.headers.get("authorization") ?? "").not.toContain("from-the-environment");
    expect(requests[0]!.body.model).toBe(provider.modelId);
    if (provider.provider === "openai") expect(requests[0]!.body.store).toBe(false);
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "model_request_usage", provider: provider.provider, requestedModel: provider.modelId, returnedModel: provider.returned,
      returnedProvider: null, costSource: "list-price", outcome: "stop",
    }));
    expect(JSON.stringify([message, onUsage.mock.calls])).not.toContain(provider.key);
  });

  it("streams a tool call, continues with the tool result, and runs the classifier", async () => {
    const { transport, requests } = recordingTransport([provider.toolCall, () => provider.text("Done")]);
    const { result, model } = await runtime(transport);
    const stream = result.streamSimple(model, context);
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const tool = await stream.result();
    expect(events).toContain("toolcall_delta");
    expect(tool.stopReason).toBe("toolUse");
    const call = tool.content[0];
    expect(call).toMatchObject({ type: "toolCall", name: "read_file", arguments: { path: "README.md" } });
    const callId = call?.type === "toolCall" ? call.id : "";
    const resumed = await result.completeSimple(model, { ...context, messages: [...context.messages, tool,
      { role: "toolResult", toolCallId: callId, toolName: "read_file", content: [{ type: "text", text: "file content" }], isError: false, timestamp: 1 }] });
    expect(resumed.content).toMatchObject([{ type: "text", text: "Done" }]);
    expect(JSON.stringify(requests[1]!.body)).toContain("file content");

    const verdict = recordingTransport([() => provider.text('{"decision":"allow","reason":"The member requested this change."}')]);
    const classifierRuntime = (await runtime(verdict.transport)).result;
    const classifier = await createModelClassifier({ model: selected, modelRuntime: classifierRuntime, failOnUnknownModel: true });
    expect(await classifier({ memberMessages: ["Rename the issue"], call: { tool: "update_issue", summary: "Rename", arguments: { title: "new" } } })).toMatchObject({ decision: "allow" });
  });

  it("persists and resumes a real Pi session without credential files or the key", async () => {
    const { transport } = recordingTransport([provider.toolCall, () => provider.text("Done")]);
    const { result } = await runtime(transport);
    const stateDirectory = await mkdtemp(join(tmpdir(), `${provider.provider}-session-`));
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "file content" }], details: {} }));
    const options = { stateDirectory, modelRuntime: result, model: { ...selected, thinkingLevel: "off" as const }, systemPrompt: "Test", extensions: [],
      customTools: [{ name: "read_file", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), execute }],
    };
    const first = await createPiSessionRuntime(options);
    let sessionFile: string;
    try {
      expect(await runOrchestratorTurn(first, "read README.md")).toBe("Done");
      sessionFile = first.session.sessionFile!;
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await first.dispose(); }
    const resumed = await createPiSessionRuntime({ ...options, sessionFile });
    try {
      expect(await runOrchestratorTurn(resumed, "What did the file contain?")).toBe("Done");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await resumed.dispose(); }
    expect(await readFile(sessionFile, "utf8")).not.toContain(provider.key);
    const files = await readdir(stateDirectory, { recursive: true });
    expect(files.some((file) => file.endsWith("auth.json"))).toBe(false);
  });

  it.each([401, 404, 429, 529, 500])("replaces HTTP %i provider errors with a safe diagnostic", async (status) => {
    const body = provider.provider === "anthropic"
      ? { type: "error", error: { type: "api_error", message: `private prompt ${provider.key}` } }
      : { error: { message: `private prompt ${provider.key}`, type: "server_error", code: null } };
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "x-should-retry": "false" } }));
    const { result, model } = await runtime(transport);
    const message = await result.completeSimple(model, context);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(new RegExp(`^${provider.label} request failed; `));
    expect(JSON.stringify(message)).not.toContain("private prompt");
    expect(JSON.stringify(message)).not.toContain(provider.key);
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    const transport: typeof fetch = async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("should have aborted");
    };
    const { result, model } = await runtime(transport);
    const message = await result.completeSimple(model, context, { signal: controller.signal });
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe(`${provider.label} request cancelled`);
  });

  it.each(["worker", "orchestrator", "classifier"] as const)("uses the %s's Bedrock default when no secret is configured", async (role) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const resolved = await createModelRuntimeWithFallback(selected, role, { environment: {} });
      expect(resolved.model).toEqual({ provider: "amazon-bedrock", modelId: DEFAULT_BEDROCK_MODELS[role] });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`"reason":"${provider.provider}_secret_missing"`));
    } finally { log.mockRestore(); }
  });

  it("falls back for a nonexistent or empty secret, but not for access denied", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const read of [async () => undefined, async () => "  \n", async () => { throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" }); }]) {
        const resolved = await createModelRuntimeWithFallback(selected, "worker", { environment, readSecret: read });
        expect(resolved.model.provider).toBe("amazon-bedrock");
      }
      await expect(createModelRuntimeWithFallback(selected, "worker", { environment,
        readSecret: async () => { throw Object.assign(new Error(provider.key), { name: "AccessDeniedException" }); },
      })).rejects.toThrow(`${provider.label} credential could not be loaded`);
    } finally { log.mockRestore(); }
  });

  it("refuses models outside the Pi catalog", async () => {
    await expect(createConfiguredModelRuntime({ ...selected, modelId: "missing-model" }, { environment, readSecret })).rejects.toThrow(`${provider.label} model is not in the installed Pi catalog`);
  });
});

describe("direct provider keys", () => {
  it("refuses reasoning on a model without reasoning support", async () => {
    await expect(createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-4o", thinkingLevel: "high" }, { environment, readSecret })).rejects.toThrow("does not support reasoning");
  });

  it("refuses a Claude subscription token at runtime without exposing it", async () => {
    const token = "sk-ant-oat01-subscription-token";
    const error = await readProviderKey("anthropic", anthropicArn, async () => token).catch((caught: unknown) => caught);
    expect(String(error)).toContain("Anthropic credential could not be loaded");
    expect(String(error)).not.toContain(token);
  });

  it.each([
    ["anthropic", "sk-ant-api03-abcdef", undefined],
    ["anthropic", "sk-ant-oat01-abcdef", "subscription token"],
    ["anthropic", "sk-proj-abcdef", "starts with sk-ant-"],
    ["openai", "sk-proj-abcdef", undefined],
    ["openai", "sk-abcdef0123", undefined],
    ["openai", "sk-or-v1-abcdef", "OpenRouter key"],
    ["openai", "sk-ant-api03-abcdef", "Anthropic key"],
    ["openai", "proj-abcdef", "starts with sk-"],
    ["openrouter", "sk-or-v1-abcdef", undefined],
  ] as const)("judges a %s key %s", (provider, key, problem) => {
    if (problem === undefined) expect(providerKeyProblem(provider, key)).toBeUndefined();
    else expect(providerKeyProblem(provider, key)).toContain(problem);
  });

  it("redacts both providers' key formats", () => {
    expect(redactText(`key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(redactText(`key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  });
});
