// DEC 254f review (kept by DEC 254g, which drops Code's pinned model list): the model gateway's agent route holds every non-Anthropic model name to its default output limit (64,000 tokens) and refuses a request asking for more. Pi asks for the
// catalog's whole output limit (zai.glm-5: 131,072), so a core step on a Bedrock model the gateway offers would be refused at every call. A routed model on that list asks for at most the
// gateway's limit (its offered-models answer carries no output limit, so 64,000 stands for every model but Claude on that route); Claude and routes on another API keep their catalog limit.
// DEC 254g: the gateway is the authority on which models it offers; its 400 for one it does not offer ends the call in model-runtime's own fixed words ("model not offered").
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { GATEWAY_CONVERSE_MAX_OUTPUT_TOKENS, GATEWAY_MODEL_NOT_OFFERED_ANSWERS, MODEL_NOT_OFFERED_DETAIL, createConfiguredModelRuntime, gatewayModelNotOfferedBody } from "../../packages/model-runtime/src/index.js";
import { GATEWAY_CONVERSE_MODELS } from "../support/offered-models-fake.js";
import { catalogModelByName } from "../../packages/model-runtime/src/catalog.js";

const plain: Context = { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] };
const answer = (model: string) => new Response([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

async function routedRuntime(name: string, provider: "anthropic" | "amazon-bedrock", reply: () => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = vi.fn(async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>); return reply(); }) as unknown as typeof fetch;
  const runtime = await createConfiguredModelRuntime({ provider, modelId: name }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route: { alias: name, api: "anthropic-messages", catalog: name } } });
  return { runtime, bodies };
}

async function maxTokensAsked(name: string, provider: "anthropic" | "amazon-bedrock"): Promise<{ registered: number; sent: unknown }> {
  const { runtime, bodies } = await routedRuntime(name, provider, () => answer(name));
  const model = runtime.getModel("rovara-route", name)!;
  const message = await runtime.completeSimple(model, plain);
  expect(message.stopReason).toBe("stop");
  return { registered: model.maxTokens, sent: bodies[0]?.max_tokens };
}

describe("a routed call to a Bedrock model the gateway offers", () => {

  it("never asks for more than the gateway's limit on any offered model, and keeps a lower catalog limit", async () => {
    for (const name of [...GATEWAY_CONVERSE_MODELS, "acme.brand-new-model-v9:0"]) {
      const catalog = catalogModelByName(name)?.model.maxTokens ?? 16_384;
      const { registered, sent } = await maxTokensAsked(name, "amazon-bedrock");
      expect(registered, name).toBe(Math.min(catalog, GATEWAY_CONVERSE_MAX_OUTPUT_TOKENS));
      expect(sent, name).toBe(registered);
    }
  });
});

describe("every other routed model keeps its catalog limit (today's behaviour)", () => {
  it("a Claude model asks for its whole catalog limit", async () => {
    const catalog = catalogModelByName("claude-sonnet-4-6")!.model.maxTokens;
    expect(catalog).toBeGreaterThan(GATEWAY_CONVERSE_MAX_OUTPUT_TOKENS);
    expect(await maxTokensAsked("claude-sonnet-4-6", "anthropic")).toEqual({ registered: catalog, sent: catalog });
  });

});

describe("a model the gateway does not offer (DEC 254g: the gateway is the authority)", () => {
  const refusal = (message: string, status = 400) => () => Response.json({ error: { type: "invalid_request", message } }, { status });

  it("ends the call in model-runtime's own fixed words for each of the gateway's not-offered answers", async () => {
    for (const message of GATEWAY_MODEL_NOT_OFFERED_ANSWERS) {
      const { runtime } = await routedRuntime("zai.glm-9", "amazon-bedrock", refusal(message));
      const result = await runtime.completeSimple(runtime.getModel("rovara-route", "zai.glm-9")!, plain);
      expect(result.stopReason, message).toBe("error");
      expect(result.errorMessage, message).toBe(`Model source request failed; ${MODEL_NOT_OFFERED_DETAIL}`);
    }
  });

  it("does not classify the exact gateway answer as not offered for other HTTP statuses", async () => {
    const details = new Map([[401, "the API key was refused; check that it is valid and has not expired"], [403, "check the API key and its permissions"], [404, "check the model ID and that the key's organization can use it"], [429, "rate limited or out of credits; check the key's usage limits before retrying"], [500, "upstream unavailable; check provider status before retrying"]]);
    for (const [status, detail] of details) {
      const { runtime } = await routedRuntime("zai.glm-9", "amazon-bedrock", refusal("This model is not offered on Rovara's AI.", status));
      const result = await runtime.completeSimple(runtime.getModel("rovara-route", "zai.glm-9")!, plain);
      expect(result.errorMessage, String(status)).toBe(`Model source request failed; ${detail}`);
    }
  });

  it("does not classify the exact 400 answer as not offered on another route API", async () => {
    const transport = vi.fn(async () => Response.json({ error: { type: "invalid_request", message: "This model is not offered on Rovara's AI." } }, { status: 400 })) as unknown as typeof fetch;
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: "zai.glm-9" }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route: { alias: "company-glm", api: "openai-completions", catalog: "zai.glm-9" } } });
    const result = await runtime.completeSimple(runtime.getModel("rovara-route", "company-glm")!, plain);
    expect(result.errorMessage).toBe("Model source request failed; the request was refused; check the model's context and output limits");
  });

  it("any other 400 keeps the ordinary refused-request words (the body is matched whole, never echoed)", async () => {
    for (const reply of [refusal("This model is not offered on Rovara's AI. secret-prompt"), refusal("prompt too long"), () => new Response("This model is not offered on Rovara's AI.", { status: 400 })]) {
      const { runtime } = await routedRuntime("zai.glm-9", "amazon-bedrock", reply);
      const result = await runtime.completeSimple(runtime.getModel("rovara-route", "zai.glm-9")!, plain);
      expect(result.errorMessage).toBe("Model source request failed; the request was refused; check the model's context and output limits");
      expect(result.errorMessage).not.toContain("secret-prompt");
    }
  });

  it("is told by the gateway's exact answer only", () => {
    expect(gatewayModelNotOfferedBody(JSON.stringify({ error: { type: "invalid_request", message: "This model is not offered on Rovara's AI." } }))).toBe(true);
    for (const body of ["", "not json", "null", "[]", JSON.stringify({ error: "This model is not offered on Rovara's AI." }), JSON.stringify({ message: "This model is not offered on Rovara's AI." }),
      JSON.stringify({ error: { message: "this model is not offered on rovara's ai." } })]) expect(gatewayModelNotOfferedBody(body), body).toBe(false);
  });
});
