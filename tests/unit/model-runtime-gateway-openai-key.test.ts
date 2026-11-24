// #1389: a company's own OpenAI key runs its coding agent through the model gateway's Anthropic Messages route, which translates the request to OpenAI Chat
// Completions and refuses, as a whole, any request carrying extended thinking or an image. A routed OpenAI model is therefore sent neither, whatever thinking level
// the step asks for; Claude and Bedrock models on the same route are unchanged. OpenAI's own names also carry the `openai` provider, never Bedrock's.
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import type { InvocationModelRoute } from "@agentx/contracts";
import { agentModelIdentity, agentModelName, isOpenAiAgentModel } from "../../packages/contracts/src/agent-model-choice.js";
import { createConfiguredModelRuntime, isGatewayChatModel, routeSupportsReasoning, routedThinkingLevel } from "../../packages/model-runtime/src/index.js";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const withImage: Context = { messages: [{ role: "user", content: [{ type: "text", text: "What is in this file?" }, { type: "image", data: PIXEL, mimeType: "image/png" }], timestamp: 1 }] };
const answer = (model: string) => new Response([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

const route = (name: string) => ({ alias: name, api: "anthropic-messages" as const, catalog: name });

async function sent(name: string, provider: "openai" | "anthropic"): Promise<{ body: Record<string, unknown>; reasoning: boolean; input: readonly string[] }> {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = vi.fn(async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>); return answer(name); }) as unknown as typeof fetch;
  const runtime = await createConfiguredModelRuntime({ provider, modelId: name }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route: route(name) } });
  const model = runtime.getModel("rovara-route", name)!;
  const message = await runtime.completeSimple(model, withImage, { reasoning: "medium" });
  expect(message.stopReason).toBe("stop");
  return { body: bodies[0]!, reasoning: model.reasoning, input: model.input };
}

const blocks = (body: Record<string, unknown>) => (body.messages as Array<{ content: unknown }>).flatMap((m) => Array.isArray(m.content) ? m.content as Array<{ type: string }> : []);

describe("an OpenAI model on the gateway's agent route (the company's own OpenAI key)", () => {
  it("is registered without reasoning and with text-only input", async () => {
    for (const name of ["gpt-5", "gpt-5-mini", "gpt-5.4-mini"]) {
      const { reasoning, input } = await sent(name, "openai");
      expect(reasoning, name).toBe(false);
      expect(input, name).toEqual(["text"]);
    }
  });

  it("sends no extended thinking and no image block, even when the step asks for thinking", async () => {
    const { body } = await sent("gpt-5", "openai");
    expect(body.thinking === undefined || (body.thinking as { type?: string }).type === "disabled").toBe(true);
    expect(blocks(body).map((block) => block.type)).not.toContain("image");
  });

  it("runs any saved thinking level as off", () => {
    expect(isGatewayChatModel(route("gpt-5"))).toBe(true);
    expect(routeSupportsReasoning(route("gpt-5"))).toBe(false);
    expect(routedThinkingLevel(route("gpt-5"), "high")).toBe("off");
    expect(routedThinkingLevel(route("gpt-5"), undefined)).toBeUndefined();
  });

  it("is only the gateway's Anthropic Messages route: the same name on another route API is not changed", () => {
    expect(isGatewayChatModel({ alias: "gpt-5", api: "openai-responses", catalog: "gpt-5" })).toBe(false);
  });
});

describe("isGatewayChatModel: the route's provider identity, not the shape of the name", () => {
  const anthropicRoute = (name: string, identity?: InvocationModelRoute["identity"]): InvocationModelRoute => ({ alias: name, api: "anthropic-messages", catalog: name, ...(identity === undefined ? {} : { identity }) });
  const openRouterIdentity = (modelId: string) => ({ provider: "openrouter" as const, sourceId: "source-1", connectionRevision: "rev-1", modelId });

  it("is true for an OpenRouter route, named by its own identity", () => {
    expect(isGatewayChatModel(anthropicRoute("openai/gpt-oss-20b", openRouterIdentity("openai/gpt-oss-20b")))).toBe(true);
    expect(isGatewayChatModel(anthropicRoute("some-vendor/unlisted-model", openRouterIdentity("some-vendor/unlisted-model")))).toBe(true);
  });

  it("is true for an OpenRouter route with no identity, named by the OpenRouter catalog entry its name has", () => {
    expect(isGatewayChatModel(anthropicRoute("openai/gpt-oss-20b"))).toBe(true);
    expect(isGatewayChatModel(anthropicRoute("z-ai/glm-5"))).toBe(true);
  });

  it("is false when the route is not OpenRouter's, whatever its name looks like", () => {
    expect(isGatewayChatModel(anthropicRoute("claude-sonnet-4-6"))).toBe(false);
    expect(isGatewayChatModel(anthropicRoute("us.anthropic.claude-sonnet-4-6"))).toBe(false);
    expect(isGatewayChatModel(anthropicRoute("openai.gpt-oss-120b-1:0"))).toBe(false);
    // A slash name the catalogs do not know and the route does not call OpenRouter's (a company's own model): not guessed from the slash.
    expect(isGatewayChatModel(anthropicRoute("acme/private-model"))).toBe(false);
  });

  it("is false for an OpenRouter route on another route API (only the Anthropic Messages route is translated)", () => {
    expect(isGatewayChatModel({ alias: "openai/gpt-oss-20b", api: "openai-completions", catalog: "openai/gpt-oss-20b", identity: openRouterIdentity("openai/gpt-oss-20b") })).toBe(false);
  });

  it("keeps the existing OpenAI rule", () => {
    expect(isGatewayChatModel(anthropicRoute("gpt-5"))).toBe(true);
    expect(isGatewayChatModel(anthropicRoute("o4-mini"))).toBe(true);
  });
});

describe("Claude on the same route is unchanged", () => {
  it("keeps reasoning and image input, and sends thinking when the step asks for it", async () => {
    const { body, reasoning, input } = await sent("claude-sonnet-4-6", "anthropic");
    expect(reasoning).toBe(true);
    expect(input).toContain("image");
    expect((body.thinking as { type?: string } | undefined)?.type).not.toBe("disabled");
    expect(body.thinking).toBeDefined();
    expect(blocks(body).map((block) => block.type)).toContain("image");
    expect(isGatewayChatModel(route("claude-sonnet-4-6"))).toBe(false);
  });
});

describe("OpenAI model names", () => {
  it("are OpenAI's own names, never a Bedrock id, a Claude name or an OpenRouter id", () => {
    for (const name of ["gpt-5", "gpt-5-mini", "gpt-5-codex", "gpt-5.4-mini", "gpt-4.1", "o3", "o4-mini"]) expect(isOpenAiAgentModel(name), name).toBe(true);
    for (const name of ["openai.gpt-oss-120b-1:0", "us.amazon.nova-2-lite-v1:0", "zai.glm-5", "claude-sonnet-5-5", "openai/gpt-5", "gpt-", "gpt-x", "omni", "o0", "GPT-5"]) expect(isOpenAiAgentModel(name), name).toBe(false);
  });

  it("are named under the openai provider, and round-trip to one gateway name", () => {
    expect(agentModelIdentity("gpt-5")).toEqual({ provider: "openai", modelId: "gpt-5" });
    expect(agentModelName({ provider: "openai", modelId: "gpt-5" })).toBe("gpt-5");
    expect(agentModelName({ provider: "amazon-bedrock", modelId: "gpt-5" })).toBeUndefined();
    expect(agentModelIdentity("openai.gpt-oss-120b-1:0")).toEqual({ provider: "amazon-bedrock", modelId: "openai.gpt-oss-120b-1:0" });
  });
});
