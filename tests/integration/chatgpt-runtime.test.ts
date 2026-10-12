// Sign in with ChatGPT (#341): a task on its owner's plan reaches OpenAI through the installed Pi
// transport with the plan's access token, asked for before every request, never with the OpenAI secret.
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";

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
