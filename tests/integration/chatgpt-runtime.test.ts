// Sign in with ChatGPT (#341): a task on its owner's plan reaches OpenAI through the installed Pi
// transport with the plan's access token, asked for before every request, never with the OpenAI secret.
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, type ChatGptFallback } from "../../packages/model-runtime/src/index.js";

const context: Context = { messages: [{ role: "user", content: "Say done", timestamp: 0 }] };
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function text(value: string) {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_1", object: "response", model: "gpt-6.1-sol", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: value },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", object: "response", model: "gpt-6.1-sol", status: "completed", output: [item], usage } },
  ]);
}

function recording(responses: Array<() => Response>) {
  const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ url: input instanceof Request ? input.url : input.toString(), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
    return responses[Math.min(requests.length - 1, responses.length - 1)]!();
  });
  return { transport, requests };
}

describe("a task on a ChatGPT plan, through the installed Pi transport (#341)", () => {
  const selected = { provider: "openai", modelId: "gpt-6.1-sol" };

  it("sends the plan's current token on every request, never reads the OpenAI secret, and sends what ChatGPT accepts", async () => {
    const tokens = ["chatgpt-access-1", "chatgpt-access-1", "chatgpt-access-2"];
    const apiKey = vi.fn(async () => tokens.shift() ?? "chatgpt-access-2");
    const readSecret = vi.fn(async () => "sk-proj-never-used");
    const { transport, requests } = recording([() => text("Done")]);
    const runtime = await createConfiguredModelRuntime(selected, { environment: { AGENTX_OPENAI_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/openai-AbCdEf" }, readSecret, fetch: transport, apiKey, onUsage: vi.fn() });
    const model = runtime.getModel("openai", "gpt-6.1-sol")!;
    expect(model).toBeDefined();
    await runtime.completeSimple(model, context, { maxTokens: 500, temperature: 0.2 });
    await runtime.completeSimple(model, context);
    expect(readSecret).not.toHaveBeenCalled();
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer chatgpt-access-1", "Bearer chatgpt-access-2"]);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    // Pi recognises a ChatGPT token and leaves out what ChatGPT refuses.
    expect(requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", store: false });
    expect(requests[0]!.body).not.toHaveProperty("max_output_tokens");
    expect(requests[0]!.body).not.toHaveProperty("temperature");
  });

  it("says a refusal in the plan's terms, without the provider's body", async () => {
    const { transport } = recording([() => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "secret detail" } }), { status: 429 })]);
    const runtime = await createConfiguredModelRuntime(selected, { fetch: transport, apiKey: async () => "chatgpt-access-1", onUsage: vi.fn() });
    const message = await runtime.completeSimple(runtime.getModel("openai", "gpt-6.1-sol")!, context, { maxRetries: 0 });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("ChatGPT request failed; your ChatGPT plan's usage limit may be reached, see https://chatgpt.com/settings/usage");
  });

  it("runs only OpenAI models on a plan", async () => {
    await expect(createConfiguredModelRuntime({ provider: "anthropic", modelId: "claude-sonnet-4-6" }, { apiKey: async () => "chatgpt-access-1" }))
      .rejects.toThrow("a ChatGPT plan can run only OpenAI models");
  });
});

/** The install's default model behind a ChatGPT plan: a real Anthropic transport over a fake API. */
function anthropicText(value: string) {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}

async function planWithFallback(openai: Array<() => Response>, options: { apiKey?: () => Promise<string> } = {}) {
  const { transport, requests } = recording(openai);
  const defaultCalls = vi.fn(async () => anthropicText("Finished on the default"));
  const defaultRuntime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: "claude-sonnet-4-6" }, {
    environment: { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/anthropic-AbCdEf" },
    readSecret: async () => "sk-ant-api03-default-model-key", fetch: defaultCalls, onUsage: vi.fn(),
  });
  const onFallback = vi.fn();
  const fallback: ChatGptFallback = {
    stream: async (context, streamOptions) => defaultRuntime.streamSimple(defaultRuntime.getModel("anthropic", "claude-sonnet-4-6")!, context, streamOptions),
    onFallback,
  };
  const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-6.1-sol" }, {
    fetch: transport, apiKey: options.apiKey ?? (async () => "chatgpt-access-1"), chatgptFallback: fallback, onUsage: vi.fn(),
  });
  const model = runtime.getModel("openai", "gpt-6.1-sol")!;
  return { ask: () => runtime.completeSimple(model, context), requests, defaultCalls, onFallback, fallback };
}

const limited = () => new Response(JSON.stringify({ error: { type: "usage_limit_reached", code: "subscription_sharing_usage_limit_exceeded", message: "prompt text echoed" } }), { status: 429 });

describe("a ChatGPT plan that cannot serve the task (#342)", () => {
  it("moves the request that hit the limit, and every later one, to the default model, and says why once", async () => {
    const h = await planWithFallback([() => text("On the plan"), limited, () => text("never asked")]);
    expect((await h.ask()).content).toMatchObject([{ type: "text", text: "On the plan" }]);
    const fellBack = await h.ask();
    expect(fellBack.stopReason).toBe("stop");
    expect(fellBack).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Finished on the default" }] });
    expect(await h.ask()).toMatchObject({ provider: "anthropic" });
    // The plan was asked twice; the third request went straight to the default.
    expect(h.requests).toHaveLength(2);
    expect(h.defaultCalls).toHaveBeenCalledTimes(2);
    expect(h.onFallback.mock.calls).toEqual([["limit"]]);
    expect(h.fallback.reason).toBe("limit");
    // The default model never sees the ChatGPT token.
    const defaultHeaders = new Headers((h.defaultCalls.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(defaultHeaders.get("authorization") ?? "").not.toContain("chatgpt-access");
  });

  it("falls back when the connection was revoked: the token is refused, or OpenAI refuses it", async () => {
    const refusedToken = await planWithFallback([() => text("never asked")], { apiKey: (() => { let calls = 0; return async () => { calls += 1; if (calls > 1) throw new Error("AUTH_REQUIRED: revoked"); return "chatgpt-access-1"; }; })() });
    expect(await refusedToken.ask()).toMatchObject({ provider: "anthropic" });
    expect(refusedToken.requests).toHaveLength(0);
    expect(refusedToken.onFallback.mock.calls).toEqual([["revoked"]]);
    const refusedByOpenAi = await planWithFallback([() => new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 })]);
    expect(await refusedByOpenAi.ask()).toMatchObject({ provider: "anthropic" });
    expect(refusedByOpenAi.onFallback.mock.calls).toEqual([["revoked"]]);
  });

  it("falls back when the plan no longer allows the model", async () => {
    const h = await planWithFallback([() => new Response(JSON.stringify({ detail: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." }), { status: 400 })]);
    expect(await h.ask()).toMatchObject({ provider: "anthropic" });
    expect(h.onFallback.mock.calls).toEqual([["model"]]);
  });

  it("does not fall back for a failure the default would not fix, such as OpenAI being down", async () => {
    const h = await planWithFallback([() => new Response("upstream", { status: 503 })]);
    const failed = await h.ask();
    expect(failed).toMatchObject({ provider: "openai", stopReason: "error" });
    expect(h.defaultCalls).not.toHaveBeenCalled();
    expect(h.onFallback).not.toHaveBeenCalled();
  });
});
