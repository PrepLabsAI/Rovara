// 0.5.52: the model gateway's Chat Completions dialects (a company's own OpenAI key, OpenRouter key, or OpenAI-compatible endpoint) refuse a WHOLE agent request that carries
// extended thinking, unless it is `{type:"disabled"}` (Cloud packages/model-gateway/src/agent-openai.ts toChatCompletions: `body.thinking !== undefined &&
// record(body.thinking)?.type !== "disabled"` returns undefined, which the gateway answers 400 invalid_request). #1389 handled OpenAI's bare ids only; an OpenRouter
// `vendor/model` route (openai/gpt-oss-20b) kept Pi's catalog row (reasoning, and no "off" level), so Pi sent thinking (its "off" is clamped up to "low") and the call failed.
// This contract pins the worker side for every refusing dialect: the request such a route sends never carries enabled thinking, whatever level the step asks for, and an
// Anthropic route still gets thinking. If the gateway's rule changes, change `gatewayRefuses` below with it.
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import type { InvocationModelRoute } from "@agentx/contracts";
import { catalogModel, catalogModelIds } from "../../packages/model-runtime/src/catalog.js";
import { createConfiguredModelRuntime, isGatewayChatModel, routeSupportsReasoning, routedThinkingLevel } from "../../packages/model-runtime/src/index.js";

/** The gateway rule for the Chat Completions dialects (openai, openrouter, endpoint): thinking is accepted only as disabled. */
const thinkingType = (body: Record<string, unknown>): unknown => {
  const thinking = body.thinking;
  return typeof thinking === "object" && thinking !== null && "type" in thinking ? thinking.type : undefined;
};
const gatewayRefuses = (body: Record<string, unknown>): boolean => body.thinking !== undefined && thinkingType(body) !== "disabled";

const answer = (model: string) => new Response([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
type Level = "minimal" | "low" | "medium" | "high" | undefined;
const LEVELS: Level[] = [undefined, "minimal", "low", "medium", "high"];

const plain = (name: string): InvocationModelRoute => ({ alias: name, api: "anthropic-messages", catalog: name });
const withIdentity = (name: string): InvocationModelRoute => ({ ...plain(name), identity: { provider: "openrouter", sourceId: "source-1", connectionRevision: "rev-1", modelId: name } });

/** What the worker's Pi request carries for `route` when the step asks for `level`: the request body the gateway would see. */
async function request(route: InvocationModelRoute, level: Level): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = vi.fn(async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>); return answer(route.alias); }) as unknown as typeof fetch;
  const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: route.alias }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route } });
  const model = runtime.getModel("rovara-route", route.alias)!;
  const message = await runtime.completeSimple(model, context, level === undefined ? {} : { reasoning: level });
  expect(message.stopReason).toBe("stop");
  return bodies[0]!;
}

const DIALECT_ROUTES: Record<"openai" | "openrouter" | "endpoint", InvocationModelRoute[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-5.4-mini", "o4-mini"].map(plain),
  // gpt-oss-20b is the staging failure: the Pi row reasons and has no "off" level. A route is named with or without the connection's own identity.
  openrouter: [plain("openai/gpt-oss-20b"), withIdentity("openai/gpt-oss-20b"), plain("z-ai/glm-5"), withIdentity("deepseek/deepseek-chat-v3.1"), plain("qwen/qwen3.7-plus")],
  // A company's own endpoint serves a name the Pi catalogs do not list, so the route has no catalog row and no reasoning.
  endpoint: ["acme-llm-70b", "my-company-coder", "llama-3.3-70b-instruct-acme"].map(plain),
};

describe("the Chat Completions dialects the gateway refuses thinking for", () => {
  it("the staging case is real: Pi's catalog row for openai/gpt-oss-20b reasons and does not allow off", () => {
    const row = catalogModel({ provider: "openrouter", modelId: "openai/gpt-oss-20b" });
    expect(row?.reasoning).toBe(true);
    expect((row?.thinkingLevelMap as { off?: unknown } | undefined)?.off).toBeNull();
  });

  for (const [dialect, routes] of Object.entries(DIALECT_ROUTES)) {
    describe(dialect, () => {
      for (const route of routes) {
        it(`${route.alias}${route.identity === undefined ? "" : " (with identity)"}: the request never carries enabled thinking, at any level`, async () => {
          for (const level of LEVELS) {
            const body = await request(route, level);
            expect(gatewayRefuses(body), `${route.alias} at ${level ?? "default"}: ${JSON.stringify(body.thinking)}`).toBe(false);
            expect(body.thinking === undefined || thinkingType(body) === "disabled").toBe(true);
          }
        });

        it(`${route.alias}: does not reason, so every saved level runs as off`, () => {
          // OpenAI and OpenRouter routes are gateway chat models by identity; a company's own endpoint model is one the catalogs do not list, so it has no reasoning either way.
          expect(isGatewayChatModel(route)).toBe(dialect !== "endpoint");
          expect(routeSupportsReasoning(route)).toBe(false);
          expect(routedThinkingLevel(route, "high")).toBe("off");
          expect(routedThinkingLevel(route, "medium")).toBe("off");
          expect(routedThinkingLevel(route, undefined)).toBeUndefined();
        });
      }
    });
  }

  it("every OpenRouter reasoning row of the installed catalog, as a gateway name, sends no enabled thinking at any level", async () => {
    const names = catalogModelIds("openrouter").filter((id) => /^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/u.test(id));
    const reasoning = names.filter((id) => catalogModel({ provider: "openrouter", modelId: id })?.reasoning === true);
    expect(reasoning.length).toBeGreaterThan(10);
    for (const name of reasoning) {
      expect(isGatewayChatModel(withIdentity(name)), name).toBe(true);
      expect(routeSupportsReasoning(withIdentity(name)), name).toBe(false);
      // The wire, at the level Pi would default to and at the highest (an Anthropic model listed under OpenRouter manages effort per turn, a path of its own).
      for (const level of ["medium", "high"] as const) expect(gatewayRefuses(await request(withIdentity(name), level)), `${name} at ${level}`).toBe(false);
    }
  });
});

describe("the request carries only fields the gateway's Chat Completions translation accepts", () => {
  // Cloud toChatCompletions refuses a body with any other top-level key (e.g. an `output_config` effort that adaptive thinking would add).
  const GATEWAY_ALLOWED = new Set(["model", "messages", "max_tokens", "stream", "system", "temperature", "top_p", "stop_sequences", "metadata", "tools", "tool_choice", "thinking"]);
  it("every OpenRouter reasoning row of the installed catalog, as a gateway name, sends only allowed top-level fields", async () => {
    const names = catalogModelIds("openrouter").filter((id) => /^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/u.test(id));
    for (const name of names.filter((id) => catalogModel({ provider: "openrouter", modelId: id })?.reasoning === true)) {
      for (const level of ["minimal", "high"] as const) {
        const extra = Object.keys(await request(withIdentity(name), level)).filter((key) => !GATEWAY_ALLOWED.has(key));
        expect(extra, `${name} at ${level}`).toEqual([]);
      }
    }
  });
});

describe("an Anthropic route is unchanged: it still gets thinking", () => {
  for (const name of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
    it(`${name}: reasoning on, thinking sent when the step asks`, async () => {
      expect(isGatewayChatModel(plain(name))).toBe(false);
      expect(routeSupportsReasoning(plain(name))).toBe(true);
      expect(routedThinkingLevel(plain(name), "high")).toBe("high");
      const body = await request(plain(name), "medium");
      expect(body.thinking).toBeDefined();
      expect(gatewayRefuses(body)).toBe(true); // it would be refused on a Chat Completions dialect; Anthropic's own route accepts it
    });
  }

  it("a Bedrock id on the gateway route keeps its catalog reasoning", () => {
    const bedrock = plain("zai.glm-5");
    expect(isGatewayChatModel(bedrock)).toBe(false);
  });
});
