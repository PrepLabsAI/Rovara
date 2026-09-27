import { DEFAULT_BEDROCK_MODELS } from "../../packages/model-runtime/src/config.js";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createModelClassifier } from "../../packages/orchestrator/src/action-classifier.js";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createConfiguredModelRuntime, createModelRuntimeWithFallback, openRouterRouting, readOpenRouterKey } from "../../packages/model-runtime/src/index.js";
import type { Context } from "@earendil-works/pi-ai";

const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openrouter-AbCdEf";
const secret = "sk-or-test-never-persist-this";
const selected = { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" };
const environment = { AGENTX_OPENROUTER_SECRET_ARN: secretArn, AGENTX_OPENROUTER_PROVIDERS: "anthropic" };
const context: Context = { messages: [{ role: "user", content: "Read a file", timestamp: 0 }], tools: [{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }] };
function response(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
const textChunks = [
  { id: "gen-test", model: "anthropic/claude-sonnet-4-20250514", provider: "Anthropic", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
];
async function runtime(transport: typeof fetch, onUsage = vi.fn()) {
  const result = await createConfiguredModelRuntime(selected, { environment, readSecret: async () => secret, fetch: transport, onUsage });
  return { result, model: result.getModel(selected.provider, selected.modelId)!, onUsage };
}

describe("OpenRouter through the installed Pi transport", () => {
  it.each(["worker", "orchestrator", "classifier"] as const)("uses the %s default when no secret ARN is configured", async (role) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const resolved = await createModelRuntimeWithFallback(selected, role, { environment: {} });
      expect(resolved.model).toEqual({ provider: "amazon-bedrock", modelId: DEFAULT_BEDROCK_MODELS[role] });
      expect(resolved.runtime.getModel(resolved.model.provider, resolved.model.modelId)).toBeDefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"openrouter_secret_missing"'));
    } finally { log.mockRestore(); }
  });

  it("uses the configured worker default for a nonexistent or empty secret, but refuses access-denied fallback", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const env = { ...environment, AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "amazon.nova-lite-v1:0" };
    try {
      for (const readSecret of [async () => undefined, async () => { throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" }); }]) {
        const resolved = await createModelRuntimeWithFallback(selected, "worker", { environment: env, readSecret });
        expect(resolved.model).toEqual({ provider: "amazon-bedrock", modelId: env.AGENTX_MODEL_ID });
      }
      log.mockClear();
      await expect(createModelRuntimeWithFallback(selected, "worker", { environment: env,
        readSecret: async () => { throw Object.assign(new Error(secret), { name: "AccessDeniedException" }); },
      })).rejects.toThrow("credential could not be loaded");
      expect(log).not.toHaveBeenCalled();
      const resolved = await createModelRuntimeWithFallback(selected, "worker", { environment: env, readSecret: async () => secret });
      expect(resolved.model).toEqual(selected);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("runs Qwen3-Coder without reasoning parameters and refuses dynamic router aliases", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const qwen = { provider: "openrouter", modelId: "qwen/qwen3-coder", thinkingLevel: "off" };
    const result = await createConfiguredModelRuntime(qwen, {
      environment: { ...environment, AGENTX_OPENROUTER_PROVIDERS: "deepinfra/turbo" }, readSecret: async () => secret, onUsage: () => {},
      fetch: async (_url, init) => {
        if (typeof init?.body !== "string") throw new Error("expected JSON");
        requests.push(JSON.parse(init.body) as Record<string, unknown>);
        return response(textChunks);
      },
    });
    expect((await result.completeSimple(result.getModel(qwen.provider, qwen.modelId)!, context, { reasoning: "off" })).stopReason).toBe("stop");
    expect(requests[0]).toMatchObject({ model: qwen.modelId, provider: { only: ["deepinfra/turbo"] } });
    expect(requests[0]).not.toHaveProperty("reasoning");
    await expect(createConfiguredModelRuntime({ ...qwen, thinkingLevel: "high" }, { environment })).rejects.toThrow("does not support reasoning");
    await expect(createConfiguredModelRuntime({ ...selected, modelId: "openrouter/auto" }, { environment })).rejects.toThrow("approve a specific model ID");
  });
  it("persists and resumes a real Pi session with tool results, without credential files", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const transport: typeof fetch = async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON");
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return requests.length === 1 ? response([
        { id: "gen-tool", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]) : response(textChunks);
    };
    const { result } = await runtime(transport);
    const stateDirectory = await mkdtemp(join(tmpdir(), "openrouter-session-"));
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
      expect(requests.at(-1)?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", content: "file content" })]));
    } finally { await resumed.dispose(); }
    expect(await readFile(sessionFile, "utf8")).not.toContain(secret);
    const files = await readdir(stateDirectory, { recursive: true });
    expect(files.some((file) => file.endsWith("auth.json"))).toBe(false);
  });

  it("runs the action classifier through OpenRouter and parses its verdict", async () => {
    const transport: typeof fetch = async () => response([
      { choices: [{ index: 0, delta: { content: '{"decision":"allow","reason":"The member requested this change."}' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const { result } = await runtime(transport);
    const classifier = await createModelClassifier({ model: selected, modelRuntime: result, failOnUnknownModel: true });
    expect(await classifier({ memberMessages: ["Rename the issue"], call: { tool: "update_issue", summary: "Rename", arguments: { title: "new" } } })).toMatchObject({ decision: "allow" });
  });
  it("streams split tool arguments, continues with the tool result, and records requested/returned identifiers", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const transport: typeof fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return requests.length === 1 ? response([
        { id: "gen-tool", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ]) : response(textChunks);
    };
    const { result, model, onUsage } = await runtime(transport);
    const stream = result.streamSimple(model, context);
    const events = [];
    for await (const event of stream) events.push(event.type);
    const tool = await stream.result();
    expect(events).toContain("toolcall_delta");
    expect(tool.stopReason).toBe("toolUse");
    expect(tool.content[0]).toMatchObject({ type: "toolCall", name: "read_file", arguments: { path: "README.md" } });
    const resumed = await result.completeSimple(model, { ...context, messages: [...context.messages, tool, { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: [{ type: "text", text: "file content" }], isError: false, timestamp: 1 }] });
    expect(resumed.content).toMatchObject([{ type: "text", text: "Done" }]);
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool" })]));
    expect(requests[0]).toMatchObject({ model: selected.modelId, provider: { only: ["anthropic"], allow_fallbacks: false, require_parameters: true, data_collection: "deny" } });
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ requestedModel: selected.modelId, returnedModel: "anthropic/claude-sonnet-4-20250514", returnedProvider: "Anthropic", costSource: "estimated" }));
    expect(JSON.stringify([tool, resumed, onUsage.mock.calls])).not.toContain(secret);
  });

  it.each([401, 429, 503])("sanitizes HTTP %i errors without retrying the request", async (status) => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: `private prompt ${secret}` } }), { status, headers: { "Content-Type": "application/json" } }));
    const { result, model } = await runtime(transport);
    const message = await result.completeSimple(model, context);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("OpenRouter request failed");
    expect(JSON.stringify(message)).not.toContain(secret);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation and terminates the stream", async () => {
    const controller = new AbortController();
    const transport: typeof fetch = async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("should have aborted");
    };
    const { result, model } = await runtime(transport);
    const message = await result.completeSimple(model, context, { signal: controller.signal });
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe("OpenRouter request cancelled");
  });

  it("rejects unavailable models and missing/invalid credentials without exposing values", async () => {
    await expect(createConfiguredModelRuntime({ provider: "openrouter", modelId: "missing/model" }, { environment })).rejects.toThrow("not in the installed Pi catalog");
    await expect(readOpenRouterKey("raw-key")).rejects.toThrow("secret ARN");
    await expect(readOpenRouterKey(secretArn, async () => { throw new Error(secret); })).rejects.toThrow("credential could not be loaded");
    expect(() => openRouterRouting({ AGENTX_OPENROUTER_PROVIDERS: "anthropic\nunsafe" })).toThrow("provider slugs");
  });
});
